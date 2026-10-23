import assert from "node:assert/strict";
import dufu from "../workspaces/WhereWindsMeet/skills/dufu.js";
import { health } from "../workspaces/WhereWindsMeet/skills/lib/dufu-reads.js";

// Exercise the real scheduler with a deterministic clock and input recorder.
// Contacts here drive model predictions only; this does not simulate game damage.
const epoch = 1_800_000_000_000;
const frameMs = 1000 / 30;
const centers = [2, 5, 8, 11, 14, 17.5, 22, 27.5, 35.5, 50.5];
let time, cfg, touches, stick, sent, heads;
Date.now = () => epoch + time;
globalThis.sleep = (ms) => { time += ms; };
globalThis.log = () => {};
globalThis.remaining = () => 3_600_000;
globalThis.event = (name, data) => { sent.push({ name, data: JSON.parse(JSON.stringify(data)) }); };
globalThis.frame = () => ({ seq: Math.floor(time / frameMs) });
// cfg.ageMs: the frame's age (img.time - img.age_ms = its capture time), only when set (the other tests keep {seq})
globalThis.screenshot = () => ({ seq: Math.floor(time / frameMs), ...(cfg.ageMs != null ? { time: epoch + time, age_ms: cfg.ageMs } : {}) });
// the item slot (SLOT_POTION_T): the potion unless cfg.slot(time) says the other item is there
globalThis.match = (template) => Array.isArray(template)
    ? { hit: template[0].startsWith("combat/potion_") && !(cfg.slot && !cfg.slot(time)), box: null }
    : { hit: !!cfg.match?.(template, time) };
globalThis.touch = {
    down(p, id) {
        if (id === 0) stick = p;
        cfg.onTap?.(p);
        touches.push({ op: "down", p, id, at: time, stick: [...stick] });
    },
    move(p, id) {
        if (id === 0) stick = p;
        touches.push({ op: "move", p, id, at: time });
    },
    up(id) { touches.push({ op: "up", id, at: time }); },
};
globalThis.color = ({ roi: [x, y, w, h], lower }) => {
    let box;
    // the phase-2 red line (redLine's reads): cfg.redLine(time) = the line's row y, or null. A thin component in each
    // column, a full strip around it, a full 3-row band; the 12-row side bands stay empty.
    const ly = cfg.redLine?.(time);
    if (ly != null && Array.isArray(lower[0]) && lower[0][2] === 200) {
        if (w === 4 && y === 152) return { hit: true, results: [{ box: [x, ly - 2, 4, 4], count: 16 }] };
        if (h === 4 && y === ly - 2) return { hit: true, results: [{ box: [x, y, w, 4], count: 4 * w }] };
        if (w === 780 && h === 3 && y === ly - 1) return { hit: true, results: [{ box: [150, y, 780, 3], count: 3 * 700 }] };
        return { hit: false, results: [] };
    }
    if (y === 681 && x === 405) {
        // The HP stub: cfg.hp(time) is either one ratio (both masks agree) or { grey, red } so the health() tests
        // can feed the low-HP disagreement seen at 737 f5970-6051. A null side is an unreadable bar.
        const hp = cfg.hp ? cfg.hp(time) : 1;
        const redMask = Array.isArray(lower[0]);
        const v = typeof hp === "number" ? hp : redMask ? hp.red : hp.grey;
        if (v == null) return { hit: false, results: [] };
        const w = Math.round(v * 254);
        if (w < 4) return { hit: false, results: [] };
        box = [415, 681, w, 5];
    } else if (y === 27 && x === 347) box = [347, 27, 386, 6];
    else if (y === 35 && x === 347) {
        // the boss's 真气: cfg.qi(time) px (0 = read empty), null = not read; default 300
        const q = cfg.qi ? cfg.qi(time) : 300;
        if (q != null) box = [347, 35, q, 6];
    }
    else if (x === 150 && y === 120 && cfg.flash?.(time)) {
        // seeFlash's gold line / orange streak (FLASH_ROI): one long horizontal blob
        return { hit: true, results: [{ box: [150, 300, 400, 20], count: 9999 }] };
    }
    else if (y === 648 && x === 1004) box = [1004, 648, 34, 39];
    return box ? { hit: true, results: [{ box, count: 999 }] } : { hit: false, results: [] };
};
globalThis.infer = (model) => {
    if (model.includes("back")) return { ready: true, output: cfg.feat ? cfg.feat(time) : new Array(192).fill(0) };
    heads.add(model);
    const out = new Array(77).fill(-8);
    out[0] = out[16] = out[70] = 8;
    for (let k = 0; k < 3; k++) {
        out[22 + 11 * k + 10] = 8;
        out[55 + 5 * k] = 8;
    }
    const next = cfg.futFn ? cfg.futFn(time)
        : cfg.contacts.find((t) => t - time >= 4 * frameMs && t - time <= 35 * frameMs);
    if (next != null) {
        const f = (next - time) / frameMs;
        const bin = centers.reduce((best, c, i) => Math.abs(c - f) < Math.abs(centers[best] - f) ? i : best, 0);
        out[32] = out[55] = -8;
        out[22 + bin] = out[55 + (cfg.defFn ? cfg.defFn(time) : cfg.def)] = 8;
        if (cfg.defLogits) cfg.defLogits.forEach((v, i) => { out[55 + i] = v; }); // def1 logits (none, parry, dodge, avoid, -)
    }
    const tell = cfg.tell.find(([from, to]) => time >= from && time < to);
    if (tell) { out[70] = -8; out[70 + tell[2]] = 8; }
    if (model.includes("p2e")) {
        // head p2e: out[77..132] (fut1f / ours / cont / land, unused here) + lead1f out[133..178]. cfg.gate(time) true:
        // a contact 8 f out (G ~1), else none (bin 45, G ~0)
        for (let i = 77; i < 133; i++) out.push(-8);
        for (let b = 0; b < 46; b++) out.push(b === (cfg.gate?.(time) ? 8 : 45) ? 8 : -8);
    }
    return { ready: true, output: out };
};

