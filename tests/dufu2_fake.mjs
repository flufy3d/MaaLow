// Deterministic fake world for dufu2.js: clock, input recorder, screen reads and head logits.
// No model, no screenshot, no device. The head output is built from the scenario's `head(t)` (t = ms since the
// fight's t0) with the phase's real slice sizes (p1 98 groups + 3 col + 3 resp + 47 tte = 151, p2 88 + 3 + 3 + 47).
export const epoch = 1_800_000_000_000;
export const frameMs = 1000 / 30;
export const T0 = { 1: 7400, 2: 0 }; // the phase-1 prep's taps/sleeps (A/B: the same in the old module)
/** the skill's buttons (dufu2.js / dufu.js) */
export const POINTS = {
    PARRY: [952, 495], DODGE: [924, 674], POTION: [700, 690], STICK: [175, 569], LEFT: [92, 569], RIGHT: [258, 569],
    LOCK: [1021, 667], ITEM_OPEN: [700, 633], ITEM_PICK: [702, 575], SLOT_ICON: [700, 666],
};


/** One-hot-ish head logits for the phase. col: 0 gold / 1 red / 2 none; resp: 0 dodge / 1 parry / 2 none. */
export function headLogits(phase, { gid, med = 46, col = 2, resp = 1 } = {}) {
    const NG = phase === 1 ? 98 : 88;
    const oCol = NG, oResp = NG + 3, oTte = NG + 6;
    const out = new Array(NG + 6 + 47).fill(-20);
    out[gid] = 20;
    out[oCol + col] = 20;
    out[oResp + resp] = 20;
    out[oTte + Math.max(0, Math.min(46, med))] = 20;
    return out;
}

/** A head that names `gid` from 12 frames before each contact until 2 frames after; none otherwise. */
export function timeline({ phase, gid, col = 2, resp = 1, contacts = [], from = 12, to = 2 }) {
    const idle = phase === 1 ? 97 : 87;
    return (t) => {
        for (const c of contacts) {
            const d = c - t;
            if (d >= -to * frameMs && d <= from * frameMs) {
                return { gid, col, resp, med: Math.round(d / frameMs) };
            }
        }
        return { gid: idle, med: 46, col: 2, resp: 2 };
    };
}

/**
 * Run the skill against the fake world. scenario:
 *   head(t) -> {gid, med, col, resp}; hp(t) -> ratio | {grey, red}; qi(t) -> px; boss(t) -> px;
 *   lock(t) -> bool; mean(t) -> 0..255; curtain(t) -> [a, b] | "covered" | null; slot(t) -> bool | undefined;
 *   match(tpl, t) -> bool (extra templates); onTap(p) hook.
 * Returns {result, touches, sent, marks, t0}.
 */
