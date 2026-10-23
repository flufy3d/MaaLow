// 独夫 scheduler (试炼 → 开封皇宫 → 独夫 → 演练场 阶段一). Every stream frame: backbone dufu/unified_back9.onnx -> 192-d
// feature + 15 aux columns into the device's feature ring -> causal GRU head dufu/unified_head9s.onnx (no image input,
// seq [1,30,207] read from the ring) -> combo / stage / fut1-3 / def1-3 / tell -> a defense plan (卸势 / dodge / potion)
// rebuilt every frame, frozen near its press, executed under the button cooldowns. Around it: the flare (金光) anchored
// dodges, the curtain (幕布) gap rules and timed sweep dodges, the hit chain (stagger by drop, the escape 卸势, the
// relock wait), the safe drink, and the offense (the near gate after a 卸势 ok, the committed 横刀 set, the far
// close-in, the 气竭 window with 处决, 奇术, the 横刀 ok follow-up). Slow reads only run on the frame budget's leftover.
// The behavior is the 2026-10-20 r737 baseline (the args it ran with are the constants here); docs/dufu.md has the
// numbers and what was tried.
//   maalow do skill dufu                       (10 min, 1 potion)
//   maalow do skill dufu --args '{"ms":300000,"potions":0}'
//   maalow do skill dufu --args '{"phase":2,"trace":true}'                       (阶段二 arena, dufu_enter phase 2)
//   maalow do skill dufu --args '{"phase":2,"ms":900000}' --timeout 960000      (> ~10 min needs --timeout, @see END_MARGIN_MS)
// phase 2 (args.phase): the quest line reads 阶段二 from the start there, so only the 成功 page / death / time end the
// run; the fut/def heads' plain dodges become 卸势 (@see defAction); no curtain; 金光 dodges at the first report with a
// per-frame image rule (@see FLARE2_P); a 气竭 spell without 处决 walks in (@see QP2_WALK_AFTER_MS); args.redLine: a 卸势
// anchored on the red line some red moves show first (@see RL_DELAY_F); args.cadence (with head unified_head_p2e): the
// 节拍 卸势 replaces the planned ones (@see CAD_OFF).
import { stats } from "./lib/stats.js";
import { BOSS_FULL, ICON_WHITE, ME_X, bossPx, countAtLeast, gapNow, health, litNow, readMean, readQi, redLine, seeFlash } from "./lib/dufu-reads.js";
import { COMBO6_LABELS, DEF_LABELS, FUT_CENTER, FUT_HI, FUT_LABELS, FUT_LO, STAGE_LABELS, TELL_LABELS } from "./lib/dufu-labels.js";
import { argmax, futStats, headOut, softmax } from "./lib/dufu-math.js";

/** @type {SkillMeta} */
export const meta = { description: "独夫 phase one (args.phase 2: phase two): model defense (卸势 / dodge / potion) + offense (near gate, 处决, 奇术)", timeout: 660_000 };

const MODEL = "dufu/unified_head9s.onnx", BACK_MODEL = "dufu/unified_back9.onnx";
const MODEL_P2 = "dufu/unified_head_p2.onnx"; // phase 2's head (tools/dufu_train), the default with args.phase 2
const T = 30; // ring / seq window (frames)
const F = 192; // backbone features per frame
const A = 15; // aux columns per frame
const D = F + A; // 207 per step
const FRAME_MS = 1000 / 30; // the dataset's frame clock (durations are mapped at 30 fps)
const MIN_RING = 12; // the head runs once this many frames are in the ring (front-padded to 30)

/** @type {InferOptions} */
const BACK = { roi: [120, 30, 840, 530], size: 96, resize: "area", color: "rgb", mean: 0, std: 1, frames: [0], post: "none" };

// buttons / joystick (combat.js)
/** @type {Point} */ const PARRY = [952, 495];
/** @type {Point} */ const DODGE = [924, 674];
/** @type {Point} */ const POTION = [700, 690];
/** @type {Point} */ const STICK = [175, 569];
const STICK_R = 83;
/** @type {Point} */ const BACKWARD = [175, 652];
/** @type {Point} */ const LEFT = [92, 569];
/** @type {Point} */ const RIGHT = [258, 569];
/** @type {Point} */ const LIGHT = [945, 592];
/** @type {Point} */ const EXECUTE = [852, 430];
/** @type {Point} */ const CHARGE = [1020, 478]; // 陌刀 蓄力 (横刀: 重击)
/** @type {Point} */ const DASH = [833, 593]; // 陌刀 突进 = 燃此魂; 横刀 突进 -> 伤害
/** @type {Point} */ const BUFF = [825, 668]; // 陌刀 唤千军; 横刀 爆发
/** @type {Point} */ const SWITCH = [993, 320];
/** @type {Point} */ const QISHU = [881, 525];
// reads (lib/dufu-reads.js has the masks / ROIs)
const HIT_DROP = 0.025; // a blow: health down this much at once
const QI_STEP = 8, QI_JUMP = 80; // a good 卸势 takes 10-25 px of the boss's 真气
const GAP_IN = 20, GAP_PUSH = 120;
const CURTAIN_GONE_MS = 1500, CURTAIN_FIRST_DODGE_MS = 950, CURTAIN_DODGE_GAP_MS = 700;

// the plan
const ISSUE_LEAD_MS = Math.round((9 + 5) * FRAME_MS); // the parry lit 9 f before the contact + 5 f press -> screen
const COMMIT_MS = 90; // an item this close is frozen
const PARRY_CD_MS = 220, DODGE_CD_MS = 500;
const NEXT_MS = 50; // wait for a new stream frame at most (then screenshot anyway)
const PRED_MS = 500; // "pred" mark period
const MISS_GRACE_MS = 250; // a pressed item unresolved this long past its contact: miss
const PLAN_FRAMES_MAX = 60; // fut bins end at 60: do not plan beyond
const LATE_FRAMES = 2; // closer than this: too late to press
const COVER_FRAMES = 15; // bimodal modes this close: one press covers both
const REVISE_MOVE_MS = 100; // a contact this much later/earlier: revise (and log)
const BRANCH_MIN_P = 0.2, BRANCH_SEP_BINS = 5, BRANCH_KEEP_P = 0.25; // bimodal split + later-mode survival
const BRANCH_LATE_MS = 400; // an unreleased branch this stale: drop
const TRIG_TH = 0.45; // the timing-head trigger (S1 = fut bins 1-5): a contact this likely within 4-19 frames acts
const DODGE_MIN_P = 0.5; // def1 "dodge" below this is treated as parry (the dodge class over-fires in fights)
const HOLD_MIN_LEAD = 4; // frames: a press held by the hit stagger goes at its end only with this much lead left
// repress: a pressed fut item whose contact moved >= REPRESS_GAP_FRAMES later (the 横刀 long wind-ups) or that is
// about to expire while the fresh fut still shows a contact within REPRESS_LOOK_FRAMES is re-armed, at most REPRESS_MAX
// times (the old one-shot flag left a stale pressed k0 in the slot, 726 t7251).
const REPRESS_GAP_FRAMES = 18, REPRESS_DELAY_FRAMES = 12, REPRESS_LOOK_FRAMES = 25, REPRESS_MAX = 2;

// tells. A flare (金光) tell presses its dodge at the episode's first tell frame + ANCHOR[kind] (the head's first fire
// is the image onset +-3 f). flare_other gets 14 (batch 2) and the fut dodges wait for it (flareHold: a fut dodge took
// the CD at onset +9..12 in 42 of 66 plans) until it is pressed, FLARE_HOLD_F passes, or the episode goes quiet for
// FLARE_HOLD_GAP_F. flareSplit: FLARE_SPLIT_F after the first report, fut1 mass at 4-15 f >= FLARE_SPLIT_TH = a fast
// one (acc 0.82): the hold ends at once and the anchor moves to FLARE_FAST_ANCHOR.
const TELL_TH = 0.5, TELL_DEDUP_MS = 300, TELL_DODGE_P = 0.5, TELL_EPISODE_MS = 2000;
/** @type {Record<string, number>} */ const ANCHOR = { flare_grab: 4, flare_slam: 10, flare_other: 14 };
/** @type {Record<string, number>} */ const DODGE_LEAD = { other: 5, sweep: 5 }; // frames: the image flare / sweep tell
const FLARE_HOLD_F = 30, FLARE_HOLD_GAP_F = 6;
const FLARE_SPLIT_F = 3, FLARE_SPLIT_TH = 0.6, FLARE_FAST_ANCHOR = 6;
const SLOW_EVERY = 250, FLARE_EVERY = 400, CURTAIN_EVERY = 400; // slow reads
const SLOW_SLACK_MS = 3; // a slow check may start while this much of the budget is left
// curtain: entered by the tell (curtain), its dark class at the black cover (>= 2 frames p >= 0.7), or the image rule
// (panels + orange edge). Its sweeps come every 65 f, three per episode; a dark run's first frame or a hit in the
// curtain syncs them and the next SWEEP_N get one back dodge each, showing SWEEP_LEAD_F before. Entering it drops only
// the planned dodges (the 卸势 of plain blows stay).
const SWEEP_PERIOD_MS = 65 * FRAME_MS, SWEEP_N = 2, SWEEP_LEAD_F = 2;
const SWEEP_DARK_LAG_F = 3.3, SWEEP_HIT_LAG_F = 7.2; // device sync time - sweep frame (press-lit clock)
const DODGE_SHOW_F = 0.65; // a dodge tap shows white this long after a 卸势 tapped at the same moment would light
const SWEEP_LATE_MS = 100, SWEEP_GAP_MS = 300, SWEEP_QUIET_MS = 600, SWEEP_DARK_GAP_MS = 500, SWEEP_HIT_NEAR_F = 10;

// the hit chain. The stagger follows the read drop ([maxDrop, ms], first row that fits). After a hit up to
// HIT_ESC_MAX_DROP one 卸势 goes at the stagger's end (not in / just after the curtain, not while drinking, not when a
// plan 卸势 goes within HIT_ESC_YIELD_F), else one post-hit insurance 卸势 there (skipped when the plan has a pending
// item or pressed since the hit). A 卸势 within PARRY_RELOCK_MS of the last one, nothing back since and the same believed
// contact (<= RELOCK_SAME_F apart, or a re-armed / insurance one) waits for the game's lock to end; with less than
// RELOCK_MIN_LEAD_F lit lead left there it is dropped.
const STAGGER_BY_DROP = [[0.04, 100], [0.065, 300], [1, 500]];
const HIT_ESC_MAX_DROP = 0.065, HIT_ESC_WIN_F = 4, HIT_ESC_YIELD_F = 3;
const PARRY_RELOCK_MS = 330, RELOCK_SAME_F = 8, RELOCK_MIN_LEAD_F = 2;
const LATENCY_F = 5; // press -> on screen, frames
// phase 2 (teacher, 2026-10-23): most blows there are red-light (红光) ones a 卸势 takes; 金光 must still be dodged.
// So with args.phase 2 a def head "dodge" (fut items, their re-arms) is a 卸势; the flare tell dodges (tellPlan,
// slowFlare) are untouched. Phase two has no curtain (幕布) at all (teacher, 2026-10-23; the head's curtain / dark
// reports there are red-scene misreads that blocked potions and fired timed back dodges), so with phase 2 nothing enters
// it: the tell's curtain class and dark runs are ignored and the image rule (slowCurtain) does not run. Phase 1 is
// unchanged. @see defAction, curtainOn
// phase 2 金光 (hit attribution of 4 rounds, 2026-10-23: the openers took 43% of the HP lost). The gold streak shows
// ~10 f before the red blast (gold -6 f, blast +4 f); the anchored tell dodges (ANCHOR + flareHold / flareSplit) went
// ~270 ms after the first report, at or after the blast, while the image rule's dodges mostly got out. So with phase 2
// (@see flare2Tick) a flare report — the tell head's argmax a flare class (1-3) at p >= FLARE2_P (no second frame, the
// first reports were p 0.35-0.49), or the image rule on this frame — dodges at once (atMs = now; no anchor, no hold /
// split), left / right in turn, under DODGE_CD_MS; one episode = reports less than FLARE2_GAP_MS apart. One re-dodge
// per episode when it is still reported after the CD, within FLARE2_REDODGE_MAX_MS of the first dodge, no hit since
// it, no unpressed 卸势 due within FLARE2_PARRY_GUARD_MS and none pressed within ISSUE_LEAD_MS (the opener goes on with
// two red blows ~0.87 s apart that the plan parries; a dodge must not cut those 卸势). The image rule runs every frame before the aux is built (not on the slow-read budget), every
// FLARE2_SLOW_EVERY ms instead once its mean cost over the last FLARE2_COST_N reads passes FLARE2_COST_MS.
const FLARE2_P = 0.35, FLARE2_GAP_MS = 20 * FRAME_MS, FLARE2_HIT_F = 10;
const FLARE2_REDODGE_MAX_MS = 700, FLARE2_PARRY_GUARD_MS = 400;
const FLARE2_COST_MS = 5, FLARE2_COST_N = 30, FLARE2_SLOW_EVERY = 100;
// FLARE2_IMG off (r058-r067): the per-frame image rule cost ~33 ms a read (loop p50 27 -> 36 ms) and most of its phase-2
// hits were red bursts / lens streaks, not gold; median life 170 -> 95 s. Phase 2 keeps the 400 ms slowFlare instead.
const FLARE2_IMG = false;
// phase 2 red line (args.redLine, default off; data/tmp/p2timing, 89 rounds). Some red moves show a thin red horizontal
// line (lib/dufu-reads.js redLine) and land 12-21 f (mode 16) after its onset; a 卸势 issued at onset +6..+14 f took
// 92/93 of them (before the onset 2/31, +0..2 12/21, +3..5 28/34). Those times are the press mark (tap issue,
// Date.now()) minus the line's first video frame, and the video frames map to the capture clock (frames.py: frame =
// (trace start + capture ms - recording start) / 33.3 ms), so the anchor is the line frame's capture time (img.time -
// img.age_ms) + the delay, compared with Date.now(): LATENCY_F (tap -> screen) is already inside those numbers. Our first
// line frame is ~0..1 f after the video onset (the loop takes ~every frame, ~30 ms behind capture) and executePlan
// fires 0..1.2 f after an item's atMs, so RL_DELAY_F 6 puts the taps at ~onset +6..+8 f. An episode = line frames at
// most RL_GAP_F apart (capture time); its onset plans once. A line within RL_IGNORE_F after a contact is that contact's
// impact flash (36% of the lines): an ok / hit read (it comes ~RL_FB_LAG_F after its contact) in [onset - (RL_IGNORE_F -
// RL_FB_LAG_F), onset + RL_FB_LAG_F] ignores the line, at the onset or later until a 卸势 went in the window. The window
// is [onset + RL_WIN_LO_F, onset + RL_WIN_HI_F]: an unpressed fut 卸势 planned before its start waits for the anchor
// (floorMs); a fut 卸势 inside it covers the line; else one "red" item at the anchor waits out the parry CD / relock
// while still in the window. Once a 卸势 went in the window, the other unpressed ones up to its end are dropped.
// The read runs every frame (~2 color() reads, 3-6 with a candidate row); every other frame once its mean cost over
// the last RL_COST_N reads passes RL_COST_MS.
const RL_DELAY_F = 6, RL_GAP_F = 3.5, RL_IGNORE_F = 8, RL_FB_LAG_F = 6, RL_WIN_LO_F = 3, RL_WIN_HI_F = 15;
const RL_CONTACT_F = 16, RL_MISS_F = 30, RL_COST_MS = 5, RL_COST_N = 30;
// phase 2 cadence (节拍) 卸势 (args.cadence = the gate threshold G, default off; tools/dufu_train/README.md "dufu.js 集成规格",
// replay.py). Needs a head with the lead1f block (unified_head_p2e.onnx: out[CAD_OFF .. CAD_OFF + CAD_N - 1], the next
// contact's lead from a tap issued now in frames, bins 0..44 + none, on the tap clock: loop time + ~21 ms, no capture
// lag to take off); a head without it (fewer outputs) leaves the cadence off (result cadence.off says why).
// G = sum of lead1f bins CAD_LO..CAD_HI. exeAt = the game's last executed 卸势 as we believe it: on every 卸势 touch (any
// source) exeAt = now when now - exeAt >= CAD_LOCK_MS or an ok came since exeAt, else the touch is swallowed by the
// game's lock. lockEnd = an ok since exeAt ? 0 : exeAt + CAD_LOCK_MS. Each frame (before executePlan) a 卸势 goes when
// G >= th, now >= lockEnd + CAD_PAD_MS, PARRY_CD_MS since the last 卸势, not in stagger / potion hold / dodge / a 气竭
// window, no dodge item due within CAD_DODGE_MS, no potion item waiting, and no urgent drink yield (up to CAD_YIELD_MS
// per urgent spell). With it on, syncK (fut items, branches, re-presses, relock waits), expire's re-presses, the hit
// escape and the post-hit insurance 卸势 are off; tell / flare dodges, the potion (its quiet test is G < th), the offense
// (starts only with G < th: a 卸势 lets a held 蓄力 go), 处决 and the red-line anchor (it waits out the same lock) stay.
const CAD_OFF = 133, CAD_N = 46, CAD_LO = 2, CAD_HI = 16;
const CAD_LOCK_MS = PARRY_RELOCK_MS, CAD_PAD_MS = 15, CAD_DODGE_MS = 100, CAD_YIELD_MS = 600;
const CAD_GAP_EDGES = [330, 345, 360, 380, 450, 600, 1000]; // the result's gap histogram (ms)
// phase 2 气竭: in 4 of 9 windows the boss stood staggered at mid / far range and 处决 (shown only within reach) never
// came. With phase 2, QP2_WALK_AFTER_MS after the qiPlan candidate (真气 read empty) with no 处决 button, walk forward
// (lock-on keeps the camera on the boss) in QP_CHASE_MS pushes until the button shows, at most QP2_WALK_MAX_MS per
// 真气-empty spell; the button is then looked for every frame. After such a walk 处决 goes at the usual
// QP_EXEC_AFTER_MS after its sighting, but no later than QP2_EXEC_BY_MS after the candidate (真气 stayed empty
// ~7.3-8 s in the windows without 处决). @see qpApproach
const QP2_WALK_AFTER_MS = 300, QP2_WALK_MAX_MS = 4000, QP2_EXEC_BY_MS = 6000;
// args.head swaps the head model (default MODEL, MODEL_P2 with phase 2), e.g. "dufu/unified_head_p2e.onnx" (same IO / slices).
// run length: the loop ends this long before the call's timeout (meta.timeout or --timeout), so a long ms ends as
// "time" with its result (and the trace's last chunk) instead of being killed. The default 600 s run under the 660 s
// meta.timeout is not clipped.
const END_MARGIN_MS = 15_000;
// trace (args.trace: true = aux, "feat" = aux + the 192-d feature), for training a new (phase-2) head offline. One row
// per backbone frame: [wall ms - start (Date.now() of the frame's loop), stream seq, capture ms - start (img.time -
// img.age_ms; -1 unknown), the 15 aux columns rounded to 3 decimals (as fed to the ring), ("feat": the feature as
// float16 little-endian, base64, 512 chars)]. Transport: event(TRACE_EVENT, {start, phase, chunk, cols, rows}) every
// TRACE_CHUNK rows and the rest when the loop ends. Why events (the move.js "goto" / live_run.py pattern, no app change):
//   - the result value comes back only on a clean return (a teacher stop / timeout / error returns no value) and goes
//     to stdout of `maalow do skill` (MBs into the caller's context); the event log keeps every chunk sent before a stop;
//   - log() lines are capped at the run's last 200 (SkillRun.MAX_LOGS), so log chunks would be lost;
//   - events: in memory (last 1000) for GET /api/v1/events?since=ID&type=skill_event, and in events.jsonl on the device
//     (trimmed to the last 1000 past 4000 lines); a skill event's data has no size cap.
// Size: aux rows ~90 bytes -> ~1.6 MB / 120 events per 10 min (~28 rows/s); "feat" adds 512 chars/row -> ~10 MB. The
// last chunk is lost on a stop (event() throws then). Fetch right after the run (other events push old ones out):
//   uv run python -c "import json; from maalow.client import Client; ev=[e for e in Client().get('/events?since=0&type=skill_event') if e.get('name')=='dufu_trace']; json.dump(ev, open('trace.json','w'))"
const TRACE_EVENT = "dufu_trace", TRACE_CHUNK = 150;
const TRACE_COLS = ["wall", "seq", "cap", "dt", "since_parry", "since_dodge", "since_potion", "since_walk", "pressed", "since_ok",
    "hp", "qi", "boss", "lit", "mean", "dark3", "flare", "boss_up"];

// potion (2.3 patch): a tap within 500 ms of our 卸势, or ~0.6 s after a blow, is ignored; a 卸势 or a blow in the
// first ~0.7 s cancels the drink. So the drink waits for a quiet moment (POTION_QUIET_MS after a hit, POTION_GAP_MS
// after our own touch, no plan item within POTION_PLAN_MS, fut1 1-40 f mass < POTION_MASS_TH, no tell / curtain; at hp
// <= POTION_URGENT or waiting POTION_WAIT_MAX_MS only the touch gap and POTION_URGENT_QUIET_MS stay) and counts only once
// hp is up POTION_HEAL within POTION_CONFIRM_MS (a blow ends the wait; a heal still showing then counts late), else it
// is tapped again POTION_RETRY_MS later (POTION_MAX_TAPS at most). The bar fills over ~0.5 s: no tap POTION_SETTLE_MS
// after a heal.
const POTION_HP = 0.35, POTION_URGENT = 0.15, POTION_HOLD_MS = 2000, POTION_YIELD_MS = 150, POTION_MAX_TAPS = 8;
const POTION_QUIET_MS = 1200, POTION_GAP_MS = 550, POTION_PLAN_MS = 1200, POTION_MASS_TH = 0.3, POTION_MASS_BINS = 9;
const POTION_HEAL = 0.08, POTION_CONFIRM_MS = 2000, POTION_RETRY_MS = 600, POTION_URGENT_QUIET_MS = 900;
const POTION_SETTLE_MS = 2500, POTION_WAIT_MAX_MS = 2500;

