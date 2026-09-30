// Walk a recorded route through a stronghold (据点): points in big map px from the stronghold icon, x east / y south,
// recorded with stronghold.where() where the teacher said 记点 (teaching explore messages 92–118).
// A point with a minimap snapshot (`snap`, templates/: 44 px of minimap around the character there, arrow and fan
// painted green) is run to with move's snap mode: steered by where the snapshot shows in the minimap, no big map.
// Without one, or when the snapshot never showed, the big map is opened to see where the character is and the way to
// the point is run as a compass bearing for about the time the distance takes, then looked at again.
// A fight on the way (the top right icons hidden) is fought with combat first, then the walk goes on.
//   {points: [{at: [-108, 115], snap: "route/cixin/00.png"}, ...], from: 1, to: 4}
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
const SNAP_SLACK = 1.8; // snap legs: give up on the snapshot after this many times the expected time
const MINI = 2.3; // big map px per minimap px
const DEG_PX = 0.6; // camera turn per px dragged (move.js)
const CAM_OK = 8; // at a point: turn the camera to its recorded heading until this close

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

const bearingTo = (from, to) => (Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180 / Math.PI + 360) % 360;

/** @param {{points: {at: Point, name?: string, snap?: string, cam?: number, do?: string}[], from?: number, to?: number, reach?: number, speed?: number}} args */
export default function (args) {
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
    const look = () => {
        maps++;
        const p = where();
        if (!p) throw new Error("big map: stronghold icon not found");
        known = true;
        return p;
    };
    for (let i = from; i <= (args.to ?? args.points.length - 1); i++) {
        const p = args.points[i];
        let tries = 0;
        let snapOk = !!p.snap;
        for (;;) {
            if (++tries > LEGS) throw new Error(`point ${i} (${p.name ?? ""}): not reached after ${LEGS} tries`);
            if (snapOk) {
                const dist = Math.hypot(p.at[0] - pos.x, p.at[1] - pos.y);
                const ms = Math.round(Math.max(3000, (SNAP_SLACK * dist * 1000) / speed));
                const expect = [(p.at[0] - pos.x) / MINI, (p.at[1] - pos.y) / MINI]; // where the snapshot should show
                const r = runSkill("move", { face: true, snap: p.snap, expect, bearing: bearingTo([pos.x, pos.y], p.at), sprint: true, reachPx: 2, ms, pickup: false });
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
            legs.push({ i, bearing: Math.round(bearing), dist: Math.round(dist), ms, moved: Math.round(Math.hypot(pos.x - was.x, pos.y - was.y)), stuck: r.stuck.length });
        }
        // the last point, or one with something to do: look the way the teacher looked there
        const cam = p.cam != null && (i === (args.to ?? args.points.length - 1) || p.do) ? faceTo(p.cam) : null;
        log(`point ${i} (${p.name ?? ""}) reached at ${Math.round(pos.x)},${Math.round(pos.y)}${cam != null ? `, camera ${Math.round(cam)}° (wants ${p.cam}°)` : ""}`);
    }
    const out = { at: [Math.round(pos.x), Math.round(pos.y)], cam: pos.cam ?? null, maps, legs };
    log(JSON.stringify(out));
    return out;
}
