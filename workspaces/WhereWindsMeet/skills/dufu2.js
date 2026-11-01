// 独夫 with the move-ID student (docs/dufu-moveid-plan.md, model/dufu2/dufu2.json). Independent of dufu.js (only
// lib/dufu-reads.js's screen reads and lib/stats.js are shared).
//
// Two arenas, one skill (args.phase; everything else defaults per phase):
//   phase 2 (default since 2026-10-25 关 2: model dufu2b, 88 groups = 87 prefixes + idle): no poison, no 幕布, the quest
//     line is not an end; 跑 from the 火球雨 (@see runTick) and the 金光火球 window (@see goldBeatTick).
//   phase 1 (2026-10-28 顺序 7: model dufu1b = the live-retrained student that passed 关 2; dufu1 is the order-4 base,
//     98 groups = the p1 table's 97 + idle; no red light at all — teacher: 金光
//     dodge, everything else 卸势): prep coats the blade with poison and puts the potion back (no 增益 / 伤害: defend does
//     not attack); the quest line's 「阶段二」 ends the round (@see clearedTick); the 幕布 gap state machine
//     (@see curtainTick: dodge the sweep, the gap walk behind args.curtainGap). No 跑 / 金光火球窗 / k2:c30 chain beat
//     (phase-2 moves only).
//
// Per 30 fps tick (tick n is due at t0 + n * 33.3 ms; one ring entry per tick, never two, never none):
//   screenshot -> infer glob (whole screen -> 384x240, ring "glob", aux = the 4 contact-history values)
//              -> infer crop (big box -> 192, ring "big") -> infer crop (small box -> 192, ring "small")
//              -> infer head (no image; the three rings, last 30 entries) -> grp / col / resp / tte.
//   A tick whose screenshot shows no new capture frame still appends (the recordings repeat a frame when the
//   capture lags, ~12 %, and the student was trained with 10 % repeated frames). A loop that overran one or more
//   ticks appends the same screenshot once per missed tick (at most FILL_MAX; beyond that the ticks are skipped
//   and counted): the ring stays on the 30 fps clock the TCN was trained on.
// Contact history (s3b_train.history; dufu2.json contact_history): contacts are detected live from the bars,
//   as labels.contacts() defined them for training:
//   hit = the hp bar down >= HIT_DROP at once (hpBase logic of dufu.js: grey-bar overreads ignored); it happened
//         between the previous and this tick's capture (midpoint = "seen"); contact = seen - HIT_LAG_F (5) frames
//         (the bar shows a blow ~5 f after it lands).
//   ok  = the boss 真气 down QI_STEP..QI_JUMP px (>= 4 before, > 0 after) with our 卸势 <= OK_PARRY_MAX_F (24) f
//         before; contact = seen. An ok within MERGE_F (6) f of a hit is the hit.
//   A contact at frame c enters the history from tick c + HIST_DELAY_F (6) on (training: "known 6 frames after").
//   Detection latency: a hit is seen ~5-6 f after it lands, so it is known on the first tick after it is seen
//   (c + 6), the same as in training; an ok is seen at c + 0..1 and waits until c + 6. The rings are reset at the
//   fight start (first entry reset: true).
// mode (args.mode):
//   "shadow"  look only: no touch except the walk-in at the start (the boss does not come otherwise; args.approach
//             false: none at all); no defense, no re-lock, no potion. The decision the defend mode would
//             take is computed every tick and written to the trace (`would`) for the offline check.
//   "defend"  defense + potion only, no offense: walk in until the boss bar shows, re-lock, 卸势 / 闪避 by the
//             model (@see decide), potion at a quiet moment (@see potionTick), run from the 火球雨 (@see runTick).
//             args.offense "v2" adds the v2 offense engine (@see atk2Tick, lib/dufu-offense.js, design
//             docs/dufu-offense-design.md); it never touches contacts 0-2 and every defense press / gold tell /
//             curtain / 火球雨 preempts it. args.offense "off" (default) and no v2: args.attack adds the legacy shared
//             offense: a charge in the near gate after an ok / boss-bar drop, and the 气竭 execute (@see atkTick).
//             args.attack is ignored while offense is "v2" (they are different schedulers, never mixed).
// provider (args.provider): "qnn" (default; falls back to cpu without the plugin: the result's `provider` says what
//   ran) or "cpu". phase: 1 | 2 (default 2). Phase 2: model dufu2b, no poison / no curtain, the quest line is not an
//   end, 跑 / 金光火球窗 / chain on. Phase 1: model dufu1b, poison in prep, 幕布, the quest line's 阶段二 = cleared,
//   no 跑 / 金光火球窗 / chain, args.curtain2 / args.curtain / args.curtainGap as A/B switches.
// Trace: one row per tick (TRACE_COLS), event TRACE_EVENT in chunks of TRACE_CHUNK rows (~25 KB each); run
//   skills/event_pad.js after fetching them (tools/dufu_rounds.py does). args.pair N (shadow checks): every N-th
//   tick the screenshot is saved (captures/dufu2_live/<tag>_<n>.png) and event PAIR_EVENT carries the head logits and
//   the 30 ring entries (float32 base64) for the PC recomputation (tools/dufu_moveid/s5_pair.py).
//   maalow do skill dufu2 --args '{"mode":"shadow","ms":300000}'
//   maalow do skill dufu2 --args '{"mode":"defend","provider":"qnn","ms":600000}' --timeout 660000
//   maalow do skill dufu2 --args '{"mode":"defend","phase":1,"ms":600000}' --timeout 660000
//   maalow do skill dufu2 --args '{"mode":"defend","phase":1,"offense":"v2","ms":600000}' --timeout 660000
//   (phase 2 defaults since 2026-10-25 关 2: model dufu2b, 闪避 lead 5, run diag from the 火球雨, the 金光火球 window;
//   the A/B switches: run, runDir, goldSeq, model, dodgeLead, chain, tools/dufu_moveid/README.md「顺序 5 续」;
//   phase 1 defaults: model dufu1b, 卸势 lead 10, 闪避 lead 5, 幕布 on without the gap walk, curtain2 on;
//   offense v2 switches: offense, offenseSet, offenseCharge, tools/dufu_moveid/s5_offense_table.py)
import { stats } from "./lib/stats.js";
import { BOSS_RED, BOSS_ROI, ICON_WHITE, ME_X, bossFill, countAtLeast, gapNow, health, readMean, readQi } from "./lib/dufu-reads.js";
import { NEXT_SHARE } from "./lib/dufu-offense-table.js";
import { allow as policyAllow, value as policyValue, VALUE_THRESHOLD as POLICY_VALUE_THRESHOLD, VERSION as POLICY_VERSION } from "./lib/dufu-offense-policy.js";
import { NEAR_DROP_MS, NEAR_OK_MS, Q as OFF_Q, WINDOWS as OFF_WINDOWS, emptyP, nearNow, pick as offensePick, quietP, REASON as OFF_REASON, REASON_NAMES as OFF_REASON_NAMES } from "./lib/dufu-offense.js";
import { DEFAULTS as DEFAULTS2, GROUPS as GROUPS2 } from "./lib/dufu2-table.js";
import { DEFAULTS as DEFAULTS1, GROUPS as GROUPS1 } from "./lib/dufu1-table.js";

/** @type {SkillMeta} */
export const meta = { description: "独夫 with the dufu2 move-ID student — phase 2 (default, model dufu2b) or phase 1 (model dufu1b: poison prep, 幕布, quest-line 阶段二): shadow (look only) / defend (卸势 / 闪避 / potion; args.offense v2/v3: execute / qishu / light / follow on contact 3; v3 adds the learned safety gate; or the legacy args.attack)", timeout: 660_000 };

const FRAME_MS = 1000 / 30;
/** @type {Box} */ const BIG = [290, 55, 530, 530];
/** @type {Box} */ const SMALL = [425, 190, 260, 260];
const RING = 30, G_DIM = 128, C_DIM = 96;
// head slices: the p2 head 88 groups / idle 87 (col 88..90, resp 91..93, tte 94..140); the p1 head 98 / idle 97
// (col 98..100, resp 101..103, tte 104..150). N_TTE / TTE_NONE are the same in both. @see decode
const N_TTE = 47, TTE_NONE = 46;
const FILL_MAX = 3;
// contact history (s3b_train.history)
const HIST_DELAY_F = 6, HIST_GAP_F = 73;
// contacts (dufu_train/labels.py)
const HIT_DROP = 0.025, HIT_MAX = 0.35, HIT_LAG_F = 5, QI_STEP = 8, QI_JUMP = 80, OK_PARRY_MAX_F = 24, MERGE_F = 6;
// decisions (@see decide)
const GOLD_DODGE_P = 0.15; // P(gold) at or above this: dodge (gold must be dodged; "colour unsure" = gold not ruled out)
// phase 1: the phase-2 threshold leaves 4.95 % of gold contacts answered by 卸势 (gate 2 allows 3 %). On the student
// OOF 0.02 is 21/707 = 2.97 % (no margin) and 0.015 is 15/707 = 2.1 % with fatal-response 92.5 % (>= 90 %), so phase 1
// uses 0.015.
const GOLD_DODGE_P1 = 0.015;
const CONTACT_P = 0.4; // 1 - P(resp none) below this: no press
const LATE_F = 1; // a contact predicted this far in the past still gets its press
const GRACE_F = 6, REARM_F = 8; // a pressed contact is consumed GRACE_F after it; a prediction REARM_F later is a new one
const PARRY_LOCK_MS = 330, PARRY_CD_MS = 220, DODGE_CD_MS = 500; // the game's 卸势 lock / our cooldowns
const TAP_MS = 50;
// 闪避 lead (frames) for every dodge unless args.dodgeLead. Both phases: 5 (phase 2 the best of 14 / 8 / 5 in
// r007-r023; phase-1 failed dodges are 62 % at <=10 frames, so the table's 14 is not used by default).
const DODGE_LEAD = 5;
// run (teacher 2026-10-25: the 火球雨, a pile of fireballs from afar, is dodged by running first, then 闪避). The
// 火球雨 is the c7 chain (boss jumps back onto the steps, ~2 s wind-up, then a volley of 5-8 fireballs in ~1 s):
// the student names its opening k0:c7 ~35 f before the first fireball (live r024-r031). A run starts when the c7
// groups' summed P(grp) >= RUN_P on RUN_TICKS ticks in a row while the predicted first contact is <= RUN_START_F
// away; the stick is held at full deflection in the run direction (args.runDir) until RUN_MIN_MS have passed and the
// head has not named a c7 group for RUN_TAIL_MS (at most RUN_MAX_MS). 闪避 during a run goes the run's way and the
// stick stays held. Timing (r020-r031, hits after the onset of the c7 groups): the volley lands +33..+76 f, a second
// wave +90..+125 f; the first live runs (r032-r033) stopped after 2.1-3.3 s and were hit right after: RUN_MIN_MS
// covers both waves.
const RUN_P = 0.5, RUN_TICKS = 2, RUN_START_F = 45, RUN_MIN_MS = 4300, RUN_TAIL_MS = 600, RUN_MAX_MS = 5500;
// 金光火球 (teacher 2026-10-25: the gold move whose fireballs come one by one over a long time can only be dodged):
// the c11 chain (gold fire whirl, then fireballs at +26 / +54 / +106 f, data/moveid/moves). After its gold opening
// is dodged no contact enters the history, so the student starts its prefix over and names the fireballs k0 / k1 /
// k2 of the no-light group (parry): r007-r031 every dodged c11 opening was followed by 2-3 fireball hits. args.goldSeq:
// a dodge pressed while the head names k0:c11+c40 (anchor = the press), or a hit while it did (<= GOLD_SEQ_HIT_MS
// before; anchor = the contact), opens a window of GOLD_SEQ_F frames: every press in it is a 闪避, and a 闪避 is
// pressed for each fireball of the cadence, anchor + k x GOLD_SEQ_BEAT_F (k = 1..GOLD_SEQ_N), unless one was already
// pressed for it. The cadence (r007-r035, the hits after a dodged / hit c11 opening): fireballs land every ~27 f,
// +27 / +54 / +81 / +108 / +135 (+-3) after the dodge press; which of them hit depends on the round (+27 +55 +107 or
// +54 +82 +133), never anything else. The first live version (r038-r043: one beat at +22, then the head's own
// predictions forced to 闪避) did not help: the head predicts these fireballs late or not at all.
const GOLD_SEQ_F = 150, GOLD_SEQ_BEAT_F = 27, GOLD_SEQ_N = 5, GOLD_SEQ_MIN_F = 8, GOLD_SEQ_COVER_F = 8, GOLD_SEQ_HIT_MS = 1000;
// chain beat (args.chain): the third blow of c30 (head group k2:c30) lands 34 +- 1 f after the second, which comes
// ~49 f after the first (final rounds r072-r081: 41 of 59 triggers, +32..+40); the tte head does not see it coming
// (33 of the 43 fatal k2:c30 failures there had no press at all). Two device contacts 40-58 f apart and the head
// naming k2:c30 within CHAIN_AFTER_F of the second: a 卸势 is pressed for second + CHAIN_AFTER_F (unless one was).
const CHAIN_GAP_F = [40, 58], CHAIN_AFTER_F = 34, CHAIN_COVER_F = 8;
/** run directions (stick unit vector, y down = away from the locked boss); the sign of x alternates per run */
/** @type {Record<string, [number, number]>} */
const RUN_DIRS = { side: [1, 0], diag: [0.7071, 0.7071], back: [0, 1] };
// buttons (dufu.js / combat.js)
/** @type {Point} */ const PARRY = [952, 495];
/** @type {Point} */ const DODGE = [924, 674];
/** @type {Point} */ const POTION = [700, 690];
/** @type {Point} */ const STICK = [175, 569];
const STICK_R = 83;
/** @type {Point} */ const LEFT = [92, 569];
/** @type {Point} */ const RIGHT = [258, 569];
/** @type {Point} */ const LOCK = [1021, 667];
/** @type {Box} */ const LOCK_ROI = [1004, 648, 34, 39];
const GOLD_ICON = { lower: [200, 180, 100], upper: [255, 245, 200] };
const LOCK_MS = 2000, LOCK_EVERY = 250;
// walk in (defend) until the boss bar shows
const APPROACH_MS = 30_000, APPROACH_CYCLE = 1200, APPROACH_ON = 500;
// potion (dufu.js rules, simplified): hp <= POTION_HP, quiet = POTION_QUIET_MS after a hit, POTION_GAP_MS after our own
// press, P(contact within POTION_LOOK_F) < POTION_MASS; urgent (hp <= POTION_URGENT or waited POTION_WAIT_MAX_MS):
// only the gaps (shorter). Counted when hp is up POTION_HEAL within POTION_CONFIRM_MS, else re-tapped POTION_RETRY_MS
// later (POTION_MAX_TAPS). No 卸势 / dodge POTION_HOLD_MS after the tap (a press cancels the drink).
const POTION_HP = 0.35, POTION_URGENT = 0.15, POTION_QUIET_MS = 1200, POTION_URGENT_QUIET_MS = 600, POTION_GAP_MS = 450;
const POTION_LOOK_F = 30, POTION_MASS = 0.3, POTION_WAIT_MAX_MS = 2500, POTION_HEAL = 0.08, POTION_CONFIRM_MS = 2000;
const POTION_RETRY_MS = 600, POTION_MAX_TAPS = 8, POTION_HOLD_MS = 700, POTION_SETTLE_MS = 2500;
/** @type {Box} */ const SLOT_ROI = [670, 640, 60, 55];
const SLOT_POTION_T = ["combat/potion_drill.png", "combat/potion_real.png"];
/** @type {Point} */ const ITEM_OPEN = [700, 633];
/** @type {Box} */ const COLUMN_ROI = [665, 400, 75, 210];
/** @type {Point} */ const ITEM_PICK = [702, 575];
// phase 1 prep (dufu.js prep, 2026-10-23): swap the poison into the slot, tap the slot icon to coat the blade, swap the
// potion back. The pick swaps with the slot's item, so both swaps are checked. No 增益 / 伤害 in this skill (defend
// does not attack).
const PREP_MENU_MS = 600, PREP_USE_MS = 2500, PREP_SWAP_TRIES = 3, SLOT_POTION_TH = 0.75, COLUMN_TH = 0.8;
// the coating buff lands ~1.5 s after the slot tap; the game then shows the poison item in the slot again (r167 at 10 s).
// Settle, check, and put the potion back once more before the fight starts.
const PREP_SETTLE_MS = 2500;
const POISON_T = ["combat/poison_real.png"];
/** the poison is used by a tap on the slot icon (real fight 2026-10-23: 天工开物 398 -> 397, the blade glows green);
 *  dufu2's POTION tap (700, 690) there left 特殊道具 in the slot instead */
