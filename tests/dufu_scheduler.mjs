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
    else if (y === 477 && x === 934) { // telemetry: the parry button's white glow (0 = not lit)
        const n = cfg.parryGlow ?? 0;
        return n > 0 ? { hit: true, results: [{ box: [934, 477, 36, 36], count: n }] } : { hit: false, results: [] };
    } else if (y === 656 && x === 906) { // telemetry: the dodge button's white flash
        const n = cfg.dodgeGlow ?? 0;
        return n > 0 ? { hit: true, results: [{ box: [906, 656, 36, 36], count: n }] } : { hit: false, results: [] };
    } else if (y === 120 && x === 150) { // telemetry: the golden grab line (log-only)
        const n = typeof cfg.goldLine === "function" ? cfg.goldLine(time) : cfg.goldLine ?? 0;
        return n > 0 ? { hit: true, results: [{ box: [150, 120, 780, 60], count: n }] } : { hit: false, results: [] };
    }
    return box ? { hit: true, results: [{ box, count: 999 }] } : { hit: false, results: [] };
};
globalThis.infer = (model) => {
    if (model.includes("flare3")) return { ready: true, probs: cfg.flare3 ?? [0.10, 0.80, 0.10] };
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
    "telemetry off adds no events or touches"() {
        // The switch must be invisible when false: same deterministic events, same presses, same touch stream.
        const opts = { contacts: [1500, 3000, 4500], def: 1, hp: () => 1 };
        const base = run({ trigTh: 0.45 }, opts);
        const off = run({ trigTh: 0.45, telemetry: false }, opts);
        assert.deepEqual(off.result.presses, base.result.presses);
        assert.deepEqual(off.touches, base.touches);
        assert.deepEqual(off.result.events.map((e) => [e[1], e[2], e[3]]), base.result.events.map((e) => [e[1], e[2], e[3]]));
        assert.ok(!off.result.events.some((e) => e[2] === "press result" || e[2] === "state"), "telemetry events with the switch off");
    },
    "telemetry logs def1 probabilities and a 5-10f parry result"() {
        const opts = { contacts: [1500, 3000, 4500], def: 1, hp: (t) => t < 1200 ? 0.80 : 0.70, parryGlow: 210 };
        const on = run({ trigTh: 0.45, telemetry: true }, opts);
        const off = run({ trigTh: 0.45 }, opts);
        assert.deepEqual(on.result.presses, off.result.presses, "telemetry changed the press counts");
        assert.equal(on.touches.length, off.touches.length, "telemetry changed the touch count");
        const preds = on.result.events.filter((e) => e[2] === "pred");
        assert.ok(preds.length > 0, "no pred events");
        assert.ok(preds.every((e) => e[3].includes("def1 p ") && e[3].includes("arg ")), `pred without def1 p0-p4: ${preds[0]?.[3]}`);
        const results = on.result.events.filter((e) => e[2] === "press result");
        const fresh = results.filter((e) => !e[3].includes("read window missed"));
        assert.ok(fresh.length > 0, "no press result after a parry");
        for (const e of fresh) {
            const f = Number(/delay=(\d+)f/.exec(e[3])?.[1]);
            assert.ok(f >= 5 && f <= 10, `press result outside 5-10f: ${e[3]}`);
        }
        assert.ok(fresh.some((e) => e[3].startsWith("parry lit")), `no lit parry: ${results.map((e) => e[3])}`);
        assert.ok(fresh.every((e) => e[3].includes("stance=unknown")), "the unread stance must say unknown");
        assert.ok(fresh.every((e) => /off=\S+ busy=\d+ms grab=[01]/.test(e[3])), `missing own-action/grab context: ${fresh[0]?.[3]}`);
        const lates = on.result.events.filter((e) => e[2] === "press late");
        assert.ok(lates.length > 0, "no second press read");
        for (const e of lates) {
            const f = Number(/delay=(\d+)f/.exec(e[3])?.[1]);
            assert.ok(f >= 14 && f <= 18, `late read outside 14-18f: ${e[3]}`);
            assert.ok(/early=(lit|none|unknown)/.test(e[3]), `late read lost the early state: ${e[3]}`);
        }
        assert.ok(on.result.events.some((e) => e[2] === "state" && e[3].startsWith("hp ")), "no hp state mark");
        assert.ok(on.result.events.some((e) => e[2] === "state" && e[3].startsWith("stagger ")), "no stagger state mark");
    },
    "telemetry logs curtain would-plan without pressing"() {
        const opts = { contacts: [1500], tell: [[300, 900, 5]] };
        const on = run({ trigTh: 0.45, telemetry: true }, opts);
        const off = run({ trigTh: 0.45 }, opts);
        assert.deepEqual(on.result.presses, off.result.presses, "would-plan changed the press counts");
        assert.equal(on.touches.length, off.touches.length, "would-plan changed the touch count");
        const w = on.result.events.filter((e) => e[2] === "would-plan");
        assert.ok(w.length > 0, "no curtain would-plan mark");
        assert.ok(w.some((e) => /k\d/.test(e[3])), `would-plan never saw a contact: ${w.map((e) => e[3])}`);
        assert.ok(!off.result.events.some((e) => e[2] === "would-plan"), "would-plan with telemetry off");
    },
    "telemetry logs the golden grab line without pressing"() {
        const on = run({ telemetry: true }, { contacts: [1500], goldLine: 30000 });
        const off = run({}, { contacts: [1500], goldLine: 30000 });
        assert.deepEqual(on.result.presses, off.result.presses, "goldline changed the press counts");
        assert.equal(on.touches.length, off.touches.length, "goldline changed the touch count");
        assert.ok(on.result.events.some((e) => e[2] === "goldline" && e[3].startsWith("on")), "no goldline on");
        assert.ok(!off.result.events.some((e) => e[2] === "goldline"), "goldline with telemetry off");
    },
    "grabContactDodge waits for a slow grab's contact and drops the fut dodge"() {
        // User-confirmed mechanism: the catch is the boss hand/weapon contact, ~10 f before the delayed hp drop
        // (c1). A fut dodge at c1-14 must not take the dodge CD first.
        const { result, dodges } = run({ tellAnchor: true, grabContactDodge: true }, {
            contacts: [], tell: [[900, 1500, 2]], futFn: () => 2000,
        });
        assert.equal(dodges.length, 1, `expected one contact dodge: ${dodges.map((d) => d.at)}`);
        const presses = result.events.filter((e) => e[2] === "press" && e[3].startsWith("dodge"));
        assert.equal(presses.length, 1, `unexpected dodge presses: ${presses.map((e) => e[3])}`);
        assert.ok(presses[0][3].includes(" contact "), `not a contact dodge: ${presses[0][3]}`);
        assert.ok(presses[0][1] >= 1600, `the contact dodge went too early: ${presses[0][1]}`);
        assert.equal(result.v8.grabContact.plans, 1);
        assert.ok(result.v8.grabContact.droppedFut >= 1, `did not drop the fut dodge: ${JSON.stringify(result.v8.grabContact)}`);
        assert.ok(!result.events.some((e) => e[2] === "press" && e[3].startsWith("dodge") && e[1] < 1500), "an early fut dodge still went");
    },
    "grabContactDodge leaves a fast grab on the anchor"() {
        // c1 < grabContactMinF (18 f): the catch is already at tell+1-2 f, so the contact rule must not move it later.
        const { result } = run({ tellAnchor: true, grabContactDodge: true }, {
            contacts: [], tell: [[900, 1500, 2]], futFn: () => 1000,
        });
        assert.equal(result.v8.grabContact.plans, 0, `a fast grab got a contact dodge: ${JSON.stringify(result.v8.grabContact)}`);
        assert.ok(result.v8.grabContact.fastKept >= 1, `fast grab not counted: ${JSON.stringify(result.v8.grabContact)}`);
        assert.ok(result.events.some((e) => e[2] === "press" && e[3].startsWith("dodge") && e[3].includes(" anchor ")),
            `the fast grab lost the anchor: ${result.events.filter((e) => e[2] === "press").map((e) => e[3])}`);
    },
    "grabContactDodge off does not change the grab dodge"() {
        const opts = { contacts: [], tell: [[900, 1500, 2]], futFn: () => 2000 };
        const base = run({ tellAnchor: true }, opts);
        const off = run({ tellAnchor: true, grabContactDodge: false }, opts);
        assert.deepEqual(off.result.events.map((e) => [e[1], e[2], e[3]]), base.result.events.map((e) => [e[1], e[2], e[3]]));
        assert.deepEqual(off.touches, base.touches);
        assert.equal(off.result.v8?.grabContact, undefined);
    },
    "grabClass logs the flare3 grab probability without pressing"() {
        const opts = { contacts: [], tell: [[900, 1500, 2]], futFn: () => 2000, flare3: [0.10, 0.80, 0.10] };
        const on = run({ grabClass: true }, opts);
        const off = run({}, opts);
        assert.deepEqual(on.result.presses, off.result.presses, "grabClass changed the press counts");
        assert.equal(on.touches.length, off.touches.length, "grabClass changed the touch count");
        const marks = on.result.events.filter((e) => e[2] === "grabclass");
        assert.equal(marks.length, 1, `expected one grabclass mark: ${marks.map((e) => e[3])}`);
        assert.ok(marks[0][3].includes("p 0.10/0.80/0.10 arg grab"), `unexpected grabclass: ${marks[0][3]}`);
        assert.equal(on.result.v8.grabClass.grab, 1);
        assert.ok(!off.result.events.some((e) => e[2] === "grabclass"), "grabclass with the switch off");
        assert.equal(off.result.v8?.grabClass, undefined);
    },
    "telemetry reads a dodge press without extra touches"() {
        const opts = { contacts: [1500, 3000], def: 2, dodgeGlow: 600 };
        const on = run({ trigTh: 0.45, telemetry: true }, opts);
        const off = run({ trigTh: 0.45 }, opts);
        assert.deepEqual(on.result.presses, off.result.presses, "telemetry changed the press counts");
        assert.equal(on.touches.length, off.touches.length, "telemetry changed the touch count");
        const results = on.result.events.filter((e) => e[2] === "press result" && e[3].startsWith("dodge"));
        assert.ok(results.length > 0, "no dodge press result");
        assert.ok(results.some((e) => e[3].startsWith("dodge lit")), `no lit dodge: ${results.map((e) => e[3])}`);
    },
};

let failures = 0;
for (const [name, test] of Object.entries(tests)) {
    try { test(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failures) process.exitCode = 1;
