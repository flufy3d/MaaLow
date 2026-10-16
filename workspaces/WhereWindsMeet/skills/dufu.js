// 独夫 unified defense scheduler (pilot, no attacks). Each processed stream frame: backbone dufu/unified_back2.onnx
// -> 192-d feature -> causal GRU head dufu/unified_head2.onnx (extra seq [1,30,207]; the head ignores its image
// input) -> combo/stage/fut1-3/def1-3/tell -> a press plan (卸势 / dodge / potion) rebuilt every frame, revised
// until a commit window freezes it, executed by cooldowns; bimodal fut results become branches whose later-mode
// item stays uncommitted until the first mode resolves. Slow rules (curtain gap / flare colour / potion) only run
// while the per-frame budget is left over: they never hold the key path. `observe` does inference and logging
// only (no touches at all). The 15 aux columns reproduce unified_head2.json exactly. The boss is kept locked on
// (tap the lock button whenever its gold icon is gone: the arena auto-locks, the game drops it at the phase
// change and the camera stops tracking; combat.js rule).
//   maalow do skill dufu --args '{"observe":true,"ms":45000}'
// v1 pair: --args '{"model":"dufu/unified_head.onnx","backModel":"dufu/unified_back.onnx"}'
import { stats } from "./lib/stats.js";

/** @type {SkillMeta} */
export const meta = { description: "独夫 unified model defense: parry/dodge/potion from fut/def/tell (observe = reads only)", timeout: 660_000 };

const T = 30; // ring / seq window (frames)
const F = 192; // backbone features per frame
const A = 15; // aux columns per frame
const D = F + A; // 207 per step
const FRAME_MS = 1000 / 30; // the dataset's frame clock (durations are mapped at 30 fps)
const MIN_RING = 12; // the head runs once this many frames are in the ring (front-padded to 30)

/** @type {InferOptions} */
const BACK = { roi: [120, 30, 840, 530], size: 96, resize: "area", color: "rgb", mean: 0, std: 1, frames: [0], post: "none" };