/** @type {Point} */ const SLOT_ICON = [700, 666];
// phase 1 end by the quest line (dufu.js clearedCheck): 「…阶段二」 on two checks ~400 ms apart. The 阶段二 arena reads
// 阶段二 all along, so phase 2 never runs it.
const CLR_EVERY_MS = 400;
const QUEST_WHITE = { lower: [0, 0, 190], upper: [180, 70, 255], method: 40 };
/** @type {Box} */ const PHASE2_TOP = [222, 140, 12, 4]; // 二: >= 8 px
/** @type {Box} */ const PHASE2_BOTTOM = [220, 147, 16, 4]; // >= 10 px
/** @type {Box} */ const PHASE1_MID = [220, 144, 16, 3]; // 一: <= 2 px
// 幕布 (phase 1; teacher 2026-10-26: far away: walk into the gap; if the sweep is about to reach us, 闪避 and it is
// dodged). lib/dufu-reads.gapNow gives the free gap [left, right] or "covered"; a probe every CURTAIN_TICKS ticks
// enters the curtain, CURTAIN_GONE_MS without a gap ends it. While in it: walk the gap's centre (contact 0 sideways,
// args.curtainGap false = no walking). "covered" / the black cover: the head's k0:c5+c18 (unparryable) dodges through
// decide(); when nothing was pressed for CURTAIN_COVER_DODGE_MS the fallback dodges once (a drink pending holds it).
const CURTAIN_TICKS = 12, CURTAIN_GONE_MS = 1200, CURTAIN_COVER_DODGE_MS = 800, BLACK_MEAN = 22;
const GAP_IN = 20, GAP_PUSH = 120; // me at ME_X: within GAP_IN (or a quarter of the gap) no walking; GAP_PUSH px off
// the centre = full stick (dufu.js's gap rule)
const CURTAIN2_NAME = "k1:c18"; // the 幕布 second sweep (37/37 hit, 0 / 37 parried in the p1 data)
// offense (args.attack; shared by both phases, boss pack only picks the weapon's charge): teacher's offense rules
// (docs/dufu.md): the near gate opens after a 卸势 that landed (3 s) or a boss-bar drop (3 s); inside it, wait for a
// quiet moment (P(contact within 45 f) < 0.2, the next contact > 45 f away), then charge once and release. 陌刀 蓄力 on
// CHARGE (0.7 s), 横刀 轻蓄力 on LIGHT (0.6 s, HLIGHT_HOLD_MS in dufu.js is the full one); the phase only changes which
// weapon the character is on. 气竭: the execute button up with the boss's 真气 drained -> 轻击 filler, 处决 at 2.4 s.
// near gate of the legacy attack, and the v2 engine's near gate: one source (lib/dufu-offense.js, 1500 ms). The
// design text says 3 s; dufu2's own legacy gate has always been 1.5 s, so 1.5 s is kept (no separate 3000).
const ATK_NEAR_MS = NEAR_OK_MS, ATK_DROP_MS = NEAR_DROP_MS, ATK_BUSY_MS = 1500;
const ATK_QUIET_F = 45, ATK_QUIET_P = 0.2;
const ATK_MODAO_MS = 700, ATK_HENG_MS = 600;
const ATK_HIT_QUIET_MS = 1000;
/** @type {Point} */ const LIGHT = [945, 592]; // 轻击
/** @type {Point} */ const HEAVY = [1020, 478]; // 陌刀 蓄力 / 横刀 重击 (dufu.js CHARGE)
/** @type {Point} */ const EXECUTE = [852, 430];
/** @type {Box} */ const EXEC_ROI = [815, 391, 75, 75];
const EXEC_TH = 0.7, EXEC_FILL_MS = 2400, EXEC_LIGHT_MS = 300, EXEC_TAP_MS = 50;
// the weapon icons (dufu.js OFF_T: the 蓄力 / 重击 disc at [988,446,64,68])
/** @type {[string, Box][]} */ const WEAPON_T = [["combat/modao_charge.png", [988, 446, 64, 68]], ["combat/hengdao_heavy.png", [988, 446, 64, 68]]];
const WEAPON_TH = 0.7, WEAPON_EVERY = 250;
const BOSS_DROP_PX = 1.5, BOSS_DROP_WIN_MS = 1200, BOSS_DROP_MAX_PX = 80, BOSS_RING_MS = 4000;
// ---- 进攻 v2 (args.offense): the engine's reads and commit times (design 3.3). The actions go on contact 3 only.
/** @type {Point} */ const QISHU = [881, 525]; // 奇术 (dufu.js QISHU)
/** @type {Point} */ const SWITCH = [993, 320]; // weapon switch (dufu.js)
/** @type {Box} */ const QISHU_ROI = [848, 493, 64, 64];
const QISHU_T = "combat/qishu_ready.png";
const QS_LIT_PX = 30; // white strokes in the button: the 奇术 is ready (dufu.js qsLitRead)
const EXEC_T = "combat/execute.png";
const SWIRL_T = "combat/hengdao_swirl.png"; // the blue 爆发 disc on 重击 after a 横刀 ok (dufu.js pfTick)
const ATK2_DISC_EVERY = 250, ATK2_QISHU_EVERY = 250, ATK2_EXEC_EVERY = 250; // the v2 button reads (4 Hz)
/** commit + safety (design 3.3: execute 45 f, qishu 70 f, light 42 f, follow 61 f, set 154 f, charge 46 f) as the
 *  no-stack lock and the horizon window. All are >= dufu.js's OFF_NO_CANCEL_MS / OFF_COST_MS ("press to able to
 *  defend": light 300, follow 900, qishu 2000, execute 1150 ms). */
const ATK2_COMMIT_MS = { execute: 1500, qishu: 2333, light: 1400, follow: 2033, set: 5133, charge: 1533 };
/** pWithin(commit + safety) at or above this: no attack starts (a contact is too likely inside the animation) */
const ATK2_HORIZON_P = 0.25;
/** the commit+safety frames of an action, for the pWithin horizon (45 / 70 / 42 / 61 / 154 / 46) */
const atk2CommitF = (a) => Math.round((ATK2_COMMIT_MS[a] ?? 600) / FRAME_MS);
const ATK2_EXEC_WINDUP_MS = 1500; // the 处决 animation: nothing else may start
const ATK2_QISHU_COOL_MS = 3000; // a retry of a failed 奇术 tap
const ATK2_SWITCH_WAIT_MS = 1500, ATK2_SWITCH_TRIES = 2; // the weapon confirms ~24 f after the switch tap
const ATK2_LAND_MS = 2000; // boss HP / 真气 after an action (design 6: 前 / 后 2 s)
const ATK2_CHARGE_MS = 700; // 陌刀 蓄力 hold (dufu.js ATK_MODAO_MS)
const ATK2_CHAIN_CLEAR_MS = 30 * FRAME_MS; // the 串中 clear (design 5.1: < 30 f after the last contact)
const ATK2_OPENING_MS = 15_000; // dufu.js QS_OPEN_MS: the opening 奇术 window, from the first boss-bar sighting
const ATK2_GOLD_QUIET_MS = 2500; // conservative: a c11/c40 contact keeps the offense off it for 2.5 s
/** @type {Record<number, number>} */ const WEAPON_CODE = { "": 0, modao: 1, hengdao: 2 };
// end of the round (dufu.js deadCheck / haltCheck)
/** @type {Box} */ const GREY_ROI = [100, 100, 880, 500];
const GREY = { lower: [0, 0, 0], upper: [180, 30, 255], method: 40 };
/** @type {Box} */ const RETRY_ROI = [945, 668, 95, 24];
const RETRY_WHITE = { lower: [0, 0, 170], upper: [180, 60, 255], method: 40 };
/** @type {[string, Box][]} */ const WON_T = [["result_drill_again.png", [800, 650, 140, 60]], ["result_success.png", [440, 110, 200, 100]]];
const WON_TH = 0.8, DEAD_EVERY = 170, BOSS_EVERY = 250, BOSS_GONE_MS = 10_000;
const END_MARGIN_MS = 15_000;
// trace
const TRACE_EVENT = "dufu2_trace", PAIR_EVENT = "dufu2_pair", TRACE_CHUNK = 150;
// 进攻 v2 columns (appended 2026-11-01, names only; s5_analyze looks columns up by name): chainPos / chainLen = the
// current contact chain (frames within HIST_GAP_F), nextShare = the last contact's prefix-group next.share (-1 none),
// weapon 0 unknown / 1 陌刀 / 2 横刀, atkTier 0 none / 1 execute / 2 qishu / 3 light+follow / 4 set / 5 charge,
// atkQ = the action's P(empty) requirement, atkReason = the numeric decision reason (result.offense.reasonNames),
// bossPx = the offense boss read (lib bossFill: the widest red row of the tall ROI; the legacy `boss` column keeps
// bossBar's 6-row count), lock = the lock icon lit, range = the near gate as a 0/1 proxy (ok / boss drop within
// 1.5 s; NOT a real distance; an execute with range 0 is legal and the action log shows it).
// Opportunity log (2026-11-01): exe / disc / qishu = the button reads, pE42 / pE61 / pE70 = the engine's P(empty) for
// the action windows, cand = the engine's pick before the horizon / learned gate (a tier code; 0 = none this tick),
// gate = the v3 value score x1000 (P(the press deals >= 2 px); 0 = not run), hitAge = frames since the last detected hit
// (-1 = none), pol = 0 off / 2 v2 / 3 v3, prop = the press propensity x1000 (deterministic v2 / v3 = 1000).
const TRACE_COLS = ["wall", "seq", "cap", "n", "fill", "dup", "hp", "qi", "boss", "h0", "h1", "h2", "h3",
    "grp", "grpP", "gold", "red", "none", "dodge", "parry", "rnone", "med", "p10", "act", "would", "contact", "pipe", "loop",
    "c7P", "run", "chainPos", "chainLen", "nextShare", "weapon", "atkTier", "atkQ", "atkReason", "bossPx", "lock", "range",
    "exe", "disc", "qishu", "pE42", "pE61", "pE70", "cand", "gate", "hitAge", "pol", "prop"];
const ACT = { parry: 1, dodge: 2, potion: 3, lock: 4, walk: 5, run: 6, attack: 7 };

/**
 * The boss bar's fill in px-equivalent (red px / the bar's 6 rows). Not lib bossPx (the width of the box around any
 * red px): in the 阶段二 arena a few red px of the background on the bar's rows read 283 px with no bar (live
 * 2026-10-25, r002), so the walk-in stopped at once and "boss gone" ended the round. @param {Image} im
 */
function bossBar(im) {
    const hit = color({ ...BOSS_RED, image: im, roi: BOSS_ROI, count: 1 });
    return hit.hit ? Math.round((hit.results[0]?.count ?? 0) / BOSS_ROI[3]) : 0;
}

/** @param {number[]} out @param {number} off @param {number} n */
function softmax(out, off, n) {
    let mx = -Infinity;
    for (let i = 0; i < n; i++) mx = Math.max(mx, out[off + i]);
    const p = new Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) s += p[i] = Math.exp(out[off + i] - mx);
    for (let i = 0; i < n; i++) p[i] /= s;
    return p;
}
/** @param {number[]} p */
function argmax(p) {
    let a = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[a]) a = i;
    return a;
}
const r3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** base64 of bytes. @param {ArrayLike<number>} b */
function b64(b) {
    const out = [];
    for (let i = 0; i < b.length; i += 3) {
        const v = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
        out.push(B64[v >> 18] + B64[(v >> 12) & 63] + (i + 1 < b.length ? B64[(v >> 6) & 63] : "=") + (i + 2 < b.length ? B64[v & 63] : "="));
    }
    return out.join("");
}
/** float32 little-endian base64 of the arrays, concatenated. @param {number[][]} arrs */
function f32b64(arrs) {
    let n = 0;
    for (const a of arrs) n += a.length;
    const f = new Float32Array(n);
    let o = 0;
    for (const a of arrs) {
        f.set(a, o);
        o += a.length;
    }
    return b64(new Uint8Array(f.buffer));
}

/**
 * @param {{mode?: "shadow" | "defend", provider?: "qnn" | "cpu", phase?: 1 | 2, ms?: number, potions?: number,
 *          trace?: boolean, pair?: number, tag?: string, approach?: boolean, dodgeLead?: number | null,
 *          run?: boolean, runDir?: "side" | "diag" | "back" | ("side" | "diag" | "back")[], goldSeq?: boolean,
 *          model?: string, chain?: boolean, curtain?: boolean, curtainGap?: boolean, curtain2?: boolean, parryLead?: number,
 *          attack?: boolean, offense?: "off" | "v2" | "v3", offenseSet?: boolean, offenseCharge?: boolean,
 *          offenseGateThr?: number,
 *          offenseQ?: {execute?: number, qishu?: number, light?: number, follow?: number, set?: number, charge?: number}}} [args]
 */
