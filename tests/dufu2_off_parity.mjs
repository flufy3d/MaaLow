// Old-vs-new touch parity: `offense:"off"` (the default) must behave exactly like the fixed baseline dufu2.js. The
// defense scenarios in tests/dufu2_scenarios.mjs are replayed against both modules in the same fake world and every
// touch (down / move / up, contact, point, millisecond) must match.
//
// The baseline is a FIXED commit (4c80b3c: the offense-v2 design + cleaned defense version), not HEAD: after this
// change is committed HEAD becomes the new code and the check would compare it with itself. Bump BASE by hand when the
// defense behavior is intentionally changed. If git or that commit is not available the check is skipped (exit 0).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dufu2 from "../workspaces/WhereWindsMeet/skills/dufu2.js";
import { T0, runFake } from "./dufu2_fake.mjs";
import { SCENARIOS } from "./dufu2_scenarios.mjs";

const BASE = "4c80b3c"; // fixed baseline, bump by hand after an intentional defense change
const root = fileURLToPath(new URL("..", import.meta.url));
const skills = join(root, "workspaces", "WhereWindsMeet", "skills");
let head = "";
try {
    head = execFileSync("git", ["show", `${BASE}:workspaces/WhereWindsMeet/skills/dufu2.js`], { cwd: root, encoding: "utf8" });
} catch (error) {
    console.log(`SKIP old-vs-new: git show ${BASE} failed (${String(error).split("\n")[0]})`);
    process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), "dufu2-head-"));
let old;
try {
    const lib = pathToFileURL(join(skills, "lib")).href.replace(/\/?$/, "/");
    const src = head.replace(/from "\.\/lib\/([^"]+)"/g, (_, f) => `from "${lib}${f}"`);
    const file = join(dir, "dufu2_head.mjs");
    writeFileSync(file, src, "utf8");
    old = (await import(pathToFileURL(file).href)).default;
} finally {
    rmSync(dir, { recursive: true, force: true });
}

const scenarios = Object.keys(SCENARIOS).filter((n) => !n.startsWith("off"));
let failures = 0;
for (const name of scenarios) {
    try {
        const a = SCENARIOS[name]();
        const b = SCENARIOS[name](); // a fresh scenario: the potion one keeps mutable state
        const args = (s) => ({ mode: s.mode, phase: s.phase, offense: "off",
            ms: (s.mode === "defend" ? T0[s.phase] : 0) + s.fightMs, ...s.args });
        const o = runFake(old, args(a), a.scenario);
        const n = runFake(dufu2, args(b), b.scenario);
        assert.deepEqual(n.touches, o.touches, `${name}: touches differ`);
        assert.deepEqual(n.result.presses, o.result.presses, `${name}: press counters differ`);
        assert.deepEqual(n.result.contacts, o.result.contacts, `${name}: contacts differ`);
        assert.equal(n.result.reason, o.result.reason, `${name}: reason differs`);
        console.log(`PASS ${name}: ${o.touches.length} touches identical`);
    } catch (error) {
        failures++;
        console.error(`FAIL ${name}\n${error.stack}`);
    }
}
console.log(`${scenarios.length - failures}/${scenarios.length} scenarios identical`);
if (failures) process.exitCode = 1;
