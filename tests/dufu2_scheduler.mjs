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
/** 进攻 v2 touches: contact 3 only (never the defense's 0-2) */
const atk3 = (ts, p) => ts.filter((t) => t.op === "down" && t.id === 3 && t.p[0] === p[0] && t.p[1] === p[1]);
const atk3All = (ts) => ts.filter((t) => t.op === "down" && t.id === 3);

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
    // ---- 进攻 v2 (lib/dufu-offense.js through dufu2.js; offense:"off" is the 10 defense tests above) ----
    "offense v2: the 处决 button wins the tick (no 奇术 / 轻击), even without the near gate"() {
        const { result, touches, t0, sent } = run("offExecute");
        const ts = fightTouches(touches, t0);
        const ex = atk3(ts, POINTS.EXECUTE);
        assert.equal(ex.length, 1, `处决 taps: ${ex.map((t) => t.at - t0)}`);
        const all = atk3All(ts);
        assert.equal(all[0].p[0], POINTS.EXECUTE[0], `first offense touch: ${JSON.stringify(all[0])}`);
        assert.ok(all[0].at <= t0 + 100, `处决 at ${all[0].at - t0}`);
        assert.equal(all.filter((t) => t.at < all[0].at).length, 0);
        assert.equal(result.offense.actions.execute, 1, JSON.stringify(result.offense));
        // no ok / boss drop here: the execute log records near = false (the trace range proxy stays 0 too)
        const press = result.offense.log.find((e) => e.ev === "press" && e.a === "execute");
        assert.equal(press.near, false, JSON.stringify(press));
        const ev = sent.find((e) => e.name === "dufu2_trace");
        const c = Object.fromEntries(ev.data.cols.map((k, i) => [k, i]));
        const er = ev.data.rows.find((r) => r[c.atkTier] === 1);
        assert.ok(er, "no execute row in the trace");
        assert.equal(er[c.range], 0, "execute must keep the near-gate proxy at 0");
    },
    "offense v2: a chain-ending ok opens a long window for 奇术"() {
        const { result, touches, t0 } = run("offQishu");
        const ts = fightTouches(touches, t0);
        const qs = atk3(ts, POINTS.QISHU);
        assert.equal(qs.length, 1, `奇术 taps: ${qs.map((t) => t.at - t0)}`);
        assert.ok(qs[0].at >= t0 + 800 && qs[0].at <= t0 + 1000, `奇术 at ${qs[0].at - t0} (the ok is at 800)`);
        assert.equal(atk3(ts, POINTS.LIGHT).length, 0, "轻击 instead of 奇术");
        assert.equal(result.offense.actions.qishu, 1, JSON.stringify(result.offense.actions));
        assert.ok(near(result.offense.qAvg, 0.85, 1e-9), `qAvg ${result.offense.qAvg}`);
    },
    "offense v2: phase 1 switches to 横刀 once, then 轻击 (touch order)"() {
        const { result, touches, t0 } = run("offLight");
        const ts = fightTouches(touches, t0);
        const sw = atk3(ts, POINTS.SWITCH), li = atk3(ts, POINTS.LIGHT);
        assert.equal(sw.length, 1, `switches: ${sw.map((t) => t.at - t0)}`);
        assert.ok(li.length >= 1, `light taps: ${li.map((t) => t.at - t0)}`);
        assert.ok(sw[0].at < li[0].at, `light ${li[0].at - t0} before the switch ${sw[0].at - t0}`);
        assert.equal(result.offense.switches, 1);
        assert.ok(result.offense.actions.light >= 1);
        assert.ok(result.offense.log.some((e) => e.ev === "land" && e.tier === 3 && e.q === 0.7), JSON.stringify(result.offense.log));
        assert.ok(result.offense.log.some((e) => e.ev === "press" && e.a === "switch" && e.near === true), "the ok did not open the near gate");
        // no LIGHT on contact 3 before the switch (the switch itself is the only earlier touch)
        assert.ok(atk3All(ts.filter((t) => t.at < sw[0].at)).length === 0, "an offense touch before the switch");
    },
    "offense v2: a live chain (next.share >= .2 within 30 f) blocks, then the quiet window opens"() {
        const { result, touches, t0 } = run("offChain");
        const ts = fightTouches(touches, t0);
        assert.equal(result.oks, 1, JSON.stringify(result.contacts));
        const early = atk3All(ts).filter((t) => t.at >= t0 + 700 && t.at < t0 + 1650);
        assert.equal(early.length, 0, `contact-3 touches inside 30 f: ${JSON.stringify(early)}`);
        assert.ok(atk3(ts, POINTS.LIGHT).some((t) => t.at >= t0 + 1700), "no 轻击 after the chain cleared");
        assert.ok(result.offense.actions.light >= 1, JSON.stringify(result.offense.log));
    },
    "offense v2: the 金光火球 window blocks until it is over"() {
        const { result, touches, t0 } = run("offGoldFireball");
        const ts = fightTouches(touches, t0);
        assert.ok(dodgeDowns(ts).length >= 1, "no opening dodge");
        assert.equal(result.goldSeq.length, 1, JSON.stringify(result.goldSeq));
        const ps = atk3All(ts);
        assert.ok(ps.length >= 1, "no offense after the gold window");
        const inside = ps.filter((t) => t.at >= t0 + 900 && t.at < t0 + 5940);
        assert.equal(inside.length, 0, `offense inside the window: ${inside.map((t) => t.at - t0)}`);
        assert.ok(ps.some((t) => t.at >= t0 + 5940), `no offense after the window: ${ps.map((t) => t.at - t0)}`);
        // the extra dodges are the gold fireball cadence, not offense (contact 3)
        assert.ok(dodgeDowns(ts)[0].at <= t0 + 1000, `first dodge at ${dodgeDowns(ts)[0].at - t0}`);
    },
    "offense v2: a c11/c40 contact keeps the offense off for 2.5 s, then it recovers"() {
        const { result, touches, t0, sent } = run("offGoldContact");
        const ts = fightTouches(touches, t0);
        assert.equal(result.hits, 1, JSON.stringify(result.contacts));
        const early = atk3All(ts).filter((t) => t.at >= t0 + 1000 && t.at < t0 + 3300);
        assert.equal(early.length, 0, `contact-3 touches inside the c11 quiet: ${JSON.stringify(early)}`);
        assert.ok(atk3(ts, POINTS.LIGHT).some((t) => t.at >= t0 + 3330 && t.at <= t0 + 3600),
            `no recovery light: ${atk3(ts, POINTS.LIGHT).map((t) => t.at - t0)}`);
        const ev = sent.find((e) => e.name === "dufu2_trace");
        const c = Object.fromEntries(ev.data.cols.map((k, i) => [k, i]));
        assert.ok(ev.data.rows.some((r) => r[c.atkReason] === 15), "no gold T0 in the trace");
    },
    "offense v2: a phase-1 k2:c11 contact (dodge/unparryable) blocks for 2.5 s too"() {
        const { result, touches, t0, sent } = run("offGoldContactP1");
        const ts = fightTouches(touches, t0);
        assert.equal(result.hits, 1, JSON.stringify(result.contacts));
        const early = atk3All(ts).filter((t) => t.at >= t0 + 1000 && t.at < t0 + 3300);
        assert.equal(early.length, 0, `contact-3 touches inside the phase-1 c11 quiet: ${JSON.stringify(early)}`);
        assert.ok(atk3(ts, POINTS.LIGHT).some((t) => t.at >= t0 + 3330 && t.at <= t0 + 3600),
            `no recovery light: ${atk3(ts, POINTS.LIGHT).map((t) => t.at - t0)}`);
        const ev = sent.find((e) => e.name === "dufu2_trace");
        const c = Object.fromEntries(ev.data.cols.map((k, i) => [k, i]));
        assert.ok(ev.data.rows.some((r) => r[c.atkReason] === 15), "no gold T0 in the trace");
    },
    "offense v2: the 火球雨 (run) blocks; the same group without c7 acts"() {
        const { result, touches, t0 } = run("offRain");
        const ts = fightTouches(touches, t0);
        assert.equal(result.presses.run, 1, JSON.stringify(result.run));
        const inside = atk3All(ts).filter((t) => t.at >= t0 + 450);
        assert.equal(inside.length, 0, `offense during the rain: ${JSON.stringify(inside)}`);
        const free = run("offRainFree");
        assert.equal(free.result.presses.run, 0);
        assert.ok(atk3(fightTouches(free.touches, free.t0), POINTS.LIGHT).length >= 1, "no 轻击 without the rain");
    },
    "offense v2: the blue disc is followed; without it there is no follow"() {
        const { result, touches, t0 } = run("offFollow");
        const ts = fightTouches(touches, t0);
        const he = atk3(ts, POINTS.HEAVY);
        assert.ok(he.length >= 1, "no follow tap");
        assert.ok(he[0].at >= t0 + 400 && he[0].at <= t0 + 700, `follow at ${he[0].at - t0}`);
        assert.equal(result.offense.actions.follow, he.length);
        const off = run("offFollowOff");
        assert.equal(atk3(fightTouches(off.touches, off.t0), POINTS.HEAVY).length, 0, "a follow without the disc");
        assert.equal(off.result.offense.actions.follow, 0);
        assert.ok(atk3(fightTouches(off.touches, off.t0), POINTS.LIGHT).length >= 1, "no 轻击 without the disc");
    },
    "offense v2: a phase-1 k2:c11 gold tell cancels the pending switch (reason gold)"() {
        const { result, touches, t0 } = run("offPreemptGold");
        const ts = fightTouches(touches, t0);
        assert.equal(atk3(ts, POINTS.SWITCH).length, 1, "the switch was not started");
        assert.equal(atk3(ts, POINTS.LIGHT).length, 0, "轻击 after the gold tell");
        assert.ok(result.offense.cancels.gold >= 1, JSON.stringify(result.offense.cancels));
        assert.ok(result.offense.log.some((e) => e.ev === "cancel" && e.why === "gold"), JSON.stringify(result.offense.log));
    },
    "offense v2: a defense press due cancels the pending switch (reason defense)"() {
        const { result, touches, t0 } = run("offPreemptDefense");
        const ts = fightTouches(touches, t0);
        assert.equal(parryDowns(ts).length, 1, "the defense press is missing");
        assert.ok(result.offense.cancels.defense >= 1, JSON.stringify(result.offense.cancels));
        assert.equal(atk3(ts, POINTS.LIGHT).length, 0);
        assert.ok(atk3(ts, POINTS.SWITCH).length >= 1);
    },
    "offense v2: a held 陌刀 蓄力 is released on a gold tell (cancel reason gold)"() {
        const { result, touches, t0 } = run("offChargePreempt");
        const ts = fightTouches(touches, t0);
        const he = atk3(ts, POINTS.HEAVY);
        assert.equal(he.length, 1, `charge taps: ${he.map((t) => t.at - t0)}`);
        assert.equal(result.offense.actions.charge, 1, JSON.stringify(result.offense.actions));
        const up = ts.find((t) => t.op === "up" && t.id === 3 && t.at > he[0].at);
        assert.ok(up && up.at >= t0 + 880 && up.at <= t0 + 1000, `release at ${up?.at - t0}`);
        assert.ok(result.offense.cancels.gold >= 1, JSON.stringify(result.offense.cancels));
        assert.ok(result.offense.log.some((e) => e.ev === "cancel" && e.a === "charge" && e.why === "gold"),
            JSON.stringify(result.offense.log));
    },
    "offense v2: no ok / boss drop (no near) -> no light at all"() {
        const { result, touches, t0, sent } = run("offNearNone");
        const ts = fightTouches(touches, t0);
        assert.equal(atk3All(ts).length, 0, `contact-3 touches without near: ${JSON.stringify(atk3All(ts))}`);
        assert.equal(result.offense.presses, 0, JSON.stringify(result.offense.log));
        const ev = sent.find((e) => e.name === "dufu2_trace");
        const c = Object.fromEntries(ev.data.cols.map((k, i) => [k, i]));
        assert.ok(ev.data.rows.some((r) => r[c.atkReason] === 26), "no near reason in the trace");
    },
    "offense v2: a boss-bar drop opens the near gate -> light"() {
        const { result, touches, t0 } = run("offNearDrop");
        const ts = fightTouches(touches, t0);
        const li = atk3(ts, POINTS.LIGHT);
        assert.ok(li.length >= 1, "no light after the boss drop");
        assert.ok(li[0].at >= t0 + 700 && li[0].at <= t0 + 1000, `light at ${li[0].at - t0}`);
        assert.ok(result.offense.log.some((e) => e.ev === "press" && e.a === "light" && e.near === true), JSON.stringify(result.offense.log));
    },
    "offense v2: an ok with no group is unknown for 30 f, then the quiet window opens"() {
        const { result, touches, t0, sent } = run("offUnknownContact");
        const ts = fightTouches(touches, t0);
        assert.equal(result.oks, 1, JSON.stringify(result.contacts));
        const early = atk3All(ts).filter((t) => t.at >= t0 + 750 && t.at < t0 + 1650);
        assert.equal(early.length, 0, `contact-3 touches in the unknown window: ${JSON.stringify(early)}`);
        assert.ok(atk3(ts, POINTS.LIGHT).some((t) => t.at >= t0 + 1700), "no light after 30 f");
        const ev = sent.find((e) => e.name === "dufu2_trace");
        const c = Object.fromEntries(ev.data.cols.map((k, i) => [k, i]));
        assert.ok(ev.data.rows.some((r) => r[c.atkReason] === 27), "no unknown reason in the trace");
    },
    "offense v2: the opening 奇术 fires without near; no 奇术 ready gives no opening touch"() {
        const { result, touches, t0 } = run("offOpeningQishu");
        const ts = fightTouches(touches, t0);
        const qs = atk3(ts, POINTS.QISHU);
        assert.equal(qs.length, 1, `opening 奇术 taps: ${qs.map((t) => t.at - t0)}`);
        assert.ok(qs[0].at <= t0 + 100, `opening 奇术 at ${qs[0].at - t0}`);
        assert.equal(atk3(ts, POINTS.LIGHT).length, 0, "light in the opening without near");
        assert.equal(result.offense.actions.qishu, 1, JSON.stringify(result.offense.actions));
        const p = result.offense.log.find((e) => e.ev === "press" && e.a === "qishu");
        assert.equal(p.near, false, JSON.stringify(p));
        // the same opening with no 奇术 ready: offNearNone (phase 2, bar up, no qishu, no near) has no touch at all
        const none = run("offNearNone");
        assert.equal(atk3All(fightTouches(none.touches, none.t0)).length, 0);
    },
    "offense v2: a switch whose window went stale is canceled, never tapped"() {
        const { result, touches, t0, sent } = run("offSwitchStale");
        const ts = fightTouches(touches, t0);
        assert.equal(result.oks, 1, JSON.stringify(result.contacts));
        assert.equal(result.offense.switches, 1, JSON.stringify(result.offense.log));
        assert.ok(result.offense.cancels.stale >= 1, JSON.stringify(result.offense.cancels));
        assert.ok(result.offense.log.some((e) => e.ev === "cancel" && e.a === "light" && e.why === "stale"),
            JSON.stringify(result.offense.log));
        assert.equal(atk3(ts, POINTS.LIGHT).filter((t) => t.at < t0 + 1700).length, 0, "a light after the stale switch");
        assert.ok(atk3(ts, POINTS.LIGHT).some((t) => t.at >= t0 + 1700), "no clean light after the stale window");
        const ev = sent.find((e) => e.name === "dufu2_trace");
        const c = Object.fromEntries(ev.data.cols.map((k, i) => [k, i]));
        assert.ok(ev.data.rows.some((r) => r[c.atkReason] === 28), "no stale reason in the trace");
    },
    "offense v2: a switch confirmed after the near gate expired is stale too"() {
        const { result, touches, t0 } = run("offSwitchNearExpired");
        const ts = fightTouches(touches, t0);
        assert.ok(result.offense.switches >= 1, JSON.stringify(result.offense.log));
        assert.ok(result.offense.cancels.stale >= 1, JSON.stringify(result.offense.cancels));
        assert.equal(atk3(ts, POINTS.LIGHT).length, 0, "a light without near");
        assert.ok(result.offense.log.some((e) => e.ev === "cancel" && e.why === "stale" && e.a === "light"),
            JSON.stringify(result.offense.log));
    },
    "offense v2: the commit horizon vetoes a start when a contact is likely inside the animation"() {
        const { result, touches, t0, sent } = run("offHorizonHigh");
        const ts = fightTouches(touches, t0);
        assert.equal(atk3All(ts).length, 0, `contact-3 touches above the horizon: ${JSON.stringify(atk3All(ts))}`);
        assert.equal(result.offense.presses, 0, JSON.stringify(result.offense.log));
        const ev = sent.find((e) => e.name === "dufu2_trace");
        const c = Object.fromEntries(ev.data.cols.map((k, i) => [k, i]));
        assert.ok(ev.data.rows.some((r) => r[c.atkReason] === 29), "no horizon reason in the trace");
    },
    "offense v2: a low commit horizon starts the light"() {
        const { result, touches, t0 } = run("offHorizonLow");
        const ts = fightTouches(touches, t0);
        const li = atk3(ts, POINTS.LIGHT);
        assert.ok(li.length >= 1, "no light below the horizon");
        assert.ok(li[0].at >= t0 + 700 && li[0].at <= t0 + 1000, `light at ${li[0].at - t0}`);
        assert.ok(result.offense.log.some((e) => e.ev === "press" && e.a === "light"), JSON.stringify(result.offense.log));
    },
    "offense v2: the horizon rising during the switch cancels it as stale"() {
        const { result, touches, t0 } = run("offSwitchHorizon");
        const ts = fightTouches(touches, t0);
        assert.ok(result.offense.cancels.stale >= 1, JSON.stringify(result.offense.cancels));
        assert.equal(atk3(ts, POINTS.LIGHT).length, 0, "a light after the horizon rose");
        assert.ok(result.offense.log.some((e) => e.ev === "cancel" && e.why === "stale" && e.a === "light"),
            JSON.stringify(result.offense.log));
    },
    "offense v2: args.offenseQ overrides the q threshold (A/B switch)"() {
        const high = run("offNearDrop", { offenseQ: { light: 0.99 } });
        assert.equal(atk3All(fightTouches(high.touches, high.t0)).length, 0, "a light below the overridden q");
        assert.equal(high.result.offense.q.light, 0.99);
        const def = run("offNearDrop");
        assert.equal(def.result.offense.q.light, 0.7);
        assert.ok(atk3(fightTouches(def.touches, def.t0), POINTS.LIGHT).length >= 1);
    },
    "offense off: no contact-3 touch at all (the old defense path)"() {
        const { result, touches } = run("offOff");
        assert.equal(result.offense, null);
        assert.equal(result.attack, null);
        assert.equal(touches.filter((t) => t.op === "down" && t.id === 3).length, 0, "an offense touch with offense off");
    },
    "offense v2: the trace gets the 10 new columns at the end"() {
        const { result, sent } = run("offQishu");
        const cols = result.trace.cols;
        assert.deepEqual(cols.slice(-10), ["chainPos", "chainLen", "nextShare", "weapon", "atkTier", "atkQ", "atkReason", "bossPx", "lock", "range"]);
        const ev = sent.find((e) => e.name === "dufu2_trace");
        assert.ok(ev, "no trace chunk");
        const rows = ev.data.rows;
        assert.ok(rows.every((r) => r.length === cols.length), "a trace row is short");
        const c = Object.fromEntries(cols.map((k, i) => [k, i]));
        const qrow = rows.find((r) => r[c.atkTier] === 2 && Math.abs(r[c.nextShare]) < 5e-4);
        assert.ok(qrow, "no 奇术 / share row");
        assert.equal(qrow[c.range], 1, "the ok did not show as near in the trace");
        assert.equal(rows[0][c.weapon], 1, "phase-1 weapon code");
        assert.equal(rows[0][c.range], 0, "near before any ok / drop");
    },
};

let failures = 0;
for (const [name, test] of Object.entries(tests)) {
    try { test(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failures) process.exitCode = 1;
