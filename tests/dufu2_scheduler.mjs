import assert from "node:assert/strict";
import dufu2 from "../workspaces/WhereWindsMeet/skills/dufu2.js";
import { POINTS, T0, fightTouches, frameMs, runFake } from "./dufu2_fake.mjs";
import { SCENARIOS } from "./dufu2_scenarios.mjs";

// Behavioral regression tests for dufu2.js (phases 1 and 2) against a deterministic fake world.
// The head logits are constructed from the scenario's contact timeline; no model / screenshot is used.
const near = (a, b, tol = frameMs + 1) => Math.abs(a - b) <= tol;
const downs = (ts, p) => ts.filter((t) => t.op === "down" && t.id !== 0 && t.p[0] === p[0] && t.p[1] === p[1]);
const parryDowns = (ts) => downs(ts, POINTS.PARRY);
const dodgeDowns = (ts) => downs(ts, POINTS.DODGE);
const drinkDowns = (ts) => downs(ts, POINTS.POTION);

/** Run one shared scenario; `ms` is the fight's share (phase-1 prep is extra). */
function run(name, overrides = {}) {
    const s = SCENARIOS[name]();
    const ms = (s.mode === "defend" ? T0[s.phase] : 0) + s.fightMs;
    return runFake(dufu2, { mode: s.mode, phase: s.phase, ms, ...s.args, ...overrides }, s.scenario);
}

