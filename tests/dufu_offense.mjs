// Pure decision-table tests for skills/lib/dufu-offense.js and the compiled next.share table (no dufu2.js, no fake).
import assert from "node:assert/strict";
import { CHAIN_SHARE, NEAR_DROP_MS, NEAR_OK_MS, Q, REASON, TIER, decide, emptyP, nearNow, pick, quietP } from "../workspaces/WhereWindsMeet/skills/lib/dufu-offense.js";
import { NEXT_SHARE } from "../workspaces/WhereWindsMeet/skills/lib/dufu-offense-table.js";

const frameMs = 1000 / 30;
/** A healthy tick: a phase-1 横刀 character, no contacts, a chain-ending group, nothing special. */
const base = (o = {}) => ({
    now: 100_000, phase: 1, weapon: "hengdao", bossPx: 300, qi: 300,
    executeButton: false, blueDisc: false, qishuReady: false,
    // a recent boss-bar drop: the legacy near gate is open (the action tests need it; lastOkAt stays 0 like "never")
    lastContactAt: 0, lastContactKind: "", lastHitAt: 0, lastDropAt: 100_000 - 500, lastOkAt: 0,
    group: { name: "k0:test", k: 0, nextShare: 0.05 },
    contactChainLen: 0, contactChainPos: 0, special: {}, defenseBusyUntil: 0,
    allow: { set: false, charge: false },
    ...o,
});