function run(args = {}, options = {}) {
    time = 0;
    touches = [];
    sent = [];
    heads = new Set();
    stick = [175, 569];
    cfg = { contacts: [1500, 3000, 4500], tell: [], def: 2, hp: () => 1, ...options };
    const result = dufu({ ms: 5100, potions: 0, prep: false, ...args });
    const dodges = touches.filter((t) => t.op === "down" && t.id === 2);
    return { result, dodges, touches, sent };
}
const P2E = "dufu/unified_head_p2e.onnx";
/** the 卸势 taps' times */
const parryTaps = (ts) => ts.filter((t) => t.op === "down" && t.p[0] === 952 && t.p[1] === 495).map((t) => t.at);

const tests = {
    "model dodges alternate left and right"() {
        const { result, dodges } = run({}, { def: 2 });
        assert.equal(dodges.length, 3);
        assert.deepEqual(dodges.map((d) => d.stick), [[92, 569], [258, 569], [92, 569]]);
        const events = result.events.filter((e) => e[2] === "press" && e[3].startsWith("dodge"));
        assert.deepEqual(events.map((e) => e[3].split(" ")[1]), ["left", "right", "left"]);
    },
    "a flare tell presses one anchored dodge, also when the label turns grab"() {
        const { result, dodges } = run({}, { contacts: [], tell: [[900, 960, 1], [960, 1500, 2]], futFn: () => 1600 });
        assert.equal(dodges.length, 1, `expected the anchored dodge: ${dodges.map((d) => d.at)}`);
        assert.ok(result.events.some((e) => e[2] === "press" && e[3].includes(" anchor ")), "not an anchored dodge");
    },
    "a pressed plan follows a contact that keeps drifting later"() {
        // One true contact at 3000 ms; the head first says 1400, then 2000, 2600, 3000. The old one-shot
        // `repressed` limit stopped after the first re-arm, leaving the stale pressed k0 in the slot (726 t2247/
        // t2592/t3572 and the t7251 flare slot). The scheduler must re-arm for each later contact.
        const { result } = run({}, {
            contacts: [], def: 1,
            futFn: (t) => t < 1200 ? 1400 : t < 1900 ? 2000 : t < 2400 ? 2600 : 3000,
        });
        const presses = result.events.filter((e) => e[2] === "press" && e[3].startsWith("parry"));
        const rearms = result.events.filter((e) => e[2] === "re-press");
        assert.ok(presses.length >= 3, `expected 3 parry presses, got ${presses.length}: ${presses.map((e) => e[3])}`);
        assert.ok(rearms.some((e) => e[3].includes("#2")), `expected a second re-arm: ${rearms.map((e) => e[3])}`);
        assert.ok(!rearms.some((e) => e[3].includes("#3")), `per-item cap exceeded: ${rearms.map((e) => e[3])}`);
    },
    "a re-armed parry becomes the dodge the later contact wants"() {
        // The 726 t7251 shape: a pressed parry holds k0; the fresh contact is later and the defense head turns
        // dodge. The re-arm must replace the action, not keep the old parry kind.
        const { result, dodges } = run({}, {
            contacts: [], def: 1, defFn: (t) => t < 1450 ? 1 : 2,
            futFn: (t) => t < 1200 ? 1400 : 2400,
        });
        assert.ok(dodges.length >= 1, "the later contact was not dodged");
        assert.ok(result.events.some((e) => e[2] === "press" && e[3].startsWith("dodge")), "no dodge press");
    },
    "parryJitter moves every 卸势 by its offset"() {
        // the same three contacts: [5, 5] presses each 卸势 5 frames earlier, [-3, -3] 3 frames later
        const downs = (a) => run({ phase: 2, ...a }, {}).touches.filter((t) => t.op === "down" && t.id === 1).map((t) => t.at);
        const base = downs({}), early = downs({ parryJitter: [5, 5] }), late = downs({ parryJitter: [-3, -3] });
        assert.ok(base.length >= 2, `base presses: ${base}`);
        assert.equal(early.length, base.length);
        assert.equal(late.length, base.length);
        base.forEach((t, i) => {
            assert.ok(Math.abs(t - early[i] - 5 * frameMs) <= frameMs + 1, `early ${early[i]} vs ${t}`);
            assert.ok(Math.abs(late[i] - t - 3 * frameMs) <= frameMs + 1, `late ${late[i]} vs ${t}`);
        });
    },
    "phase 2 leadF presses later and secondTapF taps once more without an ok"() {
        const downs = (a) => run({ phase: 2, ...a }, {}).touches.filter((t) => t.op === "down" && t.id === 1).map((t) => t.at);
        const base = downs({}), later = downs({ leadF: 11 });
        assert.ok(base.length >= 2 && later.length === base.length, `${base} / ${later}`);
        base.forEach((t, i) => assert.ok(Math.abs(later[i] - t - 3 * frameMs) <= frameMs + 1, `leadF: ${later[i]} vs ${t}`));
        // a blow that keeps showing ~10 f ahead for 1 s (lands later than believed): one more tap 13 f after the first
        // believed at 1500; from 1400 the head keeps it ~4 f ahead (the blow lands later): the second tap 12 f after the press
        const fut = (t) => t < 1400 ? (t >= 900 ? 1500 : null) : t < 2000 ? t + 4 * frameMs : null;
        const slow = (a) => run({ phase: 2, ms: 2500, ...a }, { contacts: [], futFn: fut });
        const marks = (r) => r.result.events.filter((e) => e[2] === "re-press" && e[3].includes("second tap +12f"));
        assert.equal(marks(slow({})).length, 0);
        const two = slow({ secondTapF: 12 });
        assert.ok(marks(two).length >= 1, "no second tap");
        const at = marks(two)[0][1], taps = two.touches.filter((t) => t.op === "down" && t.id === 1).map((t) => t.at);
        assert.ok(taps.some((t) => t >= at && t - at <= frameMs + 1), `the second tap did not go at once: ${taps} / ${at}`);
        assert.deepEqual(run({ ...{}, secondTapF: 13, leadF: 11 }, {}).touches, run({}, {}).touches, "phase 1 changed");
    },
    "phase 2 parries the def head's dodges"() {
        const { result, dodges, touches } = run({ phase: 2 }, { def: 2 });
        assert.equal(dodges.length, 0, `phase 2 dodged: ${dodges.map((d) => d.at)}`);
        const parries = touches.filter((t) => t.op === "down" && t.id === 1);
        assert.equal(parries.length, 3, `expected one 卸势 per contact: ${parries.map((t) => t.at)}`);
        assert.ok(result.events.every((e) => !(e[2] === "press" && e[3].startsWith("dodge"))), "a dodge press in phase 2");
    },
    "phase 2 defDodgeP dodges the def head's dodges at or above it, phase 1 ignores it"() {
        const opts = { def: 1, defLogits: [-8, 0, 0.5, -8, -8] }; // P(dodge) 0.62, argmax dodge
        const parries = (t) => t.filter((x) => x.op === "down" && x.id === 1);
        const off = run({ phase: 2 }, opts);
        assert.equal(off.dodges.length, 0, "phase 2 without defDodgeP dodged");
        const on = run({ phase: 2, defDodgeP: 0.6 }, opts);
        assert.equal(on.dodges.length, 3, `expected one dodge per contact: ${on.dodges.map((d) => d.at)}`);
        assert.equal(parries(on.touches).length, 0, "a 卸势 with defDodgeP 0.6");
        const high = run({ phase: 2, defDodgeP: 0.7 }, opts);
        assert.equal(high.dodges.length, 0, "P(dodge) 0.62 dodged at defDodgeP 0.7");
        assert.deepEqual(high.touches, off.touches);
        // a parry-argmax contact with P(dodge) 0.38 dodges at a low threshold
        assert.equal(run({ phase: 2, defDodgeP: 0.3 }, { def: 1, defLogits: [-8, 0.5, 0, -8, -8] }).dodges.length, 3);
        assert.deepEqual(run({ defDodgeP: 0.6 }, opts).touches, run({}, opts).touches, "phase 1 changed by defDodgeP");
    },
    "phase 2 dodges a flare at its first report, and once more while it lasts"() {
        const opts = { contacts: [], tell: [[900, 960, 1], [960, 1500, 2]], futFn: () => null };
        const p1 = run({}, opts).dodges;
        const { result, dodges } = run({ phase: 2, flare2: true }, opts);
        assert.equal(dodges.length, 2, `expected the first dodge and one re-dodge: ${dodges.map((d) => d.at)}`);
        assert.ok(dodges[0].at < 900 + frameMs, `the first dodge is not at the first report: ${dodges[0].at}`);
        assert.ok(dodges[0].at < p1[0].at - 5 * frameMs, `not earlier than phase 1's anchored dodge: ${dodges[0].at} vs ${p1[0].at}`);
        assert.ok(dodges[1].at - dodges[0].at >= 500 && dodges[1].at < 1500, `the re-dodge is not after the CD while reported: ${dodges[1].at}`);
        assert.deepEqual(dodges.map((d) => d.stick), [[92, 569], [258, 569]], "left / right in turn");
        assert.ok(result.events.some((e) => e[2] === "press" && e[3].includes("flare2 first")), "no flare2 press");
        assert.equal(result.flare2.redodges, 1);
    },
    "phase 2 does not re-dodge into a due 卸势"() {
        // the opener's red blow after the blast is the plan's (a 卸势 due within FLARE2_PARRY_GUARD_MS): no re-dodge
        const { result, dodges, touches } = run({ phase: 2, flare2: true }, { contacts: [], tell: [[900, 1700, 1]], futFn: (t) => t < 1300 ? null : 1900 });
        assert.equal(dodges.length, 1, `dodges: ${dodges.map((d) => d.at)}`);
        assert.ok(touches.some((t) => t.op === "down" && t.id === 1 && t.at > 1300), "the 卸势 did not go");
        assert.equal(Object.values(result.flare2.reSkip).reduce((a, b) => a + b, 0), 1, JSON.stringify(result.flare2.reSkip));
        assert.equal(result.flare2.redodges, 0);
    },
    "phase 2 walks in while 真气 is empty and 处决 does not show"() {
        // 真气 empty from 1 s, 处决 within reach from 2.5 s: walk forward from ~0.3 s after the candidate until the
        // button, then 处决 at the usual 2.6 s after its sighting. Phase 1 stands still (unchanged).
        const opts = { contacts: [], qi: (t) => t < 1000 ? 300 : 0, match: (tpl, t) => tpl === "combat/execute.png" && t >= 2500 };
        // forward pushes after the round-start walk-in (the boss bar shows at once here)
        const fwd = (ts) => ts.filter((t) => t.op === "move" && t.id === 0 && t.p[0] === 175 && t.p[1] === 486 && t.at > 500);
        const p1 = run({ ms: 6000 }, opts);
        assert.equal(fwd(p1.touches).length, 0, "phase 1 walked");
        const p2 = run({ phase: 2, ms: 6000 }, opts);
        const w = fwd(p2.touches);
        assert.ok(w.length >= 2 && w[0].at >= 1300 && w[0].at < 1600, `walk start: ${w.map((t) => t.at)}`);
        assert.ok(w.every((t) => t.at < 2500), `walked after the button: ${w.map((t) => t.at)}`);
        const ups = p2.touches.filter((t) => t.op === "up" && t.id === 0 && t.at >= 2500 && t.at < 2500 + 2 * frameMs);
        assert.ok(ups.length >= 1, "the walk did not stop at the button");
        const exec = (r) => r.touches.filter((t) => t.op === "down" && t.id === 3 && t.p[0] === 852 && t.p[1] === 430).map((t) => t.at);
        const e2 = exec(p2), e1 = exec(p1);
        assert.equal(e2.length, 1, `处决 taps: ${e2}`);
        assert.ok(e2[0] >= 5100 && e2[0] < 5100 + 2 * frameMs, `处决 at ${e2[0]}`);
        assert.equal(e1.length, 1, `phase 1 处决 taps: ${e1}`);
        assert.deepEqual(p2.result.qiWalk.ends, { "处决 shows": 1 });
    },
    "phase 2's walk in stops at its cap"() {
        const opts = { contacts: [], qi: (t) => t < 1000 ? 300 : 0 };
        const { result, touches } = run({ phase: 2, ms: 7500 }, opts);
        const w = touches.filter((t) => t.op === "move" && t.id === 0 && t.p[1] === 486 && t.at > 500).map((t) => t.at);
        assert.ok(w.length >= 6, `pushes: ${w}`);
        const start = w[0];
        assert.ok(w[w.length - 1] < start + 4000, `pushed past the cap: ${w}`);
        assert.ok(w[w.length - 1] > start + 3000, `stopped early: ${w}`);
        assert.equal(result.qiWalk.caps, 1);
        assert.equal(result.off.qi.windows, 0);
    },
    "phase 2 never enters the curtain (tell curtain / dark runs)"() {
        const opts = { contacts: [], tell: [[600, 2500, 5], [2600, 3400, 6]], futFn: () => null };
        const p1 = run({}, opts).result;
        assert.ok(p1.events.some((e) => e[2] === "curtain"), "phase 1 should still enter the curtain");
        const { result, dodges } = run({ phase: 2 }, opts);
        assert.ok(result.events.every((e) => e[2] !== "curtain"), `phase 2 curtain: ${result.events.filter((e) => e[2] === "curtain").map((e) => e[3])}`);
        assert.equal(dodges.length, 0, "phase 2 dodged without a contact");
    },
    "the head arg picks the head model"() {
        run({}, { def: 2 });
        assert.deepEqual([...heads], ["dufu/unified_head9s.onnx"]);
        const base = run({ phase: 2 }, { def: 2 }).touches;
        assert.deepEqual([...heads], ["dufu/unified_head_p2.onnx"], "phase 2 defaults to its own head");
        assert.deepEqual(run({ phase: 2, head: "dufu/unified_head9s.onnx" }, { def: 2 }).touches, base);
        assert.deepEqual([...heads], ["dufu/unified_head9s.onnx"]);
    },
    "phase 1 touches do not depend on phase / trace args"() {
        const base = run({}, { def: 2 }).touches;
        assert.deepEqual(run({ phase: 1 }, { def: 2 }).touches, base);
        assert.deepEqual(run({ trace: true }, { def: 2 }).touches, base);
        assert.deepEqual(run({ trace: "feat" }, { def: 2 }).touches, base);
    },
    "the trace sends every backbone frame in chunks"() {
        const feat = () => Array.from({ length: 192 }, (_, i) => (i - 96) / 7 + Math.floor(time / 100) * 1e-3);
        const { result, sent } = run({ trace: "feat" }, { feat });
        assert.ok(sent.length >= 2 && sent.every((e) => e.name === "dufu_trace"), `chunks: ${sent.length}`);
        const rows = sent.flatMap((e) => e.data.rows);
        assert.equal(rows.length, result.trace.rows);
        assert.equal(sent.length, result.trace.chunks);
        assert.deepEqual(sent.map((e) => e.data.chunk), sent.map((_, i) => i));
        const cols = sent[0].data.cols;
        assert.equal(cols.length, 3 + 15 + 1);
        assert.ok(rows.every((r) => r.length === cols.length));
        assert.ok(rows.every((r, i) => i === 0 || r[0] >= rows[i - 1][0]), "wall ms not monotonic");
        // the float16 feature decodes back to the backbone output (3 significant digits)
        const r = rows[rows.length - 1];
        const bytes = Buffer.from(r[r.length - 1], "base64");
        assert.equal(bytes.length, 384);
        const t = r[0];
        for (let i = 0; i < 192; i++) {
            const h = bytes[2 * i] | (bytes[2 * i + 1] << 8);
            const e = (h >> 10) & 31, m = h & 1023;
            const v = (h & 0x8000 ? -1 : 1) * (e ? 2 ** (e - 15) * (1 + m / 1024) : 2 ** -14 * (m / 1024));
            const want = (i - 96) / 7 + Math.floor(t / 100) * 1e-3;
            assert.ok(Math.abs(v - want) <= Math.abs(want) / 1000 + 1e-4, `feat[${i}] ${v} vs ${want}`);
        }
        const aux = run({ trace: true }).sent.flatMap((e) => e.data.rows);
        assert.ok(aux.every((x) => x.length === 18 && x.slice(3).every((v) => Math.round(v * 1000) / 1000 === v)));
    },
    "phase 2 redLine: a red line plans one 卸势 at its capture time + 6 f"() {
        const opts = { contacts: [], futFn: () => null, redLine: (t) => t >= 1000 && t < 1300 ? 300 : null, ageMs: 30 };
        const { result, touches } = run({ phase: 2, redLine: true, ms: 2500 }, opts);
        const on = result.events.filter((e) => e[2] === "redline" && e[3].startsWith("onset"));
        assert.equal(on.length, 1, `onsets: ${on.map((e) => e[3])}`);
        const cap = on[0][1] - 30; // the first line frame's capture time (ms since start)
        const taps = touches.filter((t) => t.op === "down" && t.id === 1).map((t) => t.at);
        assert.equal(taps.length, 1, `taps: ${taps}`);
        assert.ok(taps[0] >= cap + 6 * frameMs - 1 && taps[0] <= cap + 7 * frameMs + 5, `tap ${taps[0]} vs capture ${cap}`);
        const press = result.events.find((e) => e[2] === "press" && e[3].includes(" red "));
        assert.ok(press && /redline \+[67]\.\df/.test(press[3]), `press mark: ${press?.[3]}`);
        assert.equal(result.redLine.onsets, 1);
        assert.equal(result.redLine.presses, 1);
        assert.ok(result.redLine.readMs.n > 0 && result.redLine.calls.n > 0, JSON.stringify(result.redLine));
        // a number is the delay in frames
        const t9 = run({ phase: 2, redLine: 9, ms: 2500 }, opts).touches.filter((t) => t.op === "down" && t.id === 1).map((t) => t.at);
        assert.ok(t9.length === 1 && Math.abs(t9[0] - taps[0] - 3 * frameMs) <= frameMs + 1, `redLine 9: ${t9} vs ${taps}`);
    },
    "phase 2 redLine ignores a line right after a hit (impact flash)"() {
        const opts = { contacts: [], futFn: () => null, redLine: (t) => t >= 1000 && t < 1300 ? 300 : null };
        // the hit read 1 f before the line
        const before = run({ phase: 2, redLine: true, ms: 2500 }, { ...opts, hp: (t) => t < 970 ? 0.8 : 0.75 }).result;
        assert.deepEqual(before.redLine.ignored, { hit: 1 }, JSON.stringify(before.redLine));
        assert.ok(!before.events.some((e) => e[3].includes(" red ")), "a red-line item after a hit");
        // the hit read 3 f after the line onset (the flash came first): the planned 卸势 goes unpressed
        const after = run({ phase: 2, redLine: true, ms: 2500 }, { ...opts, hp: (t) => t < 1100 ? 0.8 : 0.75 }).result;
        assert.deepEqual(after.redLine.ignored, { "hit late": 1 }, JSON.stringify(after.redLine));
        assert.equal(after.redLine.presses, 0);
        assert.ok(after.events.some((e) => e[2] === "plan" && e[3].includes("redline: hit flash")), "the red item was not dropped");
    },
    "phase 2 redLine moves an early fut 卸势 to the anchor and adds no second press"() {
        // the head believes a contact at 1500 (fut 卸势 at ~1033, before onset + 3 f): it waits for onset + 6 f
        const opts = { contacts: [], futFn: (t) => t < 1500 ? 1500 : null, redLine: (t) => t >= 1000 && t < 1300 ? 300 : null };
        const base = run({ phase: 2, ms: 2500 }, opts).touches.filter((t) => t.op === "down" && t.id === 1).map((t) => t.at);
        const { result, touches } = run({ phase: 2, redLine: true, ms: 2500 }, opts);
        const taps = touches.filter((t) => t.op === "down" && t.id === 1).map((t) => t.at);
        const on = result.events.find((e) => e[2] === "redline" && e[3].startsWith("onset"));
        assert.ok(base.length === 1 && base[0] < on[1] + 3 * frameMs, `base ${base} / onset ${on?.[1]}`);
        assert.equal(taps.length, 1, `taps: ${taps}`);
        assert.ok(taps[0] >= on[1] + 6 * frameMs - 1 && taps[0] <= on[1] + 7 * frameMs + 5, `moved tap ${taps[0]} vs onset ${on[1]}`);
        assert.equal(result.redLine.moved, 1);
        assert.ok(result.events.some((e) => e[2] === "press" && e[3].includes(" fut ") && e[3].includes("moved")), "no moved press mark");
        assert.deepEqual(result.redLine.windowPressBy, { moved: 1 });
        assert.equal(result.redLine.planned, 0, "a red item next to the fut one");
    },
    "redLine is off by default and phase 1 ignores it"() {
        const opts = { def: 2, redLine: (t) => t >= 1000 && t < 1300 ? 300 : null };
        const p2 = run({ phase: 2 }, opts);
        assert.equal(p2.result.redLine, undefined);
        assert.deepEqual(p2.touches, run({ phase: 2 }, { def: 2 }).touches, "phase 2 without redLine changed by a line");
        const p1 = run({ redLine: true }, opts);
        assert.equal(p1.result.redLine, undefined);
        assert.deepEqual(p1.touches, run({}, { def: 2 }).touches, "phase 1 changed by redLine");
    },
    "phase 2 cadence presses every ~345 ms while the gate is open, none while it is closed"() {
        // the gate open 1000-2500 ms; the default contacts (1500 / 3000 / 4500) plan no fut 卸势 with the cadence on
        const { result, touches } = run({ phase: 2, head: P2E, cadence: 0.1, ms: 4000 }, { gate: (t) => t >= 1000 && t < 2500 });
        const taps = parryTaps(touches);
        assert.ok(taps.length >= 4, `taps: ${taps}`);
        assert.ok(taps[0] >= 1000 && taps[0] < 1000 + 2 * frameMs, `first tap ${taps[0]}`);
        assert.ok(taps.every((t) => t < 2500 + 2 * frameMs), `a tap with the gate closed: ${taps}`);
        taps.slice(1).forEach((t, i) => {
            const g = t - taps[i];
            assert.ok(g >= 345 && g <= 380, `gap ${g} (${taps})`);
        });
        const marks = result.events.filter((e) => e[2] === "press");
        assert.equal(marks.length, taps.length);
        assert.ok(marks.every((e) => e[3] === "parry cadence G1.00"), marks.map((e) => e[3]).join(" / "));
        assert.equal(result.cadence.on, true);
        assert.equal(result.cadence.presses, taps.length);
        assert.equal(result.cadence.swallowed, 0);
        assert.equal(Object.values(result.cadence.gapHist).reduce((a, b) => a + b, 0), taps.length - 1);
        assert.ok(result.cadence.openShare > 0.3 && result.cadence.openShare < 0.5, `open share ${result.cadence.openShare}`);
        assert.ok(!result.events.some((e) => e[2] === "plan" && e[3].includes(" fut ")), "a fut item with the cadence on");
        // closed all run: no 卸势 at all
        assert.equal(parryTaps(run({ phase: 2, head: P2E, cadence: 0.1 }, {}).touches).length, 0);
    },
    "phase 2 cadence: an ok unlocks the next 卸势 early"() {
        const gate = (t) => t >= 1000 && t < 2500;
        const first = parryTaps(run({ phase: 2, head: P2E, cadence: 0.1, ms: 3000 }, { gate }).touches)[0];
        // the boss's 真气 drops 15 px 2 frames after the first 卸势: an ok
        const { result, touches } = run({ phase: 2, head: P2E, cadence: 0.1, ms: 3000 }, { gate, qi: (t) => t < first + 2 * frameMs ? 300 : 285 });
        assert.equal(result.oks, 1);
        const taps = parryTaps(touches);
        assert.equal(taps[0], first);
        assert.ok(taps[1] - taps[0] >= 220 && taps[1] - taps[0] < 300, `after the ok: ${taps[1] - taps[0]} ms`);
        assert.equal(result.cadence.swallowed, 0);
    },
    "phase 2 cadence is not gated by a hit and plans no post-hit fallback 卸势"() {
        // a 30% real-fight blow read at ~1200 ms: cadence keeps its ~345 ms beat without any stagger wait
        const { result, touches } = run({ phase: 2, head: P2E, cadence: 0.1, ms: 3000 }, { gate: (t) => t >= 1000, hp: (t) => t < 1200 ? 0.8 : 0.5 });
        const hit = result.events.find((e) => e[2] === "hit");
        assert.ok(hit, "no hit");
        const taps = parryTaps(touches);
        assert.ok(taps.some((t) => t > hit[1] && t < hit[1] + 250), `cadence gated after hit: ${taps} / hit ${hit[1]}`);
        assert.equal(result.cadence.wait.stagger, undefined, JSON.stringify(result.cadence.wait));
        assert.ok(!result.events.some((e) => e[2] === "press" && /posthit/.test(e[3])), "a post-hit fallback 卸势 with cadence on");
    },
    "phase 2 cadence yields to an urgent potion and waits out the drink"() {
        const { result, touches } = run({ phase: 2, head: P2E, cadence: 0.1, ms: 4000, potions: 1 }, { gate: () => true, hp: (t) => t < 1500 ? 0.8 : 0.1 });
        const drink = touches.filter((t) => t.op === "down" && t.id === 1 && t.p[0] === 700 && t.p[1] === 690).map((t) => t.at);
        assert.ok(drink.length >= 1, "no drink");
        const taps = parryTaps(touches);
        const before = taps.filter((t) => t < drink[0]);
        assert.ok(before.length >= 1 && drink[0] - before[before.length - 1] >= 400, `the drink ${drink[0]} after the 卸势 ${before}`);
        assert.ok(!taps.some((t) => t > drink[0] && t < drink[0] + 2000), `a 卸势 in the drink hold: ${taps} / ${drink}`);
        assert.ok(result.cadence.yields >= 1 && result.cadence.wait.yield > 0, JSON.stringify(result.cadence));
        assert.ok(result.cadence.wait.potion > 0, JSON.stringify(result.cadence.wait));
    },
    "phase 2 cadence and the red line never press twice inside one lock"() {
        for (const [from, ageMs] of [[1000, 30], [1150, 30], [1250, 0]]) {
            const { result, touches } = run({ phase: 2, head: P2E, cadence: 0.1, redLine: true, ms: 3000 },
                { gate: (t) => t >= 1000 && t < 2500, redLine: (t) => t >= from && t < from + 300 ? 300 : null, ageMs });
            const taps = parryTaps(touches);
            assert.ok(taps.length >= 3, `taps: ${taps}`);
            taps.slice(1).forEach((t, i) => assert.ok(t - taps[i] >= 330, `line at ${from}: gap ${t - taps[i]} (${taps})`));
            assert.equal(result.cadence.swallowed, 0);
            assert.equal(result.redLine.onsets, 1);
        }
    },
    "the cadence is off without lead1f, in phase 1 and by default (touches unchanged)"() {
        const p2 = run({ phase: 2 }, { def: 2 }).touches;
        // a p2e head without cadence: the extra columns change nothing
        assert.deepEqual(run({ phase: 2, head: P2E }, { def: 2, gate: () => true }).touches, p2, "phase 2 + p2e head changed");
        // cadence with a head without lead1f: off, with why
        const noLead = run({ phase: 2, head: "dufu/unified_head_p2.onnx", cadence: 0.1 }, { def: 2 });
        assert.deepEqual(noLead.touches, p2, "cadence without lead1f changed phase 2");
        assert.equal(noLead.result.cadence.on, false);
        assert.ok(/no lead1f/.test(noLead.result.cadence.off), noLead.result.cadence.off);
        assert.ok(noLead.result.events.some((e) => e[2] === "cadence" && e[3].startsWith("off")), "no off mark");
        // phase 1 ignores it
        const p1 = run({}, { def: 2 }).touches;
        const p1c = run({ head: P2E, cadence: 0.1 }, { def: 2, gate: () => true });
        assert.deepEqual(p1c.touches, p1, "phase 1 changed by cadence");
        assert.equal(p1c.result.cadence, undefined);
    },
    "health prefers the red bar over a low-HP grey overread"() {
        // 737 f5970-6051: the grey mask read 21% on a 17% red bar (bright tip / hit flash). The red read is the bar.
        cfg = { hp: () => ({ grey: 0.2126, red: 0.1693 }) };
        assert.equal(health({ seq: 1 }), 43 / 254);
        // Grey unreadable is the old fallback: red still answers.
        cfg = { hp: () => ({ grey: null, red: 0.1693 }) };
        assert.equal(health({ seq: 1 }), 43 / 254);
        // A grey underread is equally wrong at low HP: the red bar is still the authority.
        cfg = { hp: () => ({ grey: 0.13, red: 0.1693 }) };
        assert.equal(health({ seq: 1 }), 43 / 254);
    },
    "health keeps the grey bar above the red range"() {
        // High HP is unchanged: grey 60% wins over a spurious 20% red effect read and the red mask is not consulted.
        cfg = { hp: () => ({ grey: 0.60, red: 0.20 }) };
        assert.equal(health({ seq: 2 }), 152 / 254);
        // Low HP without a red read keeps the grey value (feedback's confirmed baseline handles the rest).
        cfg = { hp: () => ({ grey: 0.2126, red: null }) };
        assert.equal(health({ seq: 3 }), 54 / 254);
    },
    "a 21/17 low-HP oscillation triggers one hit"() {
        // The 737 shape: one real 21%->17% drop, then the grey bar overreads 21% every other 10 frames. The old
        // per-read baseline fired on every fall from 21; the confirmed baseline must fire once.
        const hp = (t) => {
            const f = Math.floor(t / frameMs);
            if (f < 10) return 0.2126;
            return Math.floor((f - 10) / 10) % 2 === 0 ? 0.1693 : 0.2126;
        };
        const { result } = run({ ms: 3000 }, { hp, contacts: [], tell: [] });
        const hits = result.events.filter((e) => e[2] === "hit");
        assert.equal(hits.length, 1, `expected one hit for one drop: ${hits.map((e) => e[3])}`);
        assert.ok(hits[0][3].startsWith("21%->17%"), `unexpected hit text: ${hits[0][3]}`);
        // Prove the sequence discriminates: a per-read baseline (h < prev - HIT_DROP) would report several hits.
        let prev = hp(0), legacy = 0;
        for (let f = 1; f < 89; f++) {
            const h = hp(f * frameMs);
            if (h < prev - 0.025) legacy++;
            prev = h;
        }
        assert.ok(legacy >= 3, `the old per-read rule should fire repeatedly here, got ${legacy}`);
    },
    "a real 80%->75% drop still triggers"() {
        const { result } = run({ ms: 2500 }, { hp: (t) => t < 1200 ? 0.80 : 0.75, contacts: [], tell: [] });
        const hits = result.events.filter((e) => e[2] === "hit");
        assert.equal(hits.length, 1, `expected one hit: ${hits.map((e) => e[3])}`);
        assert.ok(hits[0][3].startsWith("80%->75%"), `unexpected hit text: ${hits[0][3]}`);
    },
    "a heavy 30% hit does not block defense 卸势, uses only PARRY_CD_MS relock within 300 ms, and falls back when quiet"() {
        // Real-fight 30% blow (70%->40%) at 1200 ms with a follow-up contact at 1750 ms (due ~1260 ms, inside the old
        // 500 ms stagger) and a drifting re-arm to 1980 ms (due ~1480 ms, > PARRY_CD_MS 220 ms and < PARRY_RELOCK_MS
        // 330 ms after the first press). Both must press without stagger block or 330 ms fake relock.
        const { result, touches } = run({ ms: 2600 }, {
            hp: (t) => t < 1200 ? 0.70 : 0.40,
            contacts: [], def: 1,
            futFn: (t) => t < 1220 ? null : t < 1400 ? 1750 : 1980,
        });
        const hit = result.events.find((e) => e[2] === "hit");
        assert.ok(hit && hit[3].startsWith("70%->40%"), `hit: ${hit?.[3]}`);
        const taps = parryTaps(touches);
        assert.ok(taps.length >= 2, `expected follow-up + re-arm presses, got ${taps}`);
        assert.ok(taps[0] > hit[1] && taps[0] < hit[1] + 150, `first defense press held after hit: ${taps[0]} vs hit ${hit[1]}`);
        assert.ok(taps[1] - taps[0] >= 220 && taps[1] - taps[0] < 320, `post-hit press imposed 330 ms relock: gap ${taps[1] - taps[0]} (${taps})`);
        assert.equal(result.blocked.stagger, undefined);
        assert.equal(result.insurePresses, 0, "fallback fired despite a planned press");
        // Quiet model after a hit: one post-hit fallback 卸势 ~250 ms after onHit
        const quiet = run({ ms: 2500 }, { hp: (t) => t < 1200 ? 0.70 : 0.40, contacts: [], tell: [] });
        const qHit = quiet.result.events.find((e) => e[2] === "hit");
        const qTaps = parryTaps(quiet.touches);
        assert.equal(quiet.result.insurePresses, 1);
        assert.ok(qTaps.length === 1 && qTaps[0] >= qHit[1] + 250 && qTaps[0] < qHit[1] + 330, `fallback tap ${qTaps} vs hit ${qHit[1]}`);
    },
    "a potion 20%->40% is not a hit and the heal is not swallowed"() {
        // Drink at 20%, the bar fills to 40%, then a real blow takes it to 35%: exactly one hit, based on the heal.
        const hp = (t) => t < 2000 ? 0.20 : t < 3600 ? 0.40 : 0.35;
        const { result } = run({ ms: 5000, potions: 1 }, {
            hp, contacts: [], tell: [],
        });
        const hits = result.events.filter((e) => e[2] === "hit");
        assert.equal(hits.length, 1, `expected only the 40%->35% hit: ${hits.map((e) => e[3])}`);
        assert.ok(hits[0][3].startsWith("40%->35%"), `unexpected hit text: ${hits[0][3]}`);
        assert.ok(result.events.some((e) => e[2] === "potion" && e[3].startsWith("tap")), "the drink never went out");
        assert.equal(result.potion.healed, 1, `the heal was not counted: ${JSON.stringify(result.potion)}`);
        assert.equal(result.potion.fails, 0, `the heal was treated as a failed drink: ${JSON.stringify(result.potion)}`);
    },
    "a drink with the other item in the slot swaps it back first"() {
        // the slot holds the poison: ITEM_OPEN, ITEM_PICK 600 ms later, then the drink once the slot reads the potion
        let swapped = false;
        const opts = { hp: () => 0.2, contacts: [], tell: [], slot: () => swapped };
        const ts = run({ ms: 4000, potions: 1 }, { ...opts, onTap: (p) => { if (p[0] === 702 && p[1] === 575) swapped = true; } });
        const downs = ts.touches.filter((t) => t.op === "down" && t.id === 1).map((t) => `${t.p[0]},${t.p[1]}`);
        const open = downs.indexOf("700,633"), pick = downs.indexOf("702,575"), drink = downs.indexOf("700,690");
        assert.ok(open >= 0 && pick > open, `no swap: ${downs}`);
        assert.ok(drink > pick, `the drink did not follow the swap: ${downs}`);
        assert.equal(ts.result.potion.slotSwaps, 1);
    },
    "a late potion heal after a hit during the drink is still counted"() {
        // Drink at 20%, take a real blow to 10%, then the delayed heal shows 50% (before the retry): no hit on the rise, the late heal
        // counts, and the next real blow (50%->45%) is still detected.
        const hp = (t) => t < 1000 ? 0.20 : t < 1400 ? 0.10 : t < 3200 ? 0.50 : 0.45; // the heal before the 600 ms retry
        const { result } = run({ ms: 4500, potions: 1 }, {
            hp, contacts: [], tell: [],
        });
        const hits = result.events.filter((e) => e[2] === "hit");
        assert.deepEqual(hits.map((e) => e[3].split(" ")[0]), ["20%->10%", "50%->45%"],
            `expected the blow in the drink and the later blow only: ${hits.map((e) => e[3])}`);
        assert.equal(result.potion.healed, 1, `the late heal was not counted: ${JSON.stringify(result.potion)}`);
        assert.equal(result.potion.lateOks, 1, `the late-heal path did not run: ${JSON.stringify(result.potion)}`);
        assert.equal(result.potion.fails, 0, `the late heal left a failed drink: ${JSON.stringify(result.potion)}`);
    },
};

let failures = 0;
for (const [name, test] of Object.entries(tests)) {
    try { test(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failures) process.exitCode = 1;