// offense. The offense finger is contact OFF_CONTACT (0 stick, 1 parry / tap, 2 dodge), lifted by offUp, never by
// upDue; every defense touch lets a held 蓄力 go first (a finger still down restarts it).
// m30 / m40 / m60: fut1 mass of a contact within 1-30 / 1-40 / 1-60 f.
// The near gate: an ok within OFF_OK_MS or the boss bar down >= OFF_DROP_PX within OFF_DROP_WIN_MS (damage 0-5 s after
//   an ok took boss px 95%, later 32%), m30 <= OFF_GATE_VETO_TH, no combo veto, not in curtain / dodge / stagger /
//   potion / OFF_OK_AFTER_HIT_MS after a hit / OFF_AFTER_TELL_MS after a tell. In it: hot 蓄力 (热血难凉; a switch to
//   陌刀 only for that), else back to 横刀; 唤千军 on a fresh ok while still 陌刀; 横刀 轻蓄力 (held 轻击) as the filler.
//   A 蓄力 starts only with m60 < OFF_CHARGE_FREE (a 卸势 0-500 ms after the release leaves 0 damage). No cold 蓄力:
//   our own 卸势 cut most of them (teacher, 2026-10-23). Each action needs its own horizon: fut1 mass of the contacts before it can be cut < OFF_VETO_TH and no
//   plan item within its no-cancel time + OFF_ABORT_MS. OFF_WHIFF_FAR actions in a row without boss px = far.
// The committed 横刀 set (combat.js hengdaoPart: switch -> 突进 -> 爆发 -> 突进 -> 伤害) starts in the open gate with
//   爆发 cool (爆发 can slip a blow, so no horizon check) and plays through, waiting only for the defense's own states; a 金光 / curtain tell (outside 爆发's 2.4 s)
//   gives it up. No switch back (the next 蓄力 switches).
// Far (no ok for OFF_NEAR_OK_MS and no drop for OFF_NEAR_DROP_MS, or the whiffs) for OFF_FAR_MS: one close-in (燃此魂 /
//   横刀 突进 when lit, else a forward push). 燃此魂 is ended RANSHI_END_MS later by a second tap on its button (unless a
//   卸势 / dodge / blow cut it first); the offense waits for that.
// 气竭: 真气 read empty twice AND the 处决 button seen (it can show first). From its first sighting: 轻击 every
//   QP_LIGHT_MS until QP_EXEC_AFTER_MS, then 处决 when seen (the unpressed plan items go, the boss strikes nothing);
//   a button gone for QP_LOST_MS walks us in and is tapped as soon as it shows again; 轻击 until 真气 is back.
// 奇术 (箫吟千浪) only in the opening before any contact and at a 气竭 window's start (the boss strikes nothing there;
//   after an ok its long recovery ate blows, 轻蓄力 / the follow-up pay better, teacher 2026-10-23); a 卸势 cuts it only after
//   ~2 s, so the horizon must be clear that long. Out only once the cooldown shows; else retried.
// The 横刀 ok follow-up: a 横刀 ok turns 重击 into the blue 爆发 disc for ~3 s; tap it FOLLOW_DELAY_MS after the ok
//   (sooner is swallowed); the rest of the offense waits for it meanwhile.
// The run ends at the 成功 page (deadCheck) or 阶段二 in the quest line (phase 1 only).
const OFF_CONTACT = 3, OFF_TAP_MS = 40;
const OFF_QUIET_BINS = 8, OFF_STRONG_BINS = 9;
const OFF_GUARD_MS = 600, OFF_ABORT_MS = 150, OFF_AFTER_TELL_MS = 1500;
const OFF_OK_MS = 3000, OFF_VETO_TH = 0.3, OFF_GATE_VETO_TH = 0.45, OFF_CHARGE_FREE = 0.7;
const OFF_DROP_PX = 1.5, OFF_DROP_WIN_MS = 1200, OFF_DROP_MAX_PX = 80, OFF_BOSS_RING_MS = 4000, OFF_OK_AFTER_HIT_MS = 700;
const OFF_NEAR_OK_MS = 5000, OFF_NEAR_DROP_MS = 3000, OFF_WHIFF_FAR = 2, OFF_FAR_MS = 8000, OFF_FAR_PUSH_MS = 450;
const HLIGHT_HOLD_MS = 800; // 横刀 轻击 held: 轻蓄力, out on the lift (the ring fills 0.4-0.75 s; probe 2026-10-23)
const RANSHI_END_MS = 2500; // 燃此魂 runs on until its button is tapped again (ends it with a slash; teacher, 2026-10-23)
const OFF_HOT_HOLD_MS = 1800;
const OFF_SWITCH_PEND_MS = 1500, OFF_FRESH_OK_MS = 1500, OFF_COMMIT_PAUSE_MS = 3000, OFF_SKILL_PAUSE_MS = 2500;
const OFF_SLASH_MS = 500, OFF_EVAL_MS = 1200, OFF_SET_RETRY_MS = 5000;
// how long after an action starts a 卸势 cannot cut it (E0 dummy test, 2026-10-16)
/** @type {Record<string, number>} */
const OFF_NO_CANCEL_MS = { light: 0, hlight: 0, buff: 2000, switch: 400, dash: 0, burst: 2400, strike: 300, ranshi: 800, charge: 0 };
/** @type {Record<string, number>} */ // press + animation (combat.js BUFF_COST_MS / SWITCH_COST_MS / WEAK_SWITCH_MS)
const OFF_COST_MS = { light: 300, buff: 700, switch: 400, dash: 800, strike: 700, ranshi: 600, burst: 2400, follow: 900 };
const OFF_ICON_EVERY = 250, OFF_ICON_TH = 0.7;
const BURST_CD_MS = 20_000, HOT_MS = 13_000, BURST_TAP_MS = 350, BURST_TAPS = 4; // combat.js
const DASH_GONE_MS = 600, DASH_AFTER_BURST_MS = 2000, DASH_BACK_MS = 3000, STRIKE_WAIT_MS = 3500, SWITCH_WAIT_MS = 1000, GLOW_MS = 200;
const QP_EXEC_AFTER_MS = 2600, QP_EXEC_MAX_MS = 2900, QP_LIGHT_MS = 300, QP_POST_MS = 3500, QP_PENDING_MS = 300;
const QP_EXEC_SCENE_MS = 1100, QP_EXEC_TAP_MS = 50, QP_MAX_MS = 9000, QP_CAND_MS = 8000, QP_EXEC_QI_MAX = 25;
const QP_LOST_MS = 300, QP_CHASE_MS = 500, QI_EXEC_EVERY = 3;
/** @type {Box} */ const EXEC_ROI = [815, 391, 75, 75];
const EXEC_TH = 0.7;
const QS_OPEN_MS = 15_000, QS_RETRY_MS = 3000, QS_EVAL_MS = 7000, QS_NO_CANCEL_MS = 2000, QS_TH = 0.1;
const QS_CONFIRM_MS = 1000, QS_LIT_AGAIN_MS = 350, QS_RETRY_SOON_MS = 300, QS_COOL_WHITE = 70, QS_COOL_DARK = 600, QS_LIT_PX = 30;
/** @type {ColorOptions} */ const QS_DARK = { lower: [0, 0, 0], upper: [180, 255, 34], method: 40 };
const PF_DELAY_MS = 400, PF_NO_CANCEL_MS = 600, PF_TH = 0.3, PF_WINDOW_MS = 3000, PF_COST_MS = 900, PF_RETRY_MS = 350, PF_TRIES = 3;
const PF_HOLD_EXTRA_MS = 400, PF_DISC_WAIT_MS = 400;
/** @type {Box} */ const MDASH_LIT_ROI = [815, 575, 36, 36]; // 陌刀 突进's icon: white px, 107-111 lit, 0 grey (combat.js)
const MDASH_LIT_PX = 40;
/** @type {Record<string, [string, Box]>} combat.js T */
const OFF_T = {
    modao: ["combat/modao_charge.png", [988, 446, 64, 68]],
    hengdao: ["combat/hengdao_heavy.png", [988, 446, 64, 68]],
    swirl: ["combat/hengdao_swirl.png", [988, 446, 64, 68]],
    dash: ["combat/hengdao_dash.png", [801, 561, 64, 64]],
    damage: ["combat/hengdao_damage.png", [801, 561, 64, 64]],
    strike: ["combat/hengdao_strike.png", [801, 561, 64, 64]],
    mdash: ["combat/modao_dash.png", [801, 561, 64, 64]],
    burst: ["combat/hengdao_burst.png", [793, 635, 64, 64]],
    buff: ["combat/modao_buff.png", [793, 635, 64, 64]],
    qishu: ["combat/qishu_ready.png", [848, 493, 64, 64]],
};
const CLR_EVERY_MS = 400; // phase 1 only: in the 阶段二 arena the quest line reads 阶段二 from the start
const QUEST_WHITE = { lower: [0, 0, 190], upper: [180, 70, 255], method: 40 };
/** @type {Box} */ const PHASE2_TOP = [222, 140, 12, 4]; // 二: >= 8 px
/** @type {Box} */ const PHASE2_BOTTOM = [220, 147, 16, 4]; // >= 10 px
/** @type {Box} */ const PHASE1_MID = [220, 144, 16, 3]; // 一: <= 2 px

// 重伤 (dead): the grey screen with both bars gone, or the 再次训练 panel (combat.js)
/** @type {Box} */ const GREY_ROI = [100, 100, 880, 500];
const GREY = { lower: [0, 0, 0], upper: [180, 30, 255], method: 40 };
/** @type {Box} */ const RETRY_ROI = [945, 668, 95, 24];
const RETRY_WHITE = { lower: [0, 0, 170], upper: [180, 60, 255], method: 40 };
const DEAD_MS = 500;
const BOSS_GONE_MS = 10_000; // phase 2: no boss bar this long after it showed = the arena restarted (@see deadCheck)
// phase one cleared (2.3): the 成功 page (「成功」 + 再次演练 (868,679) / 演练下一阶段 (993,679)). 演练下一阶段 is a white
// button inside RETRY_ROI and the page is grey enough for GREY, so deadCheck looks for it first. Both templates score
// >= 0.997 on the page, <= 0.30 on the 重伤 page and <= 0.70 elsewhere in 26 recordings: both must match, on two checks
// in a row. The buttons show ~6 frames before 「成功」 fades in: 再次演练 alone already holds off 重伤.
/** @type {[string, Box][]} */ const WON_T = [["result_drill_again.png", [800, 650, 140, 60]], ["result_success.png", [440, 110, 200, 100]]];
const WON_TH = 0.8;
const HALT_ON_FRAMES = 2, HALT_OFF_FRAMES = 3; // @see haltCheck
/** @type {Box} */ const PAGE_BTNS = [868, 640, 212, 60]; // 再次演练 / 演练下一阶段 (and LOCK, DODGE under them)
// lock-on (combat.js): the arena auto-locks at the fight start, the game drops the lock at the phase change (~80-90 s
// in) and the camera then stops tracking: re-tap the lock button whenever its gold icon is gone.
/** @type {Point} */ const LOCK = [1021, 667];
/** @type {Box} */ const LOCK_ROI = [1004, 648, 34, 39];
const GOLD = { lower: [200, 180, 100], upper: [255, 245, 200] };
const LOCK_MS = 2000; // between re-lock taps
// round start: walk in (short bursts, never blocking) until the boss bar shows
const APPROACH_MS = 30_000, APPROACH_CYCLE = 1200, APPROACH_ON = 500;
// round start prep (@see prep): the item slot opens a column above it; the pick swaps with the slot's item
/** @type {Point} */ const ITEM_OPEN = [700, 633];
/** @type {Point} */ const ITEM_PICK = [702, 575];
const PREP_MENU_MS = 600, PREP_USE_MS = 1500, PREP_SWAP_TRIES = 3;
// the slot's item: the potion jar is white (26 px), the poison purple (0)
/** @type {Box} */ const SLOT_ROI = [683, 650, 35, 30];
const SLOT_POTION_PX = 10;

/** @typedef {{probs: number[], arg: number, p: number, label: string}} HeadOut */
/** @typedef {{combo: HeadOut, stage: HeadOut, fut: number[][], def: number[][], tell: HeadOut}} Pred */
/** @typedef {{kind: "parry"|"dodge"|"potion"|"avoid", dir: string, k: number, src: "fut"|"tell"|"potion"|"insure"|"red", atMs: number, cMs: number, untilMs: number, branch: boolean, t1Ms: number, pressedAt: number, committed: boolean, why: string, held?: boolean, repressed?: boolean, rearms?: number, relocked?: boolean, jit?: number, onMs?: number, floorMs?: number}} PlanItem */

/**
 * @param {{ms?: number, potions?: number, prep?: boolean, phase?: number, trace?: boolean | "feat", head?: string, defDodgeP?: number, redLine?: boolean | number, cadence?: number}} [args] ms: run length
 *     (default 10 min; clipped to the call's timeout less END_MARGIN_MS); potions: drinks allowed (default 1); prep: poison
 *     + buffs at the start (default on; the scheduler test turns it off); phase: 1 (default) or 2, the arena's 阶段
 *     (@see defAction, clearedCheck); trace: per-frame trace events (@see TRACE_EVENT); head: the head model (default
 *     MODEL; same IO as unified_head9s, e.g. the phase-2 "dufu/unified_head_p2.onnx"); defDodgeP: phase 2 only, a def-head
 *     contact with P(dodge) >= this is dodged instead of 卸势 (default: never; @see defAction); cadence: phase 2 only,
 *     the 节拍 卸势's gate threshold (e.g. 0.05 / 0.1 / 0.15; needs a head with lead1f; @see CAD_OFF)
 */
