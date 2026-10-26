// 独夫 阶段二 with the move-ID student (docs/dufu-moveid-plan.md, model/dufu2/dufu2.json). Independent of dufu.js
// (only lib/dufu-reads.js's bar reads and lib/stats.js are shared).
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
// provider (args.provider): "qnn" (default; falls back to cpu without the plugin: the result's `provider` says what
//   ran) or "cpu". phase: 2 only (阶段二 arena: no poison, no curtain, the quest line is not an end).
// Trace: one row per tick (TRACE_COLS), event TRACE_EVENT in chunks of TRACE_CHUNK rows (~25 KB each); run
//   skills/event_pad.js after fetching them (tools/dufu_rounds.py does). args.pair N (shadow checks): every N-th
//   tick the screenshot is saved (captures/dufu2_live/<tag>_<n>.png) and event PAIR_EVENT carries the head logits and
//   the 30 ring entries (float32 base64) for the PC recomputation (tools/dufu_moveid/s5_pair.py).
//   maalow do skill dufu2 --args '{"mode":"shadow","ms":300000}'
//   maalow do skill dufu2 --args '{"mode":"defend","provider":"qnn","ms":600000}' --timeout 660000
//   (defaults since 2026-10-25 关 2: model dufu2b, 闪避 lead 5, run diag from the 火球雨, the 金光火球 window; the A/B
//   switches: run, runDir, goldSeq, model, dodgeLead, chain (default off), tools/dufu_moveid/README.md「顺序 5 续」)
import { stats } from "./lib/stats.js";
import { BOSS_RED, BOSS_ROI, countAtLeast, health, readQi } from "./lib/dufu-reads.js";
import { DEFAULTS, GROUPS } from "./lib/dufu2-table.js";

/** @type {SkillMeta} */
export const meta = { description: "独夫 阶段二 with the dufu2 move-ID student: shadow (look only) / defend (卸势 / 闪避 / potion)", timeout: 660_000 };

const FRAME_MS = 1000 / 30;
/** @type {Box} */ const BIG = [290, 55, 530, 530];
/** @type {Box} */ const SMALL = [425, 190, 260, 260];
const RING = 30, G_DIM = 128, C_DIM = 96;
const NG = 88, IDLE = 87, O_COL = 88, O_RESP = 91, O_TTE = 94, N_TTE = 47, TTE_NONE = 46;
const FILL_MAX = 3;
// contact history (s3b_train.history)
const HIST_DELAY_F = 6, HIST_GAP_F = 73;
// contacts (dufu_train/labels.py)
const HIT_DROP = 0.025, HIT_MAX = 0.35, HIT_LAG_F = 5, QI_STEP = 8, QI_JUMP = 80, OK_PARRY_MAX_F = 24, MERGE_F = 6;
// decisions (@see decide)
const GOLD_DODGE_P = 0.15; // P(gold) at or above this: dodge (gold must be dodged; "colour unsure" = gold not ruled out)
const CONTACT_P = 0.4; // 1 - P(resp none) below this: no press
const LATE_F = 1; // a contact predicted this far in the past still gets its press
const GRACE_F = 6, REARM_F = 8; // a pressed contact is consumed GRACE_F after it; a prediction REARM_F later is a new one
const PARRY_LOCK_MS = 330, PARRY_CD_MS = 220, DODGE_CD_MS = 500; // the game's 卸势 lock / our cooldowns
const TAP_MS = 50;
const DODGE_LEAD = 5; // 闪避 lead (frames) for every dodge unless args.dodgeLead (null = the move table's dodge_lead)
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
const TRACE_COLS = ["wall", "seq", "cap", "n", "fill", "dup", "hp", "qi", "boss", "h0", "h1", "h2", "h3",
    "grp", "grpP", "gold", "red", "none", "dodge", "parry", "rnone", "med", "p10", "act", "would", "contact", "pipe", "loop",
    "c7P", "run"];
const ACT = { parry: 1, dodge: 2, potion: 3, lock: 4, walk: 5, run: 6 };
const GRP_NAMES = Object.keys(GROUPS); // gid order (the head's grp labels 0..86; 87 = idle)
/** the 火球雨 volley groups: c7 alone at its prefix position and unparryable in the table (k0..k4:c7; the later c7
 *  positions are the boss's next moves, parryable) */
const C11_GID = GRP_NAMES.indexOf("k0:c11+c40");
const C30_K2_GID = GRP_NAMES.indexOf("k2:c30");
const C7_GIDS = GRP_NAMES.map((n, i) => (/^k\d+:c7$/.test(n) && GROUPS[n].unparryable ? i : -1)).filter((i) => i >= 0);

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
 * @param {{mode?: "shadow" | "defend", provider?: "qnn" | "cpu", phase?: number, ms?: number, potions?: number,
 *          trace?: boolean, pair?: number, tag?: string, approach?: boolean, dodgeLead?: number | null,
 *          run?: boolean, runDir?: "side" | "diag" | "back" | ("side" | "diag" | "back")[], goldSeq?: boolean, model?: string, chain?: boolean}} [args]
 */
