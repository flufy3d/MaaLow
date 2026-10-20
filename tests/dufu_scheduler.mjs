import assert from "node:assert/strict";
import dufu from "../workspaces/WhereWindsMeet/skills/dufu.js";
import { health } from "../workspaces/WhereWindsMeet/skills/lib/dufu-reads.js";

// Exercise the real scheduler with a deterministic clock and input recorder.
// Contacts here drive model predictions only; this does not simulate game damage.
const epoch = 1_800_000_000_000;
const frameMs = 1000 / 30;
const centers = [2, 5, 8, 11, 14, 17.5, 22, 27.5, 35.5, 50.5];
let time, cfg, touches, stick;
Date.now = () => epoch + time;
globalThis.sleep = (ms) => { time += ms; };
globalThis.log = () => {};
globalThis.frame = () => ({ seq: Math.floor(time / frameMs) });
globalThis.screenshot = () => ({ seq: Math.floor(time / frameMs) });
globalThis.match = () => ({ hit: false });
globalThis.touch = {
    down(p, id) {
        if (id === 0) stick = p;
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
    else if (y === 35 && x === 347) box = [347, 35, 300, 6];
    else if (y === 648 && x === 1004) box = [1004, 648, 34, 39];
    return box ? { hit: true, results: [{ box, count: 999 }] } : { hit: false, results: [] };
};
globalThis.infer = (model) => {
    if (model.includes("back")) return { ready: true, output: new Array(192).fill(0) };
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
    }
    const tell = cfg.tell.find(([from, to]) => time >= from && time < to);
    if (tell) { out[70] = -8; out[70 + tell[2]] = 8; }
    return { ready: true, output: out };
};

function run(args = {}, options = {}) {
    time = 0;
    touches = [];
    stick = [175, 569];
    cfg = { contacts: [1500, 3000, 4500], tell: [], def: 2, hp: () => 1, ...options };
    const result = dufu({ ms: 5100, potions: 0, lockOn: false, flareDodge: false, ...args });
    const dodges = touches.filter((t) => t.op === "down" && t.id === 2);
    return { result, dodges, touches };
}