export default function (args = {}) {
    const mode = args.mode ?? "shadow";
    if (mode !== "shadow" && mode !== "defend") throw new Error(`mode ${mode}: shadow | defend`);
    const phase = args.phase ?? 2;
    if (phase !== 1 && phase !== 2) throw new Error(`phase ${phase}: 1 | 2`);
    // the phase's head slices and move table: p2 88 groups (idle 87), p1 98 (idle 97); same tte head
    const NG = phase === 1 ? 98 : 88, IDLE = phase === 1 ? 97 : 87;
    const O_COL = NG, O_RESP = O_COL + 3, O_TTE = O_RESP + 3;
    const DEFAULTS = phase === 1 ? DEFAULTS1 : DEFAULTS2, GROUPS = phase === 1 ? GROUPS1 : GROUPS2;
    const GRP_NAMES = Object.keys(GROUPS); // gid order = the head's grp labels 0..NG-2 (NG-1 = idle)
    // the phase-2-only groups resolve to -1 on the p1 table (their code is gated by phase anyway)
    /** the 火球雨 volley groups: c7 alone at its prefix position and unparryable in the table (k0..k4:c7; the later c7
     *  positions are the boss's next moves, parryable) */
    const C11_GID = GRP_NAMES.indexOf("k0:c11+c40");
    const C30_K2_GID = GRP_NAMES.indexOf("k2:c30");
    const C7_GIDS = GRP_NAMES.map((n, i) => (/^k\d+:c7$/.test(n) && GROUPS[n].unparryable ? i : -1)).filter((i) => i >= 0);
    const defend = mode === "defend";
    // the walk-in at the start (stick forward until the boss bar shows): the boss waits at the far end of the arena
    // and never engages a character that stays put (live 2026-10-25, r001: 55 s, no boss bar). The shadow walks in
    // too unless args.approach is false; after the bar shows it touches nothing.
    const walkIn = defend || (args.approach ?? true);
    const provider = args.provider ?? "qnn";
    const maxPotions = defend ? args.potions ?? 1 : 0;
    const traceOn = args.trace ?? true;
    const pairEvery = args.pair ?? 0;
    // args.dodgeLead: every dodge's lead (frames) instead of the move table's (closed-loop trials: only failed dodges
    // are in the recorded data, @see tools/dufu_moveid/s5_movetable.py)
    // (both phases default 5: the best of 14 / 8 / 5 in phase 2 r007-r023; the phase-1 failed dodges are 62 % at <=10
    // frames, so the table's placeholder 14 is not used unless args.dodgeLead is null)
    const dodgeLead = args.dodgeLead === null ? null
        : typeof args.dodgeLead === "number" ? args.dodgeLead
            : DODGE_LEAD;
    // args.parryLead: override every group's 卸势 lead (frames before the predicted contact) for a live A/B. Phase 1
    // defaults to 10 (the finalized 2026-10-28 config; the table's global 6 pressed too late in the first A/B). Phase 2
    // keeps null = the move table's per-group leads.
    const parryLead = typeof args.parryLead === "number" ? args.parryLead : phase === 1 ? 10 : null;
    // args.run: run from the 火球雨 (phase 2 only, default on, @see runTick); args.runDir: one direction or a list
    // cycled per run (default diag: r036-r071 side 1.58 hits per 火球雨 episode (24), diag 0.64 (14))
    const runOn = phase === 2 && defend && (args.run ?? true);
    const runDirs = [args.runDir ?? "diag"].flat();
    // args.goldSeq: the 金光火球 window (phase 2 only, default on, @see GOLD_SEQ_F)
    const goldSeqOn = phase === 2 && (args.goldSeq ?? true);
    // args.chain: the k2:c30 chain beat (phase 2 only, default on since 2026-10-26, @see CHAIN_AFTER_F)
    const chainOn = phase === 2 && (args.chain ?? true);
    // args.curtain2: phase 1 only, force the 闪避 on k1:c18 (the 幕布 second sweep: 37/37 hit, 0 parried;
    // the prefix group has no ok/pf so its label defaults to parry, @see the gate-1 live notes). Default on.
    const curtain2On = phase === 1 && (args.curtain2 ?? true);
    // args.offense: "off" (default) | "v2" | "v3" — the v2 offense engine (defend only; contact 3; design
    // docs/dufu-offense-design.md); v3 = v2 + the M1 learned safety gate (lib/dufu-offense-policy.js,
    // docs/dufu-offense-online.md), which can only veto an action v2 would take. args.attack is the legacy offense and
    // is ignored while v2/v3 is on: they are different schedulers, never mixed.
    const offenseArg = args.offense ?? "off";
    if (offenseArg !== "off" && offenseArg !== "v2" && offenseArg !== "v3") throw new Error(`offense ${offenseArg}: off | v2 | v3`);
    const offenseOn = defend && (offenseArg === "v2" || offenseArg === "v3");
    const offenseGateOn = defend && offenseArg === "v3";
    // args.attack: the shared offense (defend only; default off until the A/B says it does not cost hits, @see atkTick)
    const attackOn = defend && !offenseOn && (args.attack ?? false);
    // args.offenseSet / args.offenseCharge: the T4 整套 / T5 蓄力 are interface-only in v1 (design 3.3: set ~0 HP,
    // charge is 真气 only), so both default off; the engine still reports them when switched on.
    const offenseSet = offenseOn && (args.offenseSet ?? false);
    const offenseCharge = offenseOn && (args.offenseCharge ?? false);
    // args.offenseQ: A/B overrides for the engine's q thresholds (0..1); the conservative defaults are in
    // lib/dufu-offense.js. Unknown keys / non-numbers are ignored.
    const offenseQ = { ...OFF_Q };
    if (args.offenseQ && typeof args.offenseQ === "object") {
        for (const k of Object.keys(OFF_Q)) {
            const v = args.offenseQ[k];
            if (typeof v === "number" && isFinite(v)) offenseQ[k] = Math.max(0, Math.min(1, v));
        }
    }
    // args.offenseGateThr: A/B override for the v3 gate's veto threshold (0..1, all non-execute actions); null keeps the
    // exported per-action thresholds. It can only make the gate stricter or looser, never add an action.
    const offenseGateThr = typeof args.offenseGateThr === "number" && isFinite(args.offenseGateThr)
        ? Math.max(0, Math.min(1, args.offenseGateThr)) : null;
    // args.curtain / args.curtainGap: the phase-1 幕布 state machine (default on) / its gap walk (default off: only
    // dodge; the finalized 2026-10-28 config does not walk)
    const curtainOn = phase === 1 && (args.curtain ?? true);
    const curtainGap = args.curtainGap ?? false;
    // the gold threshold: phase 1's is tighter (2.97 % answered by 卸势 in OOF, gate 2 allows 3 %; @see GOLD_DODGE_P1)
    const goldDodgeP = phase === 1 ? GOLD_DODGE_P1 : GOLD_DODGE_P;
    for (const d of runDirs) if (!(d in RUN_DIRS)) throw new Error(`runDir ${d}: ${Object.keys(RUN_DIRS).join(" | ")}`);
    const tag = args.tag ?? String(Date.now());
    // args.model: the model directory under model/ (phase 2 default dufu2b = the student fine-tuned on the live rounds,
    // tools/dufu_moveid/s5_retrain.py; dufu2 = the order-4 student. Phase 1 default dufu1b = the live-retrained student,
    // tools/dufu_moveid/s5_retrain.py, 关 2 passed; dufu1 = the order-4 base), same inputs / outputs per
    // phase's group labels
    const mdir = args.model ?? (phase === 1 ? "dufu1b" : "dufu2b");
    const M_GLOB = `${mdir}/glob.onnx`, M_CROP = `${mdir}/crop.onnx`, M_HEAD = `${mdir}/head.onnx`;
    const start = Date.now();
    const untilMs = Math.min(args.ms ?? 600_000, remaining() - END_MARGIN_MS);
    const until = start + untilMs;
    /** @type {[number, string, string][]} */
    const marks = [];
    /** @param {string} kind @param {string} [detail] */
    const mark = (kind, detail = "") => {
        marks.push([Date.now() - start, kind, detail]);
        log(`+${Date.now() - start} ${kind} ${detail}`);
    };

    // ---- touches: downs now, ups when due (never a blocking sleep)
    /** @type {{c: number, at: number}[]} */
    let ups = [];
    let halt = false; // the 成功 page is up: no downs
    const upsDue = (/** @type {boolean} */ all = false) => {
        if (!ups.length) return;
        const now = Date.now();
        const keep = [];
        for (const u of ups) {
            if (all || u.at <= now) touch.up(u.c);
            else keep.push(u);
        }
        ups = keep;
    };
    /** @param {number} c */
    const freeContact = (c) => {
        if (!ups.some((u) => u.c === c)) return;
        ups = ups.filter((u) => u.c !== c);
        touch.up(c);
    };
    let stickF = 0; // the forward push (walking in) on contact 0
    let stickSide = 0; // the sideways push (the 幕布 gap, phase 1) on the same contact 0: never both at once
    /** @param {Point} p */
    const tap = (p) => {
        if (!defend || halt) return false;
        freeContact(1);
        touch.down(p, 1);
        ups.push({ c: 1, at: Date.now() + TAP_MS });
        return true;
    };
    const walk = (/** @type {number} */ v) => {
        if (!walkIn || v === stickF || (halt && v)) return;
        if (v) {
            if (stickSide) stickSide = 0; // contact 0 is re-aimed below: the sideways push ends
            freeContact(0);
            touch.down(STICK, 0);
            touch.move([STICK[0], Math.round(STICK[1] - STICK_R * v)], 0);
        } else if (!stickSide) touch.up(0); // the side push still owns contact 0
        stickF = v;
    };
    /** Push the stick sideways, -1 (left) .. 1 (right), on contact 0: the 幕布 gap rule. The forward push is released
     *  first, so the contact is never held in two directions. @param {number} v */
    const walkSide = (v) => {
        if (v === stickSide || (halt && v !== 0)) return;
        if (v === 0) {
            if (!stickF) touch.up(0);
            stickSide = 0;
            return;
        }
        if (stickF) walk(0);
        freeContact(0);
        touch.down(STICK, 0);
        touch.move([Math.round(STICK[0] + STICK_R * v), STICK[1]], 0);
        stickSide = v;
    };
    let dodgeSeq = 0;
    /** the run in progress (@see runTick): the stick (contact 0) is held at `at` */
    /** @type {{t0: number, at: Point, dir: string, sign: number, lastC7: number, dodges: number, hits0: number} | null} */
    let running = null;
    const dodgeTouch = () => {
        if (!defend || halt) return false;
        freeContact(2);
        if (running) { // the stick is held the run's way: the dodge goes there too
            touch.down(DODGE, 2);
            ups.push({ c: 2, at: Date.now() + TAP_MS });
            running.dodges++;
            return true;
        }
        walkSide(0); // the gap walk releases contact 0 before the dodge's own left / right
        walk(0);
        freeContact(0);
        touch.down(STICK, 0);
        touch.move(dodgeSeq++ % 2 ? RIGHT : LEFT, 0);
        touch.down(DODGE, 2);
        const t = Date.now();
        ups.push({ c: 2, at: t + TAP_MS }, { c: 0, at: t + TAP_MS + 10 });
        return true;
    };

    // ---- inference
    const common = { provider, threads: 1, color: /** @type {"bgr"} */ ("bgr"), resize: /** @type {"area"} */ ("area"), mean: 0, std: 1, post: /** @type {"none"} */ ("none") };
    /** @type {Record<string, string>} */ const ran = {};
    /** @type {Record<string, string>} */ const fellBack = {};
    const noteProv = (/** @type {string} */ k, /** @type {Inference} */ r) => {
        if (r.provider) ran[k] = r.provider;
        if (r.fallback) fellBack[k] = r.fallback;
    };
    const HEAD_OPTS = { provider, threads: 1, post: /** @type {"none"} */ ("none"),
        extra: [{ name: "glob", dim: [1, RING, G_DIM + 4], ring: true }, { name: "big", dim: [1, RING, C_DIM + 1], ring: true },
                { name: "small", dim: [1, RING, C_DIM + 1], ring: true }] };
    /** JS copy of the rings (pair checks): [{g, b, s, h}] */
    /** @type {{g: number[], b: number[], s: number[], h: number[]}[]} */
    const jsRing = [];
    /** Append one ring entry from im with the contact history h. @param {Image} im @param {number[]} h @param {boolean} reset */
    function append(im, h, reset, input = false) {
        const g = infer(M_GLOB, { ...common, image: im, roi: [0, 0, im.width, im.height], size: [384, 240], input, history: [{ name: "glob", aux: h, reset }] });
        const b = infer(M_CROP, { ...common, image: im, roi: BIG, size: 192, input, history: [{ name: "big", aux: [0], reset }] });
        const s = infer(M_CROP, { ...common, image: im, roi: SMALL, size: 192, input, history: [{ name: "small", aux: [0], reset }] });
        noteProv("glob", g);
        noteProv("crop", b);
        if (reset) jsRing.length = 0;
        if (pairEvery) {
            jsRing.push({ g: /** @type {number[]} */ (g.output), b: /** @type {number[]} */ (b.output), s: /** @type {number[]} */ (s.output), h });
            if (jsRing.length > RING) jsRing.shift();
        }
        return [g, b, s];
    }

    // ---- warm-up (qnn compiles on first open), off the clock; the fight's first entry resets the rings
    const nn = nnProviders();
    const warm0 = Date.now();
    {
        const im = screenshot();
        append(im, [2, 2, 2, 0], true);
        noteProv("head", infer(M_HEAD, HEAD_OPTS));
    }
    const warmMs = Date.now() - warm0;
    mark("start", `mode ${mode}, provider ${provider} (ran ${JSON.stringify(ran)}${Object.keys(fellBack).length ? `, fallback ${JSON.stringify(fellBack)}` : ""}), warm ${warmMs} ms, ${untilMs} ms`);
    if (offenseOn) {
        mark("atk2", `offense v2: ${phase === 1 ? "陌刀 -> 横刀 on long windows" : "横刀 native"}, set ${offenseSet ? "requested (T4 not implemented)" : "off"}, charge ${offenseCharge ? "on" : "off"}`);
        mark("atk2", `q light ${offenseQ.light} follow ${offenseQ.follow} qishu ${offenseQ.qishu} charge ${offenseQ.charge} set ${offenseQ.set} execute ${offenseQ.execute}`);
        if (args.attack) mark("atk2", "legacy attack ignored (offense v2)");
    } else if (args.offense === "v2") {
        mark("atk2", `offense v2 ignored in ${mode} (defend only)`);
    }

    // ---- trace
    /** @type {number[][]} */
    let rows = [];
    let traceN = 0, traceChunks = 0;
    const traceFlush = () => {
        if (!traceOn || !rows.length) return;
        event(TRACE_EVENT, { start, tag, chunk: traceChunks++, cols: TRACE_COLS, rows });
        rows = [];
    };

    // ---- defend prep (dufu.js prep): the potion in the item slot. Phase 2 stops there (no poison, no buffs); phase 1
    // swaps the poison in, taps the slot icon to coat the blade, then swaps the potion back (teacher 2026-10-23). Both
    // swaps are checked because the pick swaps with the slot's item (a failed swap once left poison for the drinks). No
    // 增益 / 伤害: this skill does not attack.
    /** @param {Image} im */
    const slotPotion = (im) => match(SLOT_POTION_T, { image: im, roi: SLOT_ROI, threshold: SLOT_POTION_TH }).hit;
    /** Where to tap in the open column above the slot for these templates; ITEM_PICK when none shows (the training
     *  poison has no template, dufu.js). @param {Image} im @param {string[]} templates @returns {Point} */
    function columnPick(im, templates) {
        const b = match(templates, { image: im, roi: COLUMN_ROI, threshold: COLUMN_TH }).box;
        return b ? [Math.round(b[0] + b[2] / 2), Math.round(b[1] + b[3] / 2)] : ITEM_PICK;
    }
    /** Swap the slot's item until the slot holds the potion (want) / something else. @param {boolean} want
     *  @param {string} what @returns {boolean} */
    function swapTo(want, what) {
        for (let i = 0; i < PREP_SWAP_TRIES; i++) {
            tap(ITEM_OPEN);
            sleep(PREP_MENU_MS);
            upsDue(true);
            tap(columnPick(screenshot(), want ? SLOT_POTION_T : POISON_T));
            sleep(PREP_MENU_MS);
            upsDue(true);
            if (slotPotion(screenshot()) === want) return true;
            mark("prep", `${what} not in the slot (try ${i + 1})`);
        }
        return false;
    }
    if (defend) {
        if (!slotPotion(screenshot())) swapTo(true, "potion");
        if (phase === 1) {
            const poisoned = swapTo(false, "poison");
            if (poisoned) {
                tap(SLOT_ICON);
                sleep(PREP_USE_MS);
                upsDue(true);
            }
            let back = !poisoned || swapTo(true, "potion");
            sleep(PREP_SETTLE_MS);
            const pim = screenshot();
            const settled = slotPotion(pim) && !match(POISON_T, { image: pim, roi: SLOT_ROI, threshold: 0.8 }).hit;
            if (!settled) {
                back = swapTo(true, "potion") && back;
                mark("prep", `potion re-swap after settle (${back ? "ok" : "failed"})`);
            }
            mark("prep", `${poisoned ? "poison" : "NO POISON"} + ${back ? "potion back" : "POTION NOT BACK"}${settled ? "" : " (settled)"} in ${Date.now() - start} ms`);
        }
    }

    // ---- state
    const t0 = Date.now();
    let tick = 0;
    /** @type {{t: number, f: number, kind: "hit" | "ok", seenF: number}[]} */
    const contacts = [];
    let hpBase = /** @type {number | null} */ (null), hpNow = /** @type {number | null} */ (null), hpThis = /** @type {number | null} */ (null);
    let qiNow = -1, bossNow = 0, bossSeen = false, bossSeenAt = 0, bossGoneAt = 0;
    // the offense's own boss read (lib bossFill): the widest single red row of the tall ROI, immune to the HUD moving the
    // bar 1-3 rows. bossNow stays the defense's read (walk-in / boss gone / the legacy trace column).
    let bossFillNow = 0;
    let prevCap = 0, lastSeq = -1;
    let lastParryAt = 0, lastDodgeAt = 0, lastOkAt = 0, lastHitAt = 0, lastOwnAt = 0;
    let realParryAt = 0; // our last real 卸势 touch (ok detection; the shadow's would-presses only set lastParryAt)
    /** @type {{parry: number | null, dodge: number | null}} */
    const armed = { parry: null, dodge: null }; // the predicted contact time (capture clock) a press was made for
    /** the 金光火球 window: its anchor (capture clock) and the next fireball of the cadence (1..GOLD_SEQ_N) */
    /** @type {{anchor: number, k: number} | null} */
    let goldSeq = null;
    let lastC11At = 0; // the last tick whose head named k0:c11+c40
    /** @type {any[]} */
    const goldSeqLog = []; // [anchor ms, how opened, beats pressed]
    /** Open the 金光火球 window at the contact time t. @param {number} t @param {string} how */
    const goldSeqOpen = (t, how) => {
        if (!goldSeqOn || (goldSeq && t <= goldSeq.anchor + GOLD_SEQ_F * FRAME_MS)) return;
        goldSeq = { anchor: t, k: 1 };
        goldSeqLog.push([Math.round(t - start), how, 0]);
        mark("goldSeq", how);
    };
    /** In the 金光火球 window? @param {number} Tc */
    const inGoldSeq = (Tc) => goldSeq != null && Tc >= goldSeq.anchor + GOLD_SEQ_MIN_F * FRAME_MS && Tc <= goldSeq.anchor + GOLD_SEQ_F * FRAME_MS;
    let hits = 0, oks = 0, fills = 0, skipped = 0, dups = 0, ticks = 0, looks = 0;
    const presses = { parry: 0, dodge: 0, potion: 0, lock: 0, walk: 0, run: 0, attack: 0 };
    const would = { parry: 0, dodge: 0 };
    /** @type {any[]} */
    const pressLog = []; // [t ms, kind, grp, pGold, pDodge, pParry, med, remF, lead, src]
    /** @type {any[]} */
    const curtain2Log = []; // phase 1 args.curtain2: [t ms, grp, remF, lead]
    /** @type {{shot: number[], pipe: number[], prep: number[], run: number[], inferWall: number[], reads: number[], loop: number[], head: number[]}} */
    const tm = { shot: [], pipe: [], prep: [], run: [], inferWall: [], reads: [], loop: [], head: [] };
    // potion
    let potionsUsed = 0, potionTaps = 0, potionDueAt = 0, lastPotionFailAt = 0, lastPotionOkAt = 0, holdUntil = 0;
    let slotSwaps = 0, slotMiss = 0; // in-fight quick-slot swaps (the game reverted the slot to the poison after the coating, r167)
    let lastSlotSwapAt = 0; // the item menu was open: offense stays off it for a moment
    /** @type {{at: number, hp0: number} | null} */ let potionPend = null;
    const potS = { oks: 0, fails: 0, waitWhy: /** @type {Record<string, number>} */ ({}) };
    // offense (args.attack; @see atkTick). The boss-bar ring gives the "a hit landed" near-gate anchor (dufu.js's
    // bossRingTick); the weapon read picks 陌刀 vs 横刀 by the 蓄力 / 重击 disc.
    /** @type {{t: number, b: number}[]} */ const bossRing = [];
    let lastDropAt = 0, weapon = "", lastWeaponRead = 0;
    /** @type {{t: number, until: number, kind: string, w: string} | null} */ let atkHold = null;
    let atkBusyUntil = 0, atkExecs = 0;
    /** @type {{t: number, light: number, tapped: boolean} | null} */ let execPend = null;
    /** @type {any[]} */ const atkLog = [];
    // 进攻 v2 (args.offense; @see atk2Tick). Reads (execute button / blue disc / 奇术 lit), the one pending weapon
    // switch, the commit clock, and the press/land/cancel log (design 6).
    let exeBtn = false, blueDisc = false, qishuReady = false;
    let lastExecRead = 0, lastDiscRead = 0, lastQishuRead = 0;
    let lastExecuteAt = 0, qishuCoolUntil = 0;
    let atk2BusyUntil = 0;
    /** @type {{at: number, action: string, tier: number, q: number, why: string, tries: number, contactN: number,
     *          contactT: number, contactF: number} | null} */
    let atk2Switch = null;
    /** @type {{at: number, boss0: number, qi0: number, a: string, tier: number, q: number} | null} */ let atk2Hold = null;
    const atk2Count = { execute: 0, qishu: 0, light: 0, follow: 0, set: 0, charge: 0, switches: 0 };
    /** @type {Record<string, number>} */ const atk2Cancel = {};
    /** @type {{t: number, a: string, ev: string, tier: number, q: number, why: string, boss0?: number, boss1?: number,
     *          bossPrev?: number, qi0?: number, qi1?: number, held?: number, at?: number, dmg?: number | null,
     *          near?: boolean}[]} */
    const atk2Log = [];
    /** @type {{at: number, boss0: number, bossPrev: number, qi0: number, a: string, tier: number, q: number}[]} */
    const atk2Pend = [];
    let atk2QSum = 0, atk2QN = 0;
    // the opportunity log's per-tick view: the engine's pick before the start gates (cand / pE42-70), the learned gate's
    // score (v3; 0 = not run) and the policy id. Reset every atk2Tick so a tick another module owned reports cand 0.
    let lastCand = 0, lastGate = 0;
    /** @type {Record<number, number | null> | null} */ let lastPE = null;
    let gateVetoes = 0, gatePasses = 0;
    let lastAtkTier = 0, lastAtkQ = 0, lastAtkReason = 0;
    /** the tick's prefix-chain view (trace) */
    let chainPos = 0, chainLen = 0;
    /** the last contact's prefix group (the design's contact-history group; -1 = none known) and its next.share */
    let lastContactGid = -1, lastShare = /** @type {number | null} */ (null);
    // lock / approach / end
    let lastLockRead = 0, lastLockTap = 0, lockLit = true, lastBossRead = 0, lastDeadCheck = 0;
    let deadSeen = 0, greySeen = 0, wonSeen = 0;
    let reason = "time";
    /** the head's decoded output, the latest */
    /** @typedef {{grp: number, grpP: number, col: number[], resp: number[], tte: number[], med: number, capT: number, c7P: number}} Pred */
    /** @type {Pred | null} */
    let pred = null;
    /** pred, typed (the main loop's flow analysis does not see decode() assign it) */
    const curPred = () => /** @type {Pred | null} */ (pred);

    /** Contact history for ring entry n (frame index on the tick clock). @param {number} n */
    function history(n) {
        let i = contacts.length - 1;
        while (i >= 0 && contacts[i].f > n - HIST_DELAY_F) i--;
        if (i < 0) return [2, 2, 2, 0];
        const c = contacts[i].f;
        const h0 = Math.min((n - c) / HIST_GAP_F, 2);
        const h1 = i >= 1 ? Math.min((c - contacts[i - 1].f) / HIST_GAP_F, 2) : 2;
        const h2 = i >= 2 ? Math.min((contacts[i - 1].f - contacts[i - 2].f) / HIST_GAP_F, 2) : 2;
        let run = 1;
        for (let j = i; j >= 1 && contacts[j].f - contacts[j - 1].f <= HIST_GAP_F; j--) run++;
        const h3 = n - c <= HIST_GAP_F ? Math.min(run / 4, 2) : 0;
        return [r3(h0), r3(h1), r3(h2), r3(h3)];
    }
    const frameOf = (/** @type {number} */ t) => Math.round((t - t0) / FRAME_MS);
    /** @param {number} t contact time (capture clock) @param {"hit" | "ok"} kind @param {number} seenT */
    function addContact(t, kind, seenT) {
        const f = frameOf(t);
        if (kind === "hit") {
            for (let j = contacts.length - 1; j >= 0 && contacts[j].f >= f - MERGE_F; j--) {
                if (contacts[j].kind === "ok" && Math.abs(contacts[j].f - f) <= MERGE_F) contacts.splice(j, 1);
            }
        } else if (contacts.some((c) => c.kind === "hit" && Math.abs(c.f - f) <= MERGE_F)) return 0;
        contacts.push({ t, f, kind, seenF: frameOf(seenT) });
        contacts.sort((a, b) => a.f - b.f);
        return kind === "hit" ? 1 : 2;
    }

    /** Bars: hit / ok contacts (labels.contacts definitions). @param {Image} im @param {number} cap */
    function reads(im, cap) {
        const seen = prevCap ? (prevCap + cap) / 2 : cap;
        let got = 0;
        const h = health(im);
        hpThis = h;
        const now = Date.now();
        if (h != null) {
            if (hpBase == null) hpBase = h;
            else if (h < hpBase) {
                if (h < hpBase - HIT_DROP && h > hpBase - HIT_MAX) {
                    hits++;
                    lastHitAt = now;
                    got = addContact(seen - HIT_LAG_F * FRAME_MS, "hit", seen);
                    if (now - lastC11At <= GOLD_SEQ_HIT_MS) goldSeqOpen(seen - HIT_LAG_F * FRAME_MS, "hit");
                    mark("hit", `${Math.round(hpBase * 100)}%->${Math.round(h * 100)}%`);
                }
                hpBase = h;
            } else if (h > hpBase) {
                const healing = (potionPend != null && h >= potionPend.hp0 + POTION_HEAL) || (lastPotionOkAt > 0 && now - lastPotionOkAt <= POTION_SETTLE_MS) || h - hpBase >= POTION_HEAL;
                if (healing) hpBase = h;
            }
            hpNow = h;
        }
        const q = readQi(im);
        if (q >= 0) {
            const d = qiNow - q;
            if (qiNow >= 4 && q > 0 && d >= QI_STEP && d <= QI_JUMP && realParryAt && now - realParryAt <= OK_PARRY_MAX_F * FRAME_MS + 100) {
                oks++;
                lastOkAt = now;
                const k = addContact(seen, "ok", seen);
                if (k) got = got || k;
                mark("ok", `真气 ${qiNow}->${q}`);
            }
            qiNow = q;
        }
        prevCap = cap;
        return got;
    }

    /** @param {number[]} out @param {number} capT */
    function decode(out, capT) {
        const g = softmax(out, 0, NG);
        const grp = argmax(g);
        const tte = softmax(out, O_TTE, N_TTE);
        let cum = 0, med = TTE_NONE;
        for (let i = 0; i < N_TTE; i++) {
            cum += tte[i];
            if (cum >= 0.5) {
                med = i;
                break;
            }
        }
        let c7P = 0;
        for (const i of C7_GIDS) c7P += g[i];
        pred = { grp, grpP: g[grp], col: softmax(out, O_COL, 3), resp: softmax(out, O_RESP, 3), tte, med, capT, c7P };
    }
    /** P(next contact within x frames of the frame's capture). @param {number} x */
    const pWithin = (x) => {
        if (!pred) return 0;
        let s = 0;
        for (let i = 0; i <= Math.min(TTE_NONE - 1, Math.floor(x)); i++) s += pred.tte[i];
        return s;
    };

    /**
     * The defense decision for this tick: which key, whether now. Response = the resp head (dodge / parry); a
     * gold-coloured contact (P(gold) >= GOLD_DODGE_P: gold, or gold not ruled out) and a group the move table marks
     * unparryable are always dodged. Timing: the
     * contact is predicted at capture + median(tte); the press goes when it is <= lead frames away (lead from the
     * move table by the predicted prefix group, else the global default; @see lib/dufu2-table.js), unless it is more
     * than LATE_F past, or P(contact) = 1 - P(resp none) < CONTACT_P.
     * Phase 1: args.curtain2 forces the 闪避 on k1:c18 whatever the resp head says (@see CURTAIN2_NAME).
     * @param {number} now @returns {{kind: "parry" | "dodge", Tc: number, remF: number, lead: number, src: string} | null}
     */
    function decide(now) {
        if (!pred || pred.med >= TTE_NONE) return null;
        const [pd, pp, pn] = pred.resp;
        const Tc = pred.capT + pred.med * FRAME_MS;
        const remF = (Tc - now) / FRAME_MS;
        const name = pred.grp < IDLE ? GRP_NAMES[pred.grp] : null;
        // phase-1 grab follow-ups (k*:grab, the gold grab's close-up) cannot be answered: no press at all
        if (phase === 1 && name && name.endsWith(":grab")) return null;
        const row = name ? GROUPS[name] : null;
        const gold = pred.col[0] >= goldDodgeP;
        // the move table's unparryable groups (training: 卸住率 < 20 %; live: the closed loop's correction, e.g. the
        // 火球雨 c7 chain, 0 / 163 answered by 卸势 in r007-r023) are dodged whatever the resp head says
        const seq = inGoldSeq(Tc);
        const curtain2 = curtain2On && name === CURTAIN2_NAME;
        // phase 1, colour / table / curtain rules are dodge rules: do not let the resp head's "no contact" suppress
        // them (12 gold contacts, P(gold) >= 0.02, would otherwise get no press; the OOF decision gains 12 correct,
        // 0 wrong). Phase 2 keeps the old gate.
        const urgent = phase === 1 && (gold || curtain2 || !!row?.unparryable);
        if (1 - pn < CONTACT_P && !urgent) return null;
        const kind = curtain2 || gold || pd >= pp || row?.unparryable || seq ? "dodge" : "parry";
        const lead = kind === "parry" ? parryLead ?? row?.parry_lead ?? DEFAULTS.parry_lead : dodgeLead ?? row?.dodge_lead ?? DEFAULTS.dodge_lead;
        if (remF > lead || remF < -LATE_F) return null;
        return { kind, Tc, remF, lead, src: curtain2 ? "curtain2" : gold ? "gold" : row?.unparryable && pp > pd ? "table" : seq && pp > pd ? "goldSeq" : "resp" };
    }
    /** May this press go now (lock / cooldown / already pressed for this contact)? @param {{kind: string, Tc: number}} d @param {number} now */
    function canPress(d, now) {
        if (now < holdUntil) return "potion";
        const a = d.kind === "parry" ? armed.parry : armed.dodge;
        if (a != null && d.Tc <= a + REARM_F * FRAME_MS && now <= a + GRACE_F * FRAME_MS) return "pressed";
        if (d.kind === "parry") {
            if (armed.dodge != null && Math.abs(d.Tc - armed.dodge) <= GRACE_F * FRAME_MS) return "dodged";
            const since = now - lastParryAt;
            if (since < PARRY_CD_MS || (since < PARRY_LOCK_MS && !(lastOkAt > lastParryAt))) return "lock";
        } else if (now - lastDodgeAt < DODGE_CD_MS) return "cd";
        return "";
    }
    /** @param {{kind: "parry" | "dodge", Tc: number, remF: number, lead: number, src: string}} d @param {number} now */
    function press(d, now) {
        const ok = d.kind === "parry" ? tap(PARRY) : dodgeTouch();
        if (!ok) return 0;
        if (d.kind === "parry") lastParryAt = realParryAt = now;
        else lastDodgeAt = now;
        lastOwnAt = now;
        armed[d.kind] = d.Tc;
        presses[d.kind]++;
        const p = /** @type {NonNullable<typeof pred>} */ (pred);
        if (d.kind === "dodge" && p.grp === C11_GID && d.src !== "goldBeat") goldSeqOpen(now, "dodge");
        if (d.src === "curtain2") curtain2Log.push([now - start, p.grp, Math.round(d.remF * 10) / 10, d.lead]);
        pressLog.push([now - start, d.kind, p.grp, r3(p.col[0]), r3(p.resp[0]), r3(p.resp[1]), p.med, Math.round(d.remF * 10) / 10, d.lead, d.src]);
        return ACT[d.kind];
    }

    // ---- run (the 火球雨)
    let runSeq = 0, c7Streak = 0;
    /** @type {any[]} */
    const runLog = []; // [t ms, dir, sign, ms, dodges, hits during]
    const runStop = (/** @type {number} */ now) => {
        if (!running) return;
        if (!ups.some((u) => u.c === 0)) touch.up(0);
        runLog.push([running.t0 - start, running.dir, running.sign, now - running.t0, running.dodges, hits - running.hits0]);
        mark("run", `stop after ${now - running.t0} ms, ${running.dodges} dodges, ${hits - running.hits0} hits`);
        running = null;
    };
    /** Start / hold / stop the run from the 火球雨 (defend, args.run). @param {number} now */
    function runTick(now) {
        if (!runOn || !pred) return 0;
        const c7 = pred.c7P >= RUN_P || C7_GIDS.includes(pred.grp);
        if (running) {
            if (halt) {
                runStop(now);
                return 0;
            }
            if (c7) running.lastC7 = now;
            const age = now - running.t0;
            if (age >= RUN_MAX_MS || (age >= RUN_MIN_MS && now - running.lastC7 >= RUN_TAIL_MS)) runStop(now);
            return 0;
        }
        c7Streak = pred.c7P >= RUN_P ? c7Streak + 1 : 0;
        if (halt || c7Streak < RUN_TICKS || pred.med > RUN_START_F) return 0;
        const dir = runDirs[Math.floor(runSeq / 2) % runDirs.length];
        const sign = runSeq % 2 ? -1 : 1;
        runSeq++;
        const [x, y] = RUN_DIRS[dir];
        /** @type {Point} */
        const at = [Math.round(STICK[0] + sign * x * STICK_R), Math.round(STICK[1] + y * STICK_R)];
        walk(0);
        freeContact(0);
        touch.down(STICK, 0);
        touch.move(at, 0);
        running = { t0: now, at, dir, sign, lastC7: now, dodges: 0, hits0: hits };
        presses.run++;
        mark("run", `${dir} ${sign > 0 ? "right" : "left"}: c7 P ${r3(pred.c7P)}, contact in ${pred.med} f`);
        return ACT.run;
    }

    /** The 金光火球 window: a 闪避 for each fireball of the cadence unless one was already pressed for it; closes the
     *  window when it is over. @param {number} now */
    function goldBeatTick(now) {
        if (!goldSeq) return 0;
        let act = 0;
        const lead = dodgeLead ?? DEFAULTS.dodge_lead;
        const beatT = goldSeq.anchor + goldSeq.k * GOLD_SEQ_BEAT_F * FRAME_MS;
        if (goldSeq.k <= GOLD_SEQ_N && now >= beatT - lead * FRAME_MS) {
            goldSeq.k++;
            const covered = lastDodgeAt >= beatT - (lead + GOLD_SEQ_COVER_F) * FRAME_MS;
            if (!covered && now <= beatT + LATE_F * FRAME_MS && now - lastDodgeAt >= DODGE_CD_MS && now >= holdUntil && pred) {
                act = press({ kind: "dodge", Tc: beatT, remF: (beatT - now) / FRAME_MS, lead, src: "goldBeat" }, now);
                if (act) goldSeqLog[goldSeqLog.length - 1][2]++;
            }
        }
        if (now > goldSeq.anchor + GOLD_SEQ_F * FRAME_MS) goldSeq = null;
        return act;
    }

    // ---- chain beat
    let chainFor = -1; // the contact (frame) a chain press was armed for
    /** @type {{T: number} | null} */
    let chainDue = null;
    /** @type {any[]} */
    const chainLog = []; // [second contact ms, pressed 1 / covered 0 / missed -1]
    /** The k2:c30 chain beat (@see CHAIN_AFTER_F). @param {number} now */
    function chainTick(now) {
        if (!chainOn || !pred) return 0;
        const n = contacts.length;
        if (!chainDue && n >= 2 && pred.grp === C30_K2_GID) {
            const c1 = contacts[n - 1], c0 = contacts[n - 2];
            const gap = c1.f - c0.f;
            if (c1.f !== chainFor && gap >= CHAIN_GAP_F[0] && gap <= CHAIN_GAP_F[1] && now <= c1.t + CHAIN_AFTER_F * FRAME_MS) {
                chainFor = c1.f;
                chainDue = { T: c1.t + CHAIN_AFTER_F * FRAME_MS };
                chainLog.push([Math.round(c1.t - start), 0]);
            }
        }
        if (!chainDue) return 0;
        const lead = GROUPS["k2:c30"]?.parry_lead ?? DEFAULTS.parry_lead;
        const T = chainDue.T;
        if (now < T - lead * FRAME_MS) return 0;
        chainDue = null;
        const log = chainLog[chainLog.length - 1];
        if (lastParryAt >= T - (lead + CHAIN_COVER_F) * FRAME_MS) return 0; // a 卸势 for it already
        const d = { kind: /** @type {"parry"} */ ("parry"), Tc: T, remF: (T - now) / FRAME_MS, lead, src: "chain" };
        if (now > T + LATE_F * FRAME_MS || canPress(d, now)) {
            log[1] = -1;
            return 0;
        }
        const a = press(d, now);
        log[1] = a ? 1 : -1;
        return a;
    }

    // ---- 幕布 (phase 1; teacher 2026-10-26: far away walk into the gap, if the sweep is about to reach us 闪避)
    /** @type {[number, number] | "covered" | null} */
    let gapLast = null; // the last gapNow probe
    let inCurtain = false, curtainLastAt = 0, curtainEnterAt = 0, curtainEnters = 0, curtainDodges = 0;
    // shadow: the state is read and marked, nothing is touched (defend only below)
    /** @param {Image} im @param {number} now @param {boolean} busy another press went this tick @returns {number} an act */
    function curtainTick(im, now, busy) {
        if (!curtainOn) return 0;
        let g = gapLast;
        // in the curtain every tick (the gap moves as the panels sweep), outside every CURTAIN_TICKS-th
        if (inCurtain || looks % CURTAIN_TICKS === 0) {
            g = gapNow(im);
            gapLast = g;
        }
        if (g !== null) {
            curtainLastAt = now;
            if (!inCurtain) {
                inCurtain = true;
                curtainEnterAt = now;
                curtainEnters++;
                mark("curtain", g === "covered" ? "panels: covered" : `panels: gap ${g[0]}..${g[1]}`);
            }
        } else if (inCurtain) {
            if (readMean(im) < BLACK_MEAN) { // the black cover: nothing to read, stay in the curtain
                curtainLastAt = now;
                g = "covered";
            } else if (now - curtainLastAt >= CURTAIN_GONE_MS) {
                inCurtain = false;
                gapLast = null;
                if (defend) walkSide(0);
                mark("curtain", "over");
                return 0;
            }
        }
        if (!defend) return 0;
        if (g === "covered") {
            if (stickSide) walkSide(0);
            // The head's k0:c5+c18 (unparryable) dodges through decide(). Fallback for a silent head: one 闪避
            // CURTAIN_COVER_DODGE_MS after entering / after the last dodge, unless a drink is pending.
            const since = Math.max(curtainEnterAt, lastDodgeAt);
            if (!busy && now - since >= CURTAIN_COVER_DODGE_MS && !potionPend && now >= holdUntil && pred) {
                const lead = dodgeLead ?? DEFAULTS.dodge_lead;
                const act = press({ kind: "dodge", Tc: now, remF: 0, lead, src: "curtain" }, now);
                if (act) {
                    curtainDodges++;
                    mark("curtain", "covered: dodge");
                }
                return act;
            }
            return 0;
        }
        if (!inCurtain || g == null) return 0;
        // the gap: walk its centre (args.curtainGap false: dodge only, no walking). A key pressed this tick already
        // aimed contact 0 (e.g. the dodge's own left / right): do not re-aim it now.
        if (busy) return 0;
        const [a, b] = g;
        const dx = (a + b) / 2 - ME_X;
        const margin = Math.max(GAP_IN, (b - a) / 4);
        const v = Math.abs(dx) <= margin ? 0 : Math.max(-1, Math.min(1, Math.round((dx / GAP_PUSH) * 4) / 4)) || 0;
        walkSide(curtainGap ? v : 0);
        return 0;
    }

    /** Potion at a quiet moment (defend). @param {number} now @param {Image} im */
    function potionTick(now, im) {
        if (potionPend) {
            const healed = hpNow != null && hpNow >= potionPend.hp0 + POTION_HEAL;
            if (healed || lastHitAt > potionPend.at || now - potionPend.at >= POTION_CONFIRM_MS) {
                if (healed) {
                    potionsUsed++;
                    potS.oks++;
                    lastPotionOkAt = now;
                    mark("potion", `healed ${Math.round(potionPend.hp0 * 100)}%->${Math.round((hpNow ?? 0) * 100)}%`);
                } else {
                    potS.fails++;
                    lastPotionFailAt = now;
                    mark("potion", lastHitAt > potionPend.at ? "hit during the drink" : "no heal");
                }
                potionPend = null;
            }
            return 0;
        }
        if (running) return 0; // a drink would stop the run (and a 火球雨 is coming)
        if (potionsUsed >= maxPotions || potionTaps >= POTION_MAX_TAPS || hpNow == null || hpNow > POTION_HP) {
            potionDueAt = 0;
            return 0;
        }
        if (now - lastPotionFailAt < POTION_RETRY_MS || (lastPotionOkAt && now - lastPotionOkAt < POTION_SETTLE_MS)) return 0;
        if (!potionDueAt) potionDueAt = now;
        const urgent = hpNow <= POTION_URGENT || now - potionDueAt >= POTION_WAIT_MAX_MS;
        let why = "";
        if (now - lastOwnAt < (urgent ? 250 : POTION_GAP_MS)) why = "own press";
        else if (now - lastHitAt < (urgent ? POTION_URGENT_QUIET_MS : POTION_QUIET_MS)) why = "after hit";
        else if (!urgent && pWithin(POTION_LOOK_F) >= POTION_MASS) why = "contact soon";
        if (why) {
            potS.waitWhy[why] = (potS.waitWhy[why] ?? 0) + 1;
            return 0;
        }
        // The quick slot can hold the poison again after the coating (live r167: every tap hit its cooldown). Swap the
        // potion in before drinking, like dufu.js's potionTick; at most twice per round.
        if (!slotPotion(im)) {
            if (++slotMiss < 2) return 0;
            if (slotSwaps >= 2) {
                potS.waitWhy["slot not potion"] = (potS.waitWhy["slot not potion"] ?? 0) + 1;
                return 0;
            }
            slotSwaps++;
            slotMiss = 0;
            lastSlotSwapAt = now;
            tap(ITEM_OPEN);
            sleep(PREP_MENU_MS);
            upsDue(true);
            tap(columnPick(screenshot(), SLOT_POTION_T));
            sleep(PREP_MENU_MS);
            upsDue(true);
            mark("potion", `slot swap ${slotSwaps} (${slotPotion(screenshot()) ? "potion" : "still not potion"})`);
            return 0;
        }
        slotMiss = 0;
        if (!tap(POTION)) return 0;
        potionTaps++;
        presses.potion++;
        potionPend = { at: now, hp0: hpNow };
        holdUntil = now + POTION_HOLD_MS;
        lastOwnAt = now;
        mark("potion", `tap at hp ${Math.round(hpNow * 100)}%${urgent ? " (urgent)" : ""}`);
        return ACT.potion;
    }

    // ---- offense (args.attack): a shared near-gate / 气竭 state machine. Both phases use it; the phase only decides
    // which weapon is on (phase 1 陌刀 when its icon is read, else 横刀; phase 2 always 横刀).
    /** A short offense tap on contact 3 (never the defense's contact 1). @param {Point} p @param {number} [ms] */
    function atkTap(p, ms = 50) {
        if (!defend || halt) return false;
        freeContact(3);
        touch.down(p, 3);
        ups.push({ c: 3, at: Date.now() + ms });
        return true;
    }
    /** Lift a held offense finger now. @param {string} why */
    function atkRelease(why) {
        if (!atkHold) return;
        const held = Date.now() - atkHold.t;
        freeContact(3);
        atkBuff(why, held);
        atkHold = null;
        atkBusyUntil = Date.now() + 300;
    }
    /** @param {string} why @param {number} held */
    function atkBuff(why, held) {
        atkLog.push([Math.round(Date.now() - start), "release", why, Math.round(held)]);
        mark("atk", `release ${why} after ${Math.round(held)} ms`);
    }
    /** The boss bar's drop (>= BOSS_DROP_PX within BOSS_DROP_WIN_MS): the second near-gate anchor. The ring uses the
     *  offense read (bossFill) so a 1-3 row HUD move is not a drop. @param {number} now */
    function bossDropTick(now) {
        if (bossFillNow <= 50) return;
        const last = bossRing[bossRing.length - 1];
        if (last && now - last.t < 200) return;
        bossRing.push({ t: now, b: bossFillNow });
        while (bossRing.length && now - bossRing[0].t > BOSS_RING_MS) bossRing.shift();
        if (bossRing.length < 3) return;
        const cur = Math.max(bossRing[bossRing.length - 1].b, bossRing[bossRing.length - 2].b); // one low read is no drop
        let peak = 0;
        for (const s of bossRing) if (now - s.t <= BOSS_DROP_WIN_MS) peak = Math.max(peak, s.b);
        const d = peak - cur;
        if (d >= BOSS_DROP_PX && d <= BOSS_DROP_MAX_PX) lastDropAt = now;
    }
    /** 陌刀 / 横刀 from the 蓄力 / 重击 disc (4 Hz); "" when neither template shows. @param {Image} im @param {number} now */
    function weaponNow(im, now) {
        if (now - lastWeaponRead < WEAPON_EVERY) return weapon;
        lastWeaponRead = now;
        const mo = match(WEAPON_T[0][0], { image: im, roi: WEAPON_T[0][1], threshold: WEAPON_TH }).hit;
        const he = match(WEAPON_T[1][0], { image: im, roi: WEAPON_T[1][1], threshold: WEAPON_TH }).hit;
        // after a 横刀 ok its 重击 is the blue 爆发 disc (dufu.js offWeaponNow counts the swirl as 横刀 too). Only the
        // v2 offense needs it: defense / the legacy attack keep the two-template read (no extra match per 4 Hz).
        const sw = offenseOn && match(SWIRL_T, { image: im, roi: WEAPON_T[1][1], threshold: WEAPON_TH }).hit;
        weapon = mo && !he && !sw ? "modao" : (he || sw) && !mo ? "hengdao" : "";
        return weapon;
    }
    /** 气竭: the execute button up and the boss's 真气 drained -> 轻击 filler, 处决 at EXEC_FILL_MS. @param {number} now
     *  @param {Image} im @returns {number} an act */
    function execTick(now, im) {
        if (now - lastHitAt < 500) {
            execPend = null;
            return 0;
        }
        const low = qiNow >= 0 && qiNow <= 25;
        const up = low && match("combat/execute.png", { image: im, roi: EXEC_ROI, threshold: EXEC_TH }).hit;
        if (!up) {
            execPend = null;
            return 0;
        }
        if (!execPend) {
            if (atkHold) atkRelease("execute"); // the 处决 window is worth more than the charge
            execPend = { t: now, light: 0, tapped: false };
            mark("atk", `气竭: execute button up (qi ${qiNow})`);
        }
        if (now - execPend.t >= EXEC_FILL_MS) {
            if (!execPend.tapped) {
                execPend.tapped = true;
                if (atkTap(EXECUTE, EXEC_TAP_MS)) {
                    atkExecs++;
                    atkLog.push([Math.round(now - start), "execute", "", 0]);
                    mark("atk", "处决 tap");
                }
            }
            return ACT.attack;
        }
        if (now - execPend.light >= EXEC_LIGHT_MS) {
            execPend.light = now;
            atkTap(LIGHT, 60);
        }
        return ACT.attack;
    }
    /** Attack in a quiet window after an ok / a boss-bar drop (args.attack, @see the constants). @param {number} now
     *  @param {Image} im @returns {number} an act */
    function atkTick(now, im) {
        if (!attackOn || halt) return 0;
        const e = execTick(now, im);
        if (e) return e;
        if (atkHold) {
            const stop = inCurtain || running || now < holdUntil || now - lastHitAt < 300
                || (pred != null && (pred.med <= 25 || pWithin(20) >= 0.15
                    || pred.col[0] >= goldDodgeP));
            if (stop) {
                atkRelease(inCurtain ? "curtain" : running ? "run" : now < holdUntil ? "potion" : now - lastHitAt < 300 ? "hit" : "defense");
                return 0;
            }
            if (now >= atkHold.until) {
                atkHold = null;
                atkBusyUntil = now + ATK_BUSY_MS;
            }
            return 0;
        }
        if (now < atkBusyUntil || inCurtain || running || potionPend || now < holdUntil) return 0;
        if (now - lastHitAt < ATK_HIT_QUIET_MS) return 0;
        if (now - lastOkAt > ATK_NEAR_MS && now - lastDropAt > ATK_DROP_MS) return 0;
        if (!pred) return 0;
        if (pred.med <= ATK_QUIET_F || pWithin(ATK_QUIET_F) >= ATK_QUIET_P) return 0;
        if (pred.col[0] >= goldDodgeP) return 0; // a gold tell: leave the hand free
        if (decide(now)) return 0; // a defense press is due: never start a charge in front of it
        const w = weaponNow(im, now);
        const modao = phase === 1 && w === "modao";
        const p = modao ? HEAVY : LIGHT;
        const ms = modao ? ATK_MODAO_MS : ATK_HENG_MS;
        const t = Date.now();
        freeContact(3);
        touch.down(p, 3);
        ups.push({ c: 3, at: t + ms });
        atkHold = { t, until: t + ms, kind: modao ? "charge" : "hlight", w: w || "?" };
        lastOwnAt = t;
        presses.attack++;
        atkLog.push([Math.round(t - start), atkHold.kind, atkHold.w, ms, pred.med, r3(pWithin(ATK_QUIET_F))]);
        mark("atk", `${atkHold.kind} ${atkHold.w} hold ${ms} ms (med ${pred.med}, p30 ${r3(pWithin(ATK_QUIET_F))})`);
        return ACT.attack;
    }

    // ---- 进攻 v2 (args.offense === "v2"; design docs/dufu-offense-design.md): lib/dufu-offense.js picks, this block
    // only carries the action out on contact 3. Every defense press / gold tell / curtain / 火球雨 preempts it before
    // the defense's own tick (atk2Preempt), and the engine's T0 list blocks the rest (lib/dufu-offense.js).
    /** The contacts' current chain: length and 0-based position (the prefix head's k). */
    function chainNow() {
        const n = contacts.length;
        if (!n) return { len: 0, pos: -1 };
        const last = contacts[n - 1].f;
        let len = 0;
        for (let i = n - 1; i >= 0 && contacts[i].f >= last - HIST_GAP_F; i--) len++;
        return { len, pos: len - 1 };
    }
    /** The v2 reads: the 处决 button (low 真气 only), the blue 爆发 disc, the lit 奇术 button (4 Hz). One 处决 tap per
     *  window: the button shows for ~2.4 s and the animation is longer than its own commit. */
    function atk2Reads(now, im) {
        // the 处决 button: 4 Hz (its window is ~2.4 s) and one tap per 5 s window; low 真气 only (the match is
        // short-circuited otherwise)
        if (now - lastExecRead >= ATK2_EXEC_EVERY) {
            lastExecRead = now;
            exeBtn = qiNow >= 0 && qiNow <= 25 && now - lastExecuteAt >= 5000
                && match(EXEC_T, { image: im, roi: EXEC_ROI, threshold: EXEC_TH }).hit;
        } else if (now - lastExecuteAt < 5000) {
            exeBtn = false; // a just-tapped button is not a second window
        }
        if (now - lastDiscRead >= ATK2_DISC_EVERY) {
            lastDiscRead = now;
            blueDisc = match(SWIRL_T, { image: im, roi: WEAPON_T[1][1], threshold: WEAPON_TH }).hit;
        }
        if (now < qishuCoolUntil) qishuReady = false;
        else if (now - lastQishuRead >= ATK2_QISHU_EVERY) {
            lastQishuRead = now;
            const hit = match(QISHU_T, { image: im, roi: QISHU_ROI, threshold: WEAPON_TH });
            qishuReady = false;
            if (hit.hit && hit.box) {
                const [x, y, w, h] = hit.box;
                const cx = Math.round(x + w / 2), cy = Math.round(y + h / 2);
                qishuReady = color({ ...ICON_WHITE, image: im, roi: [cx - 18, cy - 18, 36, 36], count: QS_LIT_PX }).hit;
            }
        }
    }
    /** The M1 learned gate's input (lib/dufu-offense-policy.js FEATURES): this tick's state, no future contact. */
    function gateState(now) {
        const p = curPred();
        const last = contacts.length ? contacts[contacts.length - 1] : null;
        let hits90 = 0;
        for (let i = contacts.length - 1; i >= 0; i--) {
            if (contacts[i].f < tick - 1 - 90) break;
            if (contacts[i].kind === "hit") hits90++;
        }
        return {
            hp: hpNow, qi: qiNow, bossPx: bossFillNow,
            grpP: p ? p.grpP : 0, p10: pWithin(10), med: p ? p.med : -1,
            gold: p ? p.col[0] : 0, red: p ? p.col[1] : 0, none: p ? p.col[2] : 0,
            dodge: p ? p.resp[0] : 0, parry: p ? p.resp[1] : 0, rnone: p ? p.resp[2] : 0,
            c7P: p ? p.c7P : 0, nextShare: lastShare == null ? -1 : lastShare,
            chainPos, chainLen, weapon, near: nearNow({ now, lastOkAt, lastDropAt }), lock: lockLit,
            hitAgeF: lastHitAt ? (now - lastHitAt) / FRAME_MS : 300,
            okAgeF: lastOkAt ? (now - lastOkAt) / FRAME_MS : 300,
            lastKind: last ? (last.kind === "hit" ? -1 : 1) : 0,
            hitsLast90: hits90,
            c11Active: goldNow(now), // goldSeq / gold tell / a c11-c40 contact < 2.5 s (the same window as the engine's)
        };
    }
    /** @param {number} now @param {string} a @param {number} tier @param {number} q @param {number} score @param {number} thr */
    function atk2GateVeto(now, a, tier, q, score, thr) {
        gateVetoes++;
        atk2Cancel.gate = (atk2Cancel.gate ?? 0) + 1;
        if (atk2Log.length >= 2000) atk2Log.shift();
        atk2Log.push({ t: Math.round(now - start), a, ev: "cancel", tier, q: r3(q), why: "gate", gate: Math.round(score * 1000) });
        mark("atk2", `gate veto ${a} (value ${r3(score)} < ${thr})`);
    }
    /** @param {number} now @param {string} what @param {string} why @param {number} held @param {number} [tier]
     *  @param {number} [q] */
    function atk2CancelNow(now, what, why, held = 0, tier = 0, q = 0) {
        atk2Cancel[why] = (atk2Cancel[why] ?? 0) + 1;
        if (atk2Log.length >= 2000) atk2Log.shift();
        atk2Log.push({ t: Math.round(now - start), a: what, ev: "cancel", tier, q: r3(q), why, held: Math.round(held) });
        mark("atk2", `cancel ${what} (${why})${held ? ` after ${Math.round(held)} ms` : ""}`);
    }
    /** The 金光火球 window, broader than goldSeq: the goldSeq cadence itself, a gold tell now, or a c11/c40 contact
     *  < ATK2_GOLD_QUIET_MS ago (the tell / sequence can start before goldSeq opens). The c11/c40 group rule uses the
     *  move table's semantics (dodge / unparryable, in BOTH phases); a c11/c40 name with no table row is kept
     *  conservative. @param {number} now */
    function goldNow(now) {
        if (goldSeqOn && goldSeq != null && now <= goldSeq.anchor + GOLD_SEQ_F * FRAME_MS) return true;
        if (pred != null && pred.col[0] >= goldDodgeP) return true;
        if (lastContactGid < 0 || lastContactGid >= IDLE) return false;
        const name = GRP_NAMES[lastContactGid];
        if (!name || (!name.includes("c11") && !name.includes("c40"))) return false;
        const row = GROUPS[name];
        // phase 1's k2:c11 is dodge / unparryable / fatal, not a normal move: the table decides, not the phase. If the
        // table has no row (or lacks the fields), stay conservative and keep the c11/c40 name rule.
        const known = row != null && typeof row.unparryable === "boolean"
            && (row.response === "dodge" || row.response === "parry" || row.response === "none");
        if (known && row.response !== "dodge" && row.unparryable !== true) return false;
        const last = contacts.length ? contacts[contacts.length - 1] : null;
        return last != null && now - last.t <= ATK2_GOLD_QUIET_MS;
    }
    /** Why a defense press / special window preempts the offense now ("" = none). The order is the defense's own:
     *  火球雨 > 幕布 > 喝药 > 挨打 1 s > a defense press due (the caller's decide result) > a predicted contact > a
     *  gold tell. @param {number} now @param {boolean} defenseDue the main loop's decide(now) was non-null */
    function atk2PreemptWhy(now, defenseDue) {
        if (running != null || (pred != null && pred.c7P >= RUN_P)) return "rain";
        if (inCurtain) return "curtain";
        if (potionPend != null || now < holdUntil) return "potion";
        if (lastHitAt && now - lastHitAt < ATK_HIT_QUIET_MS) return "hit";
        if (defenseDue) return "defense";
        if (pred != null && (pred.med <= 25 || pWithin(20) >= 0.15)) return "defense";
        if (goldNow(now)) return "gold";
        return "";
    }
    /** Called before the defense's tick: a pending switch / held charge lets go at once. @param {number} now
     *  @param {boolean} defenseDue the main loop's decide(now) was non-null */
    function atk2Preempt(now, defenseDue) {
        if (!offenseOn) return "";
        const why = atk2PreemptWhy(now, defenseDue);
        if (!why) return "";
        if (atk2Switch) {
            atk2CancelNow(now, atk2Switch.action, why, now - atk2Switch.at, atk2Switch.tier, atk2Switch.q);
            atk2Switch = null;
        }
        if (atk2Hold) {
            freeContact(3);
            atk2CancelNow(now, "charge", why, now - atk2Hold.at, atk2Hold.tier, atk2Hold.q);
            atk2Hold = null;
            atk2BusyUntil = now + 300;
        }
        return why;
    }
    /** The press/land log (design 6): boss px and 真气 at the press and 2 s after it. @param {number} now */
    function atk2Land(now) {
        for (let i = atk2Pend.length - 1; i >= 0; i--) {
            const p = atk2Pend[i];
            if (now < p.at) continue;
            atk2Pend.splice(i, 1);
            const dmg = p.boss0 > 50 && bossFillNow > 50 ? p.boss0 - bossFillNow : null;
            if (atk2Log.length >= 2000) atk2Log.shift();
            atk2Log.push({ t: Math.round(now - start), a: p.a, ev: "land", tier: p.tier, q: r3(p.q), why: "",
                at: Math.round(p.at - start), boss0: p.boss0, bossPrev: p.bossPrev, boss1: bossFillNow, qi0: p.qi0, qi1: qiNow, dmg });
            mark("atk2", `land ${p.a}: boss ${p.boss0} -> ${bossFillNow}${dmg != null ? ` (${dmg} px)` : ""}, 真气 ${p.qi0} -> ${qiNow}`);
        }
    }
    /** The boss bar `ms` ago (the closest ring sample; -1 when the ring is shorter). @param {number} ms */
    function bossAt(ms) {
        const target = Date.now() - ms;
        /** @type {{t: number, b: number} | null} */ let best = null;
        for (const s of bossRing) if (!best || Math.abs(s.t - target) < Math.abs(best.t - target)) best = s;
        return best ? best.b : -1;
    }
    /** Carry out one engine action on contact 3. @param {number} now @param {{action: string, tier: number, q: number,
     *  reason: string, holdMs?: number}} d @returns {number} an act */
    function atk2Do(now, d) {
        if (!defend || halt) return 0;
        const a = d.action;
        if (a !== "execute" && a !== "qishu" && a !== "follow" && a !== "light" && a !== "charge") {
            atk2CancelNow(now, a, "disabled"); // the T4 整套 interface: no action sequence in v1
            return 0;
        }
        if (a === "charge" && !offenseCharge) {
            atk2CancelNow(now, a, "disabled");
            return 0;
        }
        const boss0 = bossFillNow, qi0 = qiNow, bossPrev = bossAt(ATK2_LAND_MS);
        const near = nearNow({ now, lastOkAt, lastDropAt });
        if (a === "charge") {
            freeContact(3);
            touch.down(HEAVY, 3);
            const hold = d.holdMs ?? ATK2_CHARGE_MS;
            ups.push({ c: 3, at: Date.now() + hold });
            atk2Hold = { at: now, boss0, qi0, a, tier: d.tier, q: d.q };
            atk2BusyUntil = now + hold;
        } else {
            /** @type {Point} */
            const p = a === "execute" ? EXECUTE : a === "qishu" ? QISHU : a === "follow" ? HEAVY : LIGHT;
            const t = Date.now();
            freeContact(3);
            touch.down(p, 3);
            ups.push({ c: 3, at: t + (a === "execute" ? EXEC_TAP_MS : TAP_MS) });
            atk2BusyUntil = now + (ATK2_COMMIT_MS[a] ?? 600);
            if (a === "execute") { lastExecuteAt = now; exeBtn = false; }
            if (a === "qishu") { qishuCoolUntil = now + ATK2_QISHU_COOL_MS; qishuReady = false; }
            if (a === "follow") blueDisc = false; // one tap per disc
        }
        atk2Count[a] = (atk2Count[a] ?? 0) + 1;
        presses.attack++;
        atk2QSum += d.q;
        atk2QN++;
        if (atk2Log.length >= 2000) atk2Log.shift();
        atk2Log.push({ t: Math.round(now - start), a, ev: "press", tier: d.tier, q: r3(d.q), why: d.reason, boss0, bossPrev, qi0, near,
            gate: lastGate });
        atk2Pend.push({ at: now + ATK2_LAND_MS, boss0, bossPrev, qi0, a, tier: d.tier, q: d.q });
        mark("atk2", `${a} tier T${d.tier} q ${r3(d.q)} (${d.reason}, weapon ${weapon || "?"}, med ${pred?.med ?? -1})`);
        return ACT.attack;
    }
    /** Tap the weapon switch and queue the engine action until the 横刀 template confirms. @param {number} now
     *  @param {{action: string, tier: number, q: number, reason: string}} d */
    function atk2StartSwitch(now, d) {
        if (atk2Switch || now < atk2BusyUntil) return 0;
        const t = Date.now();
        freeContact(3);
        touch.down(SWITCH, 3);
        ups.push({ c: 3, at: t + TAP_MS });
        atk2Count.switches++;
        presses.attack++;
        // the last contact at the switch's start: the confirmation re-checks it (a contact that arrives during the
        // 1.5 s wait makes the queued action stale, even when no defense press was due for it)
        const lastC = contacts.length ? contacts[contacts.length - 1] : null;
        atk2Switch = { at: now, action: d.action, tier: d.tier, q: d.q, why: d.reason, tries: 1,
            contactN: contacts.length, contactT: lastC ? lastC.t : 0, contactF: lastC ? lastC.f : -1 };
        if (atk2Log.length >= 2000) atk2Log.shift();
        atk2Log.push({ t: Math.round(now - start), a: "switch", ev: "press", tier: d.tier, q: r3(d.q), why: d.reason,
            near: nearNow({ now, lastOkAt, lastDropAt }) });
        mark("atk2", `switch -> 横刀 for ${d.action} (${d.reason}) at contacts ${contacts.length}`);
        return ACT.attack;
    }
    /** @param {number} now @param {Image} im @param {boolean} defenseDue the main loop's decide(now) was non-null
     *  @returns {number} an act */
    function atk2SwitchTick(now, im, defenseDue) {
        const s = atk2Switch;
        if (!s) return 0;
        const w = weaponNow(im, now);
        if (w === "hengdao") {
            atk2Switch = null;
            // The queued action was chosen `now - s.at` ago. Re-check before tapping: a new contact (even without a
            // defense press due), a special window / defense press that appeared, or too long a wait makes it stale.
            const lastC = contacts.length ? contacts[contacts.length - 1] : null;
            const stale = atk2PreemptWhy(now, defenseDue) !== ""
                || contacts.length !== s.contactN
                || (lastC != null && (lastC.t > s.at || lastC.f !== s.contactF))
                || !nearNow({ now, lastOkAt, lastDropAt }) // the queued light/follow would now be outside the near gate
                || pWithin(atk2CommitF(s.action)) >= ATK2_HORIZON_P // the horizon worsened while switching
                || now - s.at > 2 * ATK2_SWITCH_WAIT_MS;
            if (stale) {
                lastAtkTier = 0;
                lastAtkQ = 0;
                lastAtkReason = OFF_REASON.stale ?? 0;
                atk2CancelNow(now, s.action, "stale", now - s.at, s.tier, s.q);
                return 0;
            }
            lastAtkTier = s.tier;
            lastAtkQ = s.q;
            lastAtkReason = OFF_REASON[s.why] ?? 0;
            return atk2Do(now, { action: s.action, tier: s.tier, q: s.q, reason: s.why });
        }
        if (now - s.at < ATK2_SWITCH_WAIT_MS) return 0;
        if (s.tries < ATK2_SWITCH_TRIES) { // the tap did not take: once more
            const t = Date.now();
            freeContact(3);
            touch.down(SWITCH, 3);
            ups.push({ c: 3, at: t + TAP_MS });
            atk2Count.switches++;
            presses.attack++;
            s.tries++;
            s.at = now;
            mark("atk2", `switch retry ${s.tries} for ${s.action}`);
            return ACT.attack;
        }
        atk2Switch = null;
        atk2CancelNow(now, s.action, "switch", now - s.at, s.tier, s.q);
        return 0;
    }
    /** The v2 special windows the engine cannot see (design 5.1). @param {number} now */
    function offenseSpecial(now) {
        return {
            curtainCovered: curtainOn && inCurtain && gapLast === "covered",
            curtainSweep: curtainOn && inCurtain,
            fireballRain: runOn && (running != null || (pred != null && pred.c7P >= RUN_P)),
            goldFireball: goldNow(now),
            phaseTransition: false, // no read yet; the T4 整套 is off in v1 anyway
            running: running != null,
            potionPending: potionPend != null || now < holdUntil
                || (lastPotionOkAt > 0 && now - lastPotionOkAt < POTION_SETTLE_MS)
                || (lastSlotSwapAt > 0 && now - lastSlotSwapAt < 1500), // the item menu was open
            executeWindup: now - lastExecuteAt < ATK2_EXEC_WINDUP_MS,
            c30Chain: chainOn && pred != null && pred.grp === C30_K2_GID && (chainDue != null || chainLen >= 2),
        };
    }
    /** 进攻 v2's tick: the engine's decision and its action on contact 3. @param {number} now @param {Image} im
     *  @param {boolean} defenseDue a defense press is due this tick @returns {number} an act */
    function atk2Tick(now, im, defenseDue) {
        if (!offenseOn) return 0;
        atk2Land(now);
        const ch = chainNow();
        chainLen = ch.len;
        chainPos = ch.pos;
        lastShare = lastContactGid >= 0 ? (NEXT_SHARE[phase]?.[lastContactGid] ?? null) : null;
        lastCand = 0;
        lastGate = 0;
        lastPE = null;
        if (!defend || halt) return 0;
        weaponNow(im, now);
        atk2Reads(now, im);
        if (atk2Hold) {
            if (now < atk2BusyUntil) return 0;
            const h = atk2Hold;
            freeContact(3);
            atk2Hold = null;
            if (atk2Log.length >= 2000) atk2Log.shift();
            atk2Log.push({ t: Math.round(now - start), a: "charge", ev: "release", tier: h.tier, q: r3(h.q), why: "time",
                at: Math.round(h.at - start), held: Math.round(now - h.at), boss0: h.boss0, boss1: bossFillNow,
                qi0: h.qi0, qi1: qiNow });
            mark("atk2", `release charge after ${Math.round(now - h.at)} ms, 真气 ${h.qi0} -> ${qiNow}`);
            atk2BusyUntil = now + (ATK2_COMMIT_MS.charge - ATK2_CHARGE_MS); // 46 f commit+safety total (1533 ms)
        }
        if (atk2Switch) return atk2SwitchTick(now, im, defenseDue);
        if (now < atk2BusyUntil) return 0;
        // The engine's group is the LAST CONTACT's prefix group (design 4: the contact history's group / k /
        // next.share); its next.share is only the chain prior. The empty-window prior is the group model right after
        // that contact (< 30 f, the design's 3.2 anchor) and the pooled quiet_far anchor after 30 f.
        const gname = lastContactGid >= 0 && lastContactGid < IDLE ? GRP_NAMES[lastContactGid] : null;
        const g = gname ? GROUPS[gname] : null;
        const last = contacts.length ? contacts[contacts.length - 1] : null;
        const live = last != null && now - last.t < ATK2_CHAIN_CLEAR_MS;
        /** @type {Record<number, number | null>} */ const pE = {};
        for (const f of OFF_WINDOWS) {
            // A contact < 30 f old with no group (the head was idle) is not a quiet window: pE is 0, the engine's
            // "unknown" block. quiet_far is only the prior when there is NO recent contact (>= 30 f / none yet).
            pE[f] = live ? (lastShare != null ? emptyP(lastShare, f) : 0) : quietP(phase, f);
        }
        // Opening 奇术 (dufu.js qsWhere: the boss bar up, no hit/ok yet, within QS_OPEN_MS): the ranged 奇术 is the old
        // engine's opening action. Only qishu's window is lifted; light / follow still need the near gate and quietP.
        const opening = bossSeenAt > 0 && contacts.length === 0 && now - bossSeenAt <= ATK2_OPENING_MS;
        if (opening) pE[70] = 1.0;
        // Layer guard (beyond the engine's T0 list): a defense press due this tick or a contact predicted within
        // 25 f leaves the hand free (the legacy atkTick's pred.med guard). The design's 30 f chain rule is in the
        // engine; this covers the tte head's own short window, which next.share cannot see.
        const guard = defenseDue || (pred != null && (pred.med <= 25 || pWithin(20) >= 0.15 || pred.col[0] >= goldDodgeP));
        const d = offensePick({
            now, phase, weapon, bossPx: bossFillNow, qi: qiNow,
            executeButton: exeBtn, blueDisc, qishuReady,
            lastContactAt: last ? last.t : 0,
            lastContactKind: last ? last.kind : "",
            lastHitAt, lastDropAt, lastOkAt,
            group: gname && g ? { name: gname, k: g.k, nextShare: lastShare } : null,
            contactChainLen: chainLen, contactChainPos: chainPos,
            special: offenseSpecial(now),
            defenseBusyUntil: guard ? now + 2 * FRAME_MS : 0,
            pEmpty: pE,
            q: offenseQ,
            allow: { set: false, charge: offenseCharge }, // the 整套 is interface-only in v1 (args.offenseSet logs it)
        });
        lastCand = d.action ? d.tier : 0;
        lastPE = pE;
        lastAtkTier = d.action ? d.tier : 0;
        lastAtkQ = d.action ? d.q : 0;
        lastAtkReason = OFF_REASON[d.reason] ?? 0;
        if (!d.action) return 0;
        // start gate: P(a contact inside commit + safety) from the head's tte. 0.25 is deliberately conservative: the
        // v2 A/B's hits clustered 0.25-1.5 s after a press. This is a probability veto, not the next.share prior.
        if (pWithin(atk2CommitF(d.action)) >= ATK2_HORIZON_P) {
            lastAtkTier = 0;
            lastAtkQ = 0;
            lastAtkReason = OFF_REASON.horizon ?? 0;
            return 0;
        }
        // M1 learned gate (v3 only): veto a rule action whose learned value P(damage >= 2 px) is below its threshold. It
        // never adds an action and never relaxes a v2 gate; execute (the stagger window, the main damage) is always let
        // through. The 2026-11-01 audit rejected the safety-hazard variant (no lift on pressed rows), @see
        // docs/dufu-offense-online.md 5.5.
        if (offenseGateOn && d.action !== "execute") {
            const gs = gateState(now);
            const score = policyValue(d.action, gs);
            lastGate = Math.round(score * 1000);
            const thr = offenseGateThr ?? (POLICY_VALUE_THRESHOLD[d.action] ?? 0);
            const ok = offenseGateThr != null ? score >= thr : policyAllow(d.action, gs);
            if (!ok) {
                atk2GateVeto(now, d.action, d.tier, d.q, score, thr);
                lastAtkTier = 0;
                lastAtkQ = 0;
                lastAtkReason = OFF_REASON.gate ?? 0;
                return 0;
            }
            gatePasses++;
        }
        if (d.switchFirst) return atk2StartSwitch(now, d);
        return atk2Do(now, d);
    }

    // The end checks are spread over the ticks (one part per tick, each part every DEAD_EVERY): the 成功 page
    // templates, the 再次训练 button, and the grey screen (an 880x500 scan, only while the bars are gone).
    let endPart = 0;
    /** @param {Image} im @param {number} now @returns {"dead" | "cleared" | null} */
    function endCheck(im, now) {
        const part = endPart++ % 3;
        if (part === 0) {
            const won = WON_T.map(([t, roi]) => match(t, { image: im, roi, threshold: WON_TH }).hit);
            const any = won[0] || won[1];
            if (any !== halt) {
                halt = any;
                if (halt) {
                    upsDue(true);
                    walk(0);
                }
                mark("halt", halt ? "成功 page: no touches" : "page gone");
            }
            wonSeen = won[0] && won[1] ? wonSeen + 1 : 0;
            if (wonSeen >= 2) return "cleared";
        } else if (part === 1 && !halt) {
            const btn = countAtLeast(RETRY_WHITE, RETRY_ROI, 800, im);
            deadSeen = btn && (bossNow <= 50 || countAtLeast(RETRY_WHITE, RETRY_ROI, 1600, im)) ? deadSeen + 1 : 0;
            if (deadSeen >= 2) return "dead";
        } else if (part === 2 && !halt) {
            const bars = bossNow > 50 || hpThis != null;
            greySeen = !bars && countAtLeast(GREY, GREY_ROI, Math.round(0.85 * GREY_ROI[2] * GREY_ROI[3]), im) ? greySeen + 1 : 0;
            if (greySeen >= 6) return "dead";
        }
        if (bossSeen) {
            if (bossNow > 50) bossGoneAt = 0;
            else if (!bossGoneAt) bossGoneAt = now;
            else if (now - bossGoneAt >= BOSS_GONE_MS) return "dead";
        }
        return null;
    }

    // phase 1 is over when the quest line reads 「…阶段二」 on two checks CLR_EVERY_MS apart (dufu.js clearedCheck; the
    // 阶段二 arena reads it all along, so phase 2 never asks)
    let clrAt = 0, clrPhase2 = 0;
    /** @param {Image} im */
    function phase2Quest(im) {
        /** @param {Box} roi */
        const n = (roi) => {
            const h = color({ ...QUEST_WHITE, image: im, roi, count: 1 });
            return h.hit ? h.results[0]?.count ?? 0 : 0;
        };
        return n(PHASE2_TOP) >= 8 && n(PHASE2_BOTTOM) >= 10 && n(PHASE1_MID) <= 2;
    }
    /** @param {Image} im @param {number} now */
    function clearedTick(im, now) {
        if (phase !== 1 || now - clrAt < CLR_EVERY_MS) return false;
        clrAt = now;
        clrPhase2 = phase2Quest(im) ? clrPhase2 + 1 : 0;
        return clrPhase2 >= 2;
    }

    let pairs = 0, pairErr = "";
    try {
        for (;;) {
            // wait for the tick (lifting due fingers meanwhile)
            const due = t0 + tick * FRAME_MS;
            for (let w = due - Date.now(); w > 0; w = due - Date.now()) {
                upsDue();
                sleep(Math.max(1, Math.min(4, Math.floor(w))));
            }
            const tA = Date.now();
            const img = screenshot();
            const tShot = Date.now() - tA;
            const cap = img.time - img.age_ms;
            const dup = img.seq === lastSeq ? 1 : 0;
            lastSeq = img.seq;
            dups += dup;
            upsDue();
            // bars -> contacts
            const tR = Date.now();
            const got = reads(img, cap);
            if (got) { // the last contact's prefix group: the head's prediction just before it was detected
                lastContactGid = pred != null && pred.grp < IDLE ? pred.grp : -1;
            }
            const now0 = Date.now();
            if (now0 - lastBossRead >= BOSS_EVERY) {
                lastBossRead = now0;
                bossNow = bossBar(img);
                bossFillNow = bossFill(img);
                bossDropTick(now0);
                if (bossNow > 50 && !bossSeen) {
                    bossSeen = true;
                    bossSeenAt = now0;
                    mark("boss", `bar after ${Math.round((now0 - t0) / 1000)} s`);
                }
            }
            tm.reads.push(Date.now() - tR);
            // ring entries: this tick + the missed ones
            const behind = Math.max(0, Math.floor((Date.now() - due) / FRAME_MS));
            const nFill = Math.min(behind, FILL_MAX);
            if (behind > FILL_MAX) {
                skipped += behind - FILL_MAX;
                tick += behind - FILL_MAX;
            }
            const tI = Date.now();
            let pipe = 0, prep = 0, run = 0;
            let lastH = [2, 2, 2, 0];
            const pairNow = pairEvery > 0 && ticks >= RING + 5 && looks % pairEvery === 0;
            /** @type {string[] | null} */ let views = null;
            for (let j = 0; j <= nFill; j++) {
                lastH = history(tick);
                const want = pairNow && j === nFill; // the last entry of this tick: the ring's newest
                const rs = append(img, lastH, tick === 0 || ticks === 0, want);
                if (want) views = rs.map((r) => b64(/** @type {number[][]} */ (r.input)[0]));
                if (j === 0) for (const r of rs) {
                    pipe += r.ms.total;
                    prep += r.ms.prep;
                    run += r.ms.run ?? 0;
                }
                tick++;
                ticks++;
            }
            fills += nFill;
            const h = infer(M_HEAD, HEAD_OPTS);
            noteProv("head", h);
            pipe += h.ms.total;
            prep += h.ms.prep;
            run += h.ms.run ?? 0;
            if (!pairNow) { // a pair tick returns the views (input: true): its cost is not the pipeline's
                tm.inferWall.push(Date.now() - tI);
                tm.head.push(h.ms.total);
                tm.shot.push(tShot);
                tm.pipe.push(pipe);
                tm.prep.push(prep);
                tm.run.push(run);
            }
            if (h.output) decode(h.output, cap);
            // pair check: screenshot + logits + the 30 ring entries
            if (pairNow && h.output) {
                try {
                    const png = saveImage(img, `captures/dufu2_live/${tag}_${String(tick - 1).padStart(5, "0")}.png`);
                    event(PAIR_EVENT, { start, tag, n: tick - 1, seq: img.seq, cap: cap - start, png, nFill, logits: f32b64([h.output]),
                                        ring: f32b64(jsRing.flatMap((e) => [e.g, e.b, e.s])), hist: jsRing.map((e) => e.h), views,
                                        len: jsRing.length, ringLen: h.ring?.len ?? null, ringSum: h.ring?.sum ?? null,
                                        provider: { ...ran } });
                    pairs++;
                } catch (e) {
                    pairErr = String(e);
                }
            }
            // decisions
            const now = Date.now();
            let act = 0, wouldAct = 0;
            if (armed.parry != null && now > armed.parry + GRACE_F * FRAME_MS) armed.parry = null;
            if (armed.dodge != null && now > armed.dodge + GRACE_F * FRAME_MS) armed.dodge = null;
            if (got) armed.parry = armed.dodge = null; // the contact came: the next prediction is a new one
            if (curPred()?.grp === C11_GID) lastC11At = now;
            if (defend) act = runTick(now);
            // one defense decision per tick: the v2 preempt reuses it instead of calling decide() again
            const d = decide(now);
            // 进攻 v2: the 2 s results of earlier actions, then a pending switch / held charge lets go at once
            if (offenseOn) { atk2Land(now); atk2Preempt(now, d != null); }
            // a charge in progress lets go before a defense press (the old skill's offYield: a held finger restarts it)
            if (atkHold && pred && (pred.med <= 35 || pWithin(25) >= 0.15
                || pred.col[0] >= goldDodgeP)) atkRelease("defense");
            if (d && !canPress(d, now)) {
                wouldAct = ACT[d.kind];
                if (defend) act = press(d, now) || act;
                else {
                    would[d.kind]++;
                    armed[d.kind] = d.Tc; // the shadow keeps the same one-press-per-contact bookkeeping
                    if (d.kind === "parry") lastParryAt = now;
                    else lastDodgeAt = now;
                    const p = curPred();
                    pressLog.push([now - start, `would-${d.kind}`, p?.grp, r3(p?.col[0] ?? 0), r3(p?.resp[0] ?? 0), r3(p?.resp[1] ?? 0), p?.med, Math.round(d.remF * 10) / 10, d.lead, d.src]);
                }
            }
            if (defend && !act) act = goldBeatTick(now);
            if (defend && !act) act = chainTick(now);
            if (defend && !act) act = potionTick(now, img);
            if (defend && !act) act = offenseOn ? atk2Tick(now, img, d != null) : atkTick(now, img);
            // 幕布 (phase 1): the gap walk runs even when a key went this tick; the covered fallback only when none did
            if (curtainOn) {
                const c = curtainTick(img, now, act !== 0);
                if (!act) act = c;
            }
            // walk in / re-lock (defend)
            if (walkIn && !bossSeen) {
                const on = now - t0 < APPROACH_MS && (now - t0) % APPROACH_CYCLE < APPROACH_ON;
                if (on && !stickF) presses.walk++;
                if (on !== !!stickF) walk(on ? 1 : 0);
                if (on && !act) act = ACT.walk;
            } else if (stickF) walk(0);
            if (defend && now - lastLockRead >= LOCK_EVERY) {
                lastLockRead = now;
                const lit = color({ ...GOLD_ICON, image: img, roi: LOCK_ROI, count: 150 }).hit;
                if (lit !== lockLit) {
                    lockLit = lit;
                    mark("lock", lit ? "icon lit" : "icon dark");
                }
                if (!lit && bossSeen && now - lastLockTap >= LOCK_MS && !act && !ups.some((u) => u.c === 1)) {
                    lastLockTap = now;
                    if (tap(LOCK)) {
                        presses.lock++;
                        act = ACT.lock;
                    }
                }
            }
            // end of the round
            if (now - lastDeadCheck >= DEAD_EVERY) {
                lastDeadCheck = now;
                const over = endCheck(img, now);
                if (over) {
                    reason = over;
                    mark(over, "");
                }
            }
            if (reason === "time" && phase === 1 && clearedTick(img, now)) {
                reason = "cleared";
                mark("cleared", "阶段二 in the quest line");
            }
            const loopMs = Date.now() - tA;
            if (!pairNow) tm.loop.push(loopMs);
            looks++;
            if (traceOn) {
                const p = curPred();
                if (offenseOn) { // the prefix-chain view (even on a tick another module took)
                    const ch = chainNow();
                    chainLen = ch.len;
                    chainPos = ch.pos;
                    lastShare = lastContactGid >= 0 ? (NEXT_SHARE[phase]?.[lastContactGid] ?? null) : null;
                }
                // range is the near gate proxy (ok / boss drop within 1.5 s), not a distance read; execute may act at 0
                const nearGate = offenseOn ? nearNow({ now, lastOkAt, lastDropAt }) : false;
                rows.push([tA - start, img.seq, cap - start, tick - 1, nFill, dup, hpNow == null ? -1 : r3(hpNow), qiNow, bossNow,
                    ...lastH, p ? p.grp : -1, p ? r3(p.grpP) : 0, ...(p ? p.col.map(r3) : [0, 0, 0]), ...(p ? p.resp.map(r3) : [0, 0, 0]),
                    p ? p.med : -1, r3(pWithin(10)), act, wouldAct, got, Math.round(pipe * 10) / 10, loopMs,
                    p ? r3(p.c7P) : 0, running ? running.sign * (1 + Object.keys(RUN_DIRS).indexOf(running.dir)) : 0,
                    chainPos, chainLen, lastShare == null ? -1 : r3(lastShare), WEAPON_CODE[weapon] ?? 0,
                    lastAtkTier, r3(lastAtkQ), lastAtkReason, bossFillNow, lockLit ? 1 : 0, nearGate ? 1 : 0,
                    exeBtn ? 1 : 0, blueDisc ? 1 : 0, qishuReady ? 1 : 0,
                    lastPE ? r3(lastPE[42] ?? 0) : 0, lastPE ? r3(lastPE[61] ?? 0) : 0, lastPE ? r3(lastPE[70] ?? 0) : 0,
                    lastCand, lastGate, lastHitAt ? Math.min(300, Math.round((now - lastHitAt) / FRAME_MS)) : -1,
                    offenseArg === "v3" ? 3 : offenseOn ? 2 : 0, offenseOn ? 1000 : 0]);
                traceN++;
                if (rows.length >= TRACE_CHUNK) traceFlush();
            }
            if (reason !== "time" || Date.now() >= until) break;
        }
    } finally {
        try {
            upsDue(true);
            running = null;
            if (walkIn) {
                touch.up(0);
                touch.up(1);
                touch.up(2);
            }
            touch.up(3);
        } catch (_) { /* stopped */ }
        try {
            traceFlush();
        } catch (_) { /* stopped: the last chunk is lost */ }
    }
    const fightMs = Date.now() - t0;
    if (offenseOn) atk2Land(Date.now()); // the last actions' 2 s window is the round's end
    const ms = Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, stats(v)]));
    const offPresses = atk2Count.execute + atk2Count.qishu + atk2Count.light + atk2Count.follow + atk2Count.charge;
    const res = {
        reason, mode, phase, provider, model: mdir, ran, fallback: fellBack, nn: { available: nn.available, qnn: nn.qnn, soc: nn.soc?.model }, warmMs,
        fightMs, ticks, looks, fills, skipped, dups, bossSeen,
        hits, oks, contacts: contacts.map((c) => [Math.round(c.t - start), c.f, c.kind, c.seenF]),
        presses, would, potion: { used: potionsUsed, taps: potionTaps, ...potS },
        run: runOn ? { dirs: runDirs, runs: runLog } : null,
        goldSeq: goldSeqOn ? goldSeqLog : null,
        chain: chainOn ? chainLog : null,
        curtain2: curtain2On ? { presses: curtain2Log.length, log: curtain2Log } : null,
        curtain: curtainOn ? { gap: curtainGap, enters: curtainEnters, dodges: curtainDodges } : null,
        attack: attackOn ? { presses: presses.attack, execs: atkExecs, log: atkLog, weapon } : null,
        offense: offenseOn ? {
            engine: offenseGateOn ? "v3" : "v2", policy: offenseGateOn ? POLICY_VERSION : null,
            gate: offenseGateOn ? { vetoes: gateVetoes, passes: gatePasses,
                threshold: offenseGateThr ?? POLICY_VALUE_THRESHOLD, override: offenseGateThr } : null,
            presses: offPresses, switches: atk2Count.switches,
            actions: { execute: atk2Count.execute, qishu: atk2Count.qishu, light: atk2Count.light,
                follow: atk2Count.follow, set: atk2Count.set, charge: atk2Count.charge },
            cancels: atk2Cancel, qAvg: atk2QN ? r3(atk2QSum / atk2QN) : null,
            pending: atk2Pend.length, log: atk2Log, lastWeapon: weapon,
            allow: { set: false, charge: offenseCharge }, setRequested: offenseSet, reasonNames: OFF_REASON_NAMES,
            q: offenseQ,
            traceCols: TRACE_COLS.slice(-21),
            traceNote: "bossPx = the offense boss read (lib bossFill: widest red row of the tall ROI); the legacy boss column is bossBar (6-row count). range = the near gate proxy (0/1: ok or boss-bar drop within 1.5 s), not a real distance; execute may act at 0",
        } : null,
        hitsPerMin: fightMs > 0 ? Math.round((hits / (fightMs / 60_000)) * 100) / 100 : 0,
        ms, start, t0, marks, pressLog,
        trace: { event: TRACE_EVENT, rows: traceN, chunks: traceChunks, cols: TRACE_COLS },
        pair: pairEvery ? { event: PAIR_EVENT, n: pairs, err: pairErr } : null,
    };
    log(`dufu2 over (${reason}) ${mode} ${JSON.stringify(ran)}: ${Math.round(fightMs / 1000)} s, ${ticks} ticks (${fills} fills, ${skipped} skipped, ${dups} dup), hits ${hits}, oks ${oks}, presses ${JSON.stringify(presses)}, would ${JSON.stringify(would)}, pipe ${JSON.stringify(ms.pipe)}, loop ${JSON.stringify(ms.loop)}`);
    return res;
}
