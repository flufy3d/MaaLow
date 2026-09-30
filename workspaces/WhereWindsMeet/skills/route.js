// Walk a recorded route through a stronghold (据点): points in big map px from the stronghold icon, x east / y south,
// recorded with stronghold.where() where the teacher said 记点 (teaching explore messages 92–118).
// A point with a minimap snapshot (`snap`, templates/: 44 px of minimap around the character there, arrow and fan
// painted green) is run to with move's snap mode: steered by where the snapshot shows in the minimap, no big map.
// Without one, or when the snapshot never showed, the big map is opened to see where the character is and the way to
// the point is run as a compass bearing for about the time the distance takes, then looked at again.
// A fight on the way (the top right icons hidden) is fought with combat first, then the walk goes on.
// Points with `do`: "flower" taps 销毁 in the interaction list on the right (templates/interact_destroy.png) and waits
// out its bar (~2–6 s); "fight" seeks the enemy around (an elite that stays put) and fights it; "chest" (shows once
// everything is done) taps 据点宝箱, 确认领取 with the panel's defaults (领取三份, 扫荡 9, teacher's choice, message 227)
// and 继续 through the 攻占 result pages.
//   {points: [{at: [-108, 115], snap: "route/cixin/00.png"}, ...], from: 1, to: 4}
//   locate: ["locate/cixin_mosaic", "locate/cixin_bigmap"]  instead (one reference or several, tried in turn): no snapshots and no big map on the way; move's goto knows where the character
//                            is on every frame (locate() of the minimap in that reference, dead reckoning between) and
//                            runs through the points, stopping only where something is done and at the end.
//                            start: where it starts (default: the point before `from`); check: true stops at every
//                            point and reads where() there too (the arrival error, for trying references); nodo: true
//                            skips the points' actions. Stuck, astray or lost ends the walk with an error.
//   anchors: "teaching/survey/a"  surveying: before each look at the big map, wait until the character has stopped and
//                            save the screenshot there (<anchors>/NNN.png); the result lists them with the frame number
//                            and the position read ({n, seq, time, x, y, cam}), to line up frames grabbed meanwhile
import { calm } from "./lib/hud.js";
import { angleDiff, cameraHeading } from "./lib/minimap.js";
import { turn } from "./move.js";
import { where } from "./stronghold.js";

/** @type {SkillMeta} */
export const meta = { description: "walk a recorded route through a stronghold", timeout: 600_000 };

const SPEED = 8; // big map px per second sprinting (measured: 23 px in 2.9 s, 39 px in 4.8 s)
const SHORT = 0.8; // big map legs: run this share of the distance, then look again
const LEG_MS = [700, 5000];
const LEGS = 8; // tries per point before giving up on it
const SNAP_SLACK = 1.8; // snap legs: longest run, times the expected time (tracking a seen snapshot)
const LOST = 1.1; // snap legs: the snapshot not seen by this many times the expected time: stop and look on the map
const MINI = 2.3; // big map px per minimap px
const DEG_PX = 0.6; // camera turn per px dragged (move.js)
const CAM_OK = 8; // at a point: turn the camera to its recorded heading until this close
const ANCHOR_SETTLE = 1500; // anchors: a sprint coasts on a while after the joystick is let go

/** The top right icons are hidden on two looks in a row (right after the map closes they can be missing a moment). */
function inFight() {
    for (let i = 0; i < 2; i++) {
        if (calm(screenshot())) return false;
        if (i === 0) sleep(400);
    }
    return true;
}

/** Turn the camera to `want` (compass degrees), a couple of drags at most. Returns the heading it ended at. */
function faceTo(want) {
    let cam = cameraHeading(screenshot());
    for (let i = 0; i < 3 && cam != null; i++) {
        const d = angleDiff(want, cam);
        if (Math.abs(d) <= CAM_OK) break;
        turn(Math.max(-300, Math.min(300, Math.round(d / DEG_PX))));
        sleep(300);
        cam = cameraHeading(screenshot(), cam);
    }
    return cam;
}