const tests = {
    "model dodges honor the configured side alternation"() {
        const { result, dodges } = run({ dodgeDir: "side" });
        assert.equal(dodges.length, 3);
        assert.deepEqual(dodges.map((d) => d.stick), [[92, 569], [258, 569], [92, 569]]);
        const events = result.events.filter((e) => e[2] === "press" && e[3].startsWith("dodge"));
        assert.deepEqual(events.map((e) => e[3].split(" ")[1]), ["left", "right", "left"]);
    },
    "model dodges honor forward and back configuration"() {
        for (const [dir, point] of [["forward", [175, 486]], ["back", [175, 652]]]) {
            const { dodges } = run({ dodgeDir: dir });
            assert.equal(dodges.length, 3);
            for (const d of dodges) assert.deepEqual(d.stick, point);
        }
    },
    "a grab threat without an explicit direction uses the configured direction"() {
        const { dodges } = run({ dodgeDir: "forward", flareThreat: true }, {
            contacts: [], tell: [[900, 1200, 2]],
        });
        assert.equal(dodges.length, 1);
        assert.deepEqual(dodges[0].stick, [175, 486]);
    },
    "explicit tell directions survive dispatch"() {
        const { dodges } = run({ dodgeDir: "cycle", tellAnchor: true }, {
            contacts: [], tell: [[900, 1200, 2], [3300, 3600, 2]],
        });
        assert.equal(dodges.length, 2);
        assert.deepEqual(dodges.map((d) => d.stick), [[175, 652], [92, 569]]);
    },
    "observe mode never emits touches"() {
        const { touches } = run({ observe: true });
        assert.equal(touches.length, 0);
    },
    "a pressed plan follows a contact that keeps drifting later"() {
        // One true contact at 3000 ms; the head first says 1400, then 2000, 2600, 3000. The old one-shot
        // `repressed` limit stopped after the first re-arm, leaving the stale pressed k0 in the slot (726 t2247/
        // t2592/t3572 and the t7251 flare slot). The scheduler must re-arm for each later contact.
        const { result } = run({ repress: true, repressMax: 2, trigTh: 0.45 }, {
            contacts: [], def: 1,
            futFn: (t) => t < 1200 ? 1400 : t < 1900 ? 2000 : t < 2400 ? 2600 : 3000,
        });
        const presses = result.events.filter((e) => e[2] === "press" && e[3].startsWith("parry"));
        const rearms = result.events.filter((e) => e[2] === "re-press");
        assert.ok(presses.length >= 3, `expected 3 parry presses, got ${presses.length}: ${presses.map((e) => e[3])}`);
        assert.ok(rearms.some((e) => e[3].includes("#2")), `expected a second re-arm: ${rearms.map((e) => e[3])}`);
        assert.ok(!rearms.some((e) => e[3].includes("#3")), `per-item cap exceeded: ${rearms.map((e) => e[3])}`);
    },
    "a grab label replaces the pending anchored dodge with a parry"() {
        // The live tell starts as flare_other (the anchored dodge is planned), then turns flare_grab before the
        // dodge's atMs. grabParry drops that pending dodge and presses the parry at the fresh contact's lead.
        const { result, dodges } = run({ tellAnchor: true, grabParry: true, flareAnchor: { flare_other: 14 }, trigTh: 2 }, {
            contacts: [], tell: [[900, 960, 1], [960, 1500, 2]], futFn: () => 1600,
        });
        assert.equal(dodges.length, 0, `grabParry still dodged: ${dodges.map((d) => d.at)}`);
        const parries = result.events.filter((e) => e[2] === "press" && e[3].startsWith("parry") && e[3].includes("grabParry"));
        assert.equal(parries.length, 1, `expected one grabParry press: ${result.events.filter((e) => e[2] === "press").map((e) => e[3])}`);
        assert.equal(result.v8.grab.plans, 1);
        assert.equal(result.v8.grab.replacedDodges, 1);
    },
    "without grabParry the grab label keeps the anchored dodge"() {
        const { result, dodges } = run({ tellAnchor: true, flareAnchor: { flare_other: 14 }, trigTh: 2 }, {
            contacts: [], tell: [[900, 960, 1], [960, 1500, 2]], futFn: () => 1600,
        });
        assert.equal(dodges.length, 1, `expected the anchored dodge: ${dodges.map((d) => d.at)}`);
        assert.ok(!result.events.some((e) => e[2] === "press" && e[3].includes("grabParry")), "unexpected grabParry press");
    },
    "a grab label inside the dodge CD does not add a parry"() {
        const { result, dodges } = run({ tellAnchor: true, grabParry: true, flareAnchor: { flare_other: 4 }, trigTh: 2 }, {
            contacts: [], tell: [[900, 1100, 1], [1100, 1300, 2]], futFn: () => 2000,
        });
        assert.equal(dodges.length, 1, "the anchored dodge should have fired before the grab label");
        assert.ok(!result.events.some((e) => e[2] === "press" && e[3].includes("grabParry")), "late grabParry press");
        assert.equal(result.v8.grab.plans, 0);
    },
    "the re-arm limit stays bounded"() {
        const { result } = run({ repress: true, repressMax: 1, trigTh: 0.45 }, {
            contacts: [], def: 1,
            futFn: (t) => t < 1200 ? 1400 : t < 1900 ? 2000 : t < 2400 ? 2600 : 3000,
        });
        const rearms = result.events.filter((e) => e[2] === "re-press");
        assert.ok(!rearms.some((e) => e[3].includes("#2")), `repressMax 1 must cap each item at #1: ${rearms.map((e) => e[3])}`);
    },
    "a re-armed parry becomes the dodge the later contact wants"() {
        // The 726 t7251 shape: a pressed parry holds k0; the fresh contact is later and the defense head turns
        // dodge. The re-arm must replace the action, not keep the old parry kind.
        const { result, dodges } = run({ repress: true, repressMax: 2, trigTh: 0.45 }, {
            contacts: [], def: 1, defFn: (t) => t < 1450 ? 1 : 2,
            futFn: (t) => t < 1200 ? 1400 : 2400,
        });
        assert.ok(dodges.length >= 1, "the later contact was not dodged");
        assert.ok(result.events.some((e) => e[2] === "press" && e[3].startsWith("dodge")), "no dodge press");
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
        const { result } = run({ ms: 5000, potions: 1, potionSafe: true, potionConfirm: true }, {
            hp, contacts: [], tell: [],
        });
        const hits = result.events.filter((e) => e[2] === "hit");
        assert.equal(hits.length, 1, `expected only the 40%->35% hit: ${hits.map((e) => e[3])}`);
        assert.ok(hits[0][3].startsWith("40%->35%"), `unexpected hit text: ${hits[0][3]}`);
        assert.ok(result.events.some((e) => e[2] === "potion" && e[3].startsWith("tap")), "the drink never went out");
        assert.equal(result.potion.healed, 1, `the heal was not counted: ${JSON.stringify(result.potion)}`);
        assert.equal(result.potion.fails, 0, `the heal was treated as a failed drink: ${JSON.stringify(result.potion)}`);
    },
    "a late potion heal after a hit during the drink is still counted"() {
        // Drink at 20%, take a real blow to 10%, then the delayed heal shows 50%: no hit on the rise, the late heal
        // counts, and the next real blow (50%->45%) is still detected.
        const hp = (t) => t < 1000 ? 0.20 : t < 2000 ? 0.10 : t < 3200 ? 0.50 : 0.45;
        const { result } = run({ ms: 4500, potions: 1, potionSafe: true, potionConfirm: true, potionRetryMs: 5000 }, {
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