export function runFake(dufu, args = {}, scenario = {}) {
    const phase = args.phase ?? 2;
    // phase-1 defend prep runs before the fight's t0; shadow has no prep
    const t0Fight = (args.mode ?? "shadow") === "defend" ? T0[phase] : 0;
    let time = 0;
    let slot = true; // the quick slot: potion (true) / the other item (false)
    let stick = [...POINTS.STICK];
    const touches = [];
    const sent = [];
    const marks = [];
    const calls = []; // [{kind, len}] in infer order

    Date.now = () => epoch + time;
    globalThis.sleep = (ms) => { time += ms; };
    globalThis.remaining = () => 3_600_000;
    globalThis.log = (msg) => { marks.push(msg); };
    globalThis.event = (name, data) => { sent.push({ name, data: JSON.parse(JSON.stringify(data)) }); };
    globalThis.saveImage = () => "captures/fake.png";
    globalThis.nnProviders = () => ({ available: true, qnn: true, soc: { model: "fake" } });
    globalThis.screenshot = () => ({ seq: Math.floor(time / frameMs), time: epoch + time, age_ms: 0, width: 1080, height: 720 });

    const rt = () => time - t0Fight; // scenario callbacks see the fight clock (prep is negative)
    const slotAt = scenario.slot ?? (() => undefined);
    const slotNow = () => {
        const forced = slotAt(rt());
        if (forced !== undefined) slot = forced;
        return slot;
    };
    const miss = () => ({ hit: false, results: [] });
    const hitBox = (box, count) => ({ hit: true, results: [{ box, count }] });

    globalThis.match = (template, opts = {}) => {
        const roi = opts.roi;
        const tpls = Array.isArray(template) ? template : [template];
        const potion = tpls[0].startsWith("combat/potion_");
        const poison = tpls[0].startsWith("combat/poison");
        if (potion) {
            if (roi && roi[0] === 670) return { hit: slotNow(), box: null };
            return { hit: false, box: null };
        }
        if (poison) {
            if (roi && roi[0] === 670) return { hit: !slotNow(), box: null };
            return { hit: false, box: null };
        }
        return { hit: !!(scenario.match && scenario.match(template, rt())), box: null };
    };

    globalThis.touch = {
        down(p, id) {
            if (id === 0) stick = p;
            if (p[0] === POINTS.ITEM_PICK[0] && p[1] === POINTS.ITEM_PICK[1]) slot = !slot;
            scenario.onTap?.(p, rt());
            touches.push({ op: "down", p, id, at: time, stick: [...stick] });
        },
        move(p, id) {
            if (id === 0) stick = p;
            touches.push({ op: "move", p, id, at: time, stick: [...stick] });
        },
        up(id) { touches.push({ op: "up", id, at: time }); },
    };

    globalThis.color = (opts) => {
        const { roi: [x, y, w, h], lower, upper } = opts;
        // our health bar (grey is numeric HSV, red is the two-range mask)
        if (x === 405 && y === 681) {
            const v = scenario.hp ? scenario.hp(rt()) : 1;
            const red = Array.isArray(lower[0]);
            const ratio = typeof v === "number" ? v : red ? v.red : v.grey;
            if (ratio == null) return miss();
            const px = Math.round(ratio * 254);
            return px < 4 ? miss() : hitBox([415, 681, px, 5], 999);
        }
        // boss 真气 line
        if (x === 347 && y === 35) {
            const q = scenario.qi ? scenario.qi(rt()) : 300;
            return q == null || q < 1 ? miss() : hitBox([347, 35, q, 6], 999);
        }
        // boss hp bar (bossBar counts red px / 6)
        if (x === 347 && y === 27) {
            const b = scenario.boss ? scenario.boss(rt()) : 300;
            return b < 1 ? miss() : { hit: true, results: [{ box: [347, 27, Math.round(b), 6], count: b * 6 }] };
        }
        // lock icon
        if (x === 1004 && y === 648) {
            return (scenario.lock ? scenario.lock(rt()) : true) ? hitBox([1004, 648, 34, 39], 999) : miss();
        }
        // readMean strips (3 x 8 rows, three V thresholds)
        if (x === 0 && w === 1080 && h === 8 && (y === 140 || y === 300 || y === 460)) {
            const bright = scenario.mean ? scenario.mean(rt()) : 160;
            const frac = Math.max(0, Math.min(1, (bright - 32) / 192));
            return { hit: true, results: [{ box: [0, y, 1080, 8], count: Math.round(frac * 1080 * 8) }] };
        }
        // 幕布 panels: dark components in CURTAIN_ROI
        if (x === 0 && y === 80 && w === 1080 && h === 150) {
            const c = scenario.curtain ? scenario.curtain(rt()) : null;
            if (c == null) return miss();
            const panels = typeof c === "string" ? [[0, 1080]] : [[0, c[0]], [c[1], 1080]];
            return {
                hit: true,
                results: panels.filter(([, b]) => b > 0).map(([a, b]) => ({ box: [a, 80, b - a, 150], count: Math.round(0.6 * (b - a) * 150) })),
            };
        }
        // 幕布 orange edges: one long thin box per boundary inside this strip
        if (y === 60 && h === 500) {
            const c = scenario.curtain ? scenario.curtain(rt()) : null;
            if (c == null) return miss();
            const xs = typeof c === "string" ? [0] : [c[0], c[1]];
            return {
                hit: true,
                results: xs
                    .map((v) => [v - 10, 60, 20, 500])
                    .filter(([bx]) => bx + 20 > x && bx < x + w)
                    .map((box) => ({ box, count: 2000 })),
            };
        }
        // phase 1 quest line (阶段二 / 一)
        if (x === 222 && y === 140) return (scenario.quest2 ? hitBox([222, 140, 12, 4], 12) : miss());
        if (x === 220 && y === 147) return (scenario.quest2 ? hitBox([220, 147, 16, 4], 16) : miss());
        if (x === 220 && y === 144) return (scenario.quest2 ? miss() : hitBox([220, 144, 16, 3], 0));
        // grey screen / 再次训练 are never up here
        if (x === 100 && y === 100 && w === 880 && h === 500) return miss();
        if (x === 945 && y === 668) return miss();
        return miss();
    };

    globalThis.infer = (model) => {
        const ms = { total: 0, prep: 0, run: 0 };
        if (model.includes("glob") || model.includes("crop")) {
            const glob = model.includes("glob");
            const output = new Array(glob ? 128 : 96).fill(0.125);
            calls.push({ kind: glob ? "glob" : "crop", len: output.length });
            return { ready: true, output, ms, provider: "cpu" };
        }
        const h = (scenario.head ? scenario.head(time - t0Fight) : null) ?? { gid: phase === 1 ? 97 : 87, med: 46, col: 2, resp: 2 };
        const output = headLogits(phase, h);
        calls.push({ kind: "head", len: output.length });
        return { ready: true, output, ms, provider: "cpu", ring: { len: 30, sum: 0 } };
    };

    const result = dufu({ ms: 3000, ...args });
    return { result, touches, sent, marks, calls, t0: result.t0 - epoch };
}

/** The fight's touches only (the phase-1 prep's menu taps happen before t0). */
export const fightTouches = (touches, t0) => touches.filter((t) => t.at >= t0);
