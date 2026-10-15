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
/** @typedef {{kind: "parry"|"dodge"|"potion"|"avoid", dir: string, k: number, src: "fut"|"tell"|"potion"|"combo"|"insure", atMs: number, cMs: number, untilMs: number, branch: boolean, t1Ms: number, pressedAt: number, committed: boolean, why: string, held?: boolean, repressed?: boolean}} PlanItem */

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
 *   closeIn?: boolean, qiAttack?: boolean, qiExecWait?: number, execThreshold?: number}} [args]
 *   observe: inference + logging only, no touches; ms: run length (default 300 s); potions: drinks allowed (0 = off);
 *   model / backModel: the frozen pair (default v2; pass the v1 names to go back); parry / dodgePoint / potionPoint:
 *   the buttons; dodgeDir: back | side | cycle | forward | backleft (the way dodges go); targetGlowLead /
 *   latencyFrames: the press lead; dodgeLead: tell dodge lead in frames per kind (grab/slam/other/sweep);
 *   staggerHold / presched: the v5 scheduler switches (@see HOLD_MIN_LEAD / COMBO_GAPS; both default off);
 *   comboV6: the v6 pair's combo slot is the gap-to-next-segment bins (presched/preschedN switch semantics);
 *   keepPlanOnHit / posthit / posthitNarrow: the v6 second-segment lifecycle switches (all default off).
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
        if (bi === 2) return (p[2] ?? 0) >= dodgeMinP ? /** @type {"dodge"} */ ("dodge") : /** @type {"parry"} */ ("parry");
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
            if (it.src === "fut" && !it.committed && !it.pressedAt) {
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
                main0.atMs = main0.cMs - issueLead;
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
                main0.cMs = main0.atMs + issueLead;
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
            addItem({ kind: t.kind, k, src: "fut", cMs: t.cMs, atMs: t.cMs - issueLead, untilMs: t.cMs + missGraceMs, why: `pred k${k}${t.covers ? " covers both" : ""}` });
        } else if (!main.committed && !main.pressedAt) {
            if (Math.abs(t.cMs - main.cMs) > REVISE_MOVE_MS || t.kind !== main.kind) {
                revisions++;
                mark("revise", `k${k} ${main.kind}->${t.kind} c ${Math.round(main.cMs - now)}->${Math.round(t.cMs - now)} ms`);
                main.kind = t.kind;
            }
            main.cMs = t.cMs;
            main.atMs = t.cMs - issueLead;
            main.untilMs = t.cMs + missGraceMs;
        } else if (repress && main.pressedAt && !main.repressed && t.cMs - main.cMs > REVISE_MOVE_MS
                   && t.cMs - main.pressedAt >= repressGapMs && t.cMs - now >= LATE_FRAMES * FRAME_MS
                   && now - main.pressedAt >= parryCd) {
            // v7 A3: the contact moved later after the press (long wind-up): re-arm once and press again at its window
            const moved = t.cMs - main.cMs;
            main.repressed = true;
            main.pressedAt = 0;
            main.cMs = t.cMs;
            main.atMs = t.cMs - issueLead;
            main.untilMs = t.cMs + missGraceMs;
            rerepresses++;
            mark("re-press", `k${k} ${main.kind} contact moved +${Math.round(moved / FRAME_MS)}f`);
        }
        if (t.branchMs) {
            if (!br) addItem({ kind: t.kind, k, src: "fut", branch: true, cMs: t.branchMs, atMs: t.branchMs - issueLead, untilMs: t.branchMs + missGraceMs, t1Ms: t.cMs, why: "branch (bimodal)" });
            else if (!br.pressedAt) {
                br.cMs = t.branchMs;
                br.atMs = t.branchMs - issueLead;
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
            if (now - flareLastFireAt > 20 * FRAME_MS || t.arg !== flareLastArg) flareFirstAt = now;
            flareLastFireAt = now;
            flareLastArg = t.arg;
        }
        // v7 A2 fallback 2 (per-frame): the tell head's dark class fires at the curtain's black cover onset
        // (233-252: 77/82 dark streaks p>=0.7 (>=2 f) sit at a real episode; 46/54 episodes covered). Sampling a
        // 400 ms slow task would miss the short covers, so it lives here, in the per-frame tell path.
        if (t.arg === 6 && t.p >= 0.7) {
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
        const anchored = tellAnchor && t.arg >= 1 && t.arg <= 3;
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
            // v7 A1: press at the episode onset + anchor frames (the appearance lands ~5 f later); the head's first
            // fire is the image onset +-3 f (tells head vs flares_ds onsets, 233-252: p50 0 / p90 +3)
            at = flareFirstAt + (ANCHOR_FRAMES[label] ?? 4) * FRAME_MS;
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
        addItem({ kind: "dodge", dir: nextDir(), k: -1, src: "tell", cMs: c1, atMs: at, untilMs: Math.max(c1, at) + missGraceMs, why: `tell ${label}${anchored ? " anchor" : ""} p${Math.round(t.p * 100)}` });
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
            mark("press", `parry${observe ? " sim" : ""} k${it.k} ${it.src} c+${Math.round((it.cMs - lastParryAt) / FRAME_MS)}f ${it.why}`);
        } else if (it.kind === "dodge") {
            pressDodge(it.dir);
            pressFrame(frameIdx);
            presses.dodge++;
            it.pressedAt = Date.now();
            mark("press", `dodge${observe ? " sim" : ""} ${it.dir} k${it.k} ${it.src} c+${Math.round((it.cMs - it.pressedAt) / FRAME_MS)}f ${it.why}`);
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
        if (it.kind === "dodge" && now - lastDodgeAt < dodgeCd) return "dodge cd";
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
                        it.atMs = it.cMs - issueLead;
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
            addItem({ kind, k: 0, src: "combo", cMs: c, atMs: c - issueLead, untilMs: c + missGraceMs, committed: true,
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
            addItem({ kind, k: i, src: "combo", cMs: c, atMs: c - issueLead, untilMs: c + missGraceMs, committed: true, why: `template T${pred.combo.arg - 1} seg${st + i}` });
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
                if (!curtainDodged && now - curtainDodgeAt > CURTAIN_DODGE_GAP_MS && now - lastDodgeAt > dodgeCd) {
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
            if (now - curtainDodgeAt > CURTAIN_DODGE_GAP_MS && now - lastDodgeAt > dodgeCd) {
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
        if (!curtainDodged && now - curtainFirstAt >= CURTAIN_FIRST_DODGE_MS && !inGap) {
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
        mark("flare", "gold + streak");
        if (!flareDodge || inCurtain) return;
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
        { name: "weak", every: 100, at: 0, active: () => qiAttack, run: slowWeak },
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
                executePlan(now2);
                expire(now2);
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
        }
    }
    const backS = stats(tMs.back), headS = stats(tMs.head), readS = stats(tMs.reads), loopS = stats(tMs.loop);
    const readyPct = headCalls ? Math.round((ready / headCalls) * 1000) / 10 : 0;
    log(`dufu over (${reason}): ${looks} looks, head ${ready}/${headCalls} ready (${readyPct}%), ${presses.parry} parry / ${presses.dodge} dodge / ${presses.potion} potion / ${presses.walk} walk, lock ${lockTaps} taps, ` +
        `${hits} hits, ${oks} ok, ${misses} misses, ${revisions} revisions, ${late} late, branches ${branches} (${branchDrops} dropped), holds ${holds} (${holdPresses} pressed), posthit ${insurePresses}, re-press ${rerepresses}, weak ${weakWindows} (${weakLights} light, ${weakExecs} exec), blocked ${JSON.stringify(blocked)}, skipped ${JSON.stringify(skips)}`);
    log(`ms: back ${JSON.stringify(backS)}, head ${JSON.stringify(headS)}, reads ${JSON.stringify(readS)}, loop ${JSON.stringify(loopS)}`);
    return {
        reason, observe, looks, ready, headCalls, readyPct,
        presses, blocked, late, misses, hits, oks, revisions, branches, branchDrops, skips, holds, holdPresses, insurePresses,
        rerepresses, weakWindows, weakLights, weakExecs,
        ms: { back: backS, head: headS, reads: readS, loop: loopS },
        start, events,
    };
}