const tests = {
    "phase 1: a normal contact is 卸势 with the final 10-frame lead"() {
        const { result, touches, t0 } = run("parry");
        assert.equal(t0, T0[1], `fight t0 changed: ${t0}`);
        const ts = fightTouches(touches, t0);
        const taps = parryDowns(ts);
        assert.equal(taps.length, 1, `卸势 taps: ${taps.map((t) => t.at)}`);
        assert.ok(near(taps[0].at, t0 + 1500 - 10 * frameMs), `press at ${taps[0].at} vs ${t0 + 1500 - 10 * frameMs}`);
        assert.equal(taps[0].id, 1);
        assert.equal(dodgeDowns(ts).length, 0, "a dodge on a parry contact");
        assert.equal(result.presses.parry, 1);
        assert.ok(result.pressLog.some(([, kind, , , , , , remF, lead]) => kind === "parry" && Math.abs(lead - 10) < 1e-9 && remF >= 9 && remF <= 10.1),
            `pressLog: ${JSON.stringify(result.pressLog)}`);
        // the tap is lifted ~50 ms later on contact 1 (the next tick)
        const up = ts.find((t) => t.op === "up" && t.id === 1);
        assert.ok(up && up.at >= taps[0].at + 50 && up.at <= taps[0].at + 50 + 2 * frameMs, `up: ${up?.at}`);
        // args.parryLead still overrides (the old A/B switch)
        const early = run("parryLead6");
        const et = parryDowns(fightTouches(early.touches, early.t0))[0];
        assert.ok(near(et.at, T0[1] + 1500 - 6 * frameMs), `parryLead 6 press at ${et.at}`);
    },
    "phase 1: a gold contact is dodged, never 卸势"() {
        const { result, touches, t0 } = run("gold");
        const ts = fightTouches(touches, t0);
        assert.equal(parryDowns(ts).length, 0, "a 卸势 on gold");
        const ds = dodgeDowns(ts);
        assert.equal(ds.length, 1, `dodge taps: ${ds.map((t) => t.at)}`);
        assert.ok(near(ds[0].at, t0 + 1500 - 5 * frameMs), `dodge at ${ds[0].at}`);
        // the dodge's own left/right on contact 0, then contact 2
        const idx = ts.indexOf(ds[0]);
        const move = ts.slice(0, idx).reverse().find((t) => t.op === "move" && t.id === 0);
        assert.deepEqual(move?.p, POINTS.LEFT, `dodge stick: ${JSON.stringify(move)}`);
        assert.equal(result.presses.dodge, 1);
        assert.ok(result.pressLog.some(([, kind, , gold]) => kind === "dodge" && gold >= 0.9), "pressLog gold not read");
    },
    "phase 1: 幕布 covered falls back to one 闪避"() {
        const { result, touches, t0 } = run("curtainCovered");
        const ts = fightTouches(touches, t0);
        assert.equal(result.curtain.enters, 1, JSON.stringify(result.curtain));
        assert.equal(result.curtain.dodges, 1, JSON.stringify(result.curtain));
        const ds = dodgeDowns(ts);
        assert.equal(ds.length, 1, `dodges: ${ds.map((t) => t.at)}`);
        assert.ok(ds[0].at >= t0 + 1800 && ds[0].at <= t0 + 2200, `covered dodge at ${ds[0].at - t0} ms`);
        assert.ok(result.pressLog.some(([, kind, , , , , , , , src]) => kind === "dodge" && src === "curtain"), "not the curtain dodge");
    },
    "phase 1: 幕布 gap walk (args.curtainGap true) pushes the stick to the gap"() {
        const { result, touches, t0 } = run("curtainGap");
        const ts = fightTouches(touches, t0);
        assert.equal(result.curtain.gap, true);
        const side = ts.find((t) => t.op === "move" && t.id === 0 && t.at >= t0 + 1000);
        assert.ok(side, "no gap walk");
        assert.deepEqual(side.p, POINTS.RIGHT, `gap push: ${JSON.stringify(side)}`);
        // default (curtainGap false) leaves the stick alone in a gap
        const off = run("curtainGap", { curtainGap: false });
        assert.ok(!fightTouches(off.touches, off.t0).some((t) => t.op === "move" && t.id === 0 && t.at >= off.t0 + 1000), "gap walk without the switch");
    },
    "low hp: miss the slot twice, swap the potion in, then drink"() {
        const { result, touches, t0 } = run("potion");
        assert.equal(t0, T0[2], `fight t0 ${t0}`);
        const ts = fightTouches(touches, t0);
        const open = downs(ts, POINTS.ITEM_OPEN), pick = downs(ts, POINTS.ITEM_PICK), drink = drinkDowns(ts);
        assert.equal(open.length, 1, `slot opens: ${open.map((t) => t.at)}`);
        assert.equal(pick.length, 1, `slot picks: ${pick.map((t) => t.at)}`);
        assert.equal(drink.length, 1, `drinks: ${drink.map((t) => t.at)}`);
        assert.ok(pick[0].at >= open[0].at + 550, `pick ${pick[0].at} vs open ${open[0].at}`);
        assert.ok(drink[0].at >= pick[0].at + 550, `drink ${drink[0].at} vs pick ${pick[0].at}`);
        assert.equal(result.potion.taps, 1, JSON.stringify(result.potion));
        assert.equal(result.potion.used, 1, JSON.stringify(result.potion));
        assert.equal(result.potion.fails, 0, JSON.stringify(result.potion));
    },
    "phase 2: the 火球雨 runs first, then dodges along the run"() {
        const { result, touches, t0 } = run("c7");
        assert.equal(t0, 0);
        const ts = fightTouches(touches, t0);
        const moves = ts.filter((t) => t.op === "move" && t.id === 0 && t.p[1] > 570);
        assert.ok(moves.length >= 1, `run moves: ${moves.map((t) => [t.at, t.p])}`);
        assert.deepEqual(moves[0].p, [234, 628], `run direction: ${JSON.stringify(moves[0].p)}`);
        const ds = dodgeDowns(ts);
        assert.equal(ds.length, 1, `dodges: ${ds.map((t) => t.at)}`);
        assert.ok(ds[0].at > moves[0].at, "the dodge came before the run");
        assert.deepEqual(ds[0].stick, [234, 628], `dodge stick changed the run: ${JSON.stringify(ds[0].stick)}`);
        assert.ok(!ts.some((t) => t.op === "move" && t.id === 0 && (t.p[0] === POINTS.LEFT[0] || t.p[0] === POINTS.RIGHT[0]) && t.at > moves[0].at),
            "a left/right dodge move during the run");
        assert.equal(result.presses.run, 1);
        assert.equal(result.presses.dodge, 1);
        assert.equal(result.run.runs.length, 1, JSON.stringify(result.run));
        assert.equal(result.run.runs[0][1], "diag");
        assert.equal(result.run.runs[0][4], 1, "the run's dodge count");
    },
    "shadow: no defense touch, the would counters follow the decision"() {
        const { result, touches } = run("shadow");
        assert.equal(touches.filter((t) => t.id !== 3).length, 0, `shadow touches: ${JSON.stringify(touches)}`);
        assert.equal(result.would.dodge, 3, `would: ${JSON.stringify(result.would)}`);
        assert.equal(result.would.parry, 0);
        assert.equal(result.presses.dodge + result.presses.parry, 0);
        assert.equal(result.pressLog.filter((p) => String(p[1]).startsWith("would-")).length, 3);
    },
    "phase 1: curtain2 (default on) dodges the second sweep the resp head parries"() {
        const { result, touches, t0 } = run("curtain2"); // k1:c18, table says parry
        const ts = fightTouches(touches, t0);
        assert.equal(parryDowns(ts).length, 0, "a 卸势 on k1:c18");
        assert.equal(dodgeDowns(ts).length, 1, "no curtain2 dodge");
        assert.equal(result.curtain2.presses, 1, JSON.stringify(result.curtain2));
        assert.ok(result.pressLog.some(([, kind, , , , , , , , src]) => kind === "dodge" && src === "curtain2"));
        // args.curtain2 false keeps the resp head's 卸势 (the old A/B switch)
        const off = run("curtain2Off");
        assert.equal(parryDowns(fightTouches(off.touches, off.t0)).length, 1, "curtain2 false did not parry");
        assert.equal(off.result.curtain2, null);
    },
    "the pipeline is glob, crop, crop, head with the phase's head width"() {
        for (const [name, width] of [["parry", 151]]) {
            const { calls, result } = run(name);
            assert.equal(calls.length, 4 + 4 * result.looks, `calls ${calls.length} / looks ${result.looks}`);
            for (let i = 0; i < calls.length; i += 4) {
                assert.deepEqual(calls.slice(i, i + 4).map((c) => c.kind), ["glob", "crop", "crop", "head"], `tick ${i / 4}`);
                assert.deepEqual(calls.slice(i, i + 3).map((c) => c.len), [128, 96, 96]);
                assert.equal(calls[i + 3].len, width);
            }
        }
        const p2 = run("p2parry");
        assert.equal(p2.calls[3].len, 141);
    },
    "pair off: no pair event and no saved frame"() {
        const { result, sent } = run("pairOff");
        assert.equal(result.pair, null);
        assert.ok(sent.every((e) => e.name !== "dufu2_pair"));
    },
};

let failures = 0;
for (const [name, test] of Object.entries(tests)) {
    try { test(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failures) process.exitCode = 1;