export default function (args = {}) {
    const mode = args.mode ?? "shadow";
    if (mode !== "shadow" && mode !== "defend") throw new Error(`mode ${mode}: shadow | defend`);
    if ((args.phase ?? 2) !== 2) throw new Error("dufu2 is the 阶段二 model: phase 2 only");
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
    // (default 5: the best of 14 / 8 / 5 in r007-r023; null = the table's)
    const dodgeLead = args.dodgeLead === null ? null : typeof args.dodgeLead === "number" ? args.dodgeLead : DODGE_LEAD;
    // args.run: run from the 火球雨 (default on, @see runTick); args.runDir: one direction or a list cycled per run
    // (default diag: r036-r071 side 1.58 hits per 火球雨 episode (24), diag 0.64 (14))
    const runOn = defend && (args.run ?? true);
    const runDirs = [args.runDir ?? "diag"].flat();
    // args.goldSeq: the 金光火球 window (default on, @see GOLD_SEQ_F)
    const goldSeqOn = args.goldSeq ?? true;
    // args.chain: the k2:c30 chain beat (@see CHAIN_AFTER_F)
    const chainOn = args.chain ?? false;
    for (const d of runDirs) if (!(d in RUN_DIRS)) throw new Error(`runDir ${d}: ${Object.keys(RUN_DIRS).join(" | ")}`);
    const tag = args.tag ?? String(Date.now());
    // args.model: the model directory under model/ (default dufu2b = the student fine-tuned on the live rounds,
    // tools/dufu_moveid/s5_retrain.py; dufu2 = the order-4 student), same inputs / outputs / group labels
    const mdir = args.model ?? "dufu2b";
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
    let stickF = 0;
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
            freeContact(0);
            touch.down(STICK, 0);
            touch.move([STICK[0], Math.round(STICK[1] - STICK_R * v)], 0);
        } else touch.up(0);
        stickF = v;
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

    // ---- trace
    /** @type {number[][]} */
    let rows = [];
    let traceN = 0, traceChunks = 0;
    const traceFlush = () => {
        if (!traceOn || !rows.length) return;
        event(TRACE_EVENT, { start, tag, chunk: traceChunks++, cols: TRACE_COLS, rows });
        rows = [];
    };

    // ---- defend prep: the potion in the item slot (dufu.js prep, phase 2: no poison, no buffs)
    if (defend && !match(SLOT_POTION_T, { image: screenshot(), roi: SLOT_ROI, threshold: 0.75 }).hit) {
        for (let i = 0; i < 3; i++) {
            tap(ITEM_OPEN);
            sleep(600);
            upsDue(true);
            const b = match(SLOT_POTION_T, { image: screenshot(), roi: COLUMN_ROI, threshold: 0.8 }).box;
            tap(b ? [Math.round(b[0] + b[2] / 2), Math.round(b[1] + b[3] / 2)] : ITEM_PICK);
            sleep(600);
            upsDue(true);
            if (match(SLOT_POTION_T, { image: screenshot(), roi: SLOT_ROI, threshold: 0.75 }).hit) break;
            mark("prep", `potion not in the slot (try ${i + 1})`);
        }
    }

    // ---- state
    const t0 = Date.now();
    let tick = 0;
    /** @type {{t: number, f: number, kind: "hit" | "ok", seenF: number}[]} */
    const contacts = [];
    let hpBase = /** @type {number | null} */ (null), hpNow = /** @type {number | null} */ (null), hpThis = /** @type {number | null} */ (null);
    let qiNow = -1, bossNow = 0, bossSeen = false, bossGoneAt = 0;
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
    const presses = { parry: 0, dodge: 0, potion: 0, lock: 0, walk: 0, run: 0 };
    const would = { parry: 0, dodge: 0 };
    /** @type {any[]} */
    const pressLog = []; // [t ms, kind, grp, pGold, pDodge, pParry, med, remF, lead, src]
    /** @type {{shot: number[], pipe: number[], prep: number[], run: number[], inferWall: number[], reads: number[], loop: number[], head: number[]}} */
    const tm = { shot: [], pipe: [], prep: [], run: [], inferWall: [], reads: [], loop: [], head: [] };
    // potion
    let potionsUsed = 0, potionTaps = 0, potionDueAt = 0, lastPotionFailAt = 0, lastPotionOkAt = 0, holdUntil = 0;
    /** @type {{at: number, hp0: number} | null} */ let potionPend = null;
    const potS = { oks: 0, fails: 0, waitWhy: /** @type {Record<string, number>} */ ({}) };
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
     * @param {number} now @returns {{kind: "parry" | "dodge", Tc: number, remF: number, lead: number, src: string} | null}
     */
    function decide(now) {
        if (!pred || pred.med >= TTE_NONE) return null;
        const [pd, pp, pn] = pred.resp;
        if (1 - pn < CONTACT_P) return null;
        const Tc = pred.capT + pred.med * FRAME_MS;
        const remF = (Tc - now) / FRAME_MS;
        const name = pred.grp < IDLE ? GRP_NAMES[pred.grp] : null;
        const row = name ? GROUPS[name] : null;
        const gold = pred.col[0] >= GOLD_DODGE_P;
        // the move table's unparryable groups (training: 卸住率 < 20 %; live: the closed loop's correction, e.g. the
        // 火球雨 c7 chain, 0 / 163 answered by 卸势 in r007-r023) are dodged whatever the resp head says
        const seq = inGoldSeq(Tc);
        const kind = gold || pd >= pp || row?.unparryable || seq ? "dodge" : "parry";
        const lead = kind === "parry" ? row?.parry_lead ?? DEFAULTS.parry_lead : dodgeLead ?? row?.dodge_lead ?? DEFAULTS.dodge_lead;
        if (remF > lead || remF < -LATE_F) return null;
        return { kind, Tc, remF, lead, src: gold ? "gold" : row?.unparryable && pp > pd ? "table" : seq && pp > pd ? "goldSeq" : "resp" };
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

    /** Potion at a quiet moment (defend). @param {number} now */
    function potionTick(now) {
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
        if (!tap(POTION)) return 0;
        potionTaps++;
        presses.potion++;
        potionPend = { at: now, hp0: hpNow };
        holdUntil = now + POTION_HOLD_MS;
        lastOwnAt = now;
        mark("potion", `tap at hp ${Math.round(hpNow * 100)}%${urgent ? " (urgent)" : ""}`);
        return ACT.potion;
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
            const now0 = Date.now();
            if (now0 - lastBossRead >= BOSS_EVERY) {
                lastBossRead = now0;
                bossNow = bossBar(img);
                if (bossNow > 50 && !bossSeen) {
                    bossSeen = true;
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
            const d = decide(now);
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
            if (defend && !act) act = potionTick(now);
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
            const loopMs = Date.now() - tA;
            if (!pairNow) tm.loop.push(loopMs);
            looks++;
            if (traceOn) {
                const p = curPred();
                rows.push([tA - start, img.seq, cap - start, tick - 1, nFill, dup, hpNow == null ? -1 : r3(hpNow), qiNow, bossNow,
                    ...lastH, p ? p.grp : -1, p ? r3(p.grpP) : 0, ...(p ? p.col.map(r3) : [0, 0, 0]), ...(p ? p.resp.map(r3) : [0, 0, 0]),
                    p ? p.med : -1, r3(pWithin(10)), act, wouldAct, got, Math.round(pipe * 10) / 10, loopMs,
                    p ? r3(p.c7P) : 0, running ? running.sign * (1 + Object.keys(RUN_DIRS).indexOf(running.dir)) : 0]);
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
        } catch (_) { /* stopped */ }
        try {
            traceFlush();
        } catch (_) { /* stopped: the last chunk is lost */ }
    }
    const fightMs = Date.now() - t0;
    const ms = Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, stats(v)]));
    const res = {
        reason, mode, provider, model: mdir, ran, fallback: fellBack, nn: { available: nn.available, qnn: nn.qnn, soc: nn.soc?.model }, warmMs,
        fightMs, ticks, looks, fills, skipped, dups, bossSeen,
        hits, oks, contacts: contacts.map((c) => [Math.round(c.t - start), c.f, c.kind, c.seenF]),
        presses, would, potion: { used: potionsUsed, taps: potionTaps, ...potS },
        run: runOn ? { dirs: runDirs, runs: runLog } : null,
        goldSeq: goldSeqOn ? goldSeqLog : null,
        chain: chainOn ? chainLog : null,
        hitsPerMin: fightMs > 0 ? Math.round((hits / (fightMs / 60_000)) * 100) / 100 : 0,
        ms, start, t0, marks, pressLog,
        trace: { event: TRACE_EVENT, rows: traceN, chunks: traceChunks, cols: TRACE_COLS },
        pair: pairEvery ? { event: PAIR_EVENT, n: pairs, err: pairErr } : null,
    };
    log(`dufu2 over (${reason}) ${mode} ${JSON.stringify(ran)}: ${Math.round(fightMs / 1000)} s, ${ticks} ticks (${fills} fills, ${skipped} skipped, ${dups} dup), hits ${hits}, oks ${oks}, presses ${JSON.stringify(presses)}, would ${JSON.stringify(would)}, pipe ${JSON.stringify(ms.pipe)}, loop ${JSON.stringify(ms.loop)}`);
    return res;
}
