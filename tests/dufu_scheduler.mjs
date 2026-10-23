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
globalThis.screenshot = () => ({ seq: Math.floor(time / frameMs) });
globalThis.match = (template) => ({ hit: !!cfg.match?.(template, time) });
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
globalThis.color = ({ roi: [x, y], lower }) => {
    let box;
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
    // the item slot (SLOT_ROI): the potion's white gourd unless cfg.slot(time) says the other item is there
    else if (y === 650 && x === 683 && !(cfg.slot && !cfg.slot(time))) box = [690, 655, 20, 20];
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
        assert.deepEqual(run({ phase: 2, head: "dufu/unified_head_p2.onnx" }, { def: 2 }).touches, base);
        assert.deepEqual([...heads], ["dufu/unified_head_p2.onnx"]);
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