// slices/labels frozen in model/dufu/unified_head2.json (v1: same)
const COMBO_LABELS = ["bg", "irregular", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13", "T14"];
// v6 combo slot (comboV6 arg): gap to the NEXT segment of the chain; 0 bg | 1 single | 2..7 bins | 8 end (combo_v6.py)
const COMBO6_LABELS = ["bg", "single", "g8-13", "g14-19", "g20-23", "g24-27", "g28-33", "g34-40", "end", "x9", "x10", "x11", "x12", "x13", "x14", "x15"];
const COMBO6_CENTER = [10.5, 16.5, 21.5, 25.5, 30.5, 37.0]; // bin centers (frames), classes 2..7
const STAGE_LABELS = ["bg", "pre", "next2", "next3", "next4+", "done"];
const FUT_LABELS = ["1-3", "4-6", "7-9", "10-12", "13-15", "16-19", "20-24", "25-30", "31-40", "41-60", "none"];
const FUT_LO = [1, 4, 7, 10, 13, 16, 20, 25, 31, 41]; // bin lower bounds (frames)
const FUT_HI = [3, 6, 9, 12, 15, 19, 24, 30, 40, 60];
const FUT_CENTER = [2, 5, 8, 11, 14, 17.5, 22, 27.5, 35.5, 50.5]; // bin centers (E[frames])
const DEF_LABELS = ["none", "parry", "dodge", "curtain", "unknown"];
const TELL_LABELS = ["none", "flare_other", "flare_grab", "flare_slam", "sweep", "curtain", "dark"];

// buttons / joystick (combat.js)
/** @type {Point} */ const PARRY = [952, 495];
/** @type {Point} */ const DODGE = [924, 674];
/** @type {Point} */ const POTION = [700, 690];
/** @type {Point} */ const STICK = [175, 569];
const STICK_R = 83;
/** @type {Point} */ const BACKWARD = [175, 652];
/** @type {Point} */ const LEFT = [92, 569];
/** @type {Point} */ const RIGHT = [258, 569];
/** @type {Point} */ const FORWARD = [175, 486];
const ME_X = 540;

// reads (combat.js; aux sources are dataset-exact per data/tmp/dufu/f6.py + ds_build.py)
/** @type {Box} */ const HP_ROI = [405, 681, 280, 5];
const HP_LEFT = 415, HP_FULL = 669, HP_GAP = 12, HP_RED_MAX = 0.45;
const HP_GREY = { lower: [0, 0, 140], upper: [180, 45, 255], method: 40 };
const HP_RED = { lower: [[0, 100, 165], [174, 100, 165]], upper: [[6, 175, 255], [180, 175, 255]], method: 40 };
const HIT_DROP = 0.025; // a blow: health down this much at once
/** @type {Box} */ const QI_ROI = [347, 35, 386, 6]; // the boss's 真气 line
const QI_HSV = { lower: [88, 30, 150], upper: [108, 130, 255], method: 40 };
const QI_STEP = 8, QI_JUMP = 80; // a good 卸势 takes 10-25 px
/** @type {Box} */ const LIT_ROI = [815, 575, 36, 36]; // f6.py's lit box (the skill icon's white strokes)
const ICON_WHITE = { lower: [0, 0, 216], upper: [180, 59, 255], method: 40 };
/** @type {Box} */ const BOSS_ROI = [347, 27, 386, 6]; // the boss bar
const BOSS_RED = { lower: [170, 0, 0], upper: [255, 130, 130] };
const BOSS_FULL = 386;
// 金光 flare rule (f6.py: gold line + orange streak)
const FLASH = { lower: [8, 25, 235], upper: [35, 255, 255], method: 40 };
/** @type {Box} */ const FLASH_ROI = [150, 120, 780, 440];
const STREAK = { lower: [8, 100, 200], upper: [20, 255, 255], method: 40 };
// frame mean estimate: 3 full-width strips x 3 V thresholds (E[V] = 32 + 64*(P64 + P128 + P192))
const MEAN_STRIPS = /** @type {[number, number][]} */ ([[140, 8], [300, 8], [460, 8]]);
const MEAN_TH = [64, 128, 192];
// 起幕布 (combat.js)
/** @type {Box} */ const CURTAIN_ROI = [0, 80, 1080, 150];
const CURTAIN_DARK = { lower: [0, 0, 0], upper: [180, 255, 30], method: 40 };
/** @type {Box} */ const EDGE_ROI = [0, 60, 1080, 500];
const EDGE = { lower: [5, 80, 150], upper: [30, 255, 255], method: 40 };
const EDGE_H = 70, EDGE_STRIPS = 3, EDGE_OVERLAP = 40;
const GAP_IN = 20, GAP_PUSH = 120;
const CURTAIN_GONE_MS = 1500, CURTAIN_FIRST_DODGE_MS = 950, CURTAIN_DODGE_GAP_MS = 700;

// scheduler defaults (spec)
const TARGET_GLOW_LEAD = 9; // frames: press this early for the parry to be lit at the contact
const LATENCY_FRAMES = 5; // measured press -> on screen, frames
const COMMIT_MS = 90; // an item this close is frozen
const PARRY_CD_MS = 220, DODGE_CD_MS = 500, STAGGER_MS = 500;
const NEXT_MS = 50; // wait for a new stream frame at most (then screenshot anyway)
const PRED_MS = 500; // "pred" mark period
const MISS_GRACE_MS = 250; // a pressed item unresolved this long past its contact: miss
const PLAN_FRAMES_MAX = 60; // fut bins end at 60: do not plan beyond
const LATE_FRAMES = 2; // closer than this: too late to press
const COVER_FRAMES = 15; // bimodal modes this close: one press covers both
const REVISE_MOVE_MS = 100; // a contact this much later/earlier: revise (and log)
const BRANCH_MIN_P = 0.2, BRANCH_SEP_BINS = 5, BRANCH_KEEP_P = 0.25; // bimodal split + later-mode survival
const TELL_TH = 0.5, TELL_DEDUP_MS = 300;
const TRIG_TH = 0.4; // the timing-head trigger (S1 = fut bins 1-5): a contact this likely within 4-19 frames acts
const DODGE_MIN_P = 0.5; // def1 "dodge" below this is treated as parry (the dodge class over-fires in fights)
// v5 tell re-calibration (tell_scan.py on 219-234, v4 head outputs): at 0.75 only 36/110 flagged flare hits got a
// tell dodge (28 at lead >= 4); at 0.50 it is 76/110 (51 at lead >= 4) for +2.7 dodges/min. sustained stays (it
// drops one-frame blips for free), episode dedup stays 2 s (1 s adds presses, saves ~1 hit less).
const TELL_DODGE_P = 0.5;
const TELL_EPISODE_MS = 2000;

// v5 scheduler switches (args, both default OFF; quantified offline in sim3.py --stagger-hold/--presched):
// staggerHold: a press blocked by the post-hit stagger is kept and retried every frame; it fires once the stagger
//   ends while >= holdMinLead frames of lead remain, else it is dropped ("held: too late"). Offline effect on the
//   219-234 sim was small (plan slots are re-created each frame anyway): keep off unless a live A/B says otherwise.
// presched: after a hit, when the combo head reports a frozen template (combo p >= 0.4, stage 2-4) pre-schedule the
//   next preschedN segment contacts from the template gaps (templates.json medians). BLOCKED offline: the v4 combo
//   head never reports the right template (2.6-4.6% arg match on template frames), so this fires ~never; arg kept
//   for future heads.
// v6 scheduler switches (args, all default OFF, for the v6 pair with comboV6):
// keepPlanOnHit: a hit no longer cancels the whole plan; unpressed items that still target a future contact stay
//   (the fresh fut head often goes quiet during the 500 ms stagger and never rebuilds them — sim: +4/30 of the
//   recorded gap24-39 "live-unpressed" second segments covered, E 9.59->9.53/min).
// posthit K (with posthitNarrow): K plan-free insurance parry presses after a hit, first at the end of the stagger
//   (+10 f for K=2). Narrow = only when no unpressed plan item is pending and no plan press happened since the hit
//   (the wide v5 variant cost +15 presses/min for -0.16/min; narrow is +6.4 sim presses/min for ~-0.11/min total).
const HOLD_MIN_LEAD = 4; // frames: a held press with less lead than this is dropped (ps_table 4-12 = 0.85-0.94)
const DROP_LAG = 5; // dataset convention: the contact happened this many frames before the hp drop shows
/** @type {number[][]} template T1..T14 median gaps (contact-to-contact frames, templates.json) */
const COMBO_GAPS = [[17], [24], [31], [38], [11], [15, 30], [12, 31], [16, 25], [18, 16], [24, 38.5], [12, 25], [37, 23.5], [25, 11.5, 31], [24, 16]];
const SLOW_EVERY = 250; // aux reads (boss / mean) and the potion decision: 4 Hz
const FLARE_EVERY = 400;
const CURTAIN_EVERY = 400;
const POTION_HP = 0.3, POTION_URGENT = 0.15, POTION_HOLD_MS = 2000, POTION_YIELD_MS = 150, POTION_SAFE_FRAMES = 15;
const SLOW_SLACK_MS = 3; // a slow check may start while this much of the budget is left
const BRANCH_LATE_MS = 400; // an unreleased branch this stale: drop

// v7 scheduler switches (args, default OFF; see model_head7_report.md):
// tellAnchor: a flare tell (arg 1..3) no longer presses at fut1-E(c)-lead but at the episode's first tell frame +
//   anchor[kind] (the head's first fire is the image onset +-3 frames, measured on 233-252: p50 0, p90 +3);
//   the offline replay (tell_scan --mode anchor, 233-252, 401 image onsets) goes from 117 to 198 of 233 flare-hit
//   contacts with a >=4-frame press, i.e. "press vs real contact" coverage 50% -> 85%.
// curtainImg: run the combat.js curtain image rule (panels + orange edge, gapNow) every curtainEvery while NOT in
//   curtain; non-null twice in a row -> enter curtain mode (the tell head only caught 1 of 252's 3 episodes).
// curtainDark: the tell head's dark class fires at the curtain's black cover onset (252: p 0.86-0.95 at frames
//   2537/4859/6990, the coach's 3 episodes); >= 2 consecutive frames of arg 6 p >= 0.7 -> enter curtain mode.
// repress: a pressed fut item whose fresh contact estimate moves >= repressGap frames later is re-armed once (the
//   横刀 long wind-ups: c reported ~37 f early -> the i-frame/parry window expired before the real contact), and a
//   pressed item that is about to expire as a miss is re-armed when the fresh fut still shows a contact within
//   repressLook frames.
// closeIn: keep the boss in melee range: forward bursts whenever no press is imminent (never during curtain /
//   dodge / stagger), plus the hold bundle (keepPlanOnHit + staggerHold + posthit 1 narrow) and the v6 gap-head
//   pre-schedule, so each chain segment gets its own c-14 press (segment gaps >= 8 f > the 6.6 f parry CD).
// qiAttack: 气竭 (qi == 0) window: light attacks + 处决 (combat.js execute template) after qiExecWait ms.
/** @type {Record<string, number>} */ const ANCHOR_FRAMES = { flare_grab: 4, flare_slam: 10, flare_other: 4 };
const REPRESS_GAP_FRAMES = 18;
const REPRESS_DELAY_FRAMES = 12;
const REPRESS_LOOK_FRAMES = 25;
const CI_CYCLE_MS = 1600, CI_ON_MS = 500;
const QI_LIGHT_MS = 420, QI_EXEC_WAIT_MS = 4000, QI_EXEC_EVERY = 3;
/** @type {Point} */ const LIGHT = [945, 592];
/** @type {Point} */ const EXECUTE = [852, 430];
/** @type {Box} */ const EXEC_ROI = [815, 391, 75, 75];
const EXEC_THRESHOLD = 0.7;

// v8 switches (args, all default OFF; offline checks in data/tmp/dufu_breakthrough/newargs/, see attribution.md /
// ceiling.md there). Device timing measured on the lit axis of attr_hits.py (253-262 run logs):
//   anchored flare dodge: first tell fire = image onset + 3.3 f (other) / 4.2 f (grab), press -> white flash +1.3 f;
//   flare contacts after the image onset: device "other" 20-21 f (p25-75), device "grab" 12-14 f (half of them 20-21).
// flareMode "late": the flare dodge shows 0-4 f before the contact (the measured dodge window; anchor 4 showed it
//   9 f after the onset = 11-12 f early on "other", 80% hit). Replayed on the 253-262 anchored presses (v8_check.py):
//   other 13 -> lead median 2.6, 49% in 0..4 (anchor 4: 5%; 14: 1.6 / 51% but 23% late); grab 5 -> 46% (4: 23%).
// flareMode "parry": flare tells press a 卸势 (lit ~5-6 f before the contact, the ps peak) instead of a dodge, and fut
//   dodges become parries while a flare is live (ceiling.md: flare segments parry-only P(hit) 0.10 vs dodge 0.43);
//   other 11 -> lit lead median 5.6, 79% in 2..9 (ps table ~0.87 ok before the 0.87 flare discount). slam: no device
//   data, contact ~+19 (levers.md) -> late 12 / parry 9.
//   Grabs keep the v7 anchor-4 dodge unless flareGrabDodge:false (grab-timed contacts parry only 11/22).
/** @type {Record<string, number>} */ const ANCHOR_LATE = { flare_grab: 5, flare_slam: 12, flare_other: 13 };
/** @type {Record<string, number>} */ const ANCHOR_PARRY = { flare_grab: 3, flare_slam: 9, flare_other: 11 };
const FUT_DODGE_LEAD_LATE = 2; // flareMode late: fut-head dodge items target a 2 f show lead (parries keep 9)
const FLARE_LIVE_MS = 1000; // a flare tell / image flare this recent: "a flare is live" (parry mode)
// curtainTimed: 幕布 sweeps come every 65 f (219-262: 63 single gaps median 65.0, sd 1.8; 31 double gaps 129), three
//   per episode (sweep index 0/1/2: 102/50/60 contacts), the first one at the black cover onset (tell dark p>=0.7
//   onset +0/+1 f in 44/56). Sync = the first frame of a tell-dark run (sweep at its press-clock time - 3.3 f) or a
//   hit in the curtain (- 7.2 f); the next SWEEP_N sweeps get one back dodge each, showing sweepLead f before.
const SWEEP_PERIOD_F = 65, SWEEP_N = 2, SWEEP_LEAD_F = 2;
const SWEEP_DARK_LAG_F = 3.3, SWEEP_HIT_LAG_F = 7.2; // device sync time - sweep frame (press-lit clock)
const DODGE_SHOW_F = 0.65; // a dodge tap shows white this long after a 卸势 tapped at the same moment would light
const SWEEP_LATE_MS = 100, SWEEP_GAP_MS = 300, SWEEP_QUIET_MS = 600, SWEEP_DARK_GAP_MS = 500, SWEEP_HIT_NEAR_F = 10;
// flare2 (combat.js): the 金光 dodge gets a second one FLARE_AGAIN_MS (250) after the 50 ms tap, whatever happened
const FLARE2_MS = 300;
// failEscape (combat.js, rounds 88-90: 10.3 -> 7.8 hits/min): a model 卸势 with no ok 250 ms after its press while the
// timing head still sees a blow (S1 >= trigTh): one side dodge, at most within 300 ms after that, >= 1 s after a dodge
const FAIL_ESCAPE_MS = 250, FAIL_ESCAPE_SPAN_MS = 300, FAIL_ESCAPE_QUIET_MS = 1000;
// flareHoldFut: from the device tell's first flare_other report until that episode's anchored dodge is pressed (or
// the episode ends: no flare_other report for FLARE_HOLD_GAP_F with no anchored item, the item dropped, or
// FLARE_HOLD_F after the first report), unpressed fut dodge items are not pressed (kept, so they can still expire or
// go after the hold). Batch 2 (287-302, flareAnchor other 14): 66 other anchored plans, 23 pressed, 42 "blocked
// dodge cd" — a fut-head dodge took the CD at onset +9..12; white flashes 15-20 f after the onset hit 0.33 vs 0.68
// at 6-14. Parries, tell dodges (grab / slam) and combo / insure items are untouched.
const FLARE_HOLD_F = 30, FLARE_HOLD_GAP_F = 6;

// v8 offense (data/tmp/dufu_breakthrough/offense_plan.md, part 1; args all default OFF: with none of offShadow /
// qiPlan / untilCleared nothing below runs, no read, no touch, no extra return field).
// offShadow (§2): quietGate = fut1 m30 (bins 0..offQuietBins-1 = a contact within 1-30 f) < offQuietTh for
//   offQuietFrames head frames in a row (1 within OFF_OK_FAST_MS of a 卸势 ok), no combo veto (a next segment
//   expected), no unpressed plan item within offGuardMs, not in curtain / dodge / stagger / potion, offAfterTellMs
//   past any tell (金光 / curtain / dark / sweep), offAfterHitMs past a hit, offAfterDodgeMs past a dodge, hp >=
//   offHpMin (not in a qiPlan window). 253-262 offline: 26% of the time, then no contact for 1 s 96.8% / 2 s 86%,
//   ~12 opens/min. offenseGuard's give-up rules (a plan item <= offAbortMs away, a tell, a hit since the open,
//   curtain / dodge / potion) are logged as aborts. Shadow = reads + `off` events + return stats, no touches.
// qiPlan (§3 T0, replaces qiAttack): 气竭 = 真气 read empty twice (the empty bar reads -1, @see slowWeak) AND the
//   处决 button seen (combat.js weakNow: round 120's fake 衰弱 had 真气 0 while the boss struck on); the button can show
//   before 真气 reads empty (126/127), so it is also looked for while 真气 <= QP_EXEC_QI_MAX. Clock = the button's first
//   sighting (it goes ~3.2 s later: 129 lost it): 轻击 every qiLightMs until qiExecAfter, 处决 when seen from then
//   (late mark past qiExecMax), its scene QP_EXEC_SCENE_MS, 轻击 until 真气 is back (qiPostMs at most). Unpressed
//   fut items are dropped every frame of the window (tell / combo / insure items stay). Taps go on contact
//   offContact with a self-managed lift (never tap()'s contact 1 / upDue). Hot 蓄力 / weapon switch: not yet.
// untilCleared: combat.js deadCheck's phase-one-cleared rule (阶段二 in the quest line twice in a row, or the boss
//   bar full again after CLR_LOW_READS reads in its last 10%) ends the run with reason "cleared".
const OFF_QUIET_TH = 0.10, OFF_QUIET_BINS = 8, OFF_QUIET_FRAMES = 3, OFF_STRONG_TH = 0.05, OFF_STRONG_BINS = 9;
const OFF_GUARD_MS = 600, OFF_ABORT_MS = 150, OFF_AFTER_HIT_MS = 1500, OFF_AFTER_DODGE_MS = 300, OFF_AFTER_TELL_MS = 1500;
const OFF_HP_MIN = 0.35, OFF_OK_FAST_MS = 1000, OFF_CONTACT = 3, OFF_TAP_MS = 40;
const QP_EXEC_AFTER_MS = 2600, QP_EXEC_MAX_MS = 2900, QP_LIGHT_MS = 300, QP_POST_MS = 3500;
const QP_EXEC_SCENE_MS = 1100, QP_EXEC_TAP_MS = 50, QP_MAX_MS = 9000, QP_CAND_MS = 8000, QP_EXEC_QI_MAX = 25;
const QP_PENDING_MS = 300; // a tell / combo item this close: no 轻击 now
const CLR_EVERY_MS = 400, CLR_LOW_PX = 38, CLR_LOW_READS = 3, CLR_FULL_PX = 378, CLR_FULL_READS = 2, CLR_GAP = 12;
/** @type {Box} */ const CLR_LAST_ROI = [349, 27, 16, 6]; // the bar used up: its left end pale lilac (combat.js)
const CLR_LAST = { lower: [150, 140, 200], upper: [225, 225, 255] };
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
// lock-on (combat.js): the arena auto-locks at the fight start, the game drops the lock at the phase change
// (~80-90 s in) and the camera then stops tracking — the boss flanks and hits from the camera's side. combat.js
// re-taps the lock button whenever the gold icon is gone; dufu.js never did (round 233: lock lost at ~87 s).
/** @type {Point} */ const LOCK = [1021, 667];
/** @type {Box} */ const LOCK_ROI = [1004, 648, 34, 39];
const GOLD = { lower: [200, 180, 100], upper: [255, 245, 200] };
const LOCK_MS = 2000; // between re-lock taps (combat.js)
// round start: walk in (short bursts, never blocking) until the boss bar shows (armed only)
const APPROACH_MS = 30_000, APPROACH_CYCLE = 1200, APPROACH_ON = 500;

/** @typedef {{probs: number[], arg: number, p: number, label: string}} HeadOut */
/** @typedef {{combo: HeadOut, stage: HeadOut, fut: number[][], def: number[][], tell: HeadOut}} Pred */
/** @typedef {{kind: "parry"|"dodge"|"potion"|"avoid", dir: string, k: number, src: "fut"|"tell"|"potion"|"combo"|"insure", atMs: number, cMs: number, untilMs: number, branch: boolean, t1Ms: number, pressedAt: number, committed: boolean, why: string, held?: boolean, repressed?: boolean, noCd?: boolean}} PlanItem */

/**
 * @param {{observe?: boolean, ms?: number, potions?: number, model?: string, backModel?: string, parry?: Point,
 *   dodgePoint?: Point, potionPoint?: Point, dodgeDir?: string, targetGlowLead?: number, latencyFrames?: number,
 *   issueLeadMs?: number, commitMs?: number, parryCd?: number, dodgeCd?: number, staggerMs?: number,
 *   dodgeLead?: Record<string, number>, nextMs?: number, predMs?: number, missGraceMs?: number, tellTh?: number,
 *   trigTh?: number, dodgeMinP?: number, tellDodgeP?: number, tellEpisodeMs?: number,
 *   slowEvery?: number, flareEvery?: number, curtain?: boolean, curtainEvery?: number, flareDodge?: boolean,
 *   potionHp?: number, potionHoldMs?: number, potionSafeFrames?: number, deadGrey?: boolean, s1Hi?: number,
 *   lockOn?: boolean, staggerHold?: boolean, holdMinLead?: number, presched?: boolean, preschedN?: number,
 *   comboV6?: boolean, keepPlanOnHit?: boolean, posthit?: number, posthitNarrow?: boolean,
 *   tellAnchor?: boolean, curtainImg?: boolean, curtainDark?: boolean, repress?: boolean, repressGap?: number,
 *   closeIn?: boolean, qiAttack?: boolean, qiExecWait?: number, execThreshold?: number,
 *   flareMode?: string, flareAnchor?: Record<string, number>, futDodgeLead?: number, flareGrabDodge?: boolean,
 *   curtainTimed?: boolean, sweepLead?: number, sweepPeriod?: number, curtainKeepParry?: boolean,
 *   flare2?: boolean, failEscape?: boolean, flareHoldFut?: boolean,
 *   offShadow?: boolean, offQuietTh?: number, offQuietBins?: number, offQuietFrames?: number, offOkFast?: boolean,
 *   offComboVeto?: boolean, offGuardMs?: number, offAbortMs?: number, offAfterHitMs?: number, offAfterDodgeMs?: number,
 *   offAfterTellMs?: number, offHpMin?: number, offStrongTh?: number, offStrongBins?: number, offContact?: number,
 *   qiPlan?: boolean, qiExecAfter?: number, qiExecMax?: number, qiLightMs?: number, qiPostMs?: number,
 *   untilCleared?: boolean}} [args]
 *   observe: inference + logging only, no touches; ms: run length (default 300 s); potions: drinks allowed (0 = off);
 *   model / backModel: the frozen pair (default v2; pass the v1 names to go back); parry / dodgePoint / potionPoint:
 *   the buttons; dodgeDir: back | side | cycle | forward | backleft (the way dodges go); targetGlowLead /
 *   latencyFrames: the press lead; dodgeLead: tell dodge lead in frames per kind (grab/slam/other/sweep);
 *   staggerHold / presched: the v5 scheduler switches (@see HOLD_MIN_LEAD / COMBO_GAPS; both default off);
 *   comboV6: the v6 pair's combo slot is the gap-to-next-segment bins (presched/preschedN switch semantics);
 *   keepPlanOnHit / posthit / posthitNarrow: the v6 second-segment lifecycle switches (all default off).
 *   v8 (all default off, @see ANCHOR_LATE / SWEEP_PERIOD_F / FLARE2_MS / FAIL_ESCAPE_MS): flareMode dodge | late |
 *   parry, flareAnchor (overrides the mode's anchor table), futDodgeLead, flareGrabDodge; curtainTimed (sweepLead,
 *   sweepPeriod); curtainKeepParry; flare2; failEscape; flareHoldFut (@see FLARE_HOLD_F).
 *   v8 offense (all default off, @see OFF_QUIET_TH / QP_EXEC_AFTER_MS / CLR_LOW_PX): offShadow (+ the off* gate
 *   parameters; logs only, no touches); qiPlan (qiExecAfter / qiExecMax / qiLightMs / qiPostMs; replaces qiAttack);
 *   untilCleared.
 */
export default function (args = {}) {
    const observe = args.observe ?? false;
    const untilMs = args.ms ?? 300_000;
    const model = args.model ?? "dufu/unified_head2.onnx";
    const backModel = args.backModel ?? "dufu/unified_back2.onnx";
    const maxPotions = args.potions ?? 0;
    const parryP = args.parry ?? PARRY;
    const dodgeP = args.dodgePoint ?? DODGE;
    const potionP = args.potionPoint ?? POTION;
    const dodgeDir = args.dodgeDir ?? "side";
    const issueLead = args.issueLeadMs ?? Math.round(((args.targetGlowLead ?? TARGET_GLOW_LEAD) + (args.latencyFrames ?? LATENCY_FRAMES)) * FRAME_MS);
    const commitMs = args.commitMs ?? COMMIT_MS;
    const parryCd = args.parryCd ?? PARRY_CD_MS;
    const dodgeCd = args.dodgeCd ?? DODGE_CD_MS;
    const staggerMs = args.staggerMs ?? STAGGER_MS;
    const nextMs = args.nextMs ?? NEXT_MS;
    const predMs = args.predMs ?? PRED_MS;
    const missGraceMs = args.missGraceMs ?? MISS_GRACE_MS;
    const tellTh = args.tellTh ?? TELL_TH;
    const trigTh = args.trigTh ?? TRIG_TH;
    const dodgeMinP = args.dodgeMinP ?? DODGE_MIN_P;
    const tellDodgeP = args.tellDodgeP ?? TELL_DODGE_P;
    const tellEpisodeMs = args.tellEpisodeMs ?? TELL_EPISODE_MS;
    const slowEvery = args.slowEvery ?? SLOW_EVERY;
    const flareEvery = args.flareEvery ?? FLARE_EVERY;
    const curtainOn = args.curtain ?? true;
    const curtainEvery = args.curtainEvery ?? CURTAIN_EVERY;
    const flareDodge = args.flareDodge ?? true;
    const potionHp = args.potionHp ?? POTION_HP;
    const potionHoldMs = args.potionHoldMs ?? POTION_HOLD_MS;
    const potionSafeFrames = args.potionSafeFrames ?? POTION_SAFE_FRAMES;
    const deadGrey = args.deadGrey ?? true; // test-only: false disables the grey-screen branch (button path alone)
    const s1Hi = args.s1Hi ?? 5; // S1 = fut1 bins 1..s1Hi (v4 window variant: 6 = 4-24 frames; recalibrate trigTh)
    const lockOn = args.lockOn ?? true; // keep the boss locked on (camera tracking); false for A/B
    const staggerHold = args.staggerHold ?? false; // v5: keep a press blocked by the hit stagger, retry at its end
    const holdMinLead = args.holdMinLead ?? HOLD_MIN_LEAD;
    const presched = args.presched ?? false; // v5/v6: pre-schedule the next contact from the combo head at a hit
    const preschedN = args.preschedN ?? 1;
    const comboV6 = args.comboV6 ?? false; // v6 pair: combo slot = gap-to-next-segment bins (COMBO6_*)
    const keepPlanOnHit = args.keepPlanOnHit ?? false; // v6: a hit keeps unpressed items that target the future
    const posthit = args.posthit ?? 0; // v6: K plan-free insurance parries after a hit (0=off)
    const posthitNarrow = args.posthitNarrow ?? true; // only when no plan item is pending / no plan press since hit
    const tellAnchor = args.tellAnchor ?? false; // v7 A1: flare dodges at the episode onset + anchor[kind]
    const curtainImg = args.curtainImg ?? false; // v7 A2: image-rule curtain fallback (probe when not in curtain)
    const curtainDark = args.curtainDark ?? false; // v7 A2: tell dark (arg 6) at the cover onset enters curtain mode
    const repress = args.repress ?? false; // v7 A3: re-arm a pressed item when the estimated contact moves later
    const closeIn = args.closeIn ?? false; // v7 B: keep melee range + chain bundle (hold/insure/presched v6)
    const qiAttack = args.qiAttack ?? false; // v7 C: light attacks + 处决 in the 气竭 (qi == 0) window
    const qiExecWait = args.qiExecWait ?? QI_EXEC_WAIT_MS; // ms of light attacks before the 处决 tap
    const execThreshold = args.execThreshold ?? EXEC_THRESHOLD;
    const repressGapMs = (args.repressGap ?? REPRESS_GAP_FRAMES) * FRAME_MS;
    // closeIn turns the v6 chain switches on unless the caller pinned them explicitly
    const holdOn = closeIn ? (args.keepPlanOnHit ?? true) : keepPlanOnHit;
    const staggerOn = closeIn ? (args.staggerHold ?? true) : staggerHold;
    const posthitN = closeIn ? (args.posthit ?? 1) : posthit;
    const preschedOn = closeIn ? (args.presched ?? true) : presched;
    /** @type {Record<string, number>} */
    const dodgeLead = { grab: 5, slam: 4, other: 5, sweep: 5, ...(args.dodgeLead ?? {}) };
    const leadMs = (/** @type {string} */ kind) => (dodgeLead[kind] ?? 0) * FRAME_MS;
    // v8 A: flare handling. "dodge" = v7 (tellAnchor decides the anchoring); "late" = anchored dodges that show ~2 f
    // before the contact + fut dodges at futDodgeLead; "parry" = flare tells press an anchored 卸势, fut dodges turn
    // into parries while a flare is live (grabs keep the v7 anchor dodge while flareGrabDodge)
    const flareMode = args.flareMode === "late" || args.flareMode === "parry" ? args.flareMode : "dodge";
    const flareGrabDodge = args.flareGrabDodge ?? true; // parry mode: grab tells still dodge (anchor 4)
    /** @type {Record<string, number>} the anchor table of the mode (frames after the episode's first tell fire) */
    const anchorTab = { ...(flareMode === "late" ? ANCHOR_LATE : flareMode === "parry" ? ANCHOR_PARRY : ANCHOR_FRAMES), ...(args.flareAnchor ?? {}) };
    // fut-head dodge items: own target show lead (default = the parry's, i.e. the v7 issue lead; late mode 2 f)
    const dodgeIssueLead = args.futDodgeLead != null || flareMode === "late"
        ? Math.round(((args.futDodgeLead ?? FUT_DODGE_LEAD_LATE) + (args.latencyFrames ?? LATENCY_FRAMES)) * FRAME_MS) : issueLead;
    const leadOf = (/** @type {string} */ kind) => (kind === "dodge" ? dodgeIssueLead : issueLead);
    const curtainTimed = args.curtainTimed ?? false; // v8 B: timed back dodges at the 幕布 sweeps (65 f period)
    const sweepLead = args.sweepLead ?? SWEEP_LEAD_F; // frames the timed sweep dodge shows before the sweep
    const sweepPeriodMs = (args.sweepPeriod ?? SWEEP_PERIOD_F) * FRAME_MS;
    const curtainKeepParry = args.curtainKeepParry ?? false; // v8 C: entering 幕布 drops only dodge-type plan items
    const flare2 = args.flare2 ?? false; // v8 D: a second 金光 dodge FLARE2_MS after the first (combat.js flare2)
    const failEscape = args.failEscape ?? false; // v8 D: side dodge after a model 卸势 with no ok (combat.js)
    const flareHoldFut = args.flareHoldFut ?? false; // v8: fut dodges wait for the flare_other anchored dodge
    // v8 offense (offense_plan.md part 1, @see OFF_QUIET_TH): all default off
    const offShadow = args.offShadow ?? false; // quietGate + offenseGuard judged and logged every frame, no touches
    const offQuietTh = args.offQuietTh ?? OFF_QUIET_TH;
    const offQuietBins = args.offQuietBins ?? OFF_QUIET_BINS;
    const offQuietFrames = args.offQuietFrames ?? OFF_QUIET_FRAMES;
    const offOkFast = args.offOkFast ?? true;
    const offComboVeto = args.offComboVeto ?? true;
    const offGuardMs = args.offGuardMs ?? OFF_GUARD_MS;
    const offAbortMs = args.offAbortMs ?? OFF_ABORT_MS;
    const offAfterHitMs = args.offAfterHitMs ?? OFF_AFTER_HIT_MS;
    const offAfterDodgeMs = args.offAfterDodgeMs ?? OFF_AFTER_DODGE_MS;
    const offAfterTellMs = args.offAfterTellMs ?? OFF_AFTER_TELL_MS;
    const offHpMin = args.offHpMin ?? OFF_HP_MIN;
    const offStrongTh = args.offStrongTh ?? OFF_STRONG_TH;
    const offStrongBins = args.offStrongBins ?? OFF_STRONG_BINS;
    const offContact = args.offContact ?? OFF_CONTACT; // the offense finger (0 stick, 1 parry/tap, 2 dodge)
    const qiPlan = args.qiPlan ?? false; // 气竭 window v2 from the 处决 button's first sighting (replaces qiAttack)
    const qiExecAfter = args.qiExecAfter ?? QP_EXEC_AFTER_MS;
    const qiExecMax = args.qiExecMax ?? QP_EXEC_MAX_MS;
    const qiLightMs = args.qiLightMs ?? QP_LIGHT_MS;
    const qiPostMs = args.qiPostMs ?? QP_POST_MS;
    const untilCleared = args.untilCleared ?? false; // end with reason "cleared" at phase one's end (combat.js)
    const offOn = offShadow || qiPlan || untilCleared;

    const start = Date.now();
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
    /** @param {Target} p @param {number | undefined} c */
    const tdown = (p, c) => (releaseFor(c), touch.down(p, c));
    /** @param {Target} p @param {number | undefined} c */
    const tmove = (p, c) => (releaseFor(c), touch.move(p, c));
    /** @param {number | undefined} c */
    const tup = (c) => (releaseFor(c), touch.up(c));
    /** Tap p (contact 1) for ms; the lift is deferred (fastTap). @param {Point} p @param {number} [ms] */
    function tap(p, ms = 50) {
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
    /** The character's health 0-1, or null (combat.js). @param {Image} image */
    function health(image) {
        const read = (/** @type {ColorOptions} */ c) => {
            const hit = color({ ...c, image, roi: HP_ROI, count: 5, connected: true });
            if (!hit.hit) return null;
            const boxes = hit.results.map((m) => m.box).sort((a, b) => a[0] - b[0]);
            if (boxes[0][0] > HP_LEFT + 8) return null;
            let right = boxes[0][0] + boxes[0][2];
            for (const [x, , w] of boxes.slice(1)) {
                if (x - right > HP_GAP) break;
                right = Math.max(right, x + w);
            }
            if (right - HP_LEFT < 4) return null;
            return Math.max(0, Math.min(1, (right - HP_LEFT) / (HP_FULL - HP_LEFT)));
        };
        const grey = read(HP_GREY);
        if (grey != null) return grey;
        const red = read(HP_RED);
        return red != null && red <= HP_RED_MAX ? red : null;
    }
    /** The boss's 真气 px from the left end; 0 when empty, -1 when not read. */
    function readQi() {
        const hit = color({ ...QI_HSV, image: img, roi: QI_ROI, count: 2, connected: true });
        if (!hit.hit) return -1;
        const boxes = hit.results.map((m) => m.box).sort((a, b) => a[0] - b[0]);
        if (boxes[0][0] > QI_ROI[0] + 6) return -1;
        let right = boxes[0][0] + boxes[0][2];
        for (const [x, , w] of boxes.slice(1)) {
            if (x - right > 8) break;
            right = Math.max(right, x + w);
        }
        return right - QI_ROI[0];
    }
    /** White px in the lit box (colour read for the aux `lit` column). */
    function litNow() {
        const hit = color({ ...ICON_WHITE, image: img, roi: LIT_ROI, count: 1 });
        return hit.hit ? hit.results[0]?.count ?? 0 : 0;
    }
    /** The boss bar's red extent in px, 0 when none (aux `boss_ratio` / `boss_bar`). */
    function bossPx() {
        const hit = color({ ...BOSS_RED, image: img, roi: BOSS_ROI, count: 1 });
        if (!hit.hit) return 0;
        return Math.max(0, Math.min(BOSS_FULL, (hit.results[0]?.box?.[2] ?? 0) - 1));
    }
    /** At least n px of colour c in roi of im, in `parts` bands (combat.js). @param {ColorOptions} c @param {Box} roi @param {number} n @param {Image} im */
    function countAtLeast(c, roi, n, im, parts = 2) {
        const [x, y, w, h] = roi;
        let sum = 0;
        for (let i = 0; i < parts; i++) {
            const y0 = y + Math.round((h * i) / parts), y1 = y + Math.round((h * (i + 1)) / parts);
            const r = color({ ...c, image: im, roi: [x, y0, w, y1 - y0], count: 1 });
            sum += r.hit ? r.results[0]?.count ?? 0 : 0;
            if (sum >= n) return true;
        }
        return false;
    }
    /** The 金光 rule: gold line + orange streak (f6.py's dataset flare flag). */
    function seeFlash() {
        const im = img;
        if (!countAtLeast(FLASH, FLASH_ROI, 230, im)) return false;
        const hit = color({ ...FLASH, image: im, roi: FLASH_ROI, count: 150, connected: true });
        if (!(hit.hit && hit.results.some(({ box: [, , w, h], count }) => w >= 230 && w >= 2.5 * h && (count ?? 0) >= 0.15 * w * h))) return false;
        if (!countAtLeast(STREAK, FLASH_ROI, 150, im)) return false;
        const st = color({ ...STREAK, image: im, roi: FLASH_ROI, count: 100, connected: true });
        return st.hit && st.results.some(({ box: [, , w, h] }) => w >= 150 && w >= 2 * h);
    }
    /** Frame brightness estimate 0-255 (the dataset's mean column is the full-frame gray mean). */
    function readMean() {
        let sum = 0;
        for (const [y, h] of MEAN_STRIPS) {
            const px = 1080 * h;
            let c = 0;
            for (const th of MEAN_TH) {
                const r = color({ method: 40, lower: [0, 0, th], upper: [180, 255, 255], image: img, roi: [0, y, 1080, h], count: 1 });
                c += (r.hit ? r.results[0]?.count ?? 0 : 0) / px;
            }
            sum += 32 + 64 * c;
        }
        return sum / MEAN_STRIPS.length;
    }
    /** 起幕布's orange edges in EDGE_STRIPS strips (combat.js). @param {Image} im */
    function edgeParts(im) {
        const [x0, y0, W, H] = EDGE_ROI;
        const sw = Math.ceil(W / EDGE_STRIPS);
        /** @type {Match[]} */
        const out = [];
        for (let i = 0; i < EDGE_STRIPS; i++) {
            const a = Math.max(x0, x0 + i * sw - EDGE_OVERLAP), b = Math.min(x0 + W, x0 + (i + 1) * sw + EDGE_OVERLAP);
            for (const m of color({ ...EDGE, image: im, roi: [a, y0, b - a, H], count: 300, connected: true }).results) {
                const [x, , w] = m.box;
                if ((a > x0 && x <= a) || (b < x0 + W && x + w >= b)) continue;
                out.push(m);
            }
        }
        return out;
    }
    /** The gap to walk into, [left, right], or "covered", or null (combat.js). @returns {[number, number] | "covered" | null} */
    function gapNow() {
        const im = img;
        const edges = edgeParts(im)
            .filter(({ box: [, , w, h], count }) => h >= EDGE_H && w <= 30 && (count ?? 0) >= 2.5 * h).map((m) => m.box);
        if (!edges.length) return null;
        const dark = color({ ...CURTAIN_DARK, image: im, roi: CURTAIN_ROI, count: 5000, connected: true });
        if (!dark.hit) return null;
        const panels = dark.results.map((m) => m.box).filter((b, i) => b[2] >= 100 && b[3] >= 100 && (dark.results[i].count ?? 0) >= 0.5 * b[2] * b[3]);
        if (!panels.length) return null;
        const sides = panels.flatMap(([x, , w]) => [x, x + w]);
        if (!edges.some(([x, , w]) => sides.some((s) => Math.abs(x + w / 2 - s) <= 40))) return null;
        const spans = panels.map(([x, , w]) => [x, x + w]).sort((a, b) => a[0] - b[0]);
        /** @type {[number, number][]} */
        const free = [];
        let at = 0;
        for (const [a, b] of spans) {
            if (a - at >= 40) free.push([at, a]);
            at = Math.max(at, b);
        }
        if (1080 - at >= 40) free.push([at, 1080]);
        const inner = free.filter(([a, b]) => a > 0 && b < 1080);
        const cands = inner.length ? inner : free;
        if (!cands.length) return "covered";
        const off = (/** @type {[number, number]} */ [a, b]) => (a <= ME_X && ME_X <= b ? 0 : Math.min(Math.abs(a - ME_X), Math.abs(b - ME_X)));
        return cands.reduce((p, q) => (off(q) < off(p) ? q : p));
    }
    const hpRead = () => perFrame("hp", (im) => health(im));
    const qiRead = () => perFrame("qi", () => readQi());
    const litRead = () => perFrame("lit", () => litNow());
    const bossRead = () => perFrame("boss", () => bossPx());

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
    let qiNow = -1, litPx = 0, bossNow = 0, meanNow = -1, dark3 = 0, flare = 0;
    /** @type {number[]} */
    const meanRing = [];
    let potionsUsed = 0;
    let dodgeSeq = 0, inDodge = false, stickSide = 0;
    let inCurtain = false, curtainLastAt = 0, curtainFirstAt = 0, curtainDodged = false, curtainDodgeAt = 0, lastFlareDodgeAt = 0, lastPotionHoldMark = 0;
    let curtainDarkSeen = 0; // v7 A2: consecutive tell-dark frames at the cover onset
    let weakSince = 0, qiZeroSeen = 0, qiEmpty = 0, lastLightAt = 0, lastExecTapAt = 0, lastExecMatchAt = 0; // v7 C
    let lastAvoidDropAt = 0; // an "avoid" (curtain) item just handled: no new one for a moment
    let lastTellArg = -1, lastTellDodgeArg = -1, lastTellDodgeAt = 0; // tell continuity + one dodge per episode
    let flareLastFireAt = 0, flareFirstAt = 0, flareLastArg = -1; // v7 A1 anchor: the current flare episode's onset
    let flareSeenAt = 0; // v8: the image flare rule's last hit (parry mode's "flare live")
    let sweepAt = 0, sweepK = 1, sweepSrc = "", lastDarkAt = 0, timedSweeps = 0; // v8 curtainTimed
    let lastPlanParryAt = 0, failEscapeFor = 0, failEscapes = 0, flare2s = 0, tellParries = 0; // v8 flare2 / failEscape
    // v8 flareHoldFut: the hold's start (0 = off), the last flare_other report, the episode's anchored item
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
    /** @type {Pred | null} */
    let pred = null;
    /** @type {PlanItem[]} */
    let plan = [];
    let headCalls = 0, ready = 0, looks = 0, reason = "time";
    let hits = 0, oks = 0, misses = 0, late = 0, revisions = 0, branches = 0, branchDrops = 0;
    let holds = 0, holdPresses = 0, insurePresses = 0, pressedSinceHit = false, rerepresses = 0;
    let weakWindows = 0, weakLights = 0, weakExecs = 0;
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

    // --- prediction decoding
    /** @param {number[]} out @param {number} off @param {number} n */
    function softmax(out, off, n) {
        let mx = -Infinity;
        for (let i = 0; i < n; i++) mx = Math.max(mx, out[off + i]);
        const p = new Array(n).fill(0);
        let sum = 0;
        for (let i = 0; i < n; i++) {
            p[i] = Math.exp(out[off + i] - mx);
            sum += p[i];
        }
        for (let i = 0; i < n; i++) p[i] /= sum;
        return p;
    }
    /** @param {number[]} p */
    function argmax(p) {
        let a = 0;
        for (let i = 1; i < p.length; i++) if (p[i] > p[a]) a = i;
        return a;
    }
    /** @param {number[]} p @param {string[]} labels @returns {HeadOut} */
    function headOut(p, labels) {
        const arg = argmax(p);
        return { probs: p, arg, p: p[arg], label: labels[arg] };
    }
    /** @param {number[]} out */
    function decode(out) {
        pred = {
            combo: headOut(softmax(out, 0, 16), COMBO_LABELS),
            stage: headOut(softmax(out, 16, 6), STAGE_LABELS),
            fut: [0, 1, 2].map((i) => softmax(out, 22 + i * 11, 11)),
            def: [0, 1, 2].map((i) => softmax(out, 55 + i * 5, 5)),
            tell: headOut(softmax(out, 70, 7), TELL_LABELS),
        };
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

    // --- the 15 aux columns (unified_head2.json), frozen with each frame
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
    const comboRunning = () => !pred ? false : comboV6
        ? pred.combo.arg >= 2 && pred.combo.arg <= 7 && pred.combo.p >= 0.4 // chain continues: a next segment expected
        : pred.combo.arg >= 2 && pred.combo.p >= 0.4 && pred.stage.arg >= 1 && pred.stage.arg <= 4;
    const comboDropped = () => !!pred && pred.combo.arg <= 1;
    /** @param {number} k @param {number} i */
    const futBin = (k, i) => pred?.fut[k]?.[i] ?? 0;
    /** @param {number[]} p @returns {{none: number, sum: number, exp: number, mode: number, i1: number, p1: number, i2: number, p2: number}} */
    function futStats(p) {
        let sum = 0, e = 0, i1 = -1, p1 = 0, i2 = -1, p2 = 0;
        for (let i = 0; i < 10; i++) {
            const v = p[i] ?? 0;
            sum += v;
            e += v * FUT_CENTER[i];
            if (v > p1) {
                i2 = i1;
                p2 = p1;
                i1 = i;
                p1 = v;
            } else if (v > p2) {
                i2 = i;
                p2 = v;
            }
        }
        return { none: p[10] ?? 0, sum, exp: sum > 0 ? e / sum : Infinity, mode: i1, i1, p1, i2, p2 };
    }
    /** The defense the k-th contact wants: null on none. @param {number[]} p */
    function defAction(p) {
        let bi = 0;
        for (let i = 1; i < 5; i++) if (p[i] > p[bi]) bi = i;
        if (bi === 0) return null;
        if (bi === 3) return /** @type {"avoid"} */ ("avoid");
        if (bi === 2) return (p[2] ?? 0) >= dodgeMinP && !flareParryNow() ? /** @type {"dodge"} */ ("dodge") : /** @type {"parry"} */ ("parry");
        return /** @type {"parry"} */ ("parry");
    }
    /** v8 parry mode: a flare (tell class 1-3 or the image rule) is live and not a grab that keeps its dodge. */
    function flareParryNow() {
        if (flareMode !== "parry") return false;
        const now = Date.now();
        if (now - flareLastFireAt > FLARE_LIVE_MS && now - flareSeenAt > FLARE_LIVE_MS) return false;
        return !(flareGrabDodge && flareLastArg === 2 && now - flareLastFireAt <= FLARE_LIVE_MS);
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
    /** @param {string} why */
    function clearPlan(why) {
        if (!plan.length) return;
        mark("plan", `cancel all (${why})`);
        plan = [];
    }
    /** @param {string} why */
    function cancelFuture(why) {
        let n = 0;
        for (const it of [...plan]) {
            // v8 curtainKeepParry: only the dodge-type items go (v7 also dropped the 卸势 of plain blows: A arm 4/8
            // "predicted, not pressed" hits were planned parries cancelled by curtainImg/curtainDark entries)
            if (it.src === "fut" && !it.committed && !it.pressedAt && !(curtainKeepParry && it.kind === "parry")) {
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
        for (let i = 1; i <= s1Hi; i++) s1 += futBin(k, i);
        const def = defAction(pred?.def[k] ?? []);
        const trig = k === 0 ? s1 >= trigTh : comboRunning() || s1 >= trigTh * 0.6;
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
        if (plan.some((x) => x.k === k && x.src === "combo")) return; // a pre-scheduled template item owns the slot
        // v7 A3: a pressed item whose believed contact has passed without any ok/hit feedback, while the fresh fut
        // still points at a real contact, is re-armed once. Bypasses the S1 trigger on purpose: after an early press
        // the head is quiet until the arm's real contact approaches (r241 press@196 c=210: S1 0.04-0.18 until t225,
        // real contact 243). The estimate may still be 30-45 f out here; re-pressing lands at c'-14.
        const main0 = plan.find((x) => x.k === k && x.src === "fut" && !x.branch);
        if (repress && main0 && main0.pressedAt && !main0.repressed && pred
            && now - main0.pressedAt >= repressGapMs && now > main0.cMs + 3 * FRAME_MS
            && lastHitAt < main0.pressedAt - FRAME_MS && lastOkAt < main0.pressedAt - FRAME_MS) {
            const st2 = futStats(pred.fut[k]);
            if (st2.none < 0.65 && st2.sum > 0.01 && st2.exp >= LATE_FRAMES && st2.exp <= 45) {
                main0.repressed = true;
                main0.pressedAt = 0;
                main0.kind = defAction(pred.def[k]) ?? /** @type {"parry"} */ ("parry");
                if (main0.kind === "avoid" && !inCurtain) main0.kind = "parry";
                main0.cMs = now + st2.exp * FRAME_MS;
                main0.atMs = main0.cMs - leadOf(main0.kind);
                main0.untilMs = main0.cMs + missGraceMs;
                rerepresses++;
                mark("re-press", `k${k} ${main0.kind} late fill c+${Math.round(st2.exp)}f`);
                return;
            }
            if (st2.sum > 0.05) {
                // the head is unsure (none >= 0.65) but the contact is still coming (252 f4204: press 37 f early,
                // sum 0.16-0.22 / none 0.80-0.89 while the real contact was 4241): a fixed short-delay second tap
                main0.repressed = true;
                main0.pressedAt = 0;
                main0.atMs = now + REPRESS_DELAY_FRAMES * FRAME_MS;
                main0.cMs = main0.atMs + leadOf(main0.kind);
                main0.untilMs = main0.atMs + 40 * FRAME_MS;
                rerepresses++;
                mark("re-press", `k${k} ${main0.kind} second tap +${REPRESS_DELAY_FRAMES}f`);
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
            addItem({ kind: t.kind, k, src: "fut", cMs: t.cMs, atMs: t.cMs - leadOf(t.kind), untilMs: t.cMs + missGraceMs, why: `pred k${k}${t.covers ? " covers both" : ""}` });
        } else if (!main.committed && !main.pressedAt) {
            if (Math.abs(t.cMs - main.cMs) > REVISE_MOVE_MS || t.kind !== main.kind) {
                revisions++;
                mark("revise", `k${k} ${main.kind}->${t.kind} c ${Math.round(main.cMs - now)}->${Math.round(t.cMs - now)} ms`);
                main.kind = t.kind;
            }
            main.cMs = t.cMs;
            main.atMs = t.cMs - leadOf(t.kind);
            main.untilMs = t.cMs + missGraceMs;
        } else if (repress && main.pressedAt && !main.repressed && t.cMs - main.cMs > REVISE_MOVE_MS
                   && t.cMs - main.pressedAt >= repressGapMs && t.cMs - now >= LATE_FRAMES * FRAME_MS
                   && now - main.pressedAt >= parryCd) {
            // v7 A3: the contact moved later after the press (long wind-up): re-arm once and press again at its window
            const moved = t.cMs - main.cMs;
            main.repressed = true;
            main.pressedAt = 0;
            main.cMs = t.cMs;
            main.atMs = t.cMs - leadOf(main.kind);
            main.untilMs = t.cMs + missGraceMs;
            rerepresses++;
            mark("re-press", `k${k} ${main.kind} contact moved +${Math.round(moved / FRAME_MS)}f`);
        }
        if (t.branchMs) {
            if (!br) addItem({ kind: t.kind, k, src: "fut", branch: true, cMs: t.branchMs, atMs: t.branchMs - leadOf(t.kind), untilMs: t.branchMs + missGraceMs, t1Ms: t.cMs, why: "branch (bimodal)" });
            else if (!br.pressedAt) {
                br.cMs = t.branchMs;
                br.atMs = t.branchMs - leadOf(br.kind);
                br.untilMs = t.branchMs + missGraceMs;
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
        // v7 A1: track flare episodes for the onset anchor (first fire of a flare run of the same class)
        if (t.arg >= 1 && t.arg <= 3) {
            if (now - flareLastFireAt > 20 * FRAME_MS || t.arg !== flareLastArg) {
                flareFirstAt = now;
                if (flareHoldFut && t.arg === 1) {
                    if (foFrom) foEnd("new episode");
                    foFrom = now;
                    foItem = null;
                    foS.holds++;
                    mark("flarehold", `start (flare_other first report p${Math.round(t.p * 100)})`);
                }
            }
            flareLastFireAt = now;
            flareLastArg = t.arg;
            if (t.arg === 1) foLastAt = now;
        }
        // v7 A2 fallback 2 (per-frame): the tell head's dark class fires at the curtain's black cover onset
        // (233-252: 77/82 dark streaks p>=0.7 (>=2 f) sit at a real episode; 46/54 episodes covered). Sampling a
        // 400 ms slow task would miss the short covers, so it lives here, in the per-frame tell path.
        if (t.arg === 6 && t.p >= 0.7) {
            // v8 curtainTimed: a dark run's first frame is a sweep (the cover onset or a later black sweep): sync
            if (curtainTimed && now - lastDarkAt > SWEEP_DARK_GAP_MS) sweepSync(now - SWEEP_DARK_LAG_F * FRAME_MS, "dark");
            lastDarkAt = now;
            if (++curtainDarkSeen >= 2 && curtainDark && !inCurtain
                && (t.p >= 0.85 || (meanNow >= 0 && meanNow < 30))) {
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
        if (t.p < tellTh || t.arg === 0 || t.arg === 6) return;
        if (t.arg === 5) {
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
        if (t.p < tellDodgeP || !sustained) return;
        if (t.arg === lastTellDodgeArg && now - lastTellDodgeAt < tellEpisodeMs) return;
        const st = futStats(pred.fut[0]);
        // v8: the late / parry flare modes are onset-anchored whatever tellAnchor says
        const anchored = (tellAnchor || flareMode !== "dodge") && t.arg >= 1 && t.arg <= 3;
        if (!anchored && (st.none >= 0.65 || st.sum <= 0.01)) return;
        const c1 = st.none >= 0.65 || st.sum <= 0.01 ? now + 350 : now + st.exp * FRAME_MS;
        if (c1 - now < LATE_FRAMES * FRAME_MS) {
            late++;
            mark("late", `tell ${t.label}`);
            return;
        }
        const label = TELL_LABELS[t.arg];
        let at;
        if (anchored && flareMode === "parry" && !(flareGrabDodge && t.arg === 2)) {
            // v8 parry mode: the flare gets a 卸势 lit ~5-6 f before its contact (one per episode, like the dodge)
            const pat = Math.max(now, flareFirstAt + (anchorTab[label] ?? ANCHOR_PARRY.flare_other) * FRAME_MS);
            if (plan.some((x) => x.src === "tell" && x.kind === "parry" && Math.abs(x.atMs - pat) < TELL_DEDUP_MS)) return;
            lastTellDodgeArg = t.arg;
            lastTellDodgeAt = now;
            tellParries++;
            addItem({ kind: "parry", k: -1, src: "tell", cMs: pat + issueLead, atMs: pat, untilMs: pat + issueLead + missGraceMs, why: `tell ${label} parry anchor p${Math.round(t.p * 100)}` });
            return;
        }
        if (anchored) {
            // v7 A1: press at the episode onset + anchor frames (the appearance lands ~5 f later); the head's first
            // fire is the image onset +-3 f (tells head vs flares_ds onsets, 233-252: p50 0 / p90 +3). v8: the
            // mode's table (late: show ~2 f before the contact); parry mode's grab dodge keeps the v7 table
            at = flareFirstAt + ((flareMode === "parry" ? ANCHOR_FRAMES[label] : anchorTab[label]) ?? 4) * FRAME_MS;
            if (at < now) at = now;
        } else if (t.arg === 4) {
            if (st.mode < 0) return;
            at = now + FUT_CENTER[st.mode] * FRAME_MS - leadMs("sweep");
        } else {
            at = c1 - leadMs(label);
        }
        if (now - lastDodgeAt < dodgeCd) return;
        if (plan.some((x) => x.src === "tell" && x.kind === "dodge" && Math.abs(x.atMs - at) < TELL_DEDUP_MS)) return;
        lastTellDodgeArg = t.arg;
        lastTellDodgeAt = now;
        const tit = addItem({ kind: "dodge", dir: nextDir(), k: -1, src: "tell", cMs: c1, atMs: at, untilMs: Math.max(c1, at) + missGraceMs, why: `tell ${label}${anchored ? " anchor" : ""} p${Math.round(t.p * 100)}` });
        if (flareHoldFut && foFrom && anchored && t.arg === 1 && !foItem) {
            foItem = tit;
            foS.anchorPlans++;
        }
    }
    /** @param {string} dir @returns {Point} */
    function dirPoint(dir) {
        return dir === "left" ? LEFT : dir === "right" ? RIGHT : dir === "forward" ? FORWARD : BACKWARD;
    }
    function nextDir() {
        const n = dodgeSeq++;
        if (dodgeDir === "side") return n % 2 ? "right" : "left";
        if (dodgeDir === "forward") return "forward";
        if (dodgeDir === "backleft") return n % 2 ? "left" : "back";
        if (dodgeDir === "cycle") return ["back", "left", "right"][n % 3];
        return "back";
    }
    /** @param {string} dir */
    function pressDodge(dir) {
        if (observe) {
            lastDodgeAt = Date.now();
            return;
        }
        inDodge = true;
        walkOff();
        try {
            tdown(STICK, 0);
            tmove(dirPoint(dir), 0);
            tdown(dodgeP, 2);
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
            if (!observe) tap(parryP);
            lastParryAt = Date.now();
            pressFrame(frameIdx);
            presses.parry++;
            it.pressedAt = lastParryAt;
            if (it.src !== "insure") pressedSinceHit = true;
            if (it.src === "fut" || it.src === "combo") lastPlanParryAt = lastParryAt; // v8 failEscape's timer
            mark("press", `parry${observe ? " sim" : ""} k${it.k} ${it.src} c+${Math.round((it.cMs - lastParryAt) / FRAME_MS)}f ${it.why}`);
        } else if (it.kind === "dodge") {
            const tapAt = Date.now();
            pressDodge(it.dir);
            pressFrame(frameIdx);
            presses.dodge++;
            it.pressedAt = Date.now();
            mark("press", `dodge${observe ? " sim" : ""} ${it.dir} k${it.k} ${it.src} c+${Math.round((it.cMs - it.pressedAt) / FRAME_MS)}f ${it.why}`);
            if (flareHoldFut) {
                if (it === foItem) {
                    foS.anchorPressed++;
                    foS.pressMsAfterFirst.push(tapAt - foFrom);
                    foEnd("anchor pressed");
                } else if (it.src === "fut" && foHeld.has(it)) foS.heldPressedAfter++;
            }
            if (flare2 && it.src === "tell" && it.why.includes("flare") && !it.why.startsWith("flare2")) {
                // v8 flare2 (combat.js): the second 金光 dodge goes whatever happened, same way, past the dodge CD
                flare2s++;
                addItem({ kind: "dodge", dir: it.dir, k: -1, src: "tell", cMs: it.cMs, atMs: tapAt + FLARE2_MS,
                          untilMs: tapAt + FLARE2_MS + missGraceMs, noCd: true, why: "flare2 (second 金光 dodge)" });
            }
        } else if (it.kind === "potion") {
            if (!observe) tap(potionP);
            lastPotionAt = Date.now();
            potionHoldUntil = lastPotionAt + potionHoldMs;
            potionsUsed++;
            pressFrame(frameIdx);
            presses.potion++;
            it.pressedAt = lastPotionAt;
            mark("potion", `hp ${Math.round((hpNow ?? 0) * 100)}% (${potionsUsed}/${maxPotions})`);
        }
    }
    /** @param {PlanItem} it @param {number} now @returns {string} */
    function pressBlocked(it, now) {
        if (now < staggerUntil) return "stagger";
        if (now < potionHoldUntil) return "potion";
        if (inDodge) return "dodge";
        if (it.kind === "parry" && now - lastParryAt < parryCd) return "parry cd";
        if (it.kind === "dodge" && now - lastDodgeAt < dodgeCd && !it.noCd) return "dodge cd";
        return "";
    }
    /** @param {number} now */
    function executePlan(now) {
        const items = [...plan].sort((a, b) => a.atMs - b.atMs);
        for (const it of items) {
            if (!plan.includes(it) || it.pressedAt) continue;
            if (now < it.atMs) continue;
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
                // v8 flareHoldFut: the flare_other anchored dodge owns the dodge CD; keep the item for after the hold
                foS.blockedFrames++;
                if (!foHeld.has(it)) {
                    foHeld.add(it);
                    foS.blockedItems++;
                    mark("flarehold", `fut dodge k${it.k} held c+${Math.round((it.cMs - now) / FRAME_MS)}f`);
                }
                continue;
            }
            if (it.src === "insure") {
                // v6 post-hit insurance (dufu.js arg posthit): fires at the stagger's end; blocked -> retry (until
                // expiry); narrow -> skipped when the plan already has a pending item or a plan press since the hit
                if (pressBlocked(it, now)) continue;
                if (pressedSinceHit) {
                    dropItem(it, "posthit: plan pressed");
                    continue;
                }
                if (posthitNarrow && plan.some((o) => o !== it && o.src !== "insure" && !o.pressedAt)) {
                    dropItem(it, "posthit: plan live");
                    continue;
                }
                if (!observe) tap(parryP);
                lastParryAt = Date.now();
                pressFrame(frameIdx);
                presses.parry++;
                insurePresses++;
                it.pressedAt = lastParryAt;
                mark("press", `parry${observe ? " sim" : ""} posthit c+${Math.round((it.cMs - lastParryAt) / FRAME_MS)}f`);
                dropItem(it, "posthit done");
                continue;
            }
            const why = pressBlocked(it, now);
            if (why) {
                blocked[why] = (blocked[why] ?? 0) + 1;
                if (staggerOn && why === "stagger" && !it.branch && it.cMs - now >= holdMinLead * FRAME_MS) {
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
            if (it.held && it.cMs - now < holdMinLead * FRAME_MS) {
                dropItem(it, "held: too late");
                continue;
            }
            press(it, now);
            if (it.held) holdPresses++;
        }
    }
    /** @param {number} now */
    function expire(now) {
        for (const it of [...plan]) {
            if (!it.branch && !it.pressedAt && it.kind !== "potion" && now > it.untilMs) {
                dropItem(it, "expired unpressed");
            } else if (!it.branch && it.pressedAt && it.kind !== "potion" && now > it.untilMs) {
                // v7 A3: about to become a miss — if the fresh fut still points at a contact the press was too early
                // for (the true contact has not happened yet), re-arm once and press again in its window. The trigger
                // gate is deliberately bypassed here: after an early press the S1 trigger usually drops while the
                // arm is still winding up (r241 press@196 c=210, S1 0.04-0.18 until t225, real contact 243).
                if (repress && !it.repressed && it.src === "fut" && it.k >= 0 && pred) {
                    const st2 = futStats(pred.fut[it.k]);
                    if (st2.none < 0.65 && st2.sum > 0.01 && st2.exp >= LATE_FRAMES && st2.exp <= REPRESS_LOOK_FRAMES) {
                        it.repressed = true;
                        it.pressedAt = 0;
                        it.kind = defAction(pred.def[it.k]) ?? /** @type {"parry"} */ ("parry");
                        if (it.kind === "avoid" && !inCurtain) it.kind = "parry";
                        it.cMs = now + st2.exp * FRAME_MS;
                        it.atMs = it.cMs - leadOf(it.kind);
                        it.untilMs = it.cMs + missGraceMs;
                        rerepresses++;
                        mark("re-press", `k${it.k} late fill c+${Math.round(st2.exp)}f`);
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
        for (const it of plan) if (!it.branch && !it.pressedAt) it.committed = it.atMs - now <= commitMs;
        if (inCurtain) {
            if (now - curtainLastAt > CURTAIN_GONE_MS) {
                inCurtain = false;
                mark("curtain", "over");
            }
        } else {
            for (let k = 0; k < 3; k++) syncK(now, k);
        }
        tellPlan(now);
        if (flareHoldFut) foTick(now);
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
    /** @param {number} now */
    function predMark(now) {
        if (!pred || now - predMarkAt < predMs) return;
        predMarkAt = now;
        const st = futStats(pred.fut[0]);
        let s1 = 0;
        for (let i = 1; i <= s1Hi; i++) s1 += futBin(0, i);
        mark("pred", `S1 ${s1.toFixed(2)} bin ${st.mode}(${FUT_LABELS[st.mode] ?? "-"}) c1 +${st.sum > 0 ? Math.round(st.exp) : "-"}f ` +
            `def1 ${DEF_LABELS[argmax(pred.def[0])]} tell ${pred.tell.label} combo ${(comboV6 ? COMBO6_LABELS : COMBO_LABELS)[pred.combo.arg]} ${pred.combo.p.toFixed(2)} stage ${pred.stage.label}`);
    }
    let predMarkAt = 0;

    // --- feedback (fast path): hp drop = hit, qi drop = ok
    /** @param {number} now @param {number} before @param {number} after */
    function onHit(now, before, after) {
        hits++;
        lastHitAt = now;
        pressedSinceHit = false;
        staggerUntil = Math.max(staggerUntil, now + staggerMs);
        const n = plan.length;
        if (holdOn) {
            // v6: keep the unpressed items that still target a future contact; only stale/consumed ones go
            /** @type {PlanItem[]} */
            const keep = [];
            for (const it of plan) {
                if (!it.pressedAt && it.cMs > now + 2 * FRAME_MS) keep.push(it);
                else mark("plan", `- ${it.kind} k${it.k} hit ${it.pressedAt ? "pressed" : "stale"}`);
            }
            plan = keep;
            mark("hit", `${Math.round(before * 100)}%->${Math.round(after * 100)}% (${n - keep.length}/${n} dropped, ${keep.length} kept)`);
        } else {
            clearPlan("hit");
            mark("hit", `${Math.round(before * 100)}%->${Math.round(after * 100)}% (${n} planned cancelled)`);
        }
        mark("stagger", `${staggerMs} ms`);
        // v8 curtainTimed: a hit in the curtain is a sweep (re-sync when unsynced or near a predicted sweep)
        if (curtainTimed && (inCurtain || now - curtainLastAt < CURTAIN_GONE_MS)) {
            const est = now - SWEEP_HIT_LAG_F * FRAME_MS;
            const valid = sweepAt && est - sweepAt <= (SWEEP_N + 0.5) * sweepPeriodMs;
            const j = valid ? Math.round((est - sweepAt) / sweepPeriodMs) : 0;
            if (!valid || (j >= 1 && Math.abs(est - sweepAt - j * sweepPeriodMs) <= SWEEP_HIT_NEAR_F * FRAME_MS)) sweepSync(est, "hit");
        }
        if (posthitN > 0) {
            addItem({ kind: "parry", k: -1, src: "insure", cMs: now + staggerMs, atMs: now + staggerMs,
                      untilMs: now + staggerMs + 30 * FRAME_MS, why: `posthit ${posthitNarrow ? "narrow" : "wide"}` });
            if (posthitN > 1) {
                addItem({ kind: "parry", k: -1, src: "insure", cMs: now + staggerMs + 10 * FRAME_MS,
                          atMs: now + staggerMs + 10 * FRAME_MS, untilMs: now + staggerMs + 40 * FRAME_MS, why: "posthit 2" });
            }
        }
        if (preschedOn) comboPlan(now);
    }
    /**
     * v5 presched: pre-schedule the following combo segments from the frozen template gaps after a hit. Uses the
     * head output of the frame before the drop (the runtime sees the hit before it runs the head on the frame);
     * contact = drop - DROP_LAG frames. Items are committed at birth and own their k slot (@see syncK).
     * v6 (comboV6): the gap-to-next-bin head gives the next segment's gap directly (prob-weighted mean over the
     * bins 2..7); one item per hit, no template table.
     * @param {number} now
     */
    function comboPlan(now) {
        if (!pred) return;
        let kind = defAction(pred.def[0]);
        if (!kind || (kind === "avoid" && !inCurtain)) kind = "parry";
        if (comboV6) {
            const p = pred.combo.probs;
            let pb = 0, g = 0;
            for (let i = 2; i <= 7; i++) {
                pb += p[i] ?? 0;
                g += (p[i] ?? 0) * COMBO6_CENTER[i - 2];
            }
            if (pb < 0.4) return;
            g /= pb;
            const c = now - DROP_LAG * FRAME_MS + g * FRAME_MS;
            if (c - now > PLAN_FRAMES_MAX * FRAME_MS || c - now < LATE_FRAMES * FRAME_MS) return;
            for (const o of [...plan]) if (o.src === "fut" && o.k === 0 && !o.pressedAt) dropItem(o, "combo owns slot");
            addItem({ kind, k: 0, src: "combo", cMs: c, atMs: c - leadOf(kind), untilMs: c + missGraceMs, committed: true,
                      why: `v6 gap ${g.toFixed(1)}f p${pb.toFixed(2)}` });
            return;
        }
        if (pred.combo.arg < 2 || pred.combo.p < 0.4) return;
        const gr = COMBO_GAPS[pred.combo.arg - 2];
        const st = pred.stage.arg;
        if (!gr || st < 2 || st > 4) return;
        const idx = Math.min(st - 2, gr.length - 1);
        let c = now - DROP_LAG * FRAME_MS;
        const n = Math.min(preschedN, gr.length - idx);
        for (let i = 0; i < n; i++) {
            c += gr[idx + i] * FRAME_MS;
            if (c - now > PLAN_FRAMES_MAX * FRAME_MS || c - now < LATE_FRAMES * FRAME_MS) break;
            addItem({ kind, k: i, src: "combo", cMs: c, atMs: c - leadOf(kind), untilMs: c + missGraceMs, committed: true, why: `template T${pred.combo.arg - 1} seg${st + i}` });
        }
    }
    /** @param {number} now */
    function onOk(now) {
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
            if (hpNow != null && h < hpNow - HIT_DROP && h > hpNow - 0.35) onHit(now, hpNow, h);
            hpNow = h;
        }
        const q = qiRead();
        if (q >= 0) {
            if (qiNow >= 4 && qiNow - q >= QI_STEP && qiNow - q <= QI_JUMP) onOk(now);
            qiNow = q;
            qiEmpty = 0;
        } else {
            // v7 C: an exhausted qi bar has no light-blue pixels at all: the read fails (-1), NOT 0 (the dataset's
            // f6.py reads 0 on the same frames). Track the empty streak so the 气竭 detector can fire.
            qiEmpty++;
        }
        litPx = litRead();
    }

    // --- the round is over (重伤): the 再次训练 panel, or a long all-grey screen (@see combat.js)
    let deadAt = 0, deadSeen = 0, greySeen = 0;
    /** @param {number} now */
    function deadCheck(now) {
        if (now - deadAt < DEAD_MS) return false;
        deadAt = now;
        // The button is unmistakable (1980 px on the death panel). But white effect bursts also cross this ROI in
        // fights (270p proxy >= 40 px, verified 1250-1430 px full-res: replay/deadcheck_sweep.py), so two checks in
        // a row must ALSO see the boss bar gone, unless the count is death-panel-sized (>= 1600) — the count is
        // the boss-bar-independent fallback for stale boss reads. The guard removes all battle-period false triggers
        // (66/67 recorded rounds, all 187 check alignments, before this guard) while the real deaths in 219-225 all
        // still fire (via the grey screen below).
        const btn = countAtLeast(RETRY_WHITE, RETRY_ROI, 800, img);
        const again = btn && (bossNow <= 50 || countAtLeast(RETRY_WHITE, RETRY_ROI, 1600, img));
        deadSeen = again ? deadSeen + 1 : 0;
        if (deadSeen >= 2) {
            mark("dead", `the round is over (reset button${bossNow > 50 ? ", strong" : ""})`);
            return true;
        }
        if (!deadGrey) return false;
        // a curtain blackout lasts ~1 s: only a grey screen of ~2.5 s counts (painting the death screen before its
        // button). 8/8 terminal recordings fire here, 75-89 frames after the screen appears, with zero battle-period
        // triggers in 74 rounds x 187 check alignments (replay/deadcheck_sweep.py).
        const grey = countAtLeast(GREY, GREY_ROI, Math.round(0.85 * GREY_ROI[2] * GREY_ROI[3]), img);
        greySeen = grey ? greySeen + 1 : 0;
        if (greySeen >= 6) {
            mark("dead", "the round is over (grey screen)");
            return true;
        }
        return false;
    }

    // --- lock-on: tap the lock button back on while the gold icon is gone (combat.js rule; no touches in observe)
    let lockWas = false, lockTaps = 0, lastLockTap = 0;
    /** @param {number} now */
    function lockCheck(now) {
        if (observe || !lockOn) return;
        const locked = color({ ...GOLD, image: img, roi: LOCK_ROI, count: 150 }).hit;
        if (locked !== lockWas) {
            lockWas = locked;
            mark("lock", locked ? "icon lit" : "icon dark");
        }
        if (!locked && !upDue && now - lastLockTap >= LOCK_MS) {
            lastLockTap = now;
            lockTaps++;
            tap(LOCK);
            mark("lock", `re-lock tap ${lockTaps}`);
        }
    }

    // --- round start (armed): walk in, in short bursts, until the boss bar shows
    let bossSeen = false;
    /** @param {number} now */
    function approach(now) {
        if (observe || bossSeen) return;
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

    // --- slow rules (run on the frame budget's leftover, in priority order)
    let stickF = 0; // the forward push (walking in); setSide is the horizontal one
    /** Push the joystick forward, 0/1 (@see setSide). @param {number} v */
    function strideF(v) {
        if (observe || v === stickF) return;
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
        if (observe) return;
        if (v === stickSide) return;
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
    /**
     * v8 curtainTimed: a sweep happened at press-clock time `at` (the moment a 卸势 tap would have lit at the sweep's
     * frame): the next SWEEP_N sweeps (period sweepPeriod) get one back dodge each (@see sweepTick).
     * @param {number} at @param {string} src
     */
    function sweepSync(at, src) {
        sweepAt = at;
        sweepK = 1;
        sweepSrc = src;
        mark("curtain", `sweep sync (${src})${inCurtain ? "" : " (not in curtain yet)"}`);
    }
    /** The next timed sweep dodge's tap time, or 0 (none due: unsynced / done / not in the curtain). */
    function sweepPressAt() {
        if (!curtainTimed || !sweepAt || !inCurtain || sweepK > SWEEP_N) return 0;
        if (Date.now() - sweepAt > (SWEEP_N + 0.5) * sweepPeriodMs) return 0; // a stale sync (e.g. a dark blip long before)
        // a dodge tapped at t shows DODGE_SHOW_F after a 卸势 tapped at t would light: show = sweep - sweepLead
        return sweepAt + sweepK * sweepPeriodMs - (sweepLead + DODGE_SHOW_F) * FRAME_MS;
    }
    /** v8 curtainTimed, per frame: tap the timed back dodge when due (late by > SWEEP_LATE_MS: skip that sweep). @param {number} now */
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
            mark("curtain", `timed sweep ${sweepK} dodge${observe ? " sim" : ""} (${sweepSrc} sync +${Math.round((now - sweepAt) / FRAME_MS)}f)`);
            sweepK++;
            return;
        }
    }
    /** v8 curtainTimed: keep the gap rule's own dodges away from a timed one that is about to go. @param {number} now */
    const sweepQuiet = (now) => {
        const at = sweepPressAt();
        return !!at && at - now < SWEEP_QUIET_MS && at - now > -SWEEP_LATE_MS;
    };
    /**
     * v8 failEscape (combat.js windupAct): the last model 卸势 (fut/combo) shows no ok FAIL_ESCAPE_MS after its press
     * while the timing head still sees a blow (S1 >= trigTh): one side dodge (left / right in turn), only within
     * FAIL_ESCAPE_SPAN_MS of that, never within FAIL_ESCAPE_QUIET_MS of a dodge, not in stagger / curtain / potion.
     * @param {number} now
     */
    function failEscapeTick(now) {
        if (!failEscape || !lastPlanParryAt || failEscapeFor === lastPlanParryAt || !pred) return;
        const dt = now - lastPlanParryAt;
        if (dt < FAIL_ESCAPE_MS) return;
        if (dt >= FAIL_ESCAPE_MS + FAIL_ESCAPE_SPAN_MS || lastOkAt >= lastPlanParryAt || lastHitAt >= lastPlanParryAt) {
            failEscapeFor = lastPlanParryAt; // window over, or it worked (ok), or it is already a hit (stagger)
            return;
        }
        if (inDodge || inCurtain || weakSince || now < staggerUntil || now < potionHoldUntil || now - lastDodgeAt < FAIL_ESCAPE_QUIET_MS) return;
        let s1 = 0;
        for (let i = 1; i <= s1Hi; i++) s1 += futBin(0, i);
        if (s1 < trigTh) return;
        failEscapeFor = lastPlanParryAt;
        failEscapes++;
        const dir = failEscapes % 2 ? "left" : "right";
        pressDodge(dir);
        pressFrame(frameIdx);
        presses.dodge++;
        mark("press", `dodge${observe ? " sim" : ""} ${dir} k-1 failEscape 卸势没卸住 +${dt}ms S1 ${s1.toFixed(2)}`);
    }
    /** @param {number} now */
    function slowCurtain(now) {
        if (!curtainOn) return;
        if (!inCurtain) {
            // v7 A2 fallback 1: the combat.js image rule itself (panels + orange edge) — the tell head caught only
            // 1 of 252's 3 episodes (the other two it called "dark"); the full-res probe hits inside 52/54 episodes
            // (curtain_probe.py) and nowhere else in the labelled rounds; one probe hit enters the curtain handler.
            if (curtainImg && gapNow() !== null) {
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
        const g = gapNow();
        if (!g) {
            // the black cover: nothing to read; stay in the curtain and dodge out of the sweep's way once
            if (meanNow >= 0 && meanNow < 22) {
                curtainLastAt = now;
                if (!curtainFirstAt) curtainFirstAt = now;
                walkOff();
                if (!curtainDodged && now - curtainDodgeAt > CURTAIN_DODGE_GAP_MS && now - lastDodgeAt > dodgeCd && !sweepQuiet(now)) {
                    curtainDodged = true;
                    curtainDodgeAt = now;
                    mark("curtain", "cover: dodge");
                    if (observe) {
                        blocked.observe = (blocked.observe ?? 0) + 1;
                    } else {
                        pressDodge("back");
                        presses.dodge++;
                    }
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
            if (now - curtainDodgeAt > CURTAIN_DODGE_GAP_MS && now - lastDodgeAt > dodgeCd && !sweepQuiet(now)) {
                curtainDodgeAt = now;
                mark("curtain", "covered: dodge");
                if (observe) {
                    blocked.observe = (blocked.observe ?? 0) + 1;
                    mark("blocked", "dodge curtain observe");
                } else {
                    pressDodge("back");
                    presses.dodge++;
                }
            }
            return;
        }
        const [a, b] = g;
        const inGap = a - GAP_IN <= ME_X && ME_X <= b + GAP_IN;
        if (!curtainDodged && now - curtainFirstAt >= CURTAIN_FIRST_DODGE_MS && !inGap && !sweepQuiet(now)) {
            curtainDodged = true;
            walkOff();
            mark("curtain", "first sweep, not in the gap: dodge");
            if (!observe) {
                pressDodge((a + b) / 2 < ME_X ? "left" : "right");
                presses.dodge++;
            }
            return;
        }
        const dx = (a + b) / 2 - ME_X;
        const margin = Math.max(GAP_IN, (b - a) / 4);
        setSide(Math.abs(dx) <= margin ? 0 : Math.max(-1, Math.min(1, Math.round((dx / GAP_PUSH) * 4) / 4)) || 0);
    }
    /** @param {number} now */
    function slowFlare(now) {
        const seen = seeFlash();
        flare = seen ? 1 : 0;
        if (!seen) return;
        flareSeenAt = now; // v8 parry mode: the flare is live
        mark("flare", "gold + streak");
        if (!flareDodge || inCurtain) return;
        if (flareMode === "parry") return; // v8: the fut items turn into parries meanwhile (@see flareParryNow)
        if (now - lastDodgeAt < dodgeCd || now - lastFlareDodgeAt < 1000) return;
        if (plan.some((x) => x.kind === "dodge" && Math.abs(x.atMs - now) < TELL_DEDUP_MS * 2)) return;
        const st = pred ? futStats(pred.fut[0]) : null;
        const c1 = st && st.none < 0.65 && st.sum > 0.01 ? now + st.exp * FRAME_MS : now + 350;
        if (c1 - now < LATE_FRAMES * FRAME_MS) return;
        lastFlareDodgeAt = now;
        addItem({ kind: "dodge", dir: nextDir(), k: -1, src: "tell", cMs: c1, atMs: c1 - leadMs("other"), untilMs: c1 + missGraceMs, why: "flare color" });
    }
    /** @param {number} now */
    function slowPotion(now) {
        if (maxPotions <= 0 || potionsUsed >= maxPotions) return;
        if (hpNow == null || hpNow > potionHp) return;
        if (now < staggerUntil || now < potionHoldUntil || inDodge) return;
        if (plan.some((it) => it.kind === "potion")) return;
        const st = pred ? futStats(pred.fut[0]) : null;
        const c1 = st && st.none < 0.65 && st.sum > 0.01 ? st.exp : Infinity;
        if (hpNow > POTION_URGENT && c1 <= potionSafeFrames) {
            if (now - lastPotionHoldMark > 1000) {
                lastPotionHoldMark = now;
                mark("plan", `potion held (contact +${Math.round(c1)}f)`);
            }
            return;
        }
        addItem({ kind: "potion", k: -1, src: "potion", atMs: now, cMs: now, untilMs: now + 1500, why: `hp ${Math.round(hpNow * 100)}%` });
    }
    /**
     * v7 C 气竭 (weak) window: qi == 0 for two consecutive frames. Light attacks (輕擊) whenever no press is
     * imminent; the 处决 button (combat.js template) is tapped once qiExecWait ms into the window (the window is
     * ~7 s in the 233-252 recordings and the button shows for its whole length: 处决 damage is ~94% of the weak
     * window's damage, so waiting ~4 s then tapping keeps most of the light damage and still lands 处决).
     * @param {number} now
     */
    function slowWeak(now) {
        if (!qiAttack || observe) return;
        // the bar is empty when the read says 0, or the read keeps failing while the boss bar is up and the last
        // readable value was already tiny (the exhausted bar has no blue pixels -> readQi -1: all of 253-260's
        // qi==0 windows, 96-190 s in, were missed by a qiNow === 0 test)
        const empty = qiNow === 0 || (qiEmpty >= 2 && qiNow >= 0 && qiNow <= 25 && bossNow > 50);
        if (empty) qiZeroSeen++;
        else qiZeroSeen = 0;
        if (!weakSince && qiZeroSeen >= 2) {
            weakSince = now;
            weakWindows++;
            mark("qi", `weak: 真气 empty (read ${qiNow}, miss ${qiEmpty})`);
        }
        if (!weakSince) return;
        if (qiEmpty === 0 && qiNow > 4) {
            mark("qi", `weak over after ${Math.round((now - weakSince) / 1000)}s (${weakLights} light, ${weakExecs} exec)`);
            weakSince = 0;
            return;
        }
        if (now - lastExecMatchAt >= QI_EXEC_EVERY * FRAME_MS) {
            lastExecMatchAt = now;
            if (perFrame("exec", (im) => match("combat/execute.png", { image: im, roi: EXEC_ROI, threshold: execThreshold }).hit)) {
                if (now - weakSince >= qiExecWait && now - lastExecTapAt > 1000) {
                    lastExecTapAt = now;
                    weakExecs++;
                    tap(EXECUTE);
                    pressFrame(frameIdx);
                    mark("qi", `处决 tap (+${Math.round((now - weakSince) / 1000)}s)`);
                    return;
                }
            }
        }
        const pending = plan.some((x) => !x.pressedAt && x.atMs - now < 500);
        if (!pending && !inDodge && now >= staggerUntil && now >= potionHoldUntil && !inCurtain && !inDodge
            && now - lastLightAt >= QI_LIGHT_MS && now - lastExecTapAt >= 400) {
            lastLightAt = now;
            weakLights++;
            tap(LIGHT);
        }
    }
    /** v7 B closeIn: forward bursts while nothing is about to be pressed, so the boss stays in melee range. @param {number} now */
    function closeInWalk(now) {
        if (!closeIn || observe) return;
        if (inCurtain || inDodge || now < staggerUntil || now < potionHoldUntil || weakSince) {
            strideF(0);
            return;
        }
        const pending = plan.some((x) => !x.pressedAt && x.atMs - now < 700);
        const on = (now - start) % CI_CYCLE_MS < CI_ON_MS;
        strideF(on && !pending && !inDodge ? 1 : 0);
    }

    // ===================================================================================================== v8 offense
    // offense_plan.md part 1 (@see OFF_QUIET_TH). Reads plan / pred / lastHitAt / lastOkAt / staggerUntil / inDodge /
    // inCurtain / potionHoldUntil / bossNow / qiNow / qiEmpty; writes only its own state, plus weakSince while a
    // qiPlan window is on (so closeIn stops walking and failEscape stays quiet, as with qiAttack) and the unpressed
    // fut items it drops in that window. Called from the main loop only when offOn.
    let offUpAt = 0, offTouched = false; // offContact is down until offUpAt (0: up); lifted by offUp, never by upDue
    /** Put the offense finger down on p for ms (the lift comes from offUp, every loop turn). @param {Point} p @param {number} ms */
    function offDown(p, ms) {
        if (observe) return;
        if (offUpAt) touch.up(offContact);
        touch.down(p, offContact);
        offUpAt = Date.now() + ms;
        offTouched = true;
    }
    /** Lift the offense finger when due (or now). */
    function offUp(force = false) {
        if (!offUpAt || (!force && Date.now() < offUpAt)) return;
        touch.up(offContact);
        offUpAt = 0;
    }

    // --- quietGate shadow (offShadow)
    let offRun = 0, offRunReady = -1, offM30 = 1, offM40 = 1, offTellAt = 0, offTickAt = 0;
    let offOpenAt = 0, offHitSeen = 0, offOkSeen = 0;
    const offS = { evalMs: 0, openMs: 0, strongMs: 0, opens: 0, closes: 0, aborts: 0, inOpenHit: 0, inOpenOk: 0 };
    /** @type {Record<string, number>} */ const offCloseWhy = {};
    /** @type {Record<string, number>} */ const offAbortWhy = {};
    /** @type {number[]} */ const offLens = [];
    /** @type {number[]} */ const offStarts = [];
    /** @type {number[]} */ const offContactTs = [];
    /** fut1 mass in bins 0..n-1. @param {number} n */
    const offMass = (n) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += futBin(0, i);
        return s;
    };
    const offComboLabel = () => (pred ? `${(comboV6 ? COMBO6_LABELS : COMBO_LABELS)[pred.combo.arg]} ${pred.combo.p.toFixed(2)}` : "-");
    const offState = () => `m30 ${offM30.toFixed(3)} m40 ${offM40.toFixed(3)} combo ${offComboLabel()}`;
    /** Why the gate is shut now ("" = open). @param {number} now */
    function offGateWhy(now) {
        if (!pred) return "no pred";
        if (inCurtain) return "curtain";
        if (inDodge) return "dodge";
        if (now < staggerUntil) return "stagger";
        if (now < potionHoldUntil) return "potion";
        if (now - lastHitAt < offAfterHitMs) return "after-hit";
        if (now - lastDodgeAt < offAfterDodgeMs) return "after-dodge";
        if (now - offTellAt < offAfterTellMs || now - flareSeenAt < offAfterTellMs || now - curtainLastAt < offAfterTellMs
            || now - lastDarkAt < offAfterTellMs) return "after-tell";
        if (!qp.shown && hpNow != null && hpNow < offHpMin) return "hp";
        const near = plan.find((it) => !it.pressedAt && it.atMs - now <= offGuardMs);
        if (near) return `plan(${near.kind} ${near.src})`;
        if (offComboVeto && comboRunning()) return "combo";
        if (offM30 >= offQuietTh) return "m30";
        const need = offOkFast && now - lastOkAt < OFF_OK_FAST_MS ? 1 : offQuietFrames;
        if (offRun < need) return "quiet-run";
        return "";
    }
    /** offenseGuard's give-up rules while the (shadow) gate is open ("" = keep on). @param {number} now */
    function offAbortNow(now) {
        if (lastHitAt >= offOpenAt) return "hit";
        if (inCurtain) return "curtain";
        if (inDodge) return "dodge";
        if (now < potionHoldUntil) return "potion";
        const t = pred?.tell;
        if (t && t.arg !== 0 && t.p >= tellTh) return `tell(${t.label})`;
        const near = plan.find((it) => !it.pressedAt && it.atMs - now <= offAbortMs);
        if (near) return `plan(${near.kind} ${near.src})`;
        return "";
    }
    /** @param {number} now @param {string} why @param {boolean} abort */
    function offClose(now, why, abort) {
        const len = now - offOpenAt;
        offLens.push(len);
        const key = why.replace(/\(.*$/, "");
        if (abort) {
            offS.aborts++;
            offAbortWhy[key] = (offAbortWhy[key] ?? 0) + 1;
        } else {
            offS.closes++;
            offCloseWhy[key] = (offCloseWhy[key] ?? 0) + 1;
        }
        mark("off", `${abort ? "abort" : "close"} ${why} after ${len} ms, ${offState()}`);
        offOpenAt = 0;
    }
    /** New hits / oks (onHit / onOk times): counted when they land while the gate is open. */
    function offContacts() {
        /** @param {number} t @param {string} kind */
        const one = (t, kind) => {
            offContactTs.push(t);
            if (!offOpenAt || t < offOpenAt) return;
            if (kind === "hit") offS.inOpenHit++;
            else offS.inOpenOk++;
            mark("off", `contact ${kind} in the open gate +${t - offOpenAt} ms`);
        };
        if (lastHitAt > offHitSeen) one((offHitSeen = lastHitAt), "hit");
        if (lastOkAt > offOkSeen) one((offOkSeen = lastOkAt), "ok");
    }
    /** Per frame, before executePlan: lifts, contact bookkeeping, the qiPlan fut filter, the shadow aborts. @param {number} now */
    function offenseGuard(now) {
        offUp();
        if (qiPlan && qp.shown) {
            // the boss strikes nothing in 衰弱: the fut items would only eat the window (tell dodges stay)
            for (const it of [...plan]) {
                if (it.src === "fut" && !it.pressedAt) {
                    plan.splice(plan.indexOf(it), 1);
                    qp.futDrops++;
                }
            }
        }
        if (!offShadow) return;
        offContacts();
        if (!offOpenAt) return;
        const why = offAbortNow(now);
        if (why) offClose(now, why, true);
    }
    /** Per frame, after expire: the gate (shadow) and the qiPlan window. @param {number} now */
    function offenseTick(now) {
        offUp();
        if (qiPlan) qpTick(now);
        if (!offShadow || !pred) return;
        if (ready !== offRunReady) { // a new head output: the run counts head frames
            offRunReady = ready;
            offM30 = offMass(offQuietBins);
            offM40 = offMass(offStrongBins);
            offRun = offM30 < offQuietTh ? offRun + 1 : 0;
            if (pred.tell.arg !== 0 && pred.tell.p >= tellTh) offTellAt = now;
        }
        const dt = offTickAt ? Math.min(200, now - offTickAt) : 0;
        offTickAt = now;
        const why = offGateWhy(now);
        if (bossNow > 50) { // fight time only (the walk-in / cut scenes do not count)
            offS.evalMs += dt;
            if (offOpenAt) offS.openMs += dt;
            if (!why && offM40 < offStrongTh) offS.strongMs += dt;
        }
        if (!why && !offOpenAt) {
            offOpenAt = now;
            offS.opens++;
            offStarts.push(now);
            mark("off", `open ${offState()} run ${offRun}${now - lastOkAt < OFF_OK_FAST_MS ? " (ok fast)" : ""}${offM40 < offStrongTh ? " strong" : ""}`);
        } else if (why && offOpenAt) offClose(now, why, false);
    }
    /** The shadow's return stats (rates per fight minute; the clean-after-open shares over opens >= 2 s old). */
    function offSummary() {
        const end = Date.now();
        const min = offS.evalMs / 60000;
        const sorted = [...offLens].sort((a, b) => a - b);
        let n2 = 0, clean1 = 0, clean2 = 0;
        for (const s of offStarts) {
            if (s + 2000 > end) continue;
            n2++;
            if (!offContactTs.some((t) => t > s && t <= s + 1000)) clean1++;
            if (!offContactTs.some((t) => t > s && t <= s + 2000)) clean2++;
        }
        const r = (/** @type {number} */ x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
        return {
            gateFrac: offS.evalMs ? r(offS.openMs / offS.evalMs) : 0, strongFrac: offS.evalMs ? r(offS.strongMs / offS.evalMs) : 0,
            fightMin: r(min, 2), opens: offS.opens, opensPerMin: min ? r(offS.opens / min, 2) : 0,
            openMsMedian: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
            inOpenHit: offS.inOpenHit, inOpenOk: offS.inOpenOk, inOpenPerMin: min ? r((offS.inOpenHit + offS.inOpenOk) / min, 2) : 0,
            clean1s: n2 ? r(clean1 / n2) : 0, clean2s: n2 ? r(clean2 / n2) : 0, closes: offS.closes, aborts: offS.aborts,
            closeWhy: offCloseWhy, abortWhy: offAbortWhy,
        };
    }

    // --- qiPlan: the 气竭 window v2, clocked from the 处决 button's first sighting
    const qp = { zeroRun: 0, cand: 0, shown: 0, tapAt: 0, lastLight: 0, lastMatch: 0, lights: 0, post: 0, lateMarked: false, boss0: 0, futDrops: 0 };
    const qpS = { windows: 0, fakes: 0, execs: 0, lost: 0, lights: 0, postLights: 0, futDrops: 0 };
    /** @type {number[]} */ const qpShownToTap = [];
    /** @type {number[]} */ const qpBossDrop = [];
    /** @param {number} now @param {boolean} post */
    function qpLight(now, post) {
        if (now - qp.lastLight < qiLightMs) return;
        if (inDodge || inCurtain || now < staggerUntil || now < potionHoldUntil) return;
        if (plan.some((x) => !x.pressedAt && x.atMs - now < QP_PENDING_MS)) return; // a tell dodge is about to go
        qp.lastLight = now;
        offDown(LIGHT, OFF_TAP_MS);
        if (post) qp.post++;
        else qp.lights++;
        mark("qi", `qiPlan 轻击${observe ? " sim" : ""}${post ? " (after 处决)" : ""} +${now - qp.shown} ms`);
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
        weakSince = 0;
        Object.assign(qp, { cand: 0, shown: 0, tapAt: 0, lastLight: 0, lights: 0, post: 0, lateMarked: false, boss0: 0, futDrops: 0 });
    }
    /** @param {number} now */
    function qpTick(now) {
        // 真气 empty: read 0, or the read keeps failing while the boss bar is up and the last read was tiny (slowWeak)
        const empty = qiNow === 0 || (qiEmpty >= 2 && qiNow >= 0 && qiNow <= 25 && bossNow > 50);
        qp.zeroRun = empty ? qp.zeroRun + 1 : 0;
        const back = qiEmpty === 0 && qiNow > 4;
        if (!qp.cand && !qp.shown && qp.zeroRun >= 2) {
            qp.cand = now;
            mark("qi", `qiPlan: 真气 empty (read ${qiNow}, miss ${qiEmpty}), 处决 looked for`);
        }
        // the 处决 button (combat/execute.png, @see slowWeak): every QI_EXEC_EVERY frames while 真气 is low, every
        // frame once it is due; the button may show before 真气 reads empty (126/127)
        const low = qp.cand > 0 || (qiNow >= 0 && qiNow <= QP_EXEC_QI_MAX && bossNow > 50);
        const due = qp.shown > 0 && !qp.tapAt && now - qp.shown >= qiExecAfter;
        let ex = false;
        if ((low || qp.shown) && !qp.tapAt && (due || now - qp.lastMatch >= QI_EXEC_EVERY * FRAME_MS)) {
            qp.lastMatch = now;
            ex = perFrame("exec", (im) => match("combat/execute.png", { image: im, roi: EXEC_ROI, threshold: execThreshold }).hit);
        }
        if (!qp.shown) {
            if (ex && !back) {
                qp.shown = now;
                qp.boss0 = bossNow;
                qpS.windows++;
                weakSince = now;
                walkOff();
                mark("qi", `qiPlan: 处决 shows ${qp.cand ? `${now - qp.cand} ms after 真气 empty` : `before 真气 read empty (真气 ${qiNow})`}`);
            } else if (qp.cand && (back || now - qp.cand > QP_CAND_MS)) {
                qpS.fakes++;
                mark("qi", `qiPlan: no 处决 in ${now - qp.cand} ms (${back ? "真气 back" : "timeout"}): not 衰弱`);
                qp.cand = 0;
            }
            return;
        }
        if (back) return qpEnd(now, "真气 back");
        if (now - qp.shown > QP_MAX_MS) return qpEnd(now, "window limit");
        if (qp.tapAt && now - qp.tapAt > QP_EXEC_SCENE_MS + qiPostMs) return qpEnd(now, "qiPostMs");
        if (!qp.tapAt) {
            if (due && ex) {
                qp.tapAt = now;
                qpS.execs++;
                qpShownToTap.push(now - qp.shown);
                offDown(EXECUTE, QP_EXEC_TAP_MS);
                pressFrame(frameIdx);
                mark("qi", `qiPlan 处决 tap${observe ? " sim" : ""} ${now - qp.shown} ms after it showed${now - qp.shown > qiExecMax ? " (late)" : ""}`);
                return;
            }
            if (now - qp.shown > qiExecMax && !qp.lateMarked) {
                qp.lateMarked = true;
                mark("qi", `qiPlan: 处决 not seen at ${now - qp.shown} ms (qiExecMax ${qiExecMax}), still looked for`);
            }
            // before qiExecAfter strike; after it wait for the button (covered by effects at times, combat.js 130),
            // striking again once it is well past its ~3.2 s life
            if (!due || now - qp.shown > qiExecMax + 300) qpLight(now, false);
            return;
        }
        if (now - qp.tapAt >= QP_EXEC_SCENE_MS) qpLight(now, true);
    }

    // --- untilCleared: phase one over (combat.js deadCheck / phase2 / cleared)
    let clrAt = 0, clrLow = 0, clrFull = 0, clrLast = false, clrPhase2 = 0, clrBossPx = -1;
    /** The boss bar read from its left end (combat.js bossOn): px, 0 when used up, null when not read. */
    function clrBoss() {
        const red = color({ ...BOSS_RED, image: img, roi: BOSS_ROI, count: 10, connected: true });
        if (red.hit) {
            const boxes = red.results.map((m) => m.box).sort((p, q) => p[0] - q[0]);
            if (boxes[0][0] <= BOSS_ROI[0] + 2) {
                let right = boxes[0][0] + boxes[0][2];
                for (const [x, , w] of boxes.slice(1)) {
                    if (x - right > CLR_GAP) break;
                    right = Math.max(right, x + w);
                }
                return right - BOSS_ROI[0];
            }
        }
        if (color({ ...CLR_LAST, image: img, roi: CLR_LAST_ROI, count: 48 }).hit) return 0;
        return null;
    }
    /** The quest line reads 「…阶段二」 (combat.js phase2). */
    function clrPhase2Now() {
        const n = (/** @type {Box} */ roi) => {
            const h = color({ ...QUEST_WHITE, image: img, roi, count: 1 });
            return h.hit ? h.results[0]?.count ?? 0 : 0;
        };
        return n(PHASE2_TOP) >= 8 && n(PHASE2_BOTTOM) >= 10 && n(PHASE1_MID) <= 2;
    }
    /** @param {number} now @returns {boolean} the run is over (cleared) */
    function clearedCheck(now) {
        if (now - clrAt < CLR_EVERY_MS) return false;
        clrAt = now;
        clrPhase2 = clrPhase2Now() ? clrPhase2 + 1 : 0;
        if (clrPhase2 >= 2) {
            mark("cleared", "阶段二 in the quest line");
            return true;
        }
        const b = clrBoss();
        if (b == null) return false;
        clrBossPx = b;
        clrLow = b <= CLR_LOW_PX ? clrLow + 1 : 0;
        if (clrLow >= CLR_LOW_READS && !clrLast) {
            clrLast = true;
            mark("cleared", `boss bar in its last 10% (${b} px)`);
        }
        clrFull = b >= CLR_FULL_PX ? clrFull + 1 : 0;
        if (clrFull >= CLR_FULL_READS && clrLast) {
            mark("cleared", "the boss bar full again after its last 10%");
            return true;
        }
        return false;
    }
    // ================================================================================================= end v8 offense
    /** @type {{name: string, every: number, at: number, active: () => boolean, run: (now: number) => void}[]} */
    const slowQueue = [
        { name: "boss", every: slowEvery, at: 0, active: () => true, run: () => { bossNow = bossRead(); } },
        { name: "mean", every: slowEvery, at: 0, active: () => true, run: () => {
            meanNow = readMean();
            meanRing.push(meanNow);
            if (meanRing.length > 3) meanRing.shift();
            dark3 = Math.min(...meanRing) < 20 ? 1 : 0;
        } },
        { name: "curtain", every: curtainEvery, at: 0, active: () => inCurtain || stickSide !== 0 || curtainImg || curtainDark, run: slowCurtain },
        { name: "flare", every: flareEvery, at: 0, active: () => true, run: slowFlare },
        { name: "potion", every: slowEvery, at: 0, active: () => maxPotions > 0 && potionsUsed < maxPotions && hpNow != null && hpNow <= potionHp, run: slowPotion },
        { name: "closein", every: 100, at: 0, active: () => closeIn, run: closeInWalk },
        { name: "weak", every: 100, at: 0, active: () => qiAttack && !qiPlan, run: slowWeak }, // v8 offense: qiPlan replaces it
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
        while (frameSeq() <= loopSeq && Date.now() - t0 < nextMs) {
            releaseDue();
            sleep(3);
        }
        const im = shot();
        loopSeq = Math.max(loopSeq, im.seq);
        return im;
    }

    log(`dufu ${observe ? "(observe) " : ""}start: ${backModel} + ${model}, ${untilMs} ms, issueLead ${issueLead} ms, potions ${maxPotions}`);
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
            if (deadCheck(now)) {
                reason = "dead";
                break;
            }
            if (untilCleared && clearedCheck(now)) { // v8 offense
                reason = "cleared";
                break;
            }
            approach(now);
            lockCheck(now);
            const dtMs = lastEntryT ? Math.min(300, Math.max(10, now - lastEntryT)) : FRAME_MS;
            const aux = buildAux(dtMs);
            const b = timed("back", () => infer(backModel, { ...BACK, image: img }));
            if (b.ready && b.output) {
                ring.push({ f: b.output, aux, t: now });
                if (ring.length > T) ring.shift();
                lastEntryT = now;
                frameIdx++;
                if (ring.length >= MIN_RING) {
                    headCalls++;
                    const h = timed("head", () => infer(model, { ...BACK, image: img, extra: [{ name: "seq", dim: [1, T, D], data: seqData() }] }));
                    if (h.ready && h.output) {
                        ready++;
                        decode(h.output);
                    }
                }
            }
            if (pred) {
                const now2 = Date.now();
                syncPlan(now2);
                if (offOn) offenseGuard(now2); // v8 offense
                executePlan(now2);
                if (curtainTimed) sweepTick(Date.now());
                if (failEscape) failEscapeTick(Date.now());
                expire(now2);
                if (offOn) offenseTick(Date.now()); // v8 offense
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
        if (!observe) {
            releaseDue(true);
            tup(0);
            if (offTouched) touch.up(offContact); // v8 offense
        }
    }
    const backS = stats(tMs.back), headS = stats(tMs.head), readS = stats(tMs.reads), loopS = stats(tMs.loop);
    const readyPct = headCalls ? Math.round((ready / headCalls) * 1000) / 10 : 0;
    log(`dufu over (${reason}): ${looks} looks, head ${ready}/${headCalls} ready (${readyPct}%), ${presses.parry} parry / ${presses.dodge} dodge / ${presses.potion} potion / ${presses.walk} walk, lock ${lockTaps} taps, ` +
        `${hits} hits, ${oks} ok, ${misses} misses, ${revisions} revisions, ${late} late, branches ${branches} (${branchDrops} dropped), holds ${holds} (${holdPresses} pressed), posthit ${insurePresses}, re-press ${rerepresses}, weak ${weakWindows} (${weakLights} light, ${weakExecs} exec), blocked ${JSON.stringify(blocked)}, skipped ${JSON.stringify(skips)}`);
    log(`ms: back ${JSON.stringify(backS)}, head ${JSON.stringify(headS)}, reads ${JSON.stringify(readS)}, loop ${JSON.stringify(loopS)}`);
    const v8On = flareMode !== "dodge" || args.futDodgeLead != null || curtainTimed || curtainKeepParry || flare2 || failEscape || flareHoldFut;
    if (flareHoldFut) foEnd("run over");
    const v8 = v8On ? { flareMode, tellParries, flare2s, timedSweeps, failEscapes, ...(flareHoldFut ? { holdFut: foS } : {}) } : undefined;
    if (v8) log(`v8: ${JSON.stringify(v8)}`);
    // v8 offense: only when one of its switches is on (the default return is unchanged)
    if (qiPlan && qp.shown) qpEnd(Date.now(), "run over");
    const off = offOn ? {
        ...(offShadow ? { gate: offSummary() } : {}),
        ...(qiPlan ? { qi: { ...qpS, execShownToTapMs: qpShownToTap, bossDropPx: qpBossDrop } } : {}),
        ...(untilCleared ? { bossLeftPx: clrBossPx, bossLast: clrLast } : {}),
    } : undefined;
    if (off) log(`off: ${JSON.stringify(off)}`);
    return {
        ...(v8 ? { v8 } : {}),
        ...(off ? { off } : {}),
        reason, observe, looks, ready, headCalls, readyPct,
        presses, blocked, late, misses, hits, oks, revisions, branches, branchDrops, skips, holds, holdPresses, insurePresses,
        rerepresses, weakWindows, weakLights, weakExecs,
        ms: { back: backS, head: headS, reads: readS, loop: loopS },
        start, events,
    };
}