/** @type {Box} */
const LIST_ROI = [690, 360, 130, 220]; // the interaction list on the right (auto_pickup.js)

/** Tap 销毁 and wait until it is gone; if it is not offered, step toward where the camera looks and look again. */
function destroy() {
    for (let step = 0; step < 3; step++) {
        const hit = waitFor(() => {
            const h = match("interact_destroy.png", { image: screenshot(), roi: LIST_ROI, threshold: 0.8 });
            return h.hit ? h : null;
        }, { timeout: 2000, interval: 200 });
        if (hit) {
            const [x, y, w, h] = /** @type {Box} */ (hit.box);
            click([x + w / 2 + 25, y + h / 2]); // on the row, right of the word
            const gone = waitFor(() => !match("interact_destroy.png", { image: screenshot(), roi: LIST_ROI, threshold: 0.8 }).hit, { timeout: 8000, interval: 300 });
            return gone ? "destroyed" : "still offered";
        }
        runSkill("move", { rel: 0, ms: 500, pickup: false });
    }
    return "not offered";
}

/** Tap a template in `roi` once it shows (within `ms`); the tap goes `dx` right of its middle. */
function tapWhen(template, roi, ms, dx = 0) {
    const hit = waitFor(() => {
        const h = match(template, { image: screenshot(), roi, threshold: 0.8 });
        return h.hit ? h : null;
    }, { timeout: ms, interval: 200 });
    if (!hit) return false;
    const [x, y, w, h] = /** @type {Box} */ (hit.box);
    click([x + w / 2 + dx, y + h / 2]);
    return true;
}

/** Open the stronghold chest and take the reward. */
function openChest() {
    if (!tapWhen("interact_chest.png", LIST_ROI, 3000, 10)) return "chest not offered";
    if (!tapWhen("reward_confirm.png", [800, 640, 280, 80], 5000)) return "no reward panel";
    let pages = 0;
    while (pages < 6 && tapWhen("result_continue.png", [900, 640, 180, 80], pages ? 3000 : 8000)) {
        pages++;
        sleep(1000);
    }
    return `taken (${pages} result pages)`;
}

/** An enemy waiting there: chase the nearest red mark until locked, then fight. */
function seekFight() {
    // move answers false instead of its report when run from a pipeline node and nobody was found
    const r = runSkill("move", { enemy: true, sprint: true, ms: 20000 });
    if (!r?.found && calm(screenshot())) return `no enemy (${r ? r.why : "none in sight"})`;
    runSkill("combat", { hp: 0.5, within: 20 });
    return "fought";
}

const bearingTo = (from, to) => (Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180 / Math.PI + 360) % 360;
const GOTO_MS = [8000, 3]; // a goto leg's time limit: at least, and this many times the time running would take
const V_RUN = 4.6; // big map px per second running (move.js)

/**
 * The point's action, once there: look the recorded way first.
 * @param {{cam?: number, do?: string}} p @param {boolean} last
 */
function act(p, last) {
    const cam = p.cam != null && (last || p.do) ? faceTo(p.cam) : null;
    const done = p.do === "flower" ? destroy() : p.do === "fight" ? seekFight() : p.do === "chest" ? openChest() : null;
    return { cam, done };
}

/**
 * Continuous mode (args.locate): legs of move's goto from stop to stop.
 * @param {{points: {at: Point, name?: string, cam?: number, do?: string}[], from?: number, to?: number, reach?: number, locate: string | string[], start?: Point, check?: boolean, nodo?: boolean}} args
 */