const tests = {
    "the compiled next.share table has the head's label widths (98 / 88 incl. idle)"() {
        assert.equal(NEXT_SHARE[1].length, 98);
        assert.equal(NEXT_SHARE[2].length, 88);
        assert.equal(NEXT_SHARE[1][97], null);
        assert.equal(NEXT_SHARE[2][87], null);
        assert.ok(Math.abs(NEXT_SHARE[1][0] - 0.0179) < 1e-9, `p1 gid 0 ${NEXT_SHARE[1][0]}`);
        assert.ok(Math.abs(NEXT_SHARE[1][43] - 0.3776) < 1e-9, `p1 gid 43 ${NEXT_SHARE[1][43]}`);
        assert.ok(Math.abs(NEXT_SHARE[2][7] - 1.0) < 1e-9, `p2 gid 7 ${NEXT_SHARE[2][7]}`);
    },
    "emptyP: the design's low-share anchor, scaled down by next.share"() {
        assert.ok(Math.abs(emptyP(CHAIN_SHARE, 45) - 0.79) < 1e-9, String(emptyP(CHAIN_SHARE, 45)));
        assert.ok(Math.abs(emptyP(0.8, 45) - 0.1975) < 1e-9, String(emptyP(0.8, 45))); // design's 串中 .178
        assert.ok(Math.abs(emptyP(0, 45) - 0.9875) < 1e-9, String(emptyP(0, 45)));
        assert.ok(emptyP(0.1, 42) > emptyP(0.1, 70), "P(empty) must fall with the window");
        assert.equal(emptyP(null, 45), null);
        assert.equal(emptyP(0.1, 37), null);
        // quiet_far: the pooled anchor (design 3.2), phase 2 lower than phase 1
        assert.ok(Math.abs(quietP(1, 45) - 0.809) < 1e-9, String(quietP(1, 45)));
        assert.ok(Math.abs(quietP(2, 45) - 0.743) < 1e-9, String(quietP(2, 45)));
        assert.ok(quietP(1, 42) > quietP(1, 70), "quiet P(empty) must fall with the window");
        assert.equal(quietP(1, 37), null);
    },
    "T0: every hard ban returns null with its reason"() {
        const cases = [
            ["defense", { defenseBusyUntil: 100_001 }],
            ["hit", { lastHitAt: 100_000 - 500 }],
            ["potion", { special: { potionPending: true } }],
            ["executeWindup", { special: { executeWindup: true } }],
            ["curtain", { special: { curtainCovered: true } }],
            ["curtain", { special: { curtainSweep: true } }],
            ["gold", { special: { goldFireball: true } }],
            ["running", { special: { fireballRain: true } }],
            ["running", { special: { running: true } }],
            ["c30", { special: { c30Chain: true } }],
            ["noBoss", { bossPx: 0 }],
            ["idle", { group: null }],
            ["chain", { group: { name: "x", nextShare: 0.3 }, lastContactAt: 100_000 - 10 * frameMs }],
        ];
        for (const [reason, o] of cases) {
            const d = pick(base(o));
            assert.equal(d.action, null, `${reason}: ${JSON.stringify(d)}`);
            assert.equal(d.reason, reason, `${reason}: got ${d.reason}`);
            assert.equal(typeof REASON[reason], "number", `${reason} is missing from the trace codes`);
            assert.equal(decide(base(o)), null);
        }
        // the same live chain 30 f after the contact is clear (share .2 is exactly the light q .80)
        assert.equal(pick(base({ group: { name: "x", nextShare: 0.2 }, lastContactAt: 100_000 - 31 * frameMs })).action, "light");
    },
    "execute (T1) wins over 奇术 / 轻击 / follow (and needs no group)"() {
        const d = pick(base({ executeButton: true, qishuReady: true, blueDisc: true }));
        assert.equal(d.action, "execute");
        assert.equal(d.tier, TIER.execute);
        assert.equal(d.q, Q.execute);
        assert.equal(d.reason, "button");
        assert.equal(pick(base({ executeButton: true, group: null })).action, "execute");
    },
    "qishu (T2): only with P(empty 70) >= .90 (a chain-ending group)"() {
        assert.equal(pick(base({ qishuReady: true, group: { name: "low", nextShare: 0 } })).action, "qishu");
        const high = pick(base({ qishuReady: true, group: { name: "mid", nextShare: 0.2 } }));
        assert.equal(high.action, "light", JSON.stringify(high));
        assert.equal(high.reason, "short");
        // the caller's pEmpty overrides the derived one
        assert.equal(pick(base({ qishuReady: true, group: { name: "x", nextShare: 0.5 }, pEmpty: { 70: 0.91 } })).action, "qishu");
        assert.notEqual(pick(base({ qishuReady: true, group: { name: "x", nextShare: 0.5 }, pEmpty: { 70: 0.89 } })).action, "qishu");
        assert.equal(Q.qishu, 0.9);
    },
    "light (T3): P(empty 42) must reach .80; q is overridable for an A/B"() {
        assert.equal(Q.light, 0.8);
        assert.equal(pick(base({ pEmpty: { 42: 0.75 } })).action, null);
        assert.equal(pick(base({ pEmpty: { 42: 0.75 } })).reason, "q42");
        assert.equal(pick(base({ pEmpty: { 42: 0.80 } })).action, "light");
        // the args.offenseQ analog: input.q overrides the thresholds
        assert.equal(pick(base({ pEmpty: { 42: 0.85 }, q: { ...Q, light: 0.9 } })).action, null);
        assert.equal(pick(base({ pEmpty: { 42: 0.85 }, q: { ...Q, light: 0.84 } })).action, "light");
    },
    "follow (T3, the blue disc) beats light; without the disc only light"() {
        const f = pick(base({ blueDisc: true }));
        assert.equal(f.action, "follow");
        assert.equal(f.tier, TIER.follow);
        assert.equal(f.q, Q.follow);
        assert.equal(f.needsHengdao, true);
        const l = pick(base({ blueDisc: false }));
        assert.equal(l.action, "light");
        assert.equal(l.q, Q.light);
    },
    "weapon stance: phase 1 陌刀 / unread switches or waits; phase 2 横刀 is native"() {
        const sw = pick(base({ weapon: "modao" }));
        assert.equal(sw.action, "light");
        assert.equal(sw.switchFirst, true);
        assert.equal(sw.needsHengdao, true);
        const unknown = pick(base({ weapon: "" }));
        assert.equal(unknown.action, null, JSON.stringify(unknown));
        assert.equal(unknown.reason, "weapon");
        const p2 = pick(base({ phase: 2, weapon: "" }));
        assert.equal(p2.action, "light");
        assert.equal(p2.switchFirst, false);
        const p2modao = pick(base({ phase: 2, weapon: "modao" }));
        assert.equal(p2modao.switchFirst, true);
    },
    "T4/T5 are interfaces only: set / charge off by default, on with allow + a long window"() {
        const set = pick(base({ special: { phaseTransition: true } }));
        assert.equal(set.action, null);
        assert.equal(set.reason, "transition");
        const setOn = pick(base({ special: { phaseTransition: true }, allow: { set: true },
            pEmpty: { 144: 0.95 } }));
        assert.equal(setOn.action, "set");
        assert.equal(setOn.tier, TIER.set);
        assert.equal(pick(base({ weapon: "modao", pEmpty: { 42: 0.5, 45: 0.9 } })).action, null, "charge off by default");
        const ch = pick(base({ weapon: "modao", allow: { charge: true }, pEmpty: { 42: 0.5, 45: 0.9 } }));
        assert.equal(ch.action, "charge");
        assert.equal(ch.holdMs, 700);
    },
    "a blocked live chain is a T0; a short window fails the light q with q42"() {
        assert.equal(pick(base({ group: { name: "x", nextShare: 0.6 } })).reason, "q42");
        assert.equal(pick(base({ group: { name: "x", nextShare: 0.6 } })).action, null);
        assert.equal(pick(base({ group: { name: "x", nextShare: 0.7 }, lastContactAt: 100_000 - 5 * frameMs })).reason, "chain");
        assert.equal(pick(base({ group: { name: "x", nextShare: 0.7 }, lastContactAt: 100_000 - 40 * frameMs })).reason, "q42");
    },
    "the near gate: light / follow / charge / set need an ok or a boss drop within 1500 ms"() {
        assert.equal(NEAR_OK_MS, 1500); // dufu2.js ATK_NEAR_MS
        assert.equal(NEAR_DROP_MS, 1500); // dufu2.js ATK_DROP_MS
        const no = { lastOkAt: 0, lastDropAt: 0 };
        const d = pick(base(no));
        assert.equal(d.action, null, JSON.stringify(d));
        assert.equal(d.reason, "near");
        assert.equal(REASON.near, 26);
        assert.equal(REASON.unknown, 27);
        assert.equal(REASON.stale, 28); // dufu2's switch re-check (layer only)
        assert.equal(nearNow(base(no)), false);
        // ok / drop within the window, including the exact 1500 ms boundary; 0 means "never" (no now - 0)
        assert.equal(pick(base({ ...no, lastOkAt: 100_000 - 1499 })).action, "light");
        assert.equal(pick(base({ ...no, lastOkAt: 100_000 - 1500 })).action, "light");
        assert.equal(pick(base({ ...no, lastOkAt: 100_000 - 1501 })).reason, "near");
        assert.equal(pick(base({ ...no, lastDropAt: 100_000 - 1000 })).action, "light");
        assert.equal(pick(base({ ...no, lastDropAt: 100_000 - 1501 })).reason, "near");
        assert.equal(nearNow(base({ ...no, lastOkAt: 100_000 - 500 })), true);
        assert.equal(nearNow(base({ ...no, lastDropAt: 100_000 - 500 })), true);
        // follow, charge and set are behind the same gate
        assert.equal(pick(base({ ...no, blueDisc: true })).reason, "near");
        assert.equal(pick(base({ ...no, weapon: "modao", allow: { charge: true } })).reason, "near");
        assert.equal(pick(base({ ...no, special: { phaseTransition: true }, allow: { set: true }, pEmpty: { 144: 0.95 } })).reason, "near");
        assert.equal(pick(base({ weapon: "modao", allow: { charge: true } })).action, "charge");
        // execute (the button) and qishu (dufu.js qsTick: opening / 气竭, no range gate) do not need it
        assert.equal(pick(base({ ...no, executeButton: true })).action, "execute");
        assert.equal(pick(base({ ...no, qishuReady: true, group: { name: "z", nextShare: 0 } })).action, "qishu");
        assert.equal(pick(base({ qishuReady: true, group: { name: "z", nextShare: 0 } })).action, "qishu"); // and with a near anchor
    },
    "a recent contact with no group blocks as unknown (never quiet_far)"() {
        const t = 100_000;
        const quiet = { 18: 0.83, 42: 0.81, 45: 0.809, 61: 0.755, 70: 0.71, 144: 0.45 };
        const recent = { group: null, pEmpty: quiet, lastContactAt: t - 10 * frameMs };
        const d = pick(base(recent));
        assert.equal(d.action, null, JSON.stringify(d));
        assert.equal(d.reason, "unknown");
        assert.equal(REASON.unknown, 27);
        assert.equal(pick(base({ ...recent, group: { name: "x", nextShare: null } })).reason, "unknown");
        // the execute button still wins over the unknown contact
        assert.equal(pick(base({ ...recent, executeButton: true })).action, "execute");
        // >= 30 f: quiet_far (and the base's recent drop) -> light
        assert.equal(pick(base({ ...recent, lastContactAt: t - 35 * frameMs })).action, "light");
        assert.equal(pick(base({ group: null, pEmpty: quiet })).action, "light");
    },
    "a quiet window (no last-contact group, pEmpty = quiet_far) still gets 轻击, not 奇术"() {
        const quiet = { 18: 0.83, 42: 0.81, 45: 0.809, 61: 0.755, 70: 0.71, 144: 0.45 };
        const l = pick(base({ group: null, pEmpty: quiet }));
        assert.equal(l.action, "light", JSON.stringify(l));
        const q = pick(base({ group: null, pEmpty: quiet, qishuReady: true }));
        assert.equal(q.action, "light", `quiet 奇术: ${JSON.stringify(q)}`);
        assert.equal(pick(base({ group: null, pEmpty: null })).reason, "idle");
    },
};

let failures = 0;
for (const [name, test] of Object.entries(tests)) {
    try { test(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failures) process.exitCode = 1;
