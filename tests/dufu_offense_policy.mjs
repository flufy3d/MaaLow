// The generated M1 policy must reproduce the Python training script's scores from the committed fixture: this catches a
// feature-order / normalisation drift between offense_online.py and skills/lib/dufu-offense-policy.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FEATURES, THRESHOLD, VALUE_FEATURES, VALUE_THRESHOLD, allow, risk, value, vector } from "../workspaces/WhereWindsMeet/skills/lib/dufu-offense-policy.js";

const fx = JSON.parse(readFileSync(new URL("../workspaces/WhereWindsMeet/skills/lib/dufu-offense-policy-fixture.json", import.meta.url), "utf8"));
assert.deepEqual(fx.features, FEATURES, "hazard feature list drifted");
assert.equal(vector(new Array(FEATURES.length).fill(0)).length, FEATURES.length, "vector length");

let worst = 0;
for (const row of fx.rows) {
    assert.equal(row.x.length, FEATURES.length, "fixture row length");
    for (const h of [61, 70]) {
        // The fixture x[] is the already-clamped feature vector; risk() takes raw state (see raw()).
        const got = risk(h, raw(row.x));
        const d = Math.abs(got - row[`p${h}`]);
        worst = Math.max(worst, d);
        assert.ok(d < 1e-5, `risk(${h}) drifted: ${got} vs ${row[`p${h}`]}`);
    }
}
assert.ok(worst < 1e-5, `worst hazard drift ${worst}`);

assert.deepEqual(fx.value_features, VALUE_FEATURES, "value feature list drifted");
let worstV = 0;
for (const row of fx.value_rows) {
    assert.equal(row.x.length, VALUE_FEATURES.length, "value fixture row length");
    const got = value(row.a, rawv(row.x));
    const d = Math.abs(got - row.p);
    worstV = Math.max(worstV, d);
    assert.ok(d < 1e-5, `value(${row.a}) drifted: ${got} vs ${row.p}`);
}

// The gate's contract: never veto execute or an action it does not model; thresholds are value floors.
const quiet = raw(new Array(FEATURES.length).fill(0));
assert.equal(allow("execute", quiet), true, "execute vetoed");
assert.equal(allow("charge", quiet), true, "an ungated action was vetoed");
for (const [a, t] of Object.entries(VALUE_THRESHOLD)) {
    assert.ok(t >= 0 && t <= 1, `${a} threshold ${t}`);
}
console.log(`PASS policy fixture: hazard ${fx.rows.length} rows x 2, worst ${worst.toExponential(2)}; ` +
    `value ${fx.value_rows.length} rows, worst ${worstV.toExponential(2)}`);
console.log(`PASS policy contract: execute / charge always allowed, value thresholds ${JSON.stringify(VALUE_THRESHOLD)}, ` +
    `hazard thresholds ${JSON.stringify(THRESHOLD)}`);

/** Fixture x[] is the already-clamped hazard vector; invert the clamps for the fields with a scale (see vector()). */
function raw(x) {
    const i = Object.fromEntries(FEATURES.map((k, j) => [k, j]));
    return {
        hp: x[i.hp], qi: x[i.qi] * 386, bossPx: x[i.bossFrac] * 386, grpP: x[i.grpP], p10: x[i.p10],
        med: x[i.medKnown] > 0.5 ? x[i.med] * 46 : -1, gold: x[i.gold], red: x[i.red], dodge: x[i.dodge],
        parry: x[i.parry], rnone: x[i.rnone], c7P: x[i.p7],
        nextShare: x[i.shareMissing] > 0.5 ? -1 : x[i.nextShare], chainPos: x[i.chainPos] * 3,
        chainLen: x[i.chainLen] * 4, weapon: x[i.weaponHeng] > 0.5 ? "hengdao" : x[i.weaponModao] > 0.5 ? "modao" : "",
        near: x[i.near] > 0.5, lock: x[i.lock] > 0.5, hitAgeF: x[i.hitAge] * 300, okAgeF: x[i.okAge] * 300,
        lastKind: x[i.lastKind], hitsLast90: x[i.hitsLast90] * 3, c11Active: x[i.c11Active] > 0.5,
    };
}

/** The value fixture x[] = VAL_BASE order + 3 action dummies: hp, qi, bossFrac, grpP, p10, nextShare, chainLen,
 *  chainPos, near, weaponHeng, hitAge, c11Active. */
function rawv(x) {
    return {
        hp: x[0], qi: x[1] * 386, bossPx: x[2] * 386, grpP: x[3], p10: x[4], nextShare: x[5],
        chainLen: x[6] * 4, chainPos: x[7] * 3, near: x[8] > 0.5, weapon: x[9] > 0.5 ? "hengdao" : "",
        hitAgeF: x[10] * 300, c11Active: x[11] > 0.5,
    };
}