function follow(args) {
    const from = args.from ?? 1;
    const to = args.to ?? args.points.length - 1;
    /** @type {Point} */
    let pos = args.start ?? args.points[from - 1].at;
    /** @type {Record<string, any>[]} */
    const legs = [];
    let maps = 0;
    const t0 = Date.now();
    /** @param {string} msg */
    const fail = (msg) => {
        log(`legs ${JSON.stringify(legs)}`);
        throw new Error(msg);
    };
    for (let i = from; i <= to; ) {
        let j = i; // the next stop
        while (j < to && !args.check && (args.nodo || !args.points[j].do)) j++;
        const seg = args.points.slice(i, j + 1).map((p) => p.at);
        let length = 0;
        seg.reduce((a, b) => ((length += Math.hypot(b[0] - a[0], b[1] - a[1])), b), pos);
        const ms = Math.round(Math.max(GOTO_MS[0], (GOTO_MS[1] * length * 1000) / V_RUN));
        const r = runSkill("move", { goto: seg, ref: args.locate, from: pos, reach: args.reach ?? 4, ms, pickup: false });
        /** @type {Record<string, any>} */
        const leg = { i, j, why: r.why, ms: r.ms, fixes: r.fixes, misses: r.misses, maxMissRun: r.maxMissRun, stuck: r.stuck.length, at: r.at };
        legs.push(leg);
        if (r.at) pos = r.at;
        if (r.why === "fight") {
            log(`points ${i}–${j}: fight`);
            runSkill("combat", { hp: 0.5, within: 20 });
            i += r.idx; // the points passed before it
            continue;
        }
        if (r.why !== "arrived") fail(`points ${i}–${j} (${args.points[j].name ?? ""}): ${r.why} at ${pos.map(Math.round)}`);
        const p = args.points[j];
        if (args.check) {
            const w = where();
            maps++;
            if (w) {
                leg.where = [w.x, w.y];
                leg.err = Math.round(Math.hypot(w.x - p.at[0], w.y - p.at[1]) * 10) / 10; // from the point
                leg.off = Math.round(Math.hypot(w.x - pos[0], w.y - pos[1]) * 10) / 10; // from where locate put it
                pos = [w.x, w.y];
            }
        }
        const { cam, done } = args.nodo ? { cam: null, done: null } : act(p, j === to);
        log(`point ${j} (${p.name ?? ""}) reached at ${pos.map(Math.round)}${leg.err != null ? ` (where() ${leg.where}, ${leg.err} px off)` : ""}${cam != null ? `, camera ${Math.round(cam)}°` : ""}${done ? `: ${done}` : ""}`);
        if (done) legs.push({ i: j, do: p.do, done });
        i = j + 1;
    }
    const out = { at: pos.map((v) => Math.round(v * 10) / 10), maps, ms: Date.now() - t0, legs };
    log(JSON.stringify(out));
    return out;
}