export default function (args = {}) {
    const maxPotions = args.potions ?? 1;
    const phase = args.phase === 2 ? 2 : 1;
    const headModel = args.head ?? (phase === 2 ? MODEL_P2 : MODEL);
    // args.parryJitter [lo, hi] (frames, exploration, default off): each fut item draws an integer offset in [lo, hi]
    // once and is pressed that much earlier (+) / later (-) than ISSUE_LEAD_MS, re-arms included; the press mark
    // carries it ("jit+3f") for the offline timing study of the phase-2 big red moves (teacher: 卸势 at their own time)
    const jitter = Array.isArray(args.parryJitter) ? args.parryJitter : null;
    // phase 2 timing (data/tmp/p2timing, 89 rounds): a 卸势 lands 3-9 f before the contact (ok .82-.97), 11-13 f only
    // .45, >= 16 f ~0; 42% of the last presses were >= 10 f early. args.leadF (phase 2): the fut items' target lead in
    // frames (default ISSUE_LEAD_MS = 14). args.secondTapF (phase 2): a fut 卸势 with no ok / hit after it is pressed
    // once more this many frames after its press while the head still shows a contact (a late-landing blow; +12..14 f
    // puts 56-66% of them in the window), once per item.
    const FUT_LEAD_MS = phase === 2 && typeof args.leadF === "number" ? Math.round(args.leadF * FRAME_MS) : ISSUE_LEAD_MS;
    const secondTapF = phase === 2 && typeof args.secondTapF === "number" ? args.secondTapF : 0;
    /** @returns {number} */
    const drawJit = () => (jitter ? jitter[0] + Math.floor(Math.random() * (jitter[1] - jitter[0] + 1)) : 0);
    /** The press lead of a fut item. @param {PlanItem | {jit?: number}} it */
    const leadOf = (it) => FUT_LEAD_MS + (it.jit ?? 0) * FRAME_MS;
    const defDodgeP = phase === 2 && typeof args.defDodgeP === "number" ? args.defDodgeP : null; // @see defAction
    // args.flare2 true: phase 2 dodges a flare tell at its first report (flare2Tick); off by default: A/B r078-r093 8 vs 8
    // rounds, hits/min 9.9 vs 10.05, median life 109 vs 119 s (no difference), so phase 1 anchored dodges stay
    const flare2On = phase === 2 && (args.flare2 ?? false); // @see flare2Tick
    const curtainOn = phase !== 2; // phase two has no curtain (the note above END_MARGIN_MS)
    // args.redLine (phase 2, default off): the red-line 卸势 anchor; true = onset + RL_DELAY_F, a number = that many frames
    const redLineF = phase === 2 && args.redLine ? (typeof args.redLine === "number" ? args.redLine : RL_DELAY_F) : 0;
    // args.cadence (phase 2, default off): the 节拍 卸势's gate threshold; on once the first head output has lead1f
    const cadTh = phase === 2 && typeof args.cadence === "number" && args.cadence > 0 ? args.cadence : 0;

    const start = Date.now();
    const untilMs = Math.min(args.ms ?? 600_000, remaining() - END_MARGIN_MS);
    const until = start + untilMs;
    /** @type {[number, number, string, string][]} */
    const events = [];
    /** @param {string} kind @param {string} [detail] */
    function mark(kind, detail = "") {
        const t = Date.now();
        events.push([t, t - start, kind, detail]);
        log(`@${t} +${t - start} ${kind}${detail ? " " + detail : ""}`);
    }

    /** @type {{back: number[], head: number[], reads: number[], loop: number[]}} */
    const tMs = { back: [], head: [], reads: [], loop: [] };
    /** @template T @param {"back"|"head"|"reads"|"loop"} name @param {() => T} fn @returns {T} */
    function timed(name, fn) {
        const t0 = Date.now();
        try {
            return fn();
        } finally {
            tMs[name].push(Date.now() - t0);
        }
    }

    // touches (combat.js): a tap puts the finger down and returns; the lift comes when due, from the frame wait
    let upDue = /** @type {{c: number, at: number} | null} */ (null);
    function releaseDue(wait = false) {
        if (!upDue) return;
        const left = upDue.at - Date.now();
        if (left > 0) {
            if (!wait) return;
            sleep(left);
        }
        const c = upDue.c;
        upDue = null;
        touch.up(c);
    }
    /** @param {number | undefined} c */
    const releaseFor = (c) => {
        if (upDue && upDue.c === (c ?? 0)) releaseDue(true);
    };
    // halt (@see haltCheck): a 成功 page template on screen — no finger goes down (lock-on, defense, offense, walking)
    // until the templates are gone again or deadCheck ends the run. Ups still go. Apart from that, no down / move
    // lands on the page's buttons (PAGE_BTNS) while either template hits this frame.
    let halt = false, haltDowns = 0, pageHeld = 0;
    /** @param {Target} p */
    const onPage = (p) => Array.isArray(p) && p[0] >= PAGE_BTNS[0] && p[0] <= PAGE_BTNS[0] + PAGE_BTNS[2] &&
        p[1] >= PAGE_BTNS[1] && p[1] <= PAGE_BTNS[1] + PAGE_BTNS[3] && wonAny();
    /** @param {Target} p */
    const heldBack = (p) => (halt ? (haltDowns++, true) : onPage(p) ? (pageHeld++, true) : false);
    /** @param {Target} p @param {number | undefined} c */
    const tdown = (p, c) => (heldBack(p) ? undefined : (releaseFor(c), touch.down(p, c)));
    /** @param {Target} p @param {number | undefined} c */
    const tmove = (p, c) => (halt || onPage(p) ? undefined : (releaseFor(c), touch.move(p, c)));
    /** @param {number | undefined} c */
    const tup = (c) => (releaseFor(c), touch.up(c));
    /** Tap p (contact 1) for ms; the lift is deferred (fastTap). @param {Point} p @param {number} [ms] */
    function tap(p, ms = 50) {
        if (heldBack(p)) return;
        offYield("tap");
        if (cadTh && p === PARRY) cadTouch(Date.now());
        tdown(p, 1);
        upDue = { c: 1, at: Date.now() + ms };
    }
    const shot = () => screenshot();
    const frameSeq = () => frame().seq;

    // reads
    let img = shot();
    let loopSeq = -1;
    /** @type {Map<string, [number, any]>} */
    const memo = new Map();
    /** fn() on img, once per frame. @template T @param {string} key @param {(im: Image) => T} fn @returns {T} */
    function perFrame(key, fn) {
        const im = img;
        const m = memo.get(key);
        if (m && m[0] === im.seq) return m[1];
        const v = fn(im);
        memo.set(key, [im.seq, v]);
        return v;
    }
    const hpRead = () => perFrame("hp", health);
    const qiRead = () => perFrame("qi", readQi);
    const litRead = () => perFrame("lit", litNow);
    const bossRead = () => perFrame("boss", bossPx);

    // state
    /** @type {{f: number[], aux: number[], t: number}[]} */
    const ring = [];
    let lastEntryT = 0; // when the last ring entry was processed
    let frameIdx = 0; // the sequence number the entry being built gets
    /** @type {number[]} */
    const pressIdx = []; // frame indices (frameIdx space) a button press was issued at
    let lastParryAt = 0, lastDodgeAt = 0, lastPotionAt = 0, lastWalkAt = 0;
    let lastOkAt = 0, lastHitAt = 0;
    let staggerUntil = 0, potionHoldUntil = 0;
    /** @type {number | null} */
    let hpNow = null;
    // The confirmed injury baseline: `hpNow` is the latest read (display, potion), `hpBase` only follows a drop or an
    // explained heal. A low-HP grey-bar overread (21% on a 17% red bar) raised `hpNow`, and the next 17% read looked
    // like a fresh blow (737: seven hits for one drop). @see feedback
    /** @type {number | null} */
    let hpBase = null;
    let qiNow = -1, litPx = 0, bossNow = 0, meanNow = -1, dark3 = 0, flare = 0, qiEmpty = 0;
    /** @type {number[]} */
    const meanRing = [];
    // potion: the tap waiting for its heal, counts, the last offense touch
    let potionsUsed = 0;
    /** @type {{at: number, hp0: number} | null} */
    let potionPend = null;
    /** @type {{at: number, hp0: number} | null} */
    let potionLate = null;
    let potionTaps = 0, lastPotionOkAt = 0, lastPotionFailAt = 0, lastPotionWaitMark = 0, lastOffDownAt = 0;
    const potS = { oks: 0, fails: 0, healMs: /** @type {number[]} */ ([]), gains: /** @type {number[]} */ ([]),
                   failWhy: /** @type {Record<string, number>} */ ({}), waitWhy: /** @type {Record<string, number>} */ ({}),
                   waitMs: /** @type {number[]} */ ([]), lateOks: 0 };
    let potionDueAt = 0; // the first frame the drink was due (wait time = due -> tap)
    let dodgeSeq = 0, inDodge = false, stickSide = 0;
    let inCurtain = false, curtainLastAt = 0, curtainFirstAt = 0, curtainDodged = false, curtainDodgeAt = 0, lastFlareDodgeAt = 0;
    let curtainDarkSeen = 0; // consecutive tell-dark frames at the cover onset
    let lastAvoidDropAt = 0; // an "avoid" (curtain) item just handled: no new one for a moment
    let lastTellArg = -1, lastTellDodgeArg = -1, lastTellDodgeAt = 0; // tell continuity + one dodge per episode
    let flareLastFireAt = 0, flareFirstAt = 0, flareLastArg = -1; // the current flare episode's onset
    let flareSeenAt = 0; // the image flare rule's last hit
    let sweepAt = 0, sweepK = 1, sweepSrc = "", lastDarkAt = 0, timedSweeps = 0; // the timed sweep dodges
    // the hit chain: the pending escape, the last 卸势's believed contact / plan press, counts
    /** @type {{hitAt: number, at: number} | null} */
    let esc = null;
    let lastParryC = 0, lastItemParryAt = 0;
    const hcS = {
        stagger: /** @type {Record<string, number>} */ ({}),
        esc: { scheduled: 0, parry: 0, yieldPlan: 0, superseded: 0, late: 0, skip: /** @type {Record<string, number>} */ ({}) },
        relock: { delayed: 0, pressed: 0, gaveUp: 0, bySrc: /** @type {Record<string, number>} */ ({}) },
    };
    // the cadence 卸势 (@see CAD_OFF): on / why off, the gate value, the believed executed 卸势, the drink yield, stats
    let cadOn = false, cadG = 0, exeAt = 0, cadLastTouch = 0, cadYieldFrom = 0, cadPressAt = 0;
    /** @type {boolean | null} */ let cadHas = null; // the head has the lead1f block (null = no output yet)
    const cadS = { off: "", presses: 0, touches: 0, swallowed: 0, frames: 0, openFrames: 0, yields: 0,
                   wait: /** @type {Record<string, number>} */ ({}), gapHist: /** @type {Record<string, number>} */ ({}), gaps: /** @type {number[]} */ ([]) };
    const cadGate = () => cadOn && cadG >= cadTh; // a cadence 卸势 may come any frame: no offense start / no drink
    const cadLockEnd = () => (lastOkAt > exeAt ? 0 : exeAt + CAD_LOCK_MS);
    /** A 卸势 touch (any source): the game executes it unless inside the lock of the last executed one. @param {number} t */
    function cadTouch(t) {
        if (!cadOn) return;
        cadS.touches++;
        if (cadLastTouch) {
            const g = t - cadLastTouch;
            cadS.gaps.push(g);
            const i = CAD_GAP_EDGES.findIndex((e) => g < e);
            const k = i < 0 ? `>=${CAD_GAP_EDGES[CAD_GAP_EDGES.length - 1]}` : i === 0 ? `<${CAD_GAP_EDGES[0]}` : `${CAD_GAP_EDGES[i - 1]}-${CAD_GAP_EDGES[i]}`;
            cadS.gapHist[k] = (cadS.gapHist[k] ?? 0) + 1;
        }
        cadLastTouch = t;
        if (!exeAt || t - exeAt >= CAD_LOCK_MS || lastOkAt > exeAt) exeAt = t;
        else cadS.swallowed++;
    }
    // flareHold: the hold's start (0 = off), the last flare_other report, the episode's anchored item
    let foFrom = 0, foLastAt = 0;
    /** @type {PlanItem | null} */
    let foItem = null;
    /** @type {Set<PlanItem>} */
    const foHeld = new Set();
    /** @type {{holds: number, blockedItems: number, blockedFrames: number, anchorPlans: number, anchorPressed: number, heldPressedAfter: number, ends: Record<string, number>, pressMsAfterFirst: number[]}} */
    const foS = { holds: 0, blockedItems: 0, blockedFrames: 0, anchorPlans: 0, anchorPressed: 0, heldPressedAfter: 0, ends: {}, pressMsAfterFirst: [] };
    /** @param {string} why */
    function foEnd(why) {
        if (!foFrom) return;
        foS.ends[why] = (foS.ends[why] ?? 0) + 1;
        mark("flarehold", `end (${why}) +${Math.round((Date.now() - foFrom) / FRAME_MS)}f, ${foHeld.size} fut dodge held`);
        foFrom = 0;
        foItem = null;
        foHeld.clear();
    }
    /** Per frame after tellPlan: end the hold when its episode is over. @param {number} now */
    function foTick(now) {
        if (!foFrom) return;
        if (now - foFrom > FLARE_HOLD_F * FRAME_MS) foEnd("timeout");
        else if (foItem && !foItem.pressedAt && !plan.includes(foItem)) foEnd("anchor dropped");
        else if (!foItem && now - foLastAt > FLARE_HOLD_GAP_F * FRAME_MS) foEnd("episode over");
    }
    // flareSplit: the current flare_other episode's first report (0 = none), its verdict, its anchored item
    let fsFrom = 0;
    /** @type {boolean | null} */
    let fsFast = null;
    /** @type {PlanItem | null} */
    let fsItem = null;
    const fsS = { fast: 0, slow: 0, moved: 0, holdEnds: 0 };
    /** Per tell output: judge the episode fast / slow FLARE_SPLIT_F frames after its first report. @param {number} now */
    function fsTick(now) {
        if (!fsFrom || fsFast !== null) return;
        if (now - fsFrom > FLARE_HOLD_F * FRAME_MS) {
            fsFrom = 0;
            return;
        }
        if (now - fsFrom < FLARE_SPLIT_F * FRAME_MS - 10) return;
        let near = 0;
        for (let i = 1; i <= 4; i++) near += futBin(0, i);
        fsFast = near >= FLARE_SPLIT_TH;
        fsS[fsFast ? "fast" : "slow"]++;
        mark("flaresplit", `${fsFast ? "fast" : "slow"} (fut1 4-15f ${near.toFixed(2)} at +${Math.round((now - fsFrom) / FRAME_MS)}f)`);
        if (!fsFast) return;
        if (foFrom) {
            fsS.holdEnds++;
            foEnd("split fast");
        }
        if (fsItem && !fsItem.pressedAt && plan.includes(fsItem)) {
            const at = Math.max(now, fsFrom + FLARE_FAST_ANCHOR * FRAME_MS);
            fsItem.atMs = at;
            fsItem.untilMs = Math.max(fsItem.cMs, at) + MISS_GRACE_MS;
            fsItem.why += " split fast";
            fsS.moved++;
        }
    }

    /** @type {Pred | null} */
    let pred = null;
    /** @type {PlanItem[]} */
    let plan = [];
    let headCalls = 0, ready = 0, looks = 0, reason = "time";
    let hits = 0, oks = 0, misses = 0, late = 0, revisions = 0, branches = 0, branchDrops = 0;
    let holds = 0, holdPresses = 0, insurePresses = 0, pressedSinceHit = false, rerepresses = 0;
    const presses = { parry: 0, dodge: 0, potion: 0, walk: 0 };
    /** @type {Record<string, number>} */
    const blocked = {};
    /** @type {Record<string, number>} */
    const skips = {};
    /** @type {Record<string, number>} */
    const slowMarkAt = {};

    /** @param {number} at */
    const pressFrame = (at) => {
        pressIdx.push(at);
        if (pressIdx.length > 16) pressIdx.shift();
    };
    /** @param {number} at */
    const sinceU = (at) => (at ? Math.min(10, (Date.now() - at) / FRAME_MS / 3) : 10);

    // --- prediction decoding (lib/dufu-math.js)
    /** @param {number[]} out */
    function decode(out) {
        pred = {
            combo: headOut(softmax(out, 0, 16), COMBO6_LABELS),
            stage: headOut(softmax(out, 16, 6), STAGE_LABELS),
            fut: [0, 1, 2].map((i) => softmax(out, 22 + i * 11, 11)),
            def: [0, 1, 2].map((i) => softmax(out, 55 + i * 5, 5)),
            tell: headOut(softmax(out, 70, 7), TELL_LABELS),
        };
        if (!cadTh) return;
        if (cadHas === null) {
            cadHas = out.length >= CAD_OFF + CAD_N;
            cadOn = cadHas;
            if (!cadHas) cadS.off = `${headModel}: ${out.length} outputs, no lead1f at ${CAD_OFF}..${CAD_OFF + CAD_N - 1}`;
            else {
                esc = null; // a hit before the first output (the ring filling) planned the old chain
                plan = plan.filter((x) => x.src !== "insure");
            }
            mark("cadence", cadOn ? `on: G (lead1f ${CAD_LO}-${CAD_HI}f) >= ${cadTh}` : `off (${cadS.off})`);
        }
        if (!cadOn) return;
        const p = softmax(out, CAD_OFF, CAD_N);
        let g = 0;
        for (let b = CAD_LO; b <= CAD_HI; b++) g += p[b];
        cadG = g;
        cadS.frames++;
        if (g >= cadTh) cadS.openFrames++;
    }
    const seqData = () => {
        const pad = T - ring.length;
        /** @type {number[]} */
        const data = [];
        for (let i = 0; i < T; i++) {
            const e = i < pad ? ring[0] : ring[i - pad];
            for (const v of e.f) data.push(v);
            for (const v of e.aux) data.push(v);
        }
        return data;
    };
    // The device assembles the head's seq from its own feature ring; check its numbers against ours. The app stores
    // and feeds float32, so our values are rounded the same way before summing (same order, oldest first). Soft check
    // only: a mismatch logs (first 10, then every 100th) and counts, it never throws.
    let ringBad = 0, ringChecks = 0;
    /** @param {Inference} h */
    function checkRing(h) {
        ringChecks++;
        const len = h.ring ? h.ring.len : -1;
        let bad = len !== ring.length;
        // the full sum costs a seqData() build: the first calls, then sparsely (the length check stays every call)
        if (!bad && (ringChecks <= 3 || ringChecks % 60 === 0)) {
            const data = seqData();
            let sum = 0;
            for (const v of data) sum += Math.fround(v);
            const dev = h.ring ? h.ring.sum : NaN;
            bad = !(Math.abs(dev - sum) <= 1e-6 + 1e-9 * Math.abs(sum));
        }
        if (bad) {
            ringBad++;
            if (ringBad <= 10 || ringBad % 100 === 0) {
                log(`ring mismatch #${ringBad}: len device/own ${len}/${ring.length}`);
            }
        }
    }

    // --- the trace (@see TRACE_EVENT): rows of the frames since the last chunk
    const traceFeat = args.trace === "feat";
    /** @type {(number | string)[][]} */
    let traceRows = [];
    let traceN = 0, traceChunks = 0;
    const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
    /** float32 -> float16 bits (round to nearest; NaN -> inf). @param {number} v */
    function half(v) {
        f32[0] = v;
        const x = u32[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
        if (e >= 31) return sign | 0x7c00;
        if (e <= 0) {
            if (e < -10) return sign;
            const mm = m | 0x800000, sh = 14 - e;
            return sign | ((mm >> sh) + ((mm >> (sh - 1)) & 1));
        }
        return sign | (((e << 10) | (m >> 13)) + ((m >> 12) & 1)); // a carry into the exponent is still right
    }
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    /** The feature as float16 little-endian, base64. @param {number[]} f */
    function featB64(f) {
        /** @type {number[]} */
        const b = [];
        for (const v of f) {
            const h = half(v);
            b.push(h & 0xff, h >> 8);
        }
        let out = "";
        for (let i = 0; i < b.length; i += 3) {
            const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
            out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
        }
        return out;
    }
    /** @param {number} now @param {Image} im @param {number[]} aux @param {number[]} f */
    function traceAdd(now, im, aux, f) {
        /** @type {(number | string)[]} */
        const row = [now - start, im.seq, im.time != null ? Math.round(im.time - (im.age_ms ?? 0)) - start : -1];
        for (const v of aux) row.push(Math.round(v * 1000) / 1000);
        if (traceFeat) row.push(featB64(f));
        traceRows.push(row);
        traceN++;
        if (traceRows.length >= TRACE_CHUNK) traceFlush();
    }
    /** Send the rows so far (after a stop / timeout event() throws: those rows are lost). */
    function traceFlush() {
        if (!traceRows.length) return;
        const rows = traceRows;
        traceRows = [];
        event(TRACE_EVENT, { start, phase, chunk: traceChunks, cols: traceFeat ? [...TRACE_COLS, "feat_f16_b64"] : TRACE_COLS, rows });
        traceChunks++;
    }

    // --- the 15 aux columns, frozen with each frame
    /** @param {number} dtMs @returns {number[]} */
    function buildAux(dtMs) {
        const aux = new Array(A).fill(0);
        aux[0] = Math.min(3, Math.max(0.5, dtMs / FRAME_MS));
        aux[1] = sinceU(lastParryAt);
        aux[2] = sinceU(lastDodgeAt);
        aux[3] = sinceU(lastPotionAt);
        aux[4] = sinceU(lastWalkAt);
        aux[5] = pressIdx.some((i) => i >= frameIdx - 2 && i <= frameIdx) ? 1 : 0;
        aux[6] = sinceU(lastOkAt);
        aux[7] = hpNow == null ? 0 : Math.min(1, Math.max(0, hpNow));
        aux[8] = Math.min(1, Math.max(0, qiNow / 385));
        aux[9] = Math.min(1, Math.max(0, bossNow / BOSS_FULL));
        aux[10] = Math.min(1, litPx / 500);
        aux[11] = Math.min(1, Math.max(0, meanNow / 255));
        aux[12] = dark3;
        aux[13] = flare;
        aux[14] = bossNow > 50 ? 1 : 0;
        return aux;
    }

    // --- the plan
    /** The combo head (the gap to the next segment): the chain continues, a next segment expected. */
    const comboRunning = () => !!pred && pred.combo.arg >= 2 && pred.combo.arg <= 7 && pred.combo.p >= 0.4;
    const comboDropped = () => !!pred && pred.combo.arg <= 1;
    /** @param {number} k @param {number} i */
    const futBin = (k, i) => pred?.fut[k]?.[i] ?? 0;
    /** The defense the k-th contact wants: null on none. @param {number[]} p */
    function defAction(p) {
        let bi = 0;
        for (let i = 1; i < 5; i++) if (p[i] > p[bi]) bi = i;
        if (bi === 0) return null;
        if (bi === 3) return /** @type {"avoid"} */ ("avoid");
        // phase 2 + args.defDodgeP: a contact (parry / dodge class) with P(dodge) >= defDodgeP is dodged (a head trained
        // with --def-from-outcome marks the blows a timely 卸势 did not take, e.g. unified_head_p2d.onnx)
        if (phase === 2 && defDodgeP != null && (bi === 1 || bi === 2) && (p[2] ?? 0) >= defDodgeP) return /** @type {"dodge"} */ ("dodge");
        if (bi === 2 && phase === 2) return /** @type {"parry"} */ ("parry"); // phase 2: a red-light blow, 卸势 (the note above END_MARGIN_MS)
        if (bi === 2) return (p[2] ?? 0) >= DODGE_MIN_P ? /** @type {"dodge"} */ ("dodge") : /** @type {"parry"} */ ("parry");
        return /** @type {"parry"} */ ("parry");
    }
    /** @param {Partial<PlanItem>} o */
    function addItem(o) {
        /** @type {PlanItem} */
        const it = { kind: "parry", dir: "", k: -1, src: "fut", atMs: 0, cMs: 0, untilMs: 0, branch: false, t1Ms: 0, pressedAt: 0, committed: false, why: "", ...o };
        plan.push(it);
        mark("plan", `+ ${it.kind} k${it.k} ${it.src}${it.branch ? " branch" : ""} at+${Math.round(it.atMs - Date.now())}ms c+${Math.round(it.cMs - Date.now())}ms ${it.why}`);
        return it;
    }
    /** @param {PlanItem} it @param {string} why */
    function dropItem(it, why) {
        const i = plan.indexOf(it);
        if (i < 0) return;
        plan.splice(i, 1);
        mark("plan", `- ${it.kind} k${it.k} ${why}`);
    }
    /**
     * Re-arm a pressed fut item for a later contact (same slot, fresh action). A stale pressed item otherwise keeps
     * k0 until it expires, so the new contact gets no plan at all (@see REPRESS_MAX).
     * @param {PlanItem} it @param {PlanItem["kind"]} kind @param {number} cMs @param {string} why
     */
    function rearmItem(it, kind, cMs, why) {
        it.rearms = (it.rearms ?? 0) + 1;
        it.repressed = true;
        it.pressedAt = 0;
        it.kind = kind === "avoid" && !inCurtain ? "parry" : kind;
        it.cMs = cMs;
        it.atMs = cMs - leadOf(it);
        it.untilMs = cMs + MISS_GRACE_MS;
        it.relocked = false;
        it.held = false;
        rerepresses++;
        mark("re-press", `k${it.k} ${it.kind} ${why} (#${it.rearms})`);
    }
    /** Entering the curtain: the planned dodge-type items go (the 卸势 of plain blows stay). @param {string} why */
    function cancelFuture(why) {
        let n = 0;
        for (const it of [...plan]) {
            if (it.src === "fut" && !it.committed && !it.pressedAt && it.kind !== "parry") {
                plan.splice(plan.indexOf(it), 1);
                n++;
            }
        }
        if (n) mark("plan", `- ${n} planned (${why})`);
    }
    /**
     * What the fresh prediction wants for contact k (0-2): null when nothing (no contact / no defense / not
     * resolved); far: too far to plan yet; late: too close to press.
     * @param {number} now @param {number} k
     */
    function targetOf(now, k) {
        const st = futStats(pred?.fut[k] ?? []);
        if (st.none >= 0.65 || st.sum <= 0.01) return null;
        const expMs = st.exp * FRAME_MS;
        if (expMs > PLAN_FRAMES_MAX * FRAME_MS) return { far: true, late: false, kind: /** @type {"parry"} */ ("parry"), cMs: 0, branchMs: 0, covers: false };
        // the timing head is the trigger (S1-style); the defense head only picks the action (unknown / none -> parry)
        let s1 = 0;
        for (let i = 1; i <= 5; i++) s1 += futBin(k, i);
        const def = defAction(pred?.def[k] ?? []);
        const trig = k === 0 ? s1 >= TRIG_TH : comboRunning() || s1 >= TRIG_TH * 0.6;
        if (!trig) return null;
        // def1 "curtain" without the actual curtain state is a favourite misread here: parry instead
        const kind = def === "avoid" && !inCurtain ? /** @type {"parry"} */ ("parry") : def ?? /** @type {"parry"} */ ("parry");
        if (expMs < LATE_FRAMES * FRAME_MS) return { far: false, late: true, kind, cMs: now + expMs, branchMs: 0, covers: false };
        const bimodal = st.p1 >= BRANCH_MIN_P && st.p2 >= BRANCH_MIN_P && Math.abs(st.i1 - st.i2) >= BRANCH_SEP_BINS;
        if (!bimodal) return { far: false, late: false, kind, cMs: now + expMs, branchMs: 0, covers: false };
        const ie = Math.min(st.i1, st.i2), il = Math.max(st.i1, st.i2);
        const early = now + FUT_CENTER[ie] * FRAME_MS, later = now + FUT_CENTER[il] * FRAME_MS;
        return { far: false, late: false, kind, cMs: early, branchMs: later - early > COVER_FRAMES * FRAME_MS ? later : 0, covers: later - early <= COVER_FRAMES * FRAME_MS };
    }
    /** @param {number} now @param {number} k */
    function syncK(now, k) {
        // A pressed item whose believed contact has passed without any ok/hit feedback, while the fresh fut still
        // points at a real contact, is re-armed once. Bypasses the S1 trigger on purpose: after an early press the head
        // is quiet until the arm's real contact approaches (r241 press@196 c=210: S1 0.04-0.18 until t225, real
        // contact 243). The estimate may still be 30-45 f out here; re-pressing lands at c'-14.
        const main0 = plan.find((x) => x.k === k && x.src === "fut" && !x.branch);
        if (secondTapF && main0 && main0.kind === "parry" && main0.pressedAt && !main0.repressed && pred
            && now - main0.pressedAt >= secondTapF * FRAME_MS
            && lastHitAt < main0.pressedAt && lastOkAt < main0.pressedAt) {
            const st2 = futStats(pred.fut[k]);
            if (st2.none < 0.65 && st2.sum > 0.05) {
                // press now: the item's lead from now (atMs = now)
                rearmItem(main0, "parry", now + leadOf(main0), `second tap +${secondTapF}f`);
                return;
            }
        }
        if (main0 && main0.pressedAt && !main0.repressed && pred
            && now - main0.pressedAt >= REPRESS_GAP_FRAMES * FRAME_MS && now > main0.cMs + 3 * FRAME_MS
            && lastHitAt < main0.pressedAt - FRAME_MS && lastOkAt < main0.pressedAt - FRAME_MS) {
            const st2 = futStats(pred.fut[k]);
            if (st2.none < 0.65 && st2.sum > 0.01 && st2.exp >= LATE_FRAMES && st2.exp <= 45) {
                const kind = defAction(pred.def[k]) ?? /** @type {"parry"} */ ("parry");
                rearmItem(main0, kind, now + st2.exp * FRAME_MS, `late fill c+${Math.round(st2.exp)}f`);
                return;
            }
            if (st2.sum > 0.05) {
                // the head is unsure (none >= 0.65) but the contact is still coming (252 f4204: press 37 f early,
                // sum 0.16-0.22 / none 0.80-0.89 while the real contact was 4241): a fixed short-delay second tap
                rearmItem(main0, main0.kind, now + (REPRESS_DELAY_FRAMES + ISSUE_LEAD_MS / FRAME_MS) * FRAME_MS, `second tap +${REPRESS_DELAY_FRAMES}f`);
                return;
            }
        }
        const t = targetOf(now, k);
        const main = plan.find((x) => x.k === k && x.src === "fut" && !x.branch);
        const br = plan.find((x) => x.k === k && x.src === "fut" && x.branch);
        if (!t) {
            if (main && !main.committed && !main.pressedAt) {
                dropItem(main, "no contact");
                revisions++;
            }
            if (br) dropItem(br, "no contact");
            return;
        }
        if (t.far) return;
        if (t.late) {
            if (!main) {
                late++;
                mark("late", `k${k} contact in ${Math.round(t.cMs - now)} ms`);
            }
            if (br) dropItem(br, "late");
            return;
        }
        if (!main) {
            if (t.kind === "avoid") {
                if (now - lastAvoidDropAt < 500) return;
                lastAvoidDropAt = now;
            }
            const jit = drawJit();
            addItem({ kind: t.kind, k, src: "fut", cMs: t.cMs, atMs: t.cMs - FUT_LEAD_MS - jit * FRAME_MS, untilMs: t.cMs + MISS_GRACE_MS, jit, why: `pred k${k}${t.covers ? " covers both" : ""}` });
        } else if (!main.committed && !main.pressedAt) {
            if (Math.abs(t.cMs - main.cMs) > REVISE_MOVE_MS || t.kind !== main.kind) {
                revisions++;
                mark("revise", `k${k} ${main.kind}->${t.kind} c ${Math.round(main.cMs - now)}->${Math.round(t.cMs - now)} ms`);
                main.kind = t.kind;
            }
            main.cMs = t.cMs;
            main.atMs = t.cMs - leadOf(main);
            main.untilMs = t.cMs + MISS_GRACE_MS;
        } else if (main.pressedAt && (main.rearms ?? 0) < REPRESS_MAX
                   && t.cMs - main.cMs > REVISE_MOVE_MS
                   && t.cMs - main.pressedAt >= REPRESS_GAP_FRAMES * FRAME_MS && t.cMs - now >= LATE_FRAMES * FRAME_MS
                   && now - main.pressedAt >= PARRY_CD_MS) {
            // the contact moved later after the press (long wind-up): re-arm and press again at its window. Keep the
            // kind: a def-head dodge flip is only taken once the old believed contact has passed (above), so a normal
            // parry is not turned into a dodge by a transient def1 vote.
            const moved = t.cMs - main.cMs;
            rearmItem(main, main.kind, t.cMs, `contact moved +${Math.round(moved / FRAME_MS)}f`);
        }
        if (t.branchMs) {
            if (!br) {
                const jit = drawJit();
                addItem({ kind: t.kind, k, src: "fut", branch: true, cMs: t.branchMs, atMs: t.branchMs - FUT_LEAD_MS - jit * FRAME_MS, untilMs: t.branchMs + MISS_GRACE_MS, t1Ms: t.cMs, jit, why: "branch (bimodal)" });
            }
            else if (!br.pressedAt) {
                br.cMs = t.branchMs;
                br.atMs = t.branchMs - leadOf(br);
                br.untilMs = t.branchMs + MISS_GRACE_MS;
                br.t1Ms = t.cMs;
            }
        } else if (br) {
            dropItem(br, "single mode");
        }
    }
    /** The mode-bin mass around the branch contact in the fresh fut1 (>= 0.25 keeps it). @param {number} now @param {PlanItem} it */
    function branchP(now, it) {
        if (!pred) return false;
        const fr = (it.cMs - now) / FRAME_MS;
        let bi = 9;
        for (let i = 0; i < 10; i++) if (fr <= FUT_HI[i]) {
            bi = i;
            break;
        }
        let p = 0;
        for (let i = Math.max(0, bi - 1); i <= Math.min(9, bi + 1); i++) p += futBin(it.k, i);
        return p >= BRANCH_KEEP_P;
    }
    /** @param {number} now */
    function tellPlan(now) {
        if (!pred) return;
        const t = pred.tell;
        const sustained = t.arg === lastTellArg;
        lastTellArg = t.arg;
        // flare episodes for the onset anchor (the first fire of a flare run of the same class)
        if (t.arg >= 1 && t.arg <= 3) {
            if (now - flareLastFireAt > 20 * FRAME_MS || t.arg !== flareLastArg) {
                flareFirstAt = now;
                if (t.arg === 1 && !flare2On) { // flare2: no hold / split (@see flare2Tick)
                    if (foFrom) foEnd("new episode");
                    foFrom = now;
                    foItem = null;
                    foS.holds++;
                    mark("flarehold", `start (flare_other first report p${Math.round(t.p * 100)})`);
                }
                fsFrom = t.arg === 1 && !flare2On ? now : 0;
                fsFast = null;
                fsItem = null;
            }
            flareLastFireAt = now;
            flareLastArg = t.arg;
            if (t.arg === 1) foLastAt = now;
        }
        if (flare2On) flare2Tick(now);
        fsTick(now);
        // The dark class fires at the curtain's black cover onset (233-252: 77/82 dark streaks p>=0.7 (>=2 f) sit at a
        // real episode). A 400 ms slow task would miss the short covers, so it lives here, in the per-frame tell path.
        if (curtainOn && t.arg === 6 && t.p >= 0.7) {
            // a dark run's first frame is a sweep (the cover onset or a later black sweep): sync the timed dodges
            if (now - lastDarkAt > SWEEP_DARK_GAP_MS) sweepSync(now - SWEEP_DARK_LAG_F * FRAME_MS, "dark");
            lastDarkAt = now;
            if (++curtainDarkSeen >= 2 && !inCurtain && (t.p >= 0.85 || (meanNow >= 0 && meanNow < 30))) {
                inCurtain = true;
                curtainFirstAt = 0;
                curtainDodged = false;
                curtainLastAt = now;
                curtainDarkSeen = 0;
                mark("curtain", "dark tell: cover");
                cancelFuture("curtain");
            }
        } else {
            curtainDarkSeen = 0;
        }
        if (t.p < TELL_TH || t.arg === 0 || t.arg === 6) return;
        if (flare2On && t.arg >= 1 && t.arg <= 3) return; // flare2Tick's
        if (t.arg === 5) {
            if (!curtainOn) return;
            if (!inCurtain) {
                inCurtain = true;
                curtainFirstAt = 0;
                curtainDodged = false;
                mark("curtain", "tell: watch the gap");
            }
            curtainLastAt = now;
            cancelFuture("curtain");
            return;
        }
        if (inCurtain) return;
        // a one-frame blip is noise; one dodge per episode (the tell stays lit while the flare is on screen)
        if (t.p < TELL_DODGE_P || !sustained) return;
        if (t.arg === lastTellDodgeArg && now - lastTellDodgeAt < TELL_EPISODE_MS) return;
        const st = futStats(pred.fut[0]);
        const anchored = t.arg >= 1 && t.arg <= 3; // else the sweep (4)
        if (!anchored && (st.none >= 0.65 || st.sum <= 0.01)) return;
        const c1 = st.none >= 0.65 || st.sum <= 0.01 ? now + 350 : now + st.exp * FRAME_MS;
        if (c1 - now < LATE_FRAMES * FRAME_MS) {
            late++;
            mark("late", `tell ${t.label}`);
            return;
        }
        const label = TELL_LABELS[t.arg];
        let at;
        if (anchored) {
            at = flareFirstAt + (ANCHOR[label] ?? 4) * FRAME_MS;
            if (t.arg === 1 && fsFast === true && fsFrom === flareFirstAt) at = flareFirstAt + FLARE_FAST_ANCHOR * FRAME_MS;
            if (at < now) at = now;
        } else {
            if (st.mode < 0) return;
            at = now + FUT_CENTER[st.mode] * FRAME_MS - DODGE_LEAD.sweep * FRAME_MS;
        }
        if (now - lastDodgeAt < DODGE_CD_MS) return;
        if (plan.some((x) => x.src === "tell" && x.kind === "dodge" && Math.abs(x.atMs - at) < TELL_DEDUP_MS)) return;
        lastTellDodgeArg = t.arg;
        lastTellDodgeAt = now;
        const tit = addItem({ kind: "dodge", dir: nextDir(), k: -1, src: "tell", cMs: c1, atMs: at, untilMs: Math.max(c1, at) + MISS_GRACE_MS, why: `tell ${label}${anchored ? " anchor" : ""} p${Math.round(t.p * 100)}` });
        if (foFrom && t.arg === 1 && !foItem) {
            foItem = tit;
            foS.anchorPlans++;
        }
        if (t.arg === 1 && fsFrom && fsFrom === flareFirstAt && !fsItem) fsItem = tit;
    }
    /** @param {string} dir @returns {Point} */
    function dirPoint(dir) {
        return dir === "left" ? LEFT : dir === "right" ? RIGHT : BACKWARD;
    }
    /** Dodges go to the side, left / right in turn. */
    function nextDir() {
        return dodgeSeq++ % 2 ? "right" : "left";
    }
    /** @param {string} dir */
    function pressDodge(dir) {
        offYield("dodge");
        inDodge = true;
        walkOff();
        try {
            tdown(STICK, 0);
            tmove(dirPoint(dir), 0);
            tdown(DODGE, 2);
            sleep(50);
            tup(2);
        } finally {
            tup(0);
            inDodge = false;
        }
        lastDodgeAt = Date.now();
    }
    /** @param {PlanItem} it @param {number} now */
    function press(it, now) {
        if (it.kind === "parry") {
            if (it.src === "red") rlPressed(it);
            tap(PARRY);
            lastParryAt = Date.now();
            pressFrame(frameIdx);
            presses.parry++;
            it.pressedAt = lastParryAt;
            lastParryC = it.cMs;
            lastItemParryAt = lastParryAt;
            if (it.src !== "insure") pressedSinceHit = true;
            // a fut 卸势 held for a red line's anchor (@see redLineTick)
            const moved = it.src !== "red" && rlEp && it.floorMs === rlEp.at ? ` redline +${((lastParryAt - rlEp.on) / FRAME_MS).toFixed(1)}f moved` : "";
            mark("press", `parry k${it.k} ${it.src} c+${Math.round((it.cMs - lastParryAt) / FRAME_MS)}f ${it.why}${it.jit ? ` jit${it.jit > 0 ? "+" : ""}${it.jit}f` : ""}${moved}`);
        } else if (it.kind === "dodge") {
            // fut plans have no direction yet: resolve it at dispatch, so a cancelled plan does not consume a side
            if (!it.dir) it.dir = nextDir();
            const tapAt = Date.now();
            pressDodge(it.dir);
            pressFrame(frameIdx);
            presses.dodge++;
            it.pressedAt = Date.now();
            mark("press", `dodge ${it.dir} k${it.k} ${it.src} c+${Math.round((it.cMs - it.pressedAt) / FRAME_MS)}f ${it.why}`);
            if (it === foItem) {
                foS.anchorPressed++;
                foS.pressMsAfterFirst.push(tapAt - foFrom);
                foEnd("anchor pressed");
            } else if (it.src === "fut" && foHeld.has(it)) foS.heldPressedAfter++;
        } else if (it.kind === "potion") {
            tap(POTION);
            lastPotionAt = Date.now();
            potionHoldUntil = lastPotionAt + POTION_HOLD_MS;
            pressFrame(frameIdx);
            presses.potion++;
            it.pressedAt = lastPotionAt;
            if (potionDueAt) potS.waitMs.push(lastPotionAt - potionDueAt);
            potionDueAt = 0;
            potionTaps++; // counted at the heal (potionTick)
            potionPend = { at: lastPotionAt, hp0: hpNow ?? 0 };
            mark("potion", `tap hp ${Math.round((hpNow ?? 0) * 100)}% (tap ${potionTaps}, ${potionsUsed}/${maxPotions} healed)`);
        }
    }
    /** @param {PlanItem} it @param {number} now @returns {string} */
    function pressBlocked(it, now) {
        // the offense is deliberately absent: offBusyUntil / offHold only gate offense. A defense press goes regardless;
        // tap() only lets a held 蓄力 go first (offYield).
        if (now < staggerUntil) return "stagger";
        if (now < potionHoldUntil && it.kind !== "dodge") return "potion"; // a dodge keeps the drink
        if (inDodge) return "dodge";
        if (it.kind === "parry" && now - lastParryAt < PARRY_CD_MS) return "parry cd";
        if (it.kind === "dodge" && now - lastDodgeAt < DODGE_CD_MS) return "dodge cd";
        return "";
    }
    /** @param {number} now */
    function executePlan(now) {
        const items = [...plan].sort((a, b) => a.atMs - b.atMs);
        for (const it of items) {
            if (!plan.includes(it) || it.pressedAt) continue;
            if (now < it.atMs) continue;
            if (it.floorMs && now < it.floorMs) continue; // a red line's anchor (@see redLineTick)
            if (it.branch) {
                if (now < it.t1Ms + 3 * FRAME_MS) continue;
                const firstKnown = lastHitAt >= it.t1Ms - 100 || lastOkAt >= it.t1Ms - 100;
                if (firstKnown || !branchP(now, it)) {
                    branchDrops++;
                    dropItem(it, firstKnown ? "branch: first mode resolved" : "branch: later mode gone");
                    continue;
                }
                it.branch = false;
                branches++;
                mark("plan", `branch k${it.k} released`);
            }
            if (it.kind === "avoid") {
                lastAvoidDropAt = now;
                dropItem(it, "curtain (gap rule)");
                continue;
            }
            if (it.kind === "potion" && plan.some((o) => o !== it && o.kind !== "potion" && !o.pressedAt && o.atMs <= now + POTION_YIELD_MS)) continue;
            if (foFrom && it.src === "fut" && it.kind === "dodge") {
                // flareHold: the flare_other anchored dodge owns the dodge CD; keep the item for after the hold
                foS.blockedFrames++;
                if (!foHeld.has(it)) {
                    foHeld.add(it);
                    foS.blockedItems++;
                    mark("flarehold", `fut dodge k${it.k} held c+${Math.round((it.cMs - now) / FRAME_MS)}f`);
                }
                continue;
            }
            if (it.src === "insure") {
                // post-hit insurance: fires at the stagger's end; blocked -> retry (until expiry); skipped when the
                // plan already has a pending item or pressed since the hit
                if (pressBlocked(it, now)) continue;
                if (relockAt(now, it.cMs, true)) continue; // retried until it expires
                if (pressedSinceHit) {
                    dropItem(it, "posthit: plan pressed");
                    continue;
                }
                if (plan.some((o) => o !== it && o.src !== "insure" && !o.pressedAt)) {
                    dropItem(it, "posthit: plan live");
                    continue;
                }
                tap(PARRY);
                lastParryAt = Date.now();
                pressFrame(frameIdx);
                presses.parry++;
                insurePresses++;
                it.pressedAt = lastParryAt;
                lastParryC = it.cMs;
                mark("press", `parry posthit c+${Math.round((it.cMs - lastParryAt) / FRAME_MS)}f`);
                dropItem(it, "posthit done");
                continue;
            }
            if (it.src === "red") {
                // the red-line 卸势: waits out the CD / stagger / relock while its window lasts (redLineTick ends it)
                const why = pressBlocked(it, now) || (relockAt(now, it.cMs, true) ? "relock" : "")
                    || (cadOn && now < cadLockEnd() ? "cadence lock" : ""); // not inside a cadence 卸势's lock
                if (why) {
                    if (!it.held) {
                        it.held = true;
                        inc(rlS.waits, why);
                        mark("redline", `卸势 waits (${why})`);
                    }
                    continue;
                }
                press(it, now);
                it.untilMs = (it.onMs ?? now) + RL_MISS_F * FRAME_MS;
                continue;
            }
            const why = pressBlocked(it, now);
            if (it.kind === "parry" && (why === "" || why === "parry cd")) {
                // a second 卸势 at the same believed contact inside the game's lock waits for its end
                const end = relockAt(now, it.cMs, !!it.repressed);
                if (end) {
                    const lead = (it.cMs - end) / FRAME_MS - LATENCY_F;
                    const src = it.src + (it.repressed ? "+re" : "");
                    if (lead < RELOCK_MIN_LEAD_F) {
                        hcS.relock.gaveUp++;
                        mark("relock", `${it.kind} k${it.k} ${src} given up: lead ${lead.toFixed(1)}f at +${end - now} ms`);
                        dropItem(it, "relock: too late");
                    } else if (!it.relocked) {
                        it.relocked = true;
                        hcS.relock.delayed++;
                        hcS.relock.bySrc[src] = (hcS.relock.bySrc[src] ?? 0) + 1;
                        mark("relock", `${it.kind} k${it.k} ${src} waits ${end - now} ms (lead ${lead.toFixed(1)}f)`);
                    }
                    continue;
                }
            }
            if (why) {
                blocked[why] = (blocked[why] ?? 0) + 1;
                if (why === "stagger" && !it.branch && it.cMs - now >= HOLD_MIN_LEAD * FRAME_MS) {
                    if (!it.held) {
                        it.held = true;
                        holds++;
                        mark("hold", `${it.kind} k${it.k} stagger, ${Math.round((it.cMs - now) / FRAME_MS)}f lead left`);
                    }
                    continue; // keep the item: retry every frame until the stagger ends
                }
                mark("blocked", `${it.kind} k${it.k} ${why}`);
                dropItem(it, `blocked ${why}`);
                continue;
            }
            if (it.held && it.cMs - now < HOLD_MIN_LEAD * FRAME_MS) {
                dropItem(it, "held: too late");
                continue;
            }
            press(it, now);
            if (it.held) holdPresses++;
            if (it.relocked) hcS.relock.pressed++;
        }
    }
    /**
     * When a 卸势 for believed contact cMs may go (0 = now): the last 卸势 is younger than PARRY_RELOCK_MS, nothing (ok /
     * hit) came back since, and it is the same contact (same = a re-armed / insurance press, or believed contacts <=
     * RELOCK_SAME_F apart; a different contact after an ok is never locked in-game).
     * @param {number} now @param {number} cMs @param {boolean} same
     */
    function relockAt(now, cMs, same) {
        if (!lastParryAt) return 0;
        const end = lastParryAt + PARRY_RELOCK_MS;
        if (now >= end || lastOkAt >= lastParryAt || lastHitAt >= lastParryAt) return 0;
        if (!same && Math.abs(cMs - lastParryC) > RELOCK_SAME_F * FRAME_MS) return 0;
        return end;
    }
    /** The escape 卸势 at the hit's stagger end, unless a plan 卸势 goes then. @param {number} now */
    function hitEscTick(now) {
        if (!esc || now < esc.at) return;
        const yieldF = HIT_ESC_YIELD_F * FRAME_MS;
        if ((lastItemParryAt > esc.hitAt && lastItemParryAt >= esc.at - yieldF)
            || plan.some((o) => o.kind === "parry" && o.src !== "insure" && !o.pressedAt && !o.branch && o.atMs <= now + yieldF)) {
            esc = null;
            hcS.esc.yieldPlan++;
            mark("escape", "parry: a plan 卸势 goes now");
            return;
        }
        if (now > esc.at + HIT_ESC_WIN_F * FRAME_MS) {
            hcS.esc.late++;
            mark("escape", `parry given up (+${now - esc.at} ms past the stagger end)`);
            esc = null;
            return;
        }
        if (inDodge || inCurtain || now < staggerUntil || now < potionHoldUntil || now - lastParryAt < PARRY_CD_MS) return;
        if (relockAt(now, now + ISSUE_LEAD_MS, true)) return;
        const hitAt = esc.hitAt;
        esc = null;
        hcS.esc.parry++;
        const c = now + ISSUE_LEAD_MS;
        tap(PARRY);
        lastParryAt = Date.now();
        lastParryC = c;
        pressFrame(frameIdx);
        presses.parry++;
        mark("press", `parry k-1 hitEscape +${now - hitAt}ms c+${Math.round((c - lastParryAt) / FRAME_MS)}f`);
    }
    /** The cadence 卸势 (@see CAD_OFF), per frame after syncPlan, before executePlan. @param {number} now */
    function cadenceTick(now) {
        if (!cadOn || !pred) return;
        // an urgent drink: the cadence stops up to CAD_YIELD_MS so the potion gets its gap after our last touch
        const urgent = potionDue() && !potionPend && ((hpNow != null && hpNow <= POTION_URGENT) || (potionDueAt > 0 && now - potionDueAt >= POTION_WAIT_MAX_MS));
        if (!urgent) cadYieldFrom = 0;
        else if (!cadYieldFrom) {
            cadYieldFrom = now;
            cadS.yields++;
            mark("cadence", `yield to the potion (hp ${Math.round((hpNow ?? 0) * 100)}%)`);
        }
        if (cadG < cadTh) return;
        const why = now < cadLockEnd() + CAD_PAD_MS ? "lock"
            : now - lastParryAt < PARRY_CD_MS ? "parry cd"
            : now < staggerUntil ? "stagger"
            : now < potionHoldUntil ? "potion"
            : inDodge ? "dodge"
            : qp.shown ? "qi"
            : plan.some((x) => x.kind === "dodge" && !x.pressedAt && x.atMs - now <= CAD_DODGE_MS) ? "dodge due"
            : plan.some((x) => x.kind === "potion" && !x.pressedAt) ? "potion due"
            : cadYieldFrom && now - cadYieldFrom < CAD_YIELD_MS ? "yield"
            : "";
        if (why) {
            inc(cadS.wait, why);
            return;
        }
        tap(PARRY);
        lastParryAt = Date.now();
        lastParryC = lastParryAt + ISSUE_LEAD_MS;
        pressFrame(frameIdx);
        presses.parry++;
        pressedSinceHit = true;
        cadS.presses++;
        cadPressAt = lastParryAt;
        mark("press", `parry cadence G${cadG.toFixed(2)}`);
    }
    const cadResult = () => ({ th: cadTh, on: cadOn, ...(cadS.off ? { off: cadS.off } : {}), presses: cadS.presses, touches: cadS.touches,
        swallowed: cadS.swallowed, openShare: cadS.frames ? Math.round((cadS.openFrames / cadS.frames) * 1000) / 1000 : 0, frames: cadS.frames,
        gapHist: cadS.gapHist, gapMs: stats(cadS.gaps), yields: cadS.yields, wait: cadS.wait });
    /** @param {number} now */
    function expire(now) {
        for (const it of [...plan]) {
            if (!it.branch && !it.pressedAt && it.kind !== "potion" && now > it.untilMs) {
                dropItem(it, "expired unpressed");
            } else if (!it.branch && it.pressedAt && it.kind !== "potion" && now > it.untilMs) {
                // about to become a miss: if the fresh fut still points at a contact the press was too early for (the
                // true contact has not happened yet), re-arm and press again in its window. The trigger gate is
                // bypassed on purpose: after an early press S1 usually drops while the arm is still winding up.
                if ((it.rearms ?? 0) < REPRESS_MAX && it.src === "fut" && it.k >= 0 && pred) {
                    const st2 = futStats(pred.fut[it.k]);
                    if (st2.none < 0.65 && st2.sum > 0.01 && st2.exp >= LATE_FRAMES && st2.exp <= REPRESS_LOOK_FRAMES) {
                        const kind = defAction(pred.def[it.k]) ?? /** @type {"parry"} */ ("parry");
                        rearmItem(it, kind, now + st2.exp * FRAME_MS, `late fill c+${Math.round(st2.exp)}f`);
                        continue;
                    }
                }
                misses++;
                mark("miss", `${it.kind} k${it.k} c+${Math.round(it.cMs - now)}ms`);
                dropItem(it, "contact passed");
            } else if (it.branch && now > it.atMs + BRANCH_LATE_MS) {
                branchDrops++;
                dropItem(it, "branch expired");
            }
        }
    }
    /** @param {number} now */
    function syncPlan(now) {
        if (!pred) return;
        for (const it of plan) if (!it.branch && !it.pressedAt) it.committed = it.atMs - now <= COMMIT_MS;
        if (inCurtain) {
            if (now - curtainLastAt > CURTAIN_GONE_MS) {
                inCurtain = false;
                mark("curtain", "over");
            }
        } else if (!cadOn) { // the cadence replaces the fut items (@see CAD_OFF)
            for (let k = 0; k < 3; k++) syncK(now, k);
        }
        tellPlan(now);
        foTick(now);
        if (comboDropped()) {
            const st = futStats(pred.fut[0]);
            if (st.none >= 0.65 || st.exp > 30) {
                for (const b of [...plan]) {
                    if (b.branch && !b.pressedAt) {
                        branchDrops++;
                        dropItem(b, "combo dropped");
                    }
                }
            }
        }
    }
    let predMarkAt = 0;
    /** @param {number} now */
    function predMark(now) {
        if (!pred || now - predMarkAt < PRED_MS) return;
        predMarkAt = now;
        const st = futStats(pred.fut[0]);
        let s1 = 0;
        for (let i = 1; i <= 5; i++) s1 += futBin(0, i);
        mark("pred", `S1 ${s1.toFixed(2)} bin ${st.mode}(${FUT_LABELS[st.mode] ?? "-"}) c1 +${st.sum > 0 ? Math.round(st.exp) : "-"}f ` +
            `def1 ${DEF_LABELS[argmax(pred.def[0])]} tell ${pred.tell.label} combo ${COMBO6_LABELS[pred.combo.arg]} ${pred.combo.p.toFixed(2)} stage ${pred.stage.label}`);
    }

    // --- feedback (fast path): hp drop = hit, qi drop = ok
    /** @param {number} now @param {number} before @param {number} after */
    function onHit(now, before, after) {
        rlOutcome(now, "hit");
        hits++;
        lastHitAt = now;
        pressedSinceHit = false;
        const drop = before - after;
        let stg = STAGGER_BY_DROP[STAGGER_BY_DROP.length - 1][1];
        const row = STAGGER_BY_DROP.find((x) => drop <= x[0] + 1e-9);
        if (row) stg = row[1];
        hcS.stagger[stg] = (hcS.stagger[stg] ?? 0) + 1;
        staggerUntil = Math.max(staggerUntil, now + stg);
        // keep the unpressed items that still target a future contact (the fresh fut head often goes quiet during the
        // stagger and never rebuilds them); only stale / consumed ones go
        const n = plan.length;
        /** @type {PlanItem[]} */
        const keep = [];
        for (const it of plan) {
            if (!it.pressedAt && it.cMs > now + 2 * FRAME_MS) keep.push(it);
            else mark("plan", `- ${it.kind} k${it.k} hit ${it.pressedAt ? "pressed" : "stale"}`);
        }
        plan = keep;
        mark("hit", `${Math.round(before * 100)}%->${Math.round(after * 100)}% (${n - keep.length}/${n} dropped, ${keep.length} kept)`);
        mark("stagger", `${stg} ms (drop ${Math.round(drop * 1000) / 10}%)`);
        // a hit in the curtain is a sweep: re-sync when unsynced or near a predicted sweep
        if (inCurtain || now - curtainLastAt < CURTAIN_GONE_MS) {
            const est = now - SWEEP_HIT_LAG_F * FRAME_MS;
            const valid = sweepAt && est - sweepAt <= (SWEEP_N + 0.5) * SWEEP_PERIOD_MS;
            const j = valid ? Math.round((est - sweepAt) / (SWEEP_PERIOD_MS)) : 0;
            if (!valid || (j >= 1 && Math.abs(est - sweepAt - j * SWEEP_PERIOD_MS) <= SWEEP_HIT_NEAR_F * FRAME_MS)) sweepSync(est, "hit");
        }
        // one escape 卸势 at this hit's stagger end, else the insurance one (heavy blows, curtain, potion); a newer hit
        // supersedes a pending escape
        if (esc) {
            hcS.esc.superseded++;
            mark("escape", "superseded by a new hit");
        }
        esc = null;
        if (cadOn) return; // no escape / insurance 卸势: after the stagger the cadence presses while its gate is open
        const skip = inCurtain || now - curtainLastAt < CURTAIN_GONE_MS ? "curtain"
            : now < potionHoldUntil || potionPend || plan.some((x) => x.kind === "potion") ? "potion"
            : drop > HIT_ESC_MAX_DROP ? "heavy" : "";
        if (skip) {
            hcS.esc.skip[skip] = (hcS.esc.skip[skip] ?? 0) + 1;
            mark("escape", `skip (${skip})`);
            addItem({ kind: "parry", k: -1, src: "insure", cMs: now + stg, atMs: now + stg,
                      untilMs: now + stg + 30 * FRAME_MS, why: "posthit narrow" });
        } else {
            esc = { hitAt: now, at: staggerUntil };
            hcS.esc.scheduled++;
            mark("escape", `parry at +${staggerUntil - now} ms`);
        }
    }
    /** @param {number} now */
    function onOk(now) {
        rlOutcome(now, "ok");
        oks++;
        lastOkAt = now;
        /** @type {PlanItem | null} */
        let best = null;
        for (const it of plan) {
            if (it.kind === "parry" && it.pressedAt && now - it.pressedAt <= 1500 && (!best || it.pressedAt > best.pressedAt)) best = it;
        }
        mark("ok", `真气 ${qiNow}->${qiRead()}${best ? ` (k${best.k})` : ""}`);
        if (best) {
            plan.splice(plan.indexOf(best), 1);
            mark("plan", `- parry k${best.k} done ok`);
        }
    }
    function feedback() {
        const now = Date.now();
        const h = hpRead();
        if (h != null) {
            // A drop is judged against hpBase, not the last read: a grey-bar overread must not turn the next correct
            // read into a second hit. The bar is quantized to ~0.4%, so hpBase follows every downward step (a small
            // chip does not accumulate into a late hit).
            if (hpBase == null) hpBase = h;
            else if (h < hpBase) {
                if (h < hpBase - HIT_DROP && h > hpBase - 0.35) onHit(now, hpBase, h);
                hpBase = h;
            } else if (h > hpBase) {
                // An upward jump is a heal only when it reaches the drink's +POTION_HEAL (a +4% grey overread does
                // not, even while the drink is pending), while the confirmed bar still fills (POTION_SETTLE_MS), or
                // when it is a whole POTION_HEAL with no drink (the other heal sources).
                const drink = potionPend ?? potionLate;
                const healing = (drink != null && h >= drink.hp0 + POTION_HEAL)
                    || (lastPotionOkAt > 0 && now - lastPotionOkAt <= POTION_SETTLE_MS)
                    || h - hpBase >= POTION_HEAL;
                if (healing) hpBase = h;
            }
            hpNow = h;
        }
        const q = qiRead();
        if (q >= 0) {
            if (qiNow >= 4 && qiNow - q >= QI_STEP && qiNow - q <= QI_JUMP) onOk(now);
            qiNow = q;
            qiEmpty = 0;
        } else {
            // an exhausted qi bar has no light-blue pixels at all: the read fails (-1), NOT 0. Track the empty streak
            // so the 气竭 detector can fire.
            qiEmpty++;
        }
        litPx = litRead();
    }

    // --- the round is over (重伤): the 再次训练 panel, or a long all-grey screen (@see combat.js)
    let deadAt = 0, deadSeen = 0, greySeen = 0, wonSeen = 0, bossGoneAt = 0;
    /** @type {number | null} ms since start when phase one was seen cleared (reason "cleared") */
    let clearedAtMs = null;
    /** @param {number} now @returns {"dead" | "cleared" | null} */
    function deadCheck(now) {
        if (now - deadAt < DEAD_MS) return null;
        deadAt = now;
        // the 成功 page first (@see WON_T): it would pass both 重伤 tests below
        const [drill, text] = WON_T.map(([t, roi]) => match(t, { image: img, roi, threshold: WON_TH }).hit);
        const won = drill && text;
        wonSeen = won ? wonSeen + 1 : 0;
        if (wonSeen >= 2) {
            mark("cleared", "the 成功 page (phase one cleared)");
            clearedAtMs = now - start;
            return "cleared";
        }
        if (drill) {
            deadSeen = 0;
            greySeen = 0;
            return null;
        }
        // The button is unmistakable (1980 px on the death panel), but white effect bursts also cross this ROI in
        // fights (1250-1430 px), so two checks in a row must ALSO see the boss bar gone, unless the count is
        // death-panel-sized (>= 1600).
        const btn = countAtLeast(RETRY_WHITE, RETRY_ROI, 800, img);
        const again = btn && (bossNow <= 50 || countAtLeast(RETRY_WHITE, RETRY_ROI, 1600, img));
        deadSeen = again ? deadSeen + 1 : 0;
        if (deadSeen >= 2) {
            mark("dead", `the round is over (reset button${bossNow > 50 ? ", strong" : ""})`);
            return "dead";
        }
        // a curtain blackout lasts ~1 s: only a grey screen of ~2.5 s counts (painting the death screen before its
        // button). 8/8 terminal recordings fire here, with zero battle-period triggers in 74 rounds.
        const grey = countAtLeast(GREY, GREY_ROI, Math.round(0.85 * GREY_ROI[2] * GREY_ROI[3]), img);
        greySeen = grey ? greySeen + 1 : 0;
        if (greySeen >= 6) {
            mark("dead", "the round is over (grey screen)");
            return "dead";
        }
        // phase 2: a death can skip both reads and the arena restarts at its gate (r128: down at ~170 s, then 12 min
        // idle): the boss bar gone BOSS_GONE_MS after it was seen ends the run
        if (phase === 2 && bossSeen) {
            if (bossNow > 50) bossGoneAt = 0;
            else if (!bossGoneAt) bossGoneAt = now;
            else if (now - bossGoneAt >= BOSS_GONE_MS) {
                mark("dead", `the round is over (boss bar gone ${BOSS_GONE_MS / 1000} s)`);
                return "dead";
            }
        }
        return null;
    }

    // --- halt: phase one over. The 成功 page's 演练下一阶段 covers LOCK, and its buttons show ~6 frames before 「成功」
    // and ~1 s before deadCheck's two reads: round 543's re-lock tap landed there and started phase two. Halt on
    // HALT_ON_FRAMES frames in a row with either WON_T template, lifted after HALT_OFF_FRAMES frames without. The boss
    // bar plays no part (round 566: it read 0-15 px over half full).
    let wonRun = 0, wonMiss = 0, halts = 0;
    /** @param {number} now */
    function haltCheck(now) {
        const hit = wonAny();
        wonRun = hit ? wonRun + 1 : 0;
        wonMiss = hit ? 0 : wonMiss + 1;
        const on = halt ? wonMiss < HALT_OFF_FRAMES : wonRun >= HALT_ON_FRAMES;
        if (on === halt) return;
        if (on) {
            releaseDue(true);
            if (offHold) offRelease(now, "halt", true);
            offUp(true);
            if (offWalking) offWalkStop("halt");
            walkOff();
            halts++;
        }
        halt = on;
        mark("halt", on ? `no touches (成功 page template, ${wonRun} frames)` : `fight back (no 成功 template for ${wonMiss} frames), ${haltDowns} downs held back`);
    }
    /** Either 成功 page template on screen (@see WON_T), once per frame. */
    function wonAny() {
        return perFrame("won", () => WON_T.some(([t, roi]) => match(t, { image: img, roi, threshold: WON_TH }).hit));
    }

    // --- lock-on: tap the lock button back on while the gold icon is gone (combat.js rule)
    let lockWas = false, lockTaps = 0, lastLockTap = 0;
    /** @param {number} now */
    function lockCheck(now) {
        if (halt) return;
        const locked = color({ ...GOLD, image: img, roi: LOCK_ROI, count: 150 }).hit;
        if (locked !== lockWas) {
            lockWas = locked;
            mark("lock", locked ? "icon lit" : "icon dark");
        }
        if (!locked && !upDue && now - lastLockTap >= LOCK_MS) {
            lastLockTap = now;
            if (wonAny()) { // LOCK is on 演练下一阶段 there
                mark("lock", "re-lock held back (成功 page)");
                return;
            }
            lockTaps++;
            tap(LOCK);
            mark("lock", `re-lock tap ${lockTaps}`);
        }
    }

    // --- round start, before walking in (the boss does not come yet): coat the blade with poison, switch the item
    // slot back to the potion, then 增益 and 伤害 (teacher, 2026-10-23)
    function prep() {
        /** @param {Point} p @param {number} ms */
        const step = (p, ms) => {
            tap(p);
            releaseDue(true);
            sleep(ms);
        };
        // the pick swaps with the slot's item; checked each time (a swap once failed and the drinks were poison)
        const potionIn = () => color({ ...ICON_WHITE, image: shot(), roi: SLOT_ROI, count: SLOT_POTION_PX }).hit;
        /** Swap until the slot holds the potion (want) or not; false when it never did. @param {boolean} want @param {string} what */
        const swapTo = (want, what) => {
            for (let i = 0; i < PREP_SWAP_TRIES; i++) {
                step(ITEM_OPEN, PREP_MENU_MS);
                step(ITEM_PICK, PREP_MENU_MS);
                if (potionIn() === want) return true;
                mark("prep", `${what} not in the slot (try ${i + 1})`);
            }
            return false;
        };
        // a round may start with the poison still in the slot (the last one's swap back failed)
        if (!potionIn() && !swapTo(true, "potion")) mark("prep", "no potion in the slot at the start");
        // phase 2: no poison (teacher, 2026-10-23: the real fight goes on from phase 1 with no quiet start to coat the
        // weapon, so the item slot is not switched at all)
        const poisoned = phase !== 2 && swapTo(false, "poison");
        if (poisoned) step(POTION, PREP_USE_MS);
        const back = !poisoned || swapTo(true, "potion");
        // 增益 is 陌刀's (横刀 has 爆发 there): switch first when the round starts on 横刀
        img = shot();
        let w = offWeaponNow();
        for (let i = 0; i < 2 && w === "hengdao"; i++) {
            step(SWITCH, SWITCH_WAIT_MS);
            img = shot();
            w = offWeaponNow();
        }
        if (w !== "modao") mark("prep", `weapon ${w ?? "unknown"}: 增益 may be the wrong button`);
        step(BUFF, PREP_USE_MS);
        step(QISHU, PREP_USE_MS);
        mark("prep", `${poisoned ? "poison" : phase === 2 ? "no poison (phase 2)" : "NO POISON"} + ${back ? "potion back" : "POTION NOT BACK"} + 增益 + 伤害 (${w ?? "unknown"}) in ${Date.now() - start} ms`);
    }

    // --- round start: walk in, in short bursts, until the boss bar shows
    let bossSeen = false;
    /** @param {number} now */
    function approach(now) {
        if (bossSeen) return;
        if (bossNow > 50) {
            bossSeen = true;
            strideF(0);
            mark("approach", `boss bar after ${Math.round((now - start) / 1000)}s`);
            return;
        }
        if (now - start > APPROACH_MS) return;
        const on = (now - start) % APPROACH_CYCLE < APPROACH_ON;
        strideF(on ? 1 : 0);
    }

    // --- the stick
    let stickF = 0; // the forward push (walking in); setSide is the horizontal one
    /** Push the joystick forward, 0/1 (@see setSide). @param {number} v */
    function strideF(v) {
        if (v === stickF || (halt && v !== 0)) return;
        if (v === 0) {
            tup(0);
            stickF = 0;
            return;
        }
        if (stickSide !== 0) return; // contact 0 is the curtain rule's
        tdown(STICK, 0);
        lastWalkAt = Date.now();
        pressFrame(frameIdx);
        presses.walk++;
        stickF = v;
        tmove([STICK[0], Math.round(STICK[1] - STICK_R * v)], 0);
    }
    function walkOff() {
        if (stickSide !== 0) setSide(0);
        if (stickF) strideF(0);
    }
    /** @param {number} v */
    function setSide(v) {
        if (v === stickSide || (halt && v !== 0)) return;
        if (v === 0) tup(0);
        else {
            if (stickF) strideF(0);
            if (stickSide === 0) {
                tdown(STICK, 0);
                lastWalkAt = Date.now();
                pressFrame(frameIdx);
                presses.walk++;
            }
            tmove([Math.round(STICK[0] + STICK_R * v), STICK[1]], 0);
        }
        stickSide = v;
    }

    // --- the curtain
    /**
     * A sweep happened at press-clock time `at` (the moment a 卸势 tap would have lit at the sweep's frame): the next
     * SWEEP_N sweeps get one back dodge each (@see sweepTick). @param {number} at @param {string} src
     */
    function sweepSync(at, src) {
        sweepAt = at;
        sweepK = 1;
        sweepSrc = src;
        mark("curtain", `sweep sync (${src})${inCurtain ? "" : " (not in curtain yet)"}`);
    }
    /** The next timed sweep dodge's tap time, or 0 (none due: unsynced / done / not in the curtain). */
    function sweepPressAt() {
        if (!sweepAt || !inCurtain || sweepK > SWEEP_N) return 0;
        if (Date.now() - sweepAt > (SWEEP_N + 0.5) * SWEEP_PERIOD_MS) return 0; // a stale sync
        // a dodge tapped at t shows DODGE_SHOW_F after a 卸势 tapped at t would light: show = sweep - SWEEP_LEAD_F
        return sweepAt + sweepK * SWEEP_PERIOD_MS - (SWEEP_LEAD_F + DODGE_SHOW_F) * FRAME_MS;
    }
    /** Per frame: tap the timed back dodge when due (late by > SWEEP_LATE_MS: skip that sweep). @param {number} now */
    function sweepTick(now) {
        for (;;) {
            const at = sweepPressAt();
            if (!at || now < at) return;
            if (now - at > SWEEP_LATE_MS) {
                mark("curtain", `timed sweep ${sweepK} late by ${now - at} ms: skipped`);
                sweepK++;
                continue;
            }
            if (inDodge || now < staggerUntil || now < potionHoldUntil || now - lastDodgeAt < SWEEP_GAP_MS) return; // retry
            pressDodge("back");
            pressFrame(frameIdx);
            presses.dodge++;
            timedSweeps++;
            mark("curtain", `timed sweep ${sweepK} dodge (${sweepSrc} sync +${Math.round((now - sweepAt) / FRAME_MS)}f)`);
            sweepK++;
            return;
        }
    }
    /** Keep the gap rule's own dodges away from a timed one that is about to go. @param {number} now */
    const sweepQuiet = (now) => {
        const at = sweepPressAt();
        return !!at && at - now < SWEEP_QUIET_MS && at - now > -SWEEP_LATE_MS;
    };
    /** @param {number} now */
    function slowCurtain(now) {
        if (!inCurtain) {
            // the combat.js image rule (panels + orange edge): the tell head misses curtains (252: 1 of 3); one probe
            // hit enters the curtain handler
            if (gapNow(img) !== null) {
                inCurtain = true;
                curtainFirstAt = 0;
                curtainDodged = false;
                curtainLastAt = now;
                curtainDarkSeen = 0;
                mark("curtain", "image: panels + edge");
                cancelFuture("curtain");
                return;
            }
            if (stickSide !== 0) walkOff();
            return;
        }
        const g = gapNow(img);
        if (!g) {
            // the black cover: nothing to read; stay in the curtain and dodge out of the sweep's way once
            if (meanNow >= 0 && meanNow < 22) {
                curtainLastAt = now;
                if (!curtainFirstAt) curtainFirstAt = now;
                walkOff();
                if (!curtainDodged && now - curtainDodgeAt > CURTAIN_DODGE_GAP_MS && now - lastDodgeAt > DODGE_CD_MS && !sweepQuiet(now)) {
                    curtainDodged = true;
                    curtainDodgeAt = now;
                    mark("curtain", "cover: dodge");
                    pressDodge("back");
                    presses.dodge++;
                }
                return;
            }
            if (now - curtainLastAt > CURTAIN_GONE_MS) {
                inCurtain = false;
                walkOff();
                mark("curtain", "over");
            }
            return;
        }
        curtainLastAt = now;
        if (!curtainFirstAt) curtainFirstAt = now;
        if (g === "covered") {
            walkOff();
            if (now - curtainDodgeAt > CURTAIN_DODGE_GAP_MS && now - lastDodgeAt > DODGE_CD_MS && !sweepQuiet(now)) {
                curtainDodgeAt = now;
                mark("curtain", "covered: dodge");
                pressDodge("back");
                presses.dodge++;
            }
            return;
        }
        const [a, b] = g;
        const inGap = a - GAP_IN <= ME_X && ME_X <= b + GAP_IN;
        if (!curtainDodged && now - curtainFirstAt >= CURTAIN_FIRST_DODGE_MS && !inGap && !sweepQuiet(now)) {
            curtainDodged = true;
            walkOff();
            mark("curtain", "first sweep, not in the gap: dodge");
            pressDodge((a + b) / 2 < ME_X ? "left" : "right");
            presses.dodge++;
            return;
        }
        const dx = (a + b) / 2 - ME_X;
        const margin = Math.max(GAP_IN, (b - a) / 4);
        setSide(Math.abs(dx) <= margin ? 0 : Math.max(-1, Math.min(1, Math.round((dx / GAP_PUSH) * 4) / 4)) || 0);
    }
    /** The image flare rule (gold + streak): the aux column, and a dodge when no tell planned one. @param {number} now */
    function slowFlare(now) {
        const seen = seeFlash(img);
        flare = seen ? 1 : 0;
        if (!seen) return;
        flareSeenAt = now;
        mark("flare", "gold + streak");
        if (inCurtain) return;
        if (now - lastDodgeAt < DODGE_CD_MS || now - lastFlareDodgeAt < 1000) return;
        if (plan.some((x) => x.kind === "dodge" && Math.abs(x.atMs - now) < TELL_DEDUP_MS * 2)) return;
        const st = pred ? futStats(pred.fut[0]) : null;
        const c1 = st && st.none < 0.65 && st.sum > 0.01 ? now + st.exp * FRAME_MS : now + 350;
        if (c1 - now < LATE_FRAMES * FRAME_MS) return;
        lastFlareDodgeAt = now;
        addItem({ kind: "dodge", dir: nextDir(), k: -1, src: "tell", cMs: c1, atMs: c1 - DODGE_LEAD.other * FRAME_MS, untilMs: c1 + MISS_GRACE_MS, why: "flare color" });
    }

    // --- phase 2 金光 (@see FLARE2_P): the image rule per frame, a dodge at the first report, one re-dodge
    let f2From = 0, f2LastAt = 0, f2SeenSeq = -1, f2ReadAt = 0, f2ReDone = false;
    /** @type {PlanItem | null} */ let f2First = null;
    /** @type {number[]} */ const f2Cost = [];
    const f2S = { episodes: 0, /** @type {Record<string, number>} */ bySrc: {}, dodges: 0, redodges: 0,
                  /** @type {Record<string, number>} */ reSkip: {}, imgReads: 0, imgHits: 0, slowReads: 0, readMs: /** @type {number[]} */ ([]) };
    /** Per frame before the aux (phase 2): seeFlash on this frame -> the flare aux column, flareSeenAt. @param {number} now */
    function flare2Read(now) {
        const slow = f2Cost.length >= FLARE2_COST_N && f2Cost.reduce((a, b) => a + b, 0) / f2Cost.length > FLARE2_COST_MS;
        if (slow && now - f2ReadAt < FLARE2_SLOW_EVERY) return;
        if (slow) f2S.slowReads++;
        f2ReadAt = now;
        const t0 = Date.now();
        const seen = seeFlash(img);
        const ms = Date.now() - t0;
        f2Cost.push(ms);
        if (f2Cost.length > FLARE2_COST_N) f2Cost.shift();
        f2S.readMs.push(ms);
        f2S.imgReads++;
        flare = seen ? 1 : 0;
        if (!seen) return;
        f2S.imgHits++;
        f2SeenSeq = img.seq;
        if (now - flareSeenAt > 300) mark("flare", "gold + streak (per frame)");
        flareSeenAt = now;
    }
    /** @param {number} now @param {string} why */
    const flare2Item = (now, why) => addItem({ kind: "dodge", dir: nextDir(), k: -1, src: "tell", cMs: now + FLARE2_HIT_F * FRAME_MS,
        atMs: now, untilMs: now + FLARE2_HIT_F * FRAME_MS + MISS_GRACE_MS, why });
    /** Per head output (phase 2, from tellPlan): a flare report dodges now; one re-dodge. @param {number} now */
    function flare2Tick(now) {
        const t = pred?.tell;
        const tell = !!t && t.arg >= 1 && t.arg <= 3 && t.p >= FLARE2_P;
        const seen = f2SeenSeq === img.seq;
        if (!t || (!tell && !seen)) return;
        const src = tell ? `${TELL_LABELS[t.arg]} p${Math.round(t.p * 100)}` : "image";
        if (!f2From || now - f2LastAt > FLARE2_GAP_MS) {
            f2From = now;
            f2First = null;
            f2ReDone = false;
            f2S.episodes++;
            inc(f2S.bySrc, tell ? TELL_LABELS[t.arg] : "image");
            mark("flare2", `episode (${src})`);
        }
        f2LastAt = now;
        if (!f2First || (!f2First.pressedAt && !plan.includes(f2First))) {
            // the first dodge (again when the last one was dropped unpressed, e.g. blocked)
            if (inDodge || now - lastDodgeAt < DODGE_CD_MS) return;
            f2First = flare2Item(now, `flare2 first ${src} +${Math.round((now - f2From) / FRAME_MS)}f`);
            f2S.dodges++;
            return;
        }
        if (!f2First.pressedAt || f2ReDone) return;
        const s = now - f2First.pressedAt;
        if (s < DODGE_CD_MS || inDodge || now - lastDodgeAt < DODGE_CD_MS) return;
        /** @param {string} why */
        const skip = (why) => {
            inc(f2S.reSkip, why);
            f2ReDone = true;
            mark("flare2", `no re-dodge (${why})`);
        };
        if (s > FLARE2_REDODGE_MAX_MS) return skip("late");
        if (lastHitAt >= f2First.pressedAt) return skip("hit");
        if (plan.some((x) => x.kind === "parry" && !x.pressedAt && x.atMs - now <= FLARE2_PARRY_GUARD_MS)) return skip("parry due");
        if (now - lastParryAt < ISSUE_LEAD_MS) return skip("parry pressed"); // its window is still to come
        f2ReDone = true;
        f2S.redodges++;
        flare2Item(now, `flare2 re-dodge ${src} +${Math.round(s / FRAME_MS)}f after the first`);
    }

    // --- phase 2 red line (@see RL_DELAY_F): the read per frame, the 卸势 window per head output
    /** @typedef {{on: number, last: number, at: number, y: number, closed: boolean, item: PlanItem | null, moved: Set<number>, dropped: Set<number>, covered: boolean, inWin: boolean}} RlEpisode */
    /** @type {RlEpisode | null} */
    let rlEp = null;
    let rlOdd = false, rlPressAt = 0, rlResolved = true;
    /** @type {number[]} */ const rlCost = [];
    const rlS = { reads: 0, slowReads: 0, lineFrames: 0, onsets: 0, ignored: /** @type {Record<string, number>} */ ({}), planned: 0,
                  covered: 0, moved: 0, droppedInWindow: 0, presses: 0, late: 0, waits: /** @type {Record<string, number>} */ ({}),
                  windowPressBy: /** @type {Record<string, number>} */ ({}), after: /** @type {Record<string, number>} */ ({}),
                  pressF: /** @type {number[]} */ ([]), readMs: /** @type {number[]} */ ([]), calls: /** @type {number[]} */ ([]) };
    const rlResult = () => ({ ...rlS, delayF: redLineF, pressF: stats(rlS.pressF), readMs: stats(rlS.readMs), calls: stats(rlS.calls) });
    /** Per frame before the aux: the red line on this frame -> a new episode at its onset. @param {number} now */
    function redLineRead(now) {
        const slow = rlCost.length >= RL_COST_N && rlCost.reduce((a, b) => a + b, 0) / rlCost.length > RL_COST_MS;
        if (slow) {
            rlOdd = !rlOdd;
            if (rlOdd) return;
            rlS.slowReads++;
        }
        const t0 = Date.now();
        const r = redLine(img);
        const ms = Date.now() - t0;
        rlCost.push(ms);
        if (rlCost.length > RL_COST_N) rlCost.shift();
        rlS.readMs.push(ms);
        rlS.calls.push(r.calls);
        rlS.reads++;
        if (r.y == null) return;
        rlS.lineFrames++;
        const cap = img.time != null ? img.time - (img.age_ms ?? 0) : now; // the line frame's capture time
        if (rlEp && cap - rlEp.last <= RL_GAP_F * FRAME_MS) {
            rlEp.last = cap;
            return;
        }
        rlS.onsets++;
        const fb = Math.max(lastHitAt, lastOkAt);
        const why = fb && fb >= cap - (RL_IGNORE_F - RL_FB_LAG_F) * FRAME_MS ? (lastHitAt >= lastOkAt ? "hit" : "ok") : "";
        rlEp = { on: cap, last: cap, at: cap + redLineF * FRAME_MS, y: r.y, closed: !!why, item: null, moved: new Set(), dropped: new Set(), covered: false, inWin: false };
        if (why) inc(rlS.ignored, why);
        mark("redline", `onset y${r.y} (frame ${Math.round(now - cap)} ms old)${why ? ` ignored: ${why} ${Math.round((cap - fb) / FRAME_MS)}f before` : `, 卸势 at +${redLineF}f`}`);
    }
    /** The red-line 卸势 window (after syncPlan, before executePlan). @param {number} now */
    function redLineTick(now) {
        const ep = rlEp;
        if (!ep || ep.closed) return;
        const lo = ep.on + RL_WIN_LO_F * FRAME_MS, hi = ep.on + RL_WIN_HI_F * FRAME_MS;
        const red = ep.item && plan.includes(ep.item) ? ep.item : null;
        const inWin = lastParryAt >= lo && lastParryAt <= hi;
        // a contact's impact flash: its ok / hit read shows up to RL_FB_LAG_F after the onset
        const fb = Math.max(lastHitAt, lastOkAt);
        if (!inWin && fb >= ep.on - (RL_IGNORE_F - RL_FB_LAG_F) * FRAME_MS && fb <= ep.on + RL_FB_LAG_F * FRAME_MS) {
            const why = lastHitAt >= lastOkAt ? "hit" : "ok";
            ep.closed = true;
            inc(rlS.ignored, `${why} late`);
            if (red && !red.pressedAt) dropItem(red, `redline: ${why} flash`);
            for (const it of plan) if (it.floorMs === ep.at) it.floorMs = 0;
            mark("redline", `ignored: ${why} ${Math.round((fb - ep.on) / FRAME_MS)}f after the onset`);
            return;
        }
        if (now > hi) {
            ep.closed = true;
            if (red && !red.pressedAt) {
                rlS.late++;
                dropItem(red, "redline: window over");
            }
            if (!ep.inWin) mark("redline", "no 卸势 in the window");
            return;
        }
        const fut = plan.filter((x) => x.kind === "parry" && x.src === "fut" && !x.branch && !x.pressedAt);
        const eff = (/** @type {PlanItem} */ x) => Math.max(x.atMs, x.floorMs ?? 0);
        if (inWin) {
            if (!ep.inWin) {
                ep.inWin = true;
                const by = plan.find((x) => x.pressedAt === lastParryAt);
                inc(rlS.windowPressBy, by?.src === "red" ? "red" : by && by.floorMs === ep.at ? "moved" : by ? by.src : cadOn && cadPressAt === lastParryAt ? "cadence" : "other");
            }
            // the window has its 卸势: no second one up to its end
            for (const x of fut) {
                if (eff(x) > hi) continue;
                if (!ep.dropped.has(x.k)) {
                    ep.dropped.add(x.k);
                    rlS.droppedInWindow++;
                }
                dropItem(x, "redline: a 卸势 went in the window");
            }
            if (red && !red.pressedAt) dropItem(red, "redline: a 卸势 went in the window");
            return;
        }
        for (const x of fut) {
            if (x.atMs >= lo || (x.floorMs ?? 0) >= ep.at) continue;
            x.floorMs = ep.at;
            if (!ep.moved.has(x.k)) {
                ep.moved.add(x.k);
                rlS.moved++;
                mark("redline", `fut k${x.k} 卸势 at +${Math.round((x.atMs - ep.on) / FRAME_MS)}f moved to +${redLineF}f`);
            }
        }
        if (fut.some((x) => eff(x) >= lo && eff(x) <= hi)) {
            if (!ep.covered) {
                ep.covered = true;
                rlS.covered++;
            }
            if (red && !red.pressedAt) {
                dropItem(red, "redline: a fut 卸势 covers it");
                ep.item = null;
            }
            return;
        }
        if (!red) {
            if (!ep.item) rlS.planned++;
            ep.item = addItem({ kind: "parry", k: -1, src: "red", cMs: ep.on + RL_CONTACT_F * FRAME_MS, atMs: Math.max(ep.at, now), untilMs: hi,
                                onMs: ep.on, why: `redline +${redLineF}f` });
        }
    }
    /** A red item is being pressed: its why is the onset offset. @param {PlanItem} it */
    function rlPressed(it) {
        const f = (Date.now() - (it.onMs ?? 0)) / FRAME_MS;
        it.why = `redline +${f.toFixed(1)}f`;
        rlS.presses++;
        rlS.pressF.push(Math.round(f * 10) / 10);
        rlPressAt = Date.now();
        rlResolved = false;
    }
    /** The first ok / hit after a red-line 卸势 (within RL_MISS_F). @param {number} now @param {string} kind */
    function rlOutcome(now, kind) {
        if (rlResolved || !rlPressAt) return;
        rlResolved = true;
        inc(rlS.after, now - rlPressAt <= RL_MISS_F * FRAME_MS ? kind : `${kind} late`);
    }

    // --- potion (@see POTION_QUIET_MS)
    /** Why the drink must wait now ("" = go). @param {number} now */
    function potionUnsafe(now) {
        const urgent = (hpNow != null && hpNow <= POTION_URGENT) || (potionDueAt > 0 && now - potionDueAt >= POTION_WAIT_MAX_MS);
        if (inCurtain) return "curtain";
        const own = Math.max(lastParryAt, lastDodgeAt, lastOffDownAt);
        if (now - own < (urgent ? Math.min(POTION_GAP_MS, 400) : POTION_GAP_MS)) return "own press";
        if (offHold || offWalking || now < offBusyUntil) return "offense";
        if (now - lastHitAt < (urgent ? Math.min(POTION_QUIET_MS, POTION_URGENT_QUIET_MS) : POTION_QUIET_MS)) return "after-hit";
        if (urgent) return "";
        // the cadence: its gate is the quiet test (no fut items; the fut1 mass below is not used)
        if (cadGate()) return "gate";
        if (plan.some((it) => !it.pressedAt && it.kind !== "potion" && it.atMs - now <= POTION_PLAN_MS)) return "plan";
        const t = pred?.tell;
        if (t && t.arg !== 0 && t.p >= TELL_TH) return "tell";
        if (!pred) return "no pred";
        if (cadOn) return "";
        let m = 0;
        for (let i = 0; i < POTION_MASS_BINS; i++) m += futBin(0, i);
        if (m >= POTION_MASS_TH) return "mass";
        return "";
    }
    /** The drink is due and waiting for a safe moment (the offense holds off meanwhile). */
    function potionDue() {
        if (maxPotions <= 0 || potionsUsed >= maxPotions || hpNow == null || hpNow > POTION_HP) return false;
        if (potionTaps >= POTION_MAX_TAPS) return false;
        return !(lastPotionOkAt && Date.now() - lastPotionOkAt < POTION_SETTLE_MS);
    }
    /** Per frame: the tap counts once hp is up POTION_HEAL; a blow or POTION_CONFIRM_MS without the heal = not
     * counted, the hold ends there. A heal still showing within POTION_CONFIRM_MS after a blow counts late. @param {number} now */
    function potionTick(now) {
        if (potionLate) {
            if (now - potionLate.at > POTION_CONFIRM_MS) potionLate = null;
            else if (hpNow != null && hpNow >= potionLate.hp0 + POTION_HEAL) {
                potionsUsed++;
                potS.oks++;
                potS.fails--;
                potS.lateOks++;
                lastPotionOkAt = now;
                mark("potion", `late heal ${now - potionLate.at} ms after the tap (${potionsUsed}/${maxPotions})`);
                potionLate = null;
            }
        }
        if (!potionPend) return;
        const p = potionPend;
        const healed = hpNow != null && hpNow >= p.hp0 + POTION_HEAL;
        const hit = lastHitAt > p.at;
        if (!healed && !hit && now - p.at < POTION_CONFIRM_MS) return;
        potionPend = null;
        const it = plan.find((x) => x.kind === "potion");
        if (it) plan.splice(plan.indexOf(it), 1);
        potionHoldUntil = Math.min(potionHoldUntil, now);
        if (healed) {
            potionsUsed++;
            potS.oks++;
            potS.healMs.push(now - p.at);
            potS.gains.push(Math.round(((hpNow ?? 0) - p.hp0) * 100) / 100);
            lastPotionOkAt = now;
            mark("potion", `healed ${Math.round(p.hp0 * 100)}%->${Math.round((hpNow ?? 0) * 100)}% after ${now - p.at} ms (${potionsUsed}/${maxPotions})`);
        } else {
            potS.fails++;
            const why = hit ? "hit" : "no heal";
            potS.failWhy[why] = (potS.failWhy[why] ?? 0) + 1;
            lastPotionFailAt = now;
            if (hit) potionLate = { at: p.at, hp0: hpNow ?? 0 };
            mark("potion", `${hit ? `hit ${now - p.at} ms into the drink` : `no heal ${POTION_CONFIRM_MS} ms after the tap`}, not counted`);
        }
    }
    // the slot swap before a drink: the potion slot sometimes holds the other item mid-fight (r075 / r103 / r105: it
    // turned to the poison by itself, then every drink tap used poison). At a safe drink moment, a slot read twice
    // without the potion's white gourd gets prep's swap (ITEM_OPEN, ITEM_PICK PREP_MENU_MS later), parries held off
    // meanwhile (potionHoldUntil), at most SLOT_SWAPS_MAX times a run.
    const SLOT_SWAPS_MAX = 3;
    let slotMiss = 0, slotSwaps = 0;
    /** @type {{at: number, picked: boolean} | null} */ let slotSwap = null;
    /** Per frame: plan the drink at a safe moment. @param {number} now */
    function planPotion(now) {
        if (slotSwap) {
            if (!slotSwap.picked && now - slotSwap.at >= PREP_MENU_MS) {
                tap(ITEM_PICK);
                slotSwap.picked = true;
            }
            if (now - slotSwap.at >= 2 * PREP_MENU_MS) {
                slotSwap = null;
                slotMiss = 0;
            }
            return;
        }
        if (maxPotions <= 0 || potionsUsed >= maxPotions) return;
        if (hpNow == null || hpNow > POTION_HP) {
            potionDueAt = 0;
            return;
        }
        if (potionPend || now - lastPotionFailAt < POTION_RETRY_MS || potionTaps >= POTION_MAX_TAPS) return;
        if (lastPotionOkAt && now - lastPotionOkAt < POTION_SETTLE_MS) return; // the bar still fills
        if (!potionDueAt) potionDueAt = now;
        if (now < staggerUntil || now < potionHoldUntil || inDodge) return;
        if (plan.some((it) => it.kind === "potion")) return;
        const why = potionUnsafe(now);
        if (why) {
            potS.waitWhy[why] = (potS.waitWhy[why] ?? 0) + 1;
            if (now - lastPotionWaitMark > 1000) {
                lastPotionWaitMark = now;
                mark("plan", `potion wait: ${why} hp ${Math.round(hpNow * 100)}%`);
            }
            return;
        }
        if (slotSwaps < SLOT_SWAPS_MAX && !color({ ...ICON_WHITE, image: img, roi: SLOT_ROI, count: SLOT_POTION_PX }).hit) {
            if (++slotMiss < 2) return;
            slotSwaps++;
            slotSwap = { at: now, picked: false };
            potionHoldUntil = now + 2 * PREP_MENU_MS + 100;
            tap(ITEM_OPEN);
            mark("potion", `slot without the potion: swap ${slotSwaps}`);
            return;
        }
        slotMiss = 0;
        addItem({ kind: "potion", k: -1, src: "potion", atMs: now, cMs: now, untilMs: now + 1500, why: `hp ${Math.round(hpNow * 100)}% safe` });
    }

    // ========================================================================================================= offense
    // Reads plan / pred / lastHitAt / lastOkAt / staggerUntil / inDodge / inCurtain / potionHoldUntil / bossNow / qiNow /
    // qiEmpty; writes its own state, plus the unpressed plan items it drops in a 气竭 window.
    let offUpAt = 0, offTouched = false; // OFF_CONTACT is down until offUpAt (0: up)
    let grabHoldAt = 0; // the first tell of the current held 蓄力 (@see offHoldAbort)
    /** Put the offense finger down on p for ms (the lift comes from offUp, every loop turn). @param {Point} p @param {number} ms */
    function offDown(p, ms) {
        if (heldBack(p)) return;
        if (offUpAt) touch.up(OFF_CONTACT);
        touch.down(p, OFF_CONTACT);
        lastOffDownAt = Date.now();
        offUpAt = Date.now() + ms;
        offTouched = true;
    }
    /** A defense touch is coming: a held 蓄力 lets go first (E0: a finger still down restarts the 蓄力). @param {string} why */
    function offYield(why) {
        if (offHold) offRelease(Date.now(), `defense ${why}`, true);
    }
    /** Lift the offense finger when due (or now). */
    function offUp(force = false) {
        if (!offUpAt || (!force && Date.now() < offUpAt)) return;
        touch.up(OFF_CONTACT);
        offUpAt = 0;
    }

    let offRunReady = -1, offM30 = 1, offM40 = 1, offM60 = 1, offTellAt = 0, offHitSeen = 0;
    /** fut1 mass in bins 0..n-1. @param {number} n */
    const offMass = (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += futBin(0, i);
        return s;
    };
    const offState = () => `m30 ${offM30.toFixed(3)} m40 ${offM40.toFixed(3)} combo ${pred ? `${COMBO6_LABELS[pred.combo.arg]} ${pred.combo.p.toFixed(2)}` : "-"}`;
    /** Per frame, before executePlan: lifts, the 气竭 window's plan filter, hits for the action results, a held 蓄力's
     * rules. @param {number} now */
    function offenseGuard(now) {
        offUp();
        if (qp.shown) {
            // the boss strikes nothing in 衰弱: the plan items would only eat the window (until the 处决 tap, a dodge
            // takes us out of its reach)
            for (const it of [...plan]) {
                if (it.pressedAt) continue;
                if (it.src === "fut") {
                    plan.splice(plan.indexOf(it), 1);
                    qp.futDrops++;
                } else if (!qp.tapAt) {
                    plan.splice(plan.indexOf(it), 1);
                    qpS.preDrops++;
                    mark("qi", `qiPlan: ${it.kind} ${it.src} dropped before 处决 (${it.why ?? ""})`);
                }
            }
        }
        if (lastHitAt > offHitSeen) {
            offHitSeen = lastHitAt;
            offHitTs.push(lastHitAt);
            if (offHitTs.length > 64) offHitTs.shift();
        }
        if (offHold) {
            const hw = offHoldAbort(now);
            if (hw) offRelease(now, hw, true);
        }
    }
    /** Per frame, after expire: the masses, a hold's end, walking, the results, 奇术 / follow-up, 气竭, the near gate.
     * @param {number} now */
    function offenseTick(now) {
        offUp();
        if (pred && ready !== offRunReady) { // a new head output
            offRunReady = ready;
            offM30 = offMass(OFF_QUIET_BINS);
            offM40 = offMass(OFF_STRONG_BINS);
            offM60 = offMass(10);
            if (pred.tell.arg !== 0 && pred.tell.p >= TELL_TH) offTellAt = now;
        }
        if (offHold && now >= offHold.until) offRelease(now, "time", false);
        offWalkTick(now);
        offEvalTick(now);
        if (pred) p6Tick(now); // before the 气竭 window's pick: 奇术 goes first
        qpTick(now);
        bossRingTick(now);
        if (pred && !qp.shown) okTick(now);
    }

    // --- actions
    /** @param {Record<string, number>} o @param {string} k @param {number} [d] */
    const inc = (o, k, d = 1) => { o[k] = (o[k] ?? 0) + d; };
    /** @type {{a: string, src: string, t: number, b0: number, done: boolean, evalAt: number, sok: number, sdrop: number}[]} */
    const offRecs = [];
    /** @type {{n: Record<string, number>, hit1s: Record<string, number>, dropPx: Record<string, number>, dropN: Record<string, number>}} */
    const offActS = { n: {}, hit1s: {}, dropPx: {}, dropN: {} };
    /** @type {Record<string, number>} */ const offStopWhy = {}; // why an action / a set / a step stopped early
    /** @type {{started: number, done: number, bursts: number, abandoned: Record<string, number>}} */
    const offSetS = { started: 0, done: 0, bursts: 0, abandoned: {} };
    const offHoldS = { n: 0, full: 0, early: 0, heldMs: /** @type {number[]} */ ([]) };
    const offWalkS = { n: 0, ms: 0 };
    /** @type {number[]} */ const offHitTs = [];
    let offBusyUntil = 0, burstAt = 0, offSetRetryAt = 0;
    let offWalking = false, offWalkUntil = 0, offWalkAt = 0, offWalkWhy = "";
    /** @type {{a: string, src: string, startAt: number, until: number} | null} */
    let offHold = null;
    /** @type {{step: string, stepAt: number, readyAt: number, tapAt: number, tries: number, gone: boolean, goneAt: number} | null} */
    let hd = null; // the committed 横刀 set
    /** @type {string | null} */ let offW = null; // the weapon (4 Hz read)
    let offBuffSeen = false; // 唤千军 lit (4 Hz)

    /** A combat.js template on this frame. @param {string} k */
    const offSeen = (k) => perFrame(`t:${k}`, (im) => match(OFF_T[k][0], { image: im, roi: OFF_T[k][1], threshold: OFF_ICON_TH }).hit);
    /** combat.js weapon(): 陌刀 / 横刀 by the 蓄力 / 重击 button, else by 突进's icon (衰弱 turns 横刀's 重击 into a swirl). */
    function offWeaponNow() {
        if (offSeen("modao")) return "modao";
        if (offSeen("hengdao")) return "hengdao";
        return offSeen("mdash") ? "modao" : offSeen("swirl") || offSeen("dash") || offSeen("strike") || offSeen("damage") ? "hengdao" : null;
    }
    /** slowQueue (4 Hz): the weapon and 唤千军's button. */
    function offIconsRead() {
        offW = offWeaponNow();
        offBuffSeen = offW === "modao" ? offSeen("buff") : false;
    }
    /** fut1 mass of the contacts that would come before an action of noCancel ms can be cut. @param {number} ms */
    function offHorizon(ms) {
        const f = (ms + ISSUE_LEAD_MS) / FRAME_MS;
        let s = 0;
        for (let i = 0; i < 10; i++) if (FUT_LO[i] < f) s += futBin(0, i);
        return s;
    }
    /** Do action a (a tap of ms on p, or the hold's down) and log it. @param {string} a @param {string} src @param {Point} p @param {number} [ms] */
    function offAct(a, src, p, ms = OFF_TAP_MS) {
        offDown(p, ms);
        inc(offActS.n, a);
        const t = Date.now();
        const sok = lastOkAt ? t - lastOkAt : -1, sdrop = lastDropAt ? t - lastDropAt : -1;
        const evalAt = a === "charge" || a === "hlight" ? Infinity : t + (a === "qishu" ? QS_EVAL_MS : OFF_EVAL_MS);
        offRecs.push({ a, src, t, b0: bossNow, done: false, evalAt, sok, sdrop });
        mark("off", `act ${a} ${src} ${offState()} boss ${bossNow} sok ${sok} sdrop ${sdrop}`);
    }
    /** A held 蓄力 (陌刀 蓄力 on CHARGE, 横刀 轻蓄力 on LIGHT). @param {string} a @param {string} src @param {number} ms @param {Point} [p] */
    function offStartCharge(a, src, ms, p = CHARGE) {
        offAct(a, src, p, ms);
        const now = Date.now();
        offHold = { a, src, startAt: now, until: now + ms };
        offHoldS.n++;
    }
    /** The guard's rules for a held 蓄力 ("" = hold on). @param {number} now */
    function offHoldAbort(now) {
        if (!offHold) { grabHoldAt = 0; return ""; }
        const qi = offHold.src === "qi";
        if (lastHitAt > offHold.startAt) return "hit";
        if (inCurtain) return "curtain";
        if (inDodge) return "dodge";
        if (now < potionHoldUntil) return "potion";
        const t = pred?.tell;
        if (!qi && t && t.arg >= 1 && t.arg <= 3 && t.p >= TELL_TH) {
            // A flare that will be dodged keeps the 蓄力 until pressDodge's own offYield releases it in the dodge's tick
            // (the combat.js order): releasing here leaves the release recovery in front of the dodge (726 grab
            // 3291 / 3692: no dodge movement in the video). A 600 ms fallback still lets go when the dodge never comes.
            if (!grabHoldAt) {
                grabHoldAt = now;
                mark("off", `flare tell: hold charge for the dodge (${t.label} p${Math.round(t.p * 100)})`);
            }
            if (now - grabHoldAt <= 600) return "";
            grabHoldAt = 0;
            return `tell(${t.label})`;
        }
        grabHoldAt = 0;
        const lim = OFF_ABORT_MS + OFF_NO_CANCEL_MS.charge;
        const near = plan.find((it) => !it.pressedAt && it.atMs - now <= lim && !(qi && it.src === "fut"));
        if (near && near.kind === "dodge") {
            // the dodge plan is the next touch: pressDodge's offYield releases the 蓄力 in that same tick (730 t2379:
            // releasing here put the recovery in front of the dodge and it still ate the grab)
            if (!grabHoldAt) {
                grabHoldAt = now;
                mark("off", `dodge plan: hold charge for the dodge (${near.src} c+${Math.round((near.cMs - now) / FRAME_MS)}f)`);
            }
            if (now - grabHoldAt <= 600) return "";
        }
        return near ? `plan(${near.kind} ${near.src})` : "";
    }
    /** @param {number} now @param {string} why @param {boolean} early */
    function offRelease(now, why, early) {
        if (!offHold) return;
        offUp(true);
        const held = now - offHold.startAt;
        offHoldS.heldMs.push(held);
        if (early) {
            offHoldS.early++;
            inc(offStopWhy, `${offHold.a}:${why.replace(/\(.*$/, "")}`);
        } else offHoldS.full++;
        mark("off", `release ${offHold.a} ${offHold.src} (${why}) after ${held} ms`);
        for (const r of offRecs) if (r.evalAt === Infinity) { if (bossNow > 50) r.b0 = bossNow; r.evalAt = now + OFF_EVAL_MS; }
        offHold = null;
        offBusyUntil = Math.max(offBusyUntil, now + OFF_SLASH_MS); // the slash comes out meanwhile
    }
    /** A forward push of ms (contact 0; never in curtain / with the side stick on). @param {number} now @param {number} ms @param {string} why */
    function offWalk(now, ms, why) {
        if (inCurtain || stickSide !== 0 || inDodge) return false;
        strideF(1);
        offWalking = true;
        offWalkAt = now;
        offWalkUntil = now + ms;
        offWalkWhy = why;
        offWalkS.n++;
        mark("off", `walk ${why} ${ms} ms`);
        return true;
    }
    /** @param {string} why */
    function offWalkStop(why) {
        if (!offWalking) return;
        const now = Date.now();
        strideF(0);
        offWalking = false;
        offWalkS.ms += now - offWalkAt;
        mark("off", `walk over (${why}) after ${now - offWalkAt} ms`);
        if (why !== "time") inc(offStopWhy, `walk:${why.replace(/\(.*$/, "")}`);
    }
    /** @param {number} now */
    function offWalkTick(now) {
        if (!offWalking) return;
        if (inDodge || inCurtain || now < staggerUntil || now < potionHoldUntil) offWalkStop("defense");
        else if (now >= offWalkUntil) offWalkStop("time");
    }
    /** Each action's 1.2 s result: the boss px it took, a hit within 1 s; the whiff loop. @param {number} now */
    function offEvalTick(now) {
        for (const r of offRecs) {
            if (r.done || now < r.evalAt) continue;
            r.done = true;
            const hit = offHitTs.some((t) => t > r.t && t <= r.t + 1000);
            if (hit) inc(offActS.hit1s, r.a);
            const drop = r.b0 > 50 && bossNow > 50 ? r.b0 - bossNow : null;
            if (drop != null) {
                inc(offActS.dropPx, r.a, drop);
                inc(offActS.dropN, r.a);
            }
            mark("off", `result ${r.a} ${r.src}: boss ${r.b0} -> ${bossNow}${drop != null ? ` (${drop} px)` : ""}${hit ? ", hit within 1 s" : ""} sok ${r.sok} sdrop ${r.sdrop}`);
            okResult(r, drop);
        }
        while (offRecs.length && offRecs[0].done) offRecs.shift();
    }

    // --- the committed 横刀 set (combat.js hengdaoPart), one step per frame
    const burstReady = (/** @type {number} */ now) => !burstAt || now - burstAt >= BURST_CD_MS;
    /** @param {number} now @param {string} why ("" = done) */
    function hdEnd(now, why) {
        if (!hd) return;
        if (why) {
            inc(offSetS.abandoned, why.replace(/\(.*$/, ""));
            inc(offStopWhy, `set:${why.replace(/ at .*$/, "")}`);
            offSetRetryAt = now + OFF_SET_RETRY_MS;
        } else offSetS.done++;
        mark("off", `横刀 set ${why ? `given up (${why})` : "done"} at ${hd.step}`);
        hd = null;
    }
    /** @param {string} step @param {number} now */
    function hdNext(step, now) {
        if (!hd) return;
        Object.assign(hd, { step, stepAt: now, readyAt: 0, tapAt: 0, tries: 0, gone: false, goneAt: 0 });
    }
    /** Ready but held: give the set up after OFF_COMMIT_PAUSE_MS. @param {number} now */
    function hdWait(now) {
        if (!hd) return;
        if (!hd.readyAt) hd.readyAt = now;
        else if (now - hd.readyAt > OFF_COMMIT_PAUSE_MS) hdEnd(now, `pause at ${hd.step}`);
    }
    /** @param {string} a @param {Point} p @param {number} now */
    function hdTap(a, p, now) {
        if (!hd) return;
        offAct(a, "set", p);
        hd.tapAt = now;
        hd.tries++;
        hd.readyAt = 0;
    }
    /** @param {number} now */
    function hdTick(now) {
        if (!hd) return;
        const s = hd;
        // a 金光 / curtain tell gives it up (not inside 爆发's 2.4 s: its own gold, swallowed anyway)
        const tw = commitTell(now);
        if (tw) return hdEnd(now, `tell ${tw} at ${s.step}`);
        if (s.step === "back") return hdEnd(now, ""); // no switch back: the next 蓄力 switches
        if (s.step === "switch") {
            const w = offWeaponNow();
            if (w === "hengdao") {
                offW = w;
                hdNext("dash1", now);
                return;
            }
            if (s.tapAt && now - s.tapAt < SWITCH_WAIT_MS) return;
            if (s.tries >= 2) return hdEnd(now, `${s.step} failed`);
            if (commitCan(Date.now())) hdTap("switch", SWITCH, now);
            else hdWait(now);
            return;
        }
        if (s.step === "dash1" || s.step === "dash2") {
            if (s.tapAt) {
                if (!offSeen("dash")) s.gone = true;
                if (now - s.tapAt >= DASH_GONE_MS) {
                    if (!s.gone) mark("off", `${s.step}: 突进's icon never went`);
                    hdNext(s.step === "dash1" ? "burst" : "strike", now);
                }
                return;
            }
            if (s.step === "dash1" && !offSeen("dash")) return hdNext("burst", now); // no charge: 爆发 at once
            if (s.step === "dash2") {
                if (offSeen("strike")) return hdNext("strike", now);
                if (now - burstAt > DASH_AFTER_BURST_MS + DASH_BACK_MS) {
                    mark("off", "突进: no second charge in sight");
                    return hdNext("back", now);
                }
                if (now - burstAt < DASH_AFTER_BURST_MS || !offSeen("dash")) return; // 爆发 still plays / no icon yet
            }
            if (commitCan(Date.now())) hdTap("dash", DASH, now);
            else hdWait(now);
            return;
        }
        if (s.step === "burst") {
            if (s.tapAt) {
                if (!offSeen("burst")) {
                    if (!s.goneAt) s.goneAt = now;
                    else if (now - s.goneAt >= GLOW_MS) { // its button gone (cooling): 爆发 is out
                        burstAt = s.tapAt;
                        offSetS.bursts++;
                        mark("off", `爆发 out after ${s.tries} tap(s)`);
                        return hdNext("dash2", now);
                    }
                    return;
                }
                s.goneAt = 0;
                if (now - s.tapAt < BURST_TAP_MS) return;
                if (s.tries >= BURST_TAPS) return hdEnd(now, "爆发 not out");
            } else if (!offSeen("burst")) {
                if (now - s.stepAt > OFF_SKILL_PAUSE_MS) hdEnd(now, "no 爆发 icon");
                return;
            }
            if (commitCan(Date.now())) hdTap("burst", BUFF, now);
            else hdWait(now);
            return;
        }
        if (s.step === "strike") {
            if (s.tapAt) {
                if (!offSeen("strike")) s.gone = true;
                if (now - s.tapAt >= OFF_COST_MS.strike) {
                    if (!s.gone && s.tries < 2) {
                        s.tapAt = 0; // the arrow still there: once more
                        return;
                    }
                    hdNext("back", now);
                }
                return;
            }
            if (!offSeen("strike")) {
                if (now - s.stepAt > STRIKE_WAIT_MS) {
                    mark("off", "伤害: never showed");
                    hdNext("back", now);
                }
                return;
            }
            if (commitCan(Date.now())) hdTap("strike", DASH, now);
            else hdWait(now);
        }
    }

    // --- the near gate (@see OFF_OK_MS) and the far close-in
    /** @type {{t: number, b: number}[]} */ const bossRing = [];
    let lastDropAt = 0, okOpenAt = 0, okTickAt = 0, okWhiff = 0, okFarByWhiff = false, okWhiffAt = 0, okFarSince = 0;
    let ranshiAt = 0; // 燃此魂 out, its ending tap still due
    let okSwitchPend = 0, okSwitchAt = 0, okDeferAt = 0;
    const DMG_ACTS = new Set(["light", "hlight", "charge", "dash", "strike", "burst", "farRanshi", "ranshiEnd", "farDash", "qishu", "follow"]);
    /** @typedef {{n: number, hit: number, px: number}} OkRes */
    const okS = {
        evalMs: 0, openMs: 0, farMs: 0, opens: 0, farByWhiff: 0, switchPend: 0, chargeDefers: 0,
        /** @type {Record<string, number>} */ closeWhy: {}, /** @type {Record<string, number>} */ closeIns: {},
        /** @type {Record<string, OkRes>} */ res: { near: { n: 0, hit: 0, px: 0 }, far: { n: 0, hit: 0, px: 0 } },
        /** @type {Record<string, OkRes>} */ byAct: {},
    };
    /** The boss bar ring (fight reads) and lastDropAt: the bar down >= OFF_DROP_PX within OFF_DROP_WIN_MS. @param {number} now */
    function bossRingTick(now) {
        if (bossNow <= 50) return;
        const last = bossRing[bossRing.length - 1];
        if (last && now - last.t < 200) return;
        bossRing.push({ t: now, b: bossNow });
        while (bossRing.length && now - bossRing[0].t > OFF_BOSS_RING_MS) bossRing.shift();
        if (bossRing.length < 3) return;
        const cur = Math.max(bossRing[bossRing.length - 1].b, bossRing[bossRing.length - 2].b); // one low read is no drop
        let peak = 0;
        for (const s of bossRing) if (now - s.t <= OFF_DROP_WIN_MS) peak = Math.max(peak, s.b);
        const d = peak - cur;
        if (d >= OFF_DROP_PX && d <= OFF_DROP_MAX_PX) lastDropAt = now;
    }
    const sinceOk = (/** @type {number} */ now) => (lastOkAt ? now - lastOkAt : Infinity);
    const sinceDrop = (/** @type {number} */ now) => (lastDropAt ? now - lastDropAt : Infinity);
    /** 陌刀 突进 (燃此魂) lit: its icon white (combat.js dashLit). */
    const mdashLit = () => offSeen("mdash") && perFrame("mdashLit", (im) => color({ ...ICON_WHITE, image: im, roi: MDASH_LIT_ROI, count: MDASH_LIT_PX }).hit);
    /** Why the near gate is shut now ("" = open). @param {number} now */
    function okGateWhy(now) {
        if (!pred) return "no pred";
        if (inCurtain) return "curtain";
        if (inDodge) return "dodge";
        if (now < staggerUntil) return "stagger";
        if (now < potionHoldUntil) return "potion";
        if (potionDue()) return "potion due";
        if (now - lastHitAt < OFF_OK_AFTER_HIT_MS) return "after-hit";
        if (now - offTellAt < OFF_AFTER_TELL_MS || now - flareSeenAt < OFF_AFTER_TELL_MS
            || now - curtainLastAt < OFF_AFTER_TELL_MS || now - lastDarkAt < OFF_AFTER_TELL_MS) return "after-tell";
        if (comboRunning()) return "combo";
        if (offM30 > OFF_GATE_VETO_TH) return "m30";
        if (okFarByWhiff) return "whiffs";
        if (sinceOk(now) > OFF_OK_MS && sinceDrop(now) > OFF_DROP_WIN_MS) return "not near";
        return "";
    }
    /** Action a fits now (no gate here): its horizon below OFF_VETO_TH, no plan item before it can be cut. @param {string} a @param {number} now */
    function okCan(a, now) {
        if (offHold || offWalking || hd || now < offBusyUntil || bossNow <= 50 || cadGate()) return false;
        const nc =Math.max(OFF_NO_CANCEL_MS[a] ?? 0, burstAt > 0 ? burstAt + OFF_NO_CANCEL_MS.burst - now : 0);
        if (offHorizon(nc) >= OFF_VETO_TH) return false;
        return !plan.some((it) => !it.pressedAt && it.atMs - now <= nc + OFF_ABORT_MS);
    }
    /** A committed step may tap now: only the defense's own states hold it. @param {number} now */
    function commitCan(now) {
        if (inCurtain || inDodge || now < staggerUntil || now < potionHoldUntil || now < offBusyUntil || bossNow <= 50) return false;
        if (offHold || offWalking || potionDue()) return false;
        return !plan.some((it) => !it.pressedAt && Math.abs(it.atMs - now) <= 100); // not on top of a defense press
    }
    /** A 金光 / curtain tell that gives a committed set up ("" = none; not inside 爆发's 2.4 s). @param {number} now */
    function commitTell(now) {
        if (hd && hd.step === "burst" && hd.tapAt) return "";
        if (burstAt && now - burstAt < OFF_NO_CANCEL_MS.burst) return "";
        if (inCurtain) return "curtain";
        const t = pred?.tell;
        if (t && t.arg !== 0 && t.p >= TELL_TH) return t.label;
        if (now - flareSeenAt < 300) return "flare image";
        return "";
    }
    /** An action's 1.2 s result: near / far tallies, the whiff loop. @param {{a: string, src: string, sok: number}} r @param {number | null} drop */
    function okResult(r, drop) {
        if (!DMG_ACTS.has(r.a) || drop == null) return;
        const hit = drop >= OFF_DROP_PX;
        const k = r.sok >= 0 && r.sok <= OFF_NEAR_OK_MS ? "near" : "far";
        const o = okS.res[k];
        o.n++;
        o.px += drop;
        if (hit) o.hit++;
        const b = (okS.byAct[r.a] ??= { n: 0, hit: 0, px: 0 });
        b.n++;
        b.px += drop;
        if (hit) b.hit++;
        if (r.src !== "ok" && r.src !== "far") return;
        okWhiff = hit ? 0 : okWhiff + 1;
        if (okWhiff >= OFF_WHIFF_FAR && !okFarByWhiff) {
            okFarByWhiff = true;
            okWhiffAt = Date.now();
            okS.farByWhiff++;
            mark("off", `far: ${okWhiff} whiffs in a row`);
        }
    }
    /** Far for OFF_FAR_MS: one close-in (燃此魂 / 突进 when lit, else a forward push). @param {number} now */
    function farCloseIn(now) {
        if (inCurtain || inDodge || now < staggerUntil || now < potionHoldUntil || bossNow <= 50 || potionDue()) return false;
        if (offM30 > OFF_VETO_TH || cadGate() || plan.some((it) => !it.pressedAt && it.atMs - now <= OFF_GUARD_MS)) return false;
        const far = now - okFarSince;
        okFarSince = now; // re-armed
        const w = offW;
        if (w === "modao" && mdashLit()) {
            inc(okS.closeIns, "ranshi");
            offAct("farRanshi", "far", DASH);
            ranshiAt = now;
        } else if (w === "hengdao" && offSeen("dash")) {
            inc(okS.closeIns, "dash");
            offAct("farDash", "far", DASH);
            offBusyUntil = now + OFF_COST_MS.dash;
        } else if (offWalk(now, OFF_FAR_PUSH_MS, "far push")) inc(okS.closeIns, "push");
        else return false;
        mark("off", `far ${far} ms: close-in (sok ${sinceOk(now)}, sdrop ${sinceDrop(now)})`);
        return true;
    }
    /** A 蓄力 may start now (m60 below OFF_CHARGE_FREE); a deferral is counted / marked once per run of frames. @param {number} now @param {string} a */
    function okChargeFree(now, a) {
        if (offM60 < OFF_CHARGE_FREE) return true;
        if (now - okDeferAt > 1000) {
            okS.chargeDefers++;
            mark("off", `${a} deferred: m60 ${offM60.toFixed(3)} >= ${OFF_CHARGE_FREE} ${offState()}`);
        }
        okDeferAt = now;
        return false;
    }
    /** @param {string} a @param {number} ms @param {Point} [p] */
    function okCharge(a, ms, p = CHARGE) {
        okSwitchPend = 0;
        offStartCharge(a, "ok", ms, p);
    }
    /** The near gate's action pick. @param {number} now @param {boolean} pend only the 蓄力 a switch was for */
    function okAct(now, pend) {
        const hot = burstAt > 0 && now - burstAt < HOT_MS;
        if (okSwitchPend && now < okSwitchPend) offW = offWeaponNow() ?? offW; // after a switch: per frame, not 4 Hz
        const w = offW;
        const so = sinceOk(now);
        if (!pend && w && burstReady(now) && now >= offSetRetryAt && commitCan(now) && !cadGate()) {
            hd = { step: w === "hengdao" ? "dash1" : "switch", stepAt: now, readyAt: 0, tapAt: 0, tries: 0, gone: false, goneAt: 0 };
            offSetS.started++;
            mark("off", `横刀 set start (${w}, committed) sok ${so} ${offState()}`);
            hdTick(now);
            return;
        }
        if (w === "modao") {
            if (hot && okCan("charge", now)) {
                if (okChargeFree(now, "charge")) return okCharge("charge", OFF_HOT_HOLD_MS);
            } else if (!hot && !pend && now - okSwitchAt >= SWITCH_WAIT_MS && okCan("switch", now)) {
                // 横刀 the rest of the time: its ok follow-up (追击重击) and 爆发 pay, a cold 蓄力 was mostly cut by
                // our own 卸势 (teacher, 2026-10-23)
                offAct("switch", "ok", SWITCH);
                okSwitchAt = now;
                offBusyUntil = now + OFF_COST_MS.switch;
                return;
            }
        } else if (w === "hengdao" && !pend && hot && now - okSwitchAt >= SWITCH_WAIT_MS && okCan("switch", now)) {
            offAct("switch", "ok", SWITCH); // only for the hot 蓄力 right after it
            okSwitchAt = now;
            offBusyUntil = now + 300;
            okSwitchPend = now + SWITCH_WAIT_MS + OFF_SWITCH_PEND_MS;
            okS.switchPend++;
            return;
        }
        if (pend) return;
        if (w === "modao" && offBuffSeen && so <= OFF_FRESH_OK_MS && okCan("buff", now)) {
            offAct("buff", "ok", BUFF);
            offBusyUntil = now + OFF_COST_MS.buff;
            offBuffSeen = false;
            return;
        }
        // the filler is 横刀's only: 陌刀 轻击 does little (teacher, 2026-10-23); 陌刀 waits for the switch back
        if (w === "hengdao" && okCan("hlight", now)) okCharge("hlight", HLIGHT_HOLD_MS, LIGHT);
    }
    /** Per frame (not in a 气竭 window): far state, the set, the gate, the action. @param {number} now */
    function okTick(now) {
        const dt = okTickAt ? Math.min(200, now - okTickAt) : 0;
        okTickAt = now;
        const fight = bossNow > 50;
        if (okFarByWhiff && (lastOkAt > okWhiffAt || lastDropAt > okWhiffAt)) {
            okFarByWhiff = false;
            okWhiff = 0;
            mark("off", `near again (${lastOkAt > okWhiffAt ? "ok" : "boss drop"})`);
        }
        const far = (sinceOk(now) > OFF_NEAR_OK_MS && sinceDrop(now) > OFF_NEAR_DROP_MS) || okFarByWhiff;
        if (!far || !fight) okFarSince = 0;
        else if (!okFarSince) okFarSince = now;
        if (hd) hdTick(now);
        const why = okGateWhy(now);
        if (fight) {
            okS.evalMs += dt;
            if (okOpenAt) okS.openMs += dt;
            if (far) okS.farMs += dt;
        }
        if (!why && !okOpenAt) {
            okOpenAt = now;
            okS.opens++;
            mark("off", `ok-gate open sok ${sinceOk(now)} sdrop ${sinceDrop(now)} ${offState()}`);
        } else if (why && okOpenAt) {
            inc(okS.closeWhy, why);
            mark("off", `ok-gate close ${why} after ${now - okOpenAt} ms`);
            okOpenAt = 0;
        }
        if (ranshiAt) {
            if (now - ranshiAt < RANSHI_END_MS) return;
            // late (the 气竭 window took the frames): a tap now would start a new 燃此魂
            const cut = Math.max(lastParryAt, lastDodgeAt, lastHitAt) > ranshiAt || now - ranshiAt > RANSHI_END_MS + 500;
            ranshiAt = 0;
            if (cut) mark("off", "燃此魂 cut or late: no ending tap");
            else {
                offAct("ranshiEnd", "far", DASH);
                offBusyUntil = now + OFF_COST_MS.ranshi;
                return;
            }
        }
        if (hd || offHold || offWalking || now < offBusyUntil) return;
        if (pfHold(now)) return; // the follow-up first
        if (far && okFarSince && now - okFarSince >= OFF_FAR_MS && farCloseIn(now)) return;
        if (okOpenAt && !far) okAct(now, false);
        else if (okSwitchPend && now < okSwitchPend && offM30 <= OFF_VETO_TH && !inCurtain && !inDodge) okAct(now, true);
    }

    // --- 奇术 and the 横刀 ok follow-up
    let qsLitAt = 0, qsLit = false, qsRetryAt = 0, qsTapAt = 0, qsOpenOk = true, qsBossAt = 0, qsPutOffAt = 0;
    let qsCoolN = 0, qsCoolSeq = -1, qsBusyTo = 0, qsSoon = true, qsWhereTap = "";
    let pfOkAt = 0, pfTapAt = 0, pfTries = 0, pfHeng = false, pfDiscAt = 0, pfHoldN = 0, pfHoldMarked = false;
    const p6S = {
        /** @type {Record<string, number>} */ qishu: {}, qishuNotOut: 0, /** @type {Record<string, number>} */ qishuPutOff: {},
        /** @type {Record<string, number>} */ qishuOut: {}, qishuRetry: 0, qishuUnknown: 0,
        follow: 0, followNotOut: 0, /** @type {Record<string, number>} */ followSkip: {}, followOks: 0,
        followHolds: 0, followHoldNoDisc: 0, followHoldFrames: 0,
    };
    /** combat.js qishuLit (4 Hz): the template and the white strokes in the middle. @param {number} now */
    function qsLitRead(now) {
        if (now - qsLitAt < OFF_ICON_EVERY) return qsLit;
        qsLitAt = now;
        qsLit = perFrame("qishuLit", (im) => {
            const hit = match(OFF_T.qishu[0], { image: im, roi: OFF_T.qishu[1], threshold: OFF_ICON_TH });
            if (!hit.hit || !hit.box) return false;
            const [x, y, w, h] = hit.box;
            const cx = Math.round(x + w / 2), cy = Math.round(y + h / 2);
            return color({ ...ICON_WHITE, image: im, roi: [cx - 18, cy - 18, 36, 36], count: QS_LIT_PX }).hit;
        });
        return qsLit;
    }
    /** The 奇术 button now (per frame): "lit", "cool" (template gone, cooldown digits on the dark disc) or "". */
    function qsState() {
        return perFrame("qishuState", (im) => {
            const hit = match(OFF_T.qishu[0], { image: im, roi: OFF_T.qishu[1], threshold: OFF_ICON_TH });
            if (hit.hit && hit.box) {
                const [x, y, w, h] = hit.box;
                const cx = Math.round(x + w / 2), cy = Math.round(y + h / 2);
                return color({ ...ICON_WHITE, image: im, roi: [cx - 18, cy - 18, 36, 36], count: QS_LIT_PX }).hit ? "lit" : "";
            }
            const [cx, cy] = QISHU;
            const digits = color({ ...ICON_WHITE, image: im, roi: [cx - 18, cy - 18, 36, 36], count: QS_COOL_WHITE }).hit;
            return digits && color({ ...QS_DARK, image: im, roi: [cx - 22, cy - 22, 44, 44], count: QS_COOL_DARK }).hit ? "cool" : "";
        });
    }
    /** The defense's own states and our busy ones ("" = free). @param {number} now */
    function p6Busy(now) {
        if (inCurtain) return "curtain";
        if (inDodge) return "dodge";
        if (now < staggerUntil) return "stagger";
        if (now < potionHoldUntil || potionDue()) return "potion";
        if (offHold || offWalking || hd || now < offBusyUntil) return "busy";
        return "";
    }
    /** Clear for an action that a 卸势 cannot cut for nc ms ("" = clear). @param {number} now @param {number} nc @param {number} th */
    function p6Clear(now, nc, th) {
        const t = pred?.tell;
        if (t && t.arg !== 0 && t.p >= TELL_TH) return "tell";
        if (now - flareSeenAt < OFF_AFTER_TELL_MS) return "after-tell";
        if (offHorizon(nc) >= th) return "horizon";
        if (cadGate()) return "gate";
        if (plan.some((it) => !it.pressedAt && it.atMs - now <= nc + OFF_ABORT_MS)) return "plan";
        return "";
    }
    /** Where 奇术 may go now ("" = nowhere): the opening (the bar up, no contact yet) or a 气竭 window's start (its
     * recovery over before the 处决 tap). @param {number} now */
    function qsWhere(now) {
        if (!qsBossAt && bossNow > 50) qsBossAt = now;
        if (qp.shown) return !qp.tapAt && now - qp.shown + QS_NO_CANCEL_MS <= QP_EXEC_AFTER_MS ? "qi" : "";
        if (qsOpenOk) {
            if (lastHitAt || lastOkAt || (qsBossAt && now - qsBossAt > QS_OPEN_MS)) qsOpenOk = false;
            else if (qsBossAt) return "open";
        }
        return "";
    }
    /** The tap's end: out (the hold to QS_NO_CANCEL_MS) or not (the hold off, a retry). @param {number} now @param {string} how */
    function qsDone(now, how) {
        const ms = now - qsTapAt;
        if (how === "cool") {
            inc(p6S.qishuOut, qsWhereTap);
            offBusyUntil = Math.max(offBusyUntil, qsTapAt + QS_NO_CANCEL_MS);
            qsSoon = true;
            mark("off", `奇术 out (cooldown, ${ms} ms)`);
        } else {
            if (how === "lit") p6S.qishuNotOut++;
            else p6S.qishuUnknown++;
            if (offBusyUntil === qsBusyTo) offBusyUntil = now; // the hold was ours: off
            qsRetryAt = now + (qsSoon ? QS_RETRY_SOON_MS : QS_RETRY_MS);
            if (qsSoon) p6S.qishuRetry++;
            mark("off", `奇术 not out (${how === "lit" ? "still lit" : "no cooldown seen"}, ${ms} ms), again in ${qsSoon ? QS_RETRY_SOON_MS : QS_RETRY_MS} ms`);
            qsSoon = !qsSoon;
        }
        qsTapAt = 0;
    }
    /** @param {number} now */
    function qsTick(now) {
        if (qsTapAt) { // out once the cooldown shows on 2 frames; lit after the tap's flash, or nothing: not out
            const st = qsState();
            const ms = now - qsTapAt;
            if (st === "cool" && img.seq !== qsCoolSeq) {
                qsCoolSeq = img.seq;
                if (++qsCoolN >= 2) qsDone(now, "cool");
            } else if (st === "lit" && ms >= QS_LIT_AGAIN_MS) qsDone(now, "lit");
            else if (ms > QS_CONFIRM_MS) qsDone(now, "none");
            return;
        }
        if (now < qsRetryAt || bossNow <= 50) return;
        if (!qsSoon && now - qsRetryAt > QS_RETRY_MS) qsSoon = true; // a long while on: a retry again
        const where = qsWhere(now);
        if (!where || !qsLitRead(now)) return;
        const why = p6Busy(now) || (where === "qi" ? "" : p6Clear(now, QS_NO_CANCEL_MS, QS_TH));
        if (why) {
            inc(p6S.qishuPutOff, `${where}:${why}`);
            if (now - qsPutOffAt > 1000) mark("off", `奇术 put off (${where}: ${why}) ${offState()}`);
            qsPutOffAt = now;
            return;
        }
        offAct("qishu", where, QISHU);
        inc(p6S.qishu, where);
        qsTapAt = now;
        qsWhereTap = where;
        qsCoolN = 0;
        qsCoolSeq = -1;
        qsLitAt = 0; // the 4 Hz read again after it
        qsBusyTo = Math.max(offBusyUntil, now + QS_CONFIRM_MS); // nothing of ours until it is known
        offBusyUntil = qsBusyTo;
    }
    /** The 横刀 ok follow-up: the blue 爆发 disc on 重击 within PF_WINDOW_MS of the ok. @param {number} now */
    function pfTick(now) {
        if (qp.shown) return;
        if (lastOkAt > pfOkAt) { // a new ok
            pfOkAt = lastOkAt;
            pfTapAt = 0;
            pfTries = 0;
            pfHeng = offW === "hengdao";
            pfDiscAt = 0;
            pfHoldN = 0;
            pfHoldMarked = false;
            if (pfHeng) p6S.followOks++;
        }
        if (!pfOkAt || now - pfOkAt > PF_WINDOW_MS || now - pfOkAt < PF_DELAY_MS || pfTries >= PF_TRIES) return;
        if (pfTapAt && now - pfTapAt < PF_RETRY_MS) return;
        const swirl = offSeen("swirl");
        if (pfTapAt) { // tapped: out once the disc goes
            if (!swirl) {
                mark("off", `follow out (${now - pfTapAt} ms, ${pfTries} tap(s))`);
                pfTries = PF_TRIES;
                offBusyUntil = Math.max(offBusyUntil, pfTapAt + PF_COST_MS); // the slash plays
                return;
            }
            p6S.followNotOut++;
        }
        if (!swirl) return;
        const why = p6Busy(now) || p6Clear(now, PF_NO_CANCEL_MS, PF_TH);
        if (why) {
            inc(p6S.followSkip, why);
            return;
        }
        offAct("follow", "ok", CHARGE);
        p6S.follow++;
        pfTapAt = now;
        pfTries++;
        offBusyUntil = Math.max(offBusyUntil, now + PF_RETRY_MS);
    }
    /** The rest of the offense waits for the follow-up after a 横刀 ok (to PF_DELAY_MS + PF_HOLD_EXTRA_MS, while the
     * disc shows; no disc by PF_DISC_WAIT_MS lets go). @param {number} now */
    function pfHold(now) {
        if (!pfOkAt || pfTries > 0 || qp.shown) return false;
        const s = now - pfOkAt;
        if (s >= PF_DELAY_MS + PF_HOLD_EXTRA_MS) return false;
        const disc = offSeen("swirl");
        if (disc && !pfDiscAt) pfDiscAt = now;
        if (!disc && (pfDiscAt || s >= PF_DISC_WAIT_MS || !pfHeng)) {
            if (!pfHoldMarked && pfHoldN) {
                pfHoldMarked = true;
                p6S.followHoldNoDisc++;
                mark("off", `follow hold off (${pfDiscAt ? "disc gone" : "no disc"}, sok ${s})`);
            }
            return false;
        }
        if (!pfHoldN++) p6S.followHolds++;
        p6S.followHoldFrames++;
        return true;
    }
    /** Per frame: before the near gate, so a follow-up goes ahead of its switch. @param {number} now */
    function p6Tick(now) {
        pfTick(now);
        qsTick(now);
    }

    // --- 气竭: the window clocked from the 处决 button's first sighting (@see QP_EXEC_AFTER_MS)
    const qp = { zeroRun: 0, cand: 0, shown: 0, tapAt: 0, switchAt: 0, lastLight: 0, lastMatch: 0, lights: 0, post: 0, lateMarked: false, boss0: 0, futDrops: 0, seenAt: 0, lostAt: 0, walkFrom: 0 };
    const qpS = { windows: 0, fakes: 0, execs: 0, lost: 0, lights: 0, postLights: 0, futDrops: 0, preDrops: 0, btnLost: 0, chases: 0, reseenTaps: 0 };
    /** @type {number[]} */ const qpShownToTap = [];
    /** @type {number[]} */ const qpBossDrop = [];
    /** @param {number} now @param {boolean} post */
    function qpLight(now, post) {
        if (offHold || offWalking || now < offBusyUntil) return;
        if (inDodge || inCurtain || now < staggerUntil || now < potionHoldUntil || potionDue()) return;
        if (plan.some((x) => !x.pressedAt && x.atMs - now < QP_PENDING_MS)) return; // a tell dodge is about to go
        if (now - qp.lastLight < QP_LIGHT_MS) return;
        // 陌刀: switch to 横刀 first (once a window), no 陌刀 轻击 (teacher, 2026-10-23)
        const w = offWeaponNow() ?? offW;
        if (w === "modao") {
            if (qp.switchAt) return;
            qp.switchAt = now;
            offAct("switch", "qi", SWITCH);
            offBusyUntil = now + SWITCH_WAIT_MS;
            mark("qi", `qiPlan switch to 横刀 +${now - qp.shown} ms`);
            return;
        }
        if (w) offW = w;
        qp.lastLight = now;
        // 横刀: 轻蓄力 while one still fits before the 处决 tap (teacher, 2026-10-23), else plain 轻击
        if (!post && w === "hengdao" && now - qp.shown + HLIGHT_HOLD_MS + OFF_SLASH_MS <= QP_EXEC_AFTER_MS) {
            offStartCharge("hlight", "qi", HLIGHT_HOLD_MS, LIGHT);
            qp.lights++;
            mark("qi", `qiPlan 轻蓄力 +${now - qp.shown} ms`);
            return;
        }
        offAct("light", "qi", LIGHT);
        if (post) qp.post++;
        else qp.lights++;
        mark("qi", `qiPlan 轻击${post ? " (after 处决)" : ""} +${now - qp.shown} ms`);
    }
    /** @param {number} now @param {string} why */
    function qpEnd(now, why) {
        const drop = qp.boss0 - bossNow;
        qpS.lights += qp.lights;
        qpS.postLights += qp.post;
        qpS.futDrops += qp.futDrops;
        qpBossDrop.push(drop);
        if (!qp.tapAt) qpS.lost++;
        mark("qi", `qiPlan window over (${why}) after ${now - qp.shown} ms: ${qp.lights} + ${qp.post} 轻击, 处决 ` +
            `${qp.tapAt ? `at ${qp.tapAt - qp.shown} ms` : "not tapped"}, boss ${qp.boss0} -> ${bossNow} px, ${qp.futDrops} fut items dropped`);
        if (offHold && offHold.src === "qi") offRelease(now, "window over", true);
        if (offWalking && (offWalkWhy === "qi chase" || offWalkWhy === "qi approach")) offWalkStop("window over");
        Object.assign(qp, { cand: 0, shown: 0, tapAt: 0, switchAt: 0, lastLight: 0, lights: 0, post: 0, lateMarked: false, boss0: 0, futDrops: 0, seenAt: 0, lostAt: 0, walkFrom: 0 });
    }
    // phase 2: walk in while 真气 is empty and 处决 does not show (@see QP2_WALK_AFTER_MS)
    let qpWalkOn = false;
    const qp2S = { walks: 0, pushes: 0, shown: 0, capped: false, caps: 0, /** @type {Record<string, number>} */ ends: {}, walkMs: /** @type {number[]} */ ([]) };
    /** @param {number} now */
    function qpApproach(now) {
        if (qp2S.capped || now - qp.cand < QP2_WALK_AFTER_MS) return;
        if (!qp.walkFrom) {
            qp.walkFrom = now;
            qpWalkOn = true;
            qp2S.walks++;
            mark("qi", `qiPlan: no 处决 ${now - qp.cand} ms after 真气 empty: walking in`);
        }
        if (now - qp.walkFrom >= QP2_WALK_MAX_MS) {
            qp2S.capped = true;
            qp2S.caps++;
            qpWalkEnd(now, "cap");
            return;
        }
        if (offWalking || inDodge || now < staggerUntil || now < potionHoldUntil) return;
        if (offHold && offHold.src !== "qi") offRelease(now, "qi approach", true);
        if (offHold || hd || now < offBusyUntil) return;
        if (offWalk(now, QP_CHASE_MS, "qi approach")) qp2S.pushes++;
    }
    /** The approach is over (the walk stays counted in qp.walkFrom until the window ends). @param {number} now @param {string} why */
    function qpWalkEnd(now, why) {
        if (!qpWalkOn) return;
        qpWalkOn = false;
        inc(qp2S.ends, why);
        if (why === "处决 shows") qp2S.shown++;
        qp2S.walkMs.push(now - qp.walkFrom);
        if (offWalking && offWalkWhy === "qi approach") offWalkStop(why);
        mark("qi", `qiPlan: walk in over (${why}) after ${now - qp.walkFrom} ms`);
    }
    /** @param {number} now */
    function qpTick(now) {
        // 真气 empty: read 0, or the read keeps failing while the boss bar is up and the last read was tiny
        const empty = qiNow === 0 || (qiEmpty >= 2 && qiNow >= 0 && qiNow <= 25 && bossNow > 50);
        qp.zeroRun = empty ? qp.zeroRun + 1 : 0;
        const back = qiEmpty === 0 && qiNow > 4;
        if (!qp.cand && !qp.shown && qp.zeroRun >= 2) {
            qp.cand = now;
            mark("qi", `qiPlan: 真气 empty (read ${qiNow}, miss ${qiEmpty}), 处决 looked for`);
        }
        // the 处决 button: every QI_EXEC_EVERY frames while 真气 is low, every frame once it is due; it may show before
        // 真气 reads empty
        const low = qp.cand > 0 || (qiNow >= 0 && qiNow <= QP_EXEC_QI_MAX && bossNow > 50);
        const due = qp.shown > 0 && !qp.tapAt && (now - qp.shown >= QP_EXEC_AFTER_MS || (qp.walkFrom > 0 && now - qp.cand >= QP2_EXEC_BY_MS));
        let ex = false;
        if ((low || qp.shown) && !qp.tapAt && (due || qp.lostAt > 0 || qp.walkFrom > 0 || now - qp.lastMatch >= QI_EXEC_EVERY * FRAME_MS)) {
            qp.lastMatch = now;
            ex = perFrame("exec", (im) => match("combat/execute.png", { image: im, roi: EXEC_ROI, threshold: EXEC_TH }).hit);
        }
        if (back) qp2S.capped = false; // a new 真气-empty spell may walk again
        if (!qp.shown) {
            if (ex && !back) {
                qp.shown = now;
                qp.seenAt = now;
                qp.boss0 = bossNow;
                qpS.windows++;
                if (qp.walkFrom) qpWalkEnd(now, "处决 shows");
                walkOff();
                mark("qi", `qiPlan: 处决 shows ${qp.cand ? `${now - qp.cand} ms after 真气 empty` : `before 真气 read empty (真气 ${qiNow})`}` +
                    `${qp.walkFrom ? ` (walked in ${now - qp.walkFrom} ms)` : ""}`);
            } else if (qp.cand && (back || now - qp.cand > QP_CAND_MS)) {
                qpS.fakes++;
                if (qp.walkFrom) qpWalkEnd(now, back ? "真气 back" : "timeout");
                qp.walkFrom = 0;
                mark("qi", `qiPlan: no 处决 in ${now - qp.cand} ms (${back ? "真气 back" : "timeout"}): not 衰弱`);
                qp.cand = 0;
            } else if (phase === 2 && qp.cand) qpApproach(now);
            return;
        }
        if (back) return qpEnd(now, "真气 back");
        if (now - qp.shown > QP_MAX_MS) return qpEnd(now, "window limit");
        if (qp.tapAt && now - qp.tapAt > QP_EXEC_SCENE_MS + QP_POST_MS) return qpEnd(now, "qiPostMs");
        if (!qp.tapAt) {
            // the button shows ~2.0-2.4 s and goes when the boss is out of reach: gone for QP_LOST_MS walks us in,
            // tapped as soon as it shows again
            const reseen = ex && qp.lostAt > 0;
            if (ex) qp.seenAt = now;
            else if (!qp.lostAt && now - qp.seenAt >= QP_LOST_MS) {
                qp.lostAt = now;
                qpS.btnLost++;
                mark("qi", `qiPlan: 处决 gone at ${now - qp.shown} ms (last seen ${now - qp.seenAt} ms ago), walking in`);
            }
            if ((due || reseen) && ex) {
                if (reseen) qpS.reseenTaps++;
                qp.tapAt = now;
                qpS.execs++;
                qpShownToTap.push(now - qp.shown);
                if (offHold) offRelease(now, "处决", true);
                if (offWalking) offWalkStop("处决");
                offAct("execute", "qi", EXECUTE, QP_EXEC_TAP_MS);
                pressFrame(frameIdx);
                mark("qi", `qiPlan 处决 tap ${now - qp.shown} ms after it showed${now - qp.shown > QP_EXEC_MAX_MS ? " (late)" : ""}${reseen ? ` (back ${now - qp.lostAt} ms after it went)` : ""}`);
                return;
            }
            if (now - qp.shown > QP_EXEC_MAX_MS && !qp.lateMarked) {
                qp.lateMarked = true;
                mark("qi", `qiPlan: 处决 not seen at ${now - qp.shown} ms (max ${QP_EXEC_MAX_MS}), still looked for`);
            }
            if (qp.lostAt) { // out of its reach: walk in (轻击 when a walk cannot go)
                if (offWalking) return;
                if (!offHold && offWalk(now, QP_CHASE_MS, "qi chase")) {
                    qpS.chases++;
                    return;
                }
            }
            // before QP_EXEC_AFTER_MS strike; after it wait for the button (covered by effects at times), striking
            // again once it is well past its ~3.2 s life
            if (!due || now - qp.shown > QP_EXEC_MAX_MS + 300) qpLight(now, false);
            return;
        }
        if (now - qp.tapAt >= QP_EXEC_SCENE_MS) qpLight(now, true);
    }

    // --- phase one over by the quest line (combat.js phase2); the 成功 page is deadCheck's
    let clrAt = 0, clrPhase2 = 0;
    /** The quest line reads 「…阶段二」. */
    function clrPhase2Now() {
        const n = (/** @type {Box} */ roi) => {
            const h = color({ ...QUEST_WHITE, image: img, roi, count: 1 });
            return h.hit ? h.results[0]?.count ?? 0 : 0;
        };
        return n(PHASE2_TOP) >= 8 && n(PHASE2_BOTTOM) >= 10 && n(PHASE1_MID) <= 2;
    }
    /** @param {number} now @returns {boolean} the run is over (cleared) */
    function clearedCheck(now) {
        if (phase === 2) return false; // the 阶段二 arena's quest line reads 阶段二 all along: deadCheck's 成功 page ends it
        if (now - clrAt < CLR_EVERY_MS) return false;
        clrAt = now;
        clrPhase2 = clrPhase2Now() ? clrPhase2 + 1 : 0;
        if (clrPhase2 >= 2) {
            mark("cleared", "阶段二 in the quest line");
            return true;
        }
        return false;
    }
    // ===================================================================================================== end offense

    /** @type {{name: string, every: number, at: number, active: () => boolean, run: (now: number) => void}[]} */
    const slowQueue = [
        { name: "boss", every: SLOW_EVERY, at: 0, active: () => true, run: () => { bossNow = bossRead(); } },
        { name: "mean", every: SLOW_EVERY, at: 0, active: () => true, run: () => {
            meanNow = readMean(img);
            meanRing.push(meanNow);
            if (meanRing.length > 3) meanRing.shift();
            dark3 = Math.min(...meanRing) < 20 ? 1 : 0;
        } },
        { name: "curtain", every: CURTAIN_EVERY, at: 0, active: () => curtainOn, run: slowCurtain },
        { name: "flare", every: FLARE_EVERY, at: 0, active: () => phase !== 2 || !FLARE2_IMG, run: slowFlare }, // phase 2 + FLARE2_IMG: flare2Read
        { name: "officons", every: OFF_ICON_EVERY, at: 0, active: () => !hd && !qp.shown, run: offIconsRead },
    ];

    /** The newest stream frame: img's if that is it, else a screenshot of it; a still screen waits NEXT_MS. */
    function nextShot() {
        const latest = frameSeq();
        if (latest > loopSeq) {
            const im = latest > img.seq ? shot() : img;
            loopSeq = Math.max(loopSeq, im.seq);
            return im;
        }
        const t0 = Date.now();
        while (frameSeq() <= loopSeq && Date.now() - t0 < NEXT_MS) {
            releaseDue();
            sleep(3);
        }
        const im = shot();
        loopSeq = Math.max(loopSeq, im.seq);
        return im;
    }

    log(`dufu start: ${BACK_MODEL} + ${headModel}, ${untilMs} ms${untilMs < (args.ms ?? 600_000) ? ` (ms ${args.ms ?? 600_000} clipped by the timeout)` : ""}, issueLead ${ISSUE_LEAD_MS} ms, potions ${maxPotions}` +
        `${phase === 2 ? `, phase 2${defDodgeP != null ? ` defDodgeP ${defDodgeP}` : ""}${cadTh ? ` cadence ${cadTh}` : ""}` : ""}${args.trace ? `, trace ${traceFeat ? "aux+feat" : "aux"} (event ${TRACE_EVENT}, start ${start})` : ""}`);
    if (args.prep ?? true) prep();
    let lastFrameStart = Date.now() - 35;
    try {
        for (;;) {
            img = nextShot();
            const t0 = Date.now();
            const budget = Math.min(40, t0 - lastFrameStart);
            lastFrameStart = t0;
            releaseDue();
            timed("reads", feedback);
            const now = Date.now();
            haltCheck(now);
            const over = deadCheck(now);
            if (over) {
                reason = over;
                break;
            }
            if (clearedCheck(now)) {
                reason = "cleared";
                clearedAtMs = now - start;
                break;
            }
            approach(now);
            lockCheck(now);
            if (phase === 2 && FLARE2_IMG) flare2Read(now);
            if (redLineF) redLineRead(now);
            const dtMs = lastEntryT ? Math.min(300, Math.max(10, now - lastEntryT)) : FRAME_MS;
            const aux = buildAux(dtMs);
            const b = timed("back", () => infer(BACK_MODEL, { ...BACK, image: img, history: [{ name: "seq", aux }] }));
            if (b.ready && b.output) {
                ring.push({ f: b.output, aux, t: now });
                if (args.trace) traceAdd(now, img, aux, b.output);
                if (ring.length > T) ring.shift();
                lastEntryT = now;
                frameIdx++;
                if (ring.length >= MIN_RING) {
                    headCalls++;
                    const h = timed("head", () => infer(headModel, { post: "none", extra: [{ name: "seq", dim: [1, T, D], ring: true }] }));
                    if (h.ready && h.output) {
                        ready++;
                        checkRing(h);
                        decode(h.output);
                    }
                }
            }
            if (pred) {
                const now2 = Date.now();
                syncPlan(now2);
                if (redLineF) redLineTick(now2);
                offenseGuard(now2);
                cadenceTick(now2);
                executePlan(now2);
                hitEscTick(Date.now());
                sweepTick(Date.now());
                expire(now2);
                potionTick(Date.now());
                planPotion(Date.now());
                offenseTick(Date.now());
                predMark(now2);
            }
            for (const s of slowQueue) {
                const nowS = Date.now();
                const every = s.name === "curtain" && inCurtain ? 150 : s.every;
                if (nowS - s.at < every) continue;
                if (!s.active()) {
                    s.at = nowS;
                    continue;
                }
                if (budget - (nowS - t0) < SLOW_SLACK_MS) {
                    skips[s.name] = (skips[s.name] ?? 0) + 1;
                    if (nowS - (slowMarkAt[s.name] ?? 0) > 1000) {
                        slowMarkAt[s.name] = nowS;
                        mark("slow skipped", s.name);
                    }
                    continue;
                }
                s.at = nowS;
                s.run(nowS);
            }
            tMs.loop.push(Date.now() - t0);
            looks++;
            if (Date.now() >= until) break;
        }
    } finally {
        releaseDue(true);
        tup(0);
        if (offTouched) touch.up(OFF_CONTACT);
        if (offWalking) strideF(0);
        if (args.trace) traceFlush();
    }
    if (qp.shown) qpEnd(Date.now(), "run over");
    if (foFrom) foEnd("run over");
    const backS = stats(tMs.back), headS = stats(tMs.head), readS = stats(tMs.reads), loopS = stats(tMs.loop);
    const readyPct = headCalls ? Math.round((ready / headCalls) * 1000) / 10 : 0;
    log(`dufu over (${reason}): ${looks} looks, head ${ready}/${headCalls} ready (${readyPct}%), ${presses.parry} parry / ${presses.dodge} dodge / ${presses.potion} potion / ${presses.walk} walk, lock ${lockTaps} taps, halt ${halts} (${haltDowns} downs held back, ${pageHeld} on the page), ` +
        `${hits} hits, ${oks} ok, ${misses} misses, ${revisions} revisions, ${late} late, branches ${branches} (${branchDrops} dropped), holds ${holds} (${holdPresses} pressed), posthit ${insurePresses}, re-press ${rerepresses}, blocked ${JSON.stringify(blocked)}, skipped ${JSON.stringify(skips)}`);
    log(`ms: back ${JSON.stringify(backS)}, head ${JSON.stringify(headS)}, reads ${JSON.stringify(readS)}, loop ${JSON.stringify(loopS)}, ringBad ${ringBad}`);
    const defense = { timedSweeps, holdFut: foS, split: fsS, chain: hcS };
    const potion = { taps: presses.potion, healed: potionsUsed, slotSwaps, ...potS };
    const sorted = [...offHoldS.heldMs].sort((a, b) => a - b);
    const off = {
        qi: { ...qpS, execShownToTapMs: qpShownToTap, bossDropPx: qpBossDrop },
        act: { n: offActS.n, hit1s: offActS.hit1s, dropPx: offActS.dropPx, dropN: offActS.dropN, stops: offStopWhy, sets: offSetS,
               holds: { n: offHoldS.n, full: offHoldS.full, early: offHoldS.early, heldMsMedian: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0 },
               walks: offWalkS },
        near: { fightMin: Math.round(okS.evalMs / 600) / 100, gateFrac: okS.evalMs ? Math.round((okS.openMs / okS.evalMs) * 1000) / 1000 : 0,
                farFrac: okS.evalMs ? Math.round((okS.farMs / okS.evalMs) * 1000) / 1000 : 0, opens: okS.opens, closeWhy: okS.closeWhy,
                farByWhiff: okS.farByWhiff, closeIns: okS.closeIns, switchPend: okS.switchPend, chargeDefers: okS.chargeDefers, res: okS.res, byAct: okS.byAct },
        p6: p6S,
    };
    log(`defense: ${JSON.stringify(defense)}`);
    log(`potion: ${JSON.stringify(potion)}`);
    if (redLineF) log(`redLine: ${JSON.stringify(rlResult())}`);
    if (cadTh) log(`cadence: ${JSON.stringify(cadResult())}`);
    log(`off: ${JSON.stringify(off)}`);
    return {
        reason, ...(reason === "cleared" ? { clearedAtMs } : {}), looks, ready, headCalls, readyPct, ringBad,
        presses, blocked, late, misses, hits, oks, revisions, branches, branchDrops, skips, holds, holdPresses, insurePresses, rerepresses,
        defense, potion, off,
        ms: { back: backS, head: headS, reads: readS, loop: loopS },
        start, events,
        ...(phase === 2 ? { phase, flare2: { ...f2S, readMs: stats(f2S.readMs) }, qiWalk: { ...qp2S, capped: undefined } } : {}),
        ...(redLineF ? { redLine: rlResult() } : {}),
        ...(cadTh ? { cadence: cadResult() } : {}),
        ...(args.trace ? { trace: { event: TRACE_EVENT, start, rows: traceN, chunks: traceChunks, feat: traceFeat } } : {}),
    };
}