/** @param {{points: {at: Point, name?: string, snap?: string, cam?: number, do?: string}[], from?: number, to?: number, reach?: number, speed?: number, anchors?: string, locate?: string | string[], start?: Point, check?: boolean, nodo?: boolean}} args */
export default function (args) {
    if (args.locate) return follow(/** @type {any} */ (args));
    const reach = args.reach ?? 6;
    const speed = args.speed ?? SPEED;
    const legs = [];
    const from = args.from ?? 1;
    // where it starts: the point before `from` (just teleported to the stone, or just reached), checked on the map
    // only when that point has no snapshot to steer by
    /** @type {{x: number, y: number, cam?: number | null}} */
    let pos = { x: args.points[from - 1].at[0], y: args.points[from - 1].at[1] };
    let known = !!args.points[from].snap; // pos is trusted
    let maps = 0;
    const anchors = [];
    const look = () => {
        maps++;
        let image = null;
        if (args.anchors) {
            sleep(ANCHOR_SETTLE);
            image = screenshot();
            saveImage(image, `${args.anchors}/${String(maps).padStart(3, "0")}.png`);
        }
        const p = where();
        if (!p) throw new Error("big map: stronghold icon not found (or standing on it)");
        if (image) {
            anchors.push({ n: maps, seq: image.seq, time: image.time, x: p.x, y: p.y, cam: p.cam });
            log(`anchor ${JSON.stringify(anchors[anchors.length - 1])}`); // kept in the logs if the walk fails later
        }
        known = true;
        return p;
    };
    for (let i = from; i <= (args.to ?? args.points.length - 1); i++) {
        const p = args.points[i];
        let tries = 0;
        let snapOk = !!p.snap;
        let away = 0; // big map legs in a row that ended farther from the point
        for (;;) {
            if (++tries > LEGS) throw new Error(`point ${i} (${p.name ?? ""}): not reached after ${LEGS} tries`);
            if (snapOk) {
                const dist = Math.hypot(p.at[0] - pos.x, p.at[1] - pos.y);
                const ms = Math.round(Math.max(3000, (SNAP_SLACK * dist * 1000) / speed));
                const expect = [(p.at[0] - pos.x) / MINI, (p.at[1] - pos.y) / MINI]; // where the snapshot should show
                const lostMs = Math.round(Math.max(1500, (LOST * dist * 1000) / speed));
                const r = runSkill("move", { face: true, snap: p.snap, expect, lostMs, bearing: bearingTo([pos.x, pos.y], p.at), sprint: true, reachPx: 2, ms, pickup: false });
                legs.push({ i, snap: true, why: r.why, seen: r.seen, ms: r.ms, stuck: r.stuck.length });
                if (r.why === "arrived") {
                    pos = { x: p.at[0], y: p.at[1] };
                    break;
                }
                if (r.why === "fight") {
                    log(`point ${i}: fight`);
                    runSkill("combat", { hp: 0.5, within: 20 });
                    continue; // the snapshot is likely in sight again from where the fight ended
                }
                snapOk = false; // never showed or stuck: find the way on the big map
                pos = look();
                continue;
            }
            if (!known) pos = look();
            const dx = p.at[0] - pos.x;
            const dy = p.at[1] - pos.y;
            const dist = Math.hypot(dx, dy);
            if (dist <= reach) break;
            const bearing = bearingTo([pos.x, pos.y], p.at);
            const ms = Math.round(Math.max(LEG_MS[0], Math.min(LEG_MS[1], (SHORT * dist * 1000) / speed)));
            const r = runSkill("move", { face: true, bearing, sprint: dist > 20, ms, pickup: false });
            if (inFight()) {
                log(`point ${i}: fight`);
                runSkill("combat", { hp: 0.5, within: 20 });
            }
            const was = pos;
            pos = look();
            // farther than before twice: the way is blocked or the position is wrong; stop rather than wander off
            const now = Math.hypot(p.at[0] - pos.x, p.at[1] - pos.y);
            away = now > dist + 3 ? away + 1 : 0;
            if (away >= 2) throw new Error(`point ${i} (${p.name ?? ""}): getting farther (${Math.round(dist)} → ${Math.round(now)} px), stopped`);
            legs.push({ i, bearing: Math.round(bearing), dist: Math.round(dist), ms, moved: Math.round(Math.hypot(pos.x - was.x, pos.y - was.y)), stuck: r.stuck.length });
        }
        // the last point, or one with something to do: look the way the teacher looked there
        const { cam, done } = act(p, i === (args.to ?? args.points.length - 1));
        log(`point ${i} (${p.name ?? ""}) reached at ${Math.round(pos.x)},${Math.round(pos.y)}${cam != null ? `, camera ${Math.round(cam)}° (wants ${p.cam}°)` : ""}${done ? `: ${done}` : ""}`);
        if (done) legs.push({ i, do: p.do, done });
    }
    const out = { at: [Math.round(pos.x), Math.round(pos.y)], cam: pos.cam ?? null, maps, legs, ...(args.anchors ? { anchors } : {}) };
    log(JSON.stringify(out));
    return out;
}
