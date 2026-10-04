// Walk a route through a stronghold (据点): points in big map px from the stronghold icon, x east / y south, as
// stronghold.where() reads them. Routes are made from one recording by tools/rec_route.py and run with `locate`
// (慈心山院's and 佛爷寨's points were read with where() where the teacher said 记点, before that tool existed).
// Without `locate` (rec_route.py survey only, not a way to run a route): the big map is opened to see where the
// character is and the way to the point is run as a compass bearing for about the time the distance takes, then looked
// at again.
// A fight on the way (the top right icons hidden) is fought with combat first, then the walk goes on.
// Points with `do`: "flower" taps 销毁 in the interaction list on the right (templates/interact_destroy.png) and waits
// out its bar (~2–6 s); "fight" seeks the enemy around (an elite that stays put) and fights it; "chest" (shows once
// everything is done) taps 据点宝箱, 确认领取 with the panel's defaults (领取三份, 扫荡 9, teacher's choice, message 227)
// and 继续 through the 攻占 result pages.
//   {stronghold: <config>, from: 1, to: 4}  a stronghold's route (its config: pipeline/stronghold_<id>.json, see
//                            stronghold.js): points, locate, tracker from it; where() reads its label and stone
//   {points: [{at: [-108, 115]}, ...], from: 1, to: 4}
//   locate: ["locate/cixin_mosaic", "locate/cixin_bigmap"]  (one reference or several, tried in turn): no big map on the way; move's goto knows where the character
//                            is on every frame (locate() of the minimap in that reference, dead reckoning between) and
//                            runs through the points, stopping only where something is done and at the end.
//                            start: where it starts (default: the point before `from`); check: true stops at every
//                            point and reads where() there too (the arrival error, for trying references), a list of
//                            points only at those (a dry run: the config's checks, where it is least sure); nodo: true
//                            skips the points' actions; skip: [14] only those points' (leaving one flower for last
//                            keeps the stronghold from finishing, so a run can be tried again). A fight on the way,
//                            or a leg that lost its way, finds the character on the whole reference and goes on.
//                            layer: "live" | "taken", the stronghold's state if known at the start (otherwise goto
//                            finds it on the minimap: lib/minimap.js strongholdState()); picks the reference's levels
//   anchors: "teaching/survey/a"  surveying: before each look at the big map, wait until the character has stopped and
//                            save the screenshot there (<anchors>/NNN.png); the result lists them with the frame number
//                            and the position read ({n, seq, time, x, y, cam}), to line up frames grabbed meanwhile
//   dwell: 3500            surveying: after each look, stand this long (ms) first: the minimap, reset to zoomed out by
//                            the big map, zooms back in after 1–2 s in a courtyard; frames standing there at a known
//                            place and zoom fill the zoomed-in mosaic (佛爷寨's east path, 2026-10-02)
import { calm } from "./lib/hud.js";
import { angleDiff, bearingOf, cameraHeading, CENTER, enemies } from "./lib/minimap.js";
import { relocate, turn } from "./move.js";
import { lines, progress, where } from "./stronghold.js";

/** @type {SkillMeta} */
export const meta = { description: "walk a recorded route through a stronghold", timeout: 1_800_000 };

const SPEED = 8; // big map px per second sprinting (measured: 23 px in 2.9 s, 39 px in 4.8 s)
const SHORT = 0.8; // big map legs: run this share of the distance, then look again
const LEG_MS = [700, 5000];
const LEGS = 8; // tries per point before giving up on it
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

// The flowers glow purple: OpenCV HSV H 118–160, S ≥ 70, V ≥ 80 gives ≥ ~900 px around one in sight and ≤ ~250 on
// the rest of the courtyard (teaching shots 0107–0116, 2026-10-01 run). 销毁 only shows within a step or two of the
// flower, closer than a route point is reached (a few px off), so the last steps go by the flower on screen.
const FLOWER = { lower: [118, 70, 80], upper: [160, 255, 255], method: 40 };
/** @type {Box} */
const FLOWER_ROI = [40, 200, 860, 390]; // the scene around the character, under the tracker, above the chat box
/** @type {Box} */
const FLOWER_RIGHT = [900, 200, 100, 340]; // and right of it down to the skill buttons: 慈心山院's third flower stood at
// x 840–1060 when the point was reached (2026-10-04, 0.9 px and 3° off), all but its edge out of FLOWER_ROI, and the
// blind steps went past it
const FLOWER_PX = [400, 8000]; // a flower a step or two away (up close it fills ~1000–6000; more is something else)
const FLOWER_NEAR = 90; // blobs this close to the biggest are petals of the same flower
/** @type {Box} */
const FLOWER_AT = [30, 230, 970, 360]; // where a flower that close shows: around the character (at 第四个毒花 low left)
const SCREEN_DEG = 0.08; // steering: degrees per screen px off the middle (the view is ~85° wide)
const STEPS = 3; // steps toward the flower before giving up (the route comes back for it at the chest)

/** The flower on screen (its purple blobs' middle), or null. @param {Image} image */
function flowerAt(image) {
    const blobs = [FLOWER_ROI, FLOWER_RIGHT].flatMap((roi) => {
        const h = color({ ...FLOWER, image, roi, count: 30, connected: true });
        return h.hit ? h.results : [];
    });
    if (!blobs.length) return null;
    const mid = (/** @type {Match} */ m) => [m.box[0] + m.box[2] / 2, m.box[1] + m.box[3] / 2];
    const top = blobs.reduce((a, b) => ((b.count ?? 0) > (a.count ?? 0) ? b : a));
    const [tx, ty] = mid(top);
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (const m of blobs) {
        const [x, y] = mid(m);
        if (Math.hypot(x - tx, y - ty) > FLOWER_NEAR) continue;
        n += m.count ?? 0;
        sx += x * (m.count ?? 0);
        sy += y * (m.count ?? 0);
    }
    const [x, y] = [sx / n, sy / n];
    const [ax, ay, aw, ah] = FLOWER_AT;
    // anything else purple (a fight's effects, flowers farther off) is not walked to: a wrong step can lead into a hall
    return n >= FLOWER_PX[0] && n <= FLOWER_PX[1] && x >= ax && x <= ax + aw && y >= ay && y <= ay + ah ? { x, y, n } : null;
}

const BLIND = 2; // steps straight ahead with no flower in sight (already destroyed, or behind something)
const BAR_MS = 10_000; // 销毁's bar: ~2–6 s (teaching messages 171, 186)

/**
 * Tap 销毁 and wait out its bar: done once the tracker's flower count goes up (the row turns white as the bar fills,
 * so the word stops matching long before the end); the whole bar's time when the tracker cannot be read. Not offered:
 * a short step toward the flower on screen (straight ahead, BLIND times, when it is not in sight), and look again; a
 * fight starting meanwhile (the icons hide, a red mark close) is fought first.
 */
function destroy() {
    let blind = 0;
    for (let step = 0; step < STEPS; step++) {
        const hit = waitFor(() => {
            const h = match("interact_destroy.png", { image: screenshot(), roi: LIST_ROI, threshold: 0.8 });
            return h.hit ? h : null;
        }, { timeout: step ? 700 : 2000, interval: 200 });
        if (hit) {
            const before = progress().flowers;
            const [x, y, w, h] = /** @type {Box} */ (hit.box);
            click([x + w / 2 + 25, y + h / 2]); // on the row, right of the word
            if (!before) {
                sleep(BAR_MS);
                return match("interact_destroy.png", { image: screenshot(), roi: LIST_ROI, threshold: 0.8 }).hit ? "still offered" : "destroyed";
            }
            // the count going up; for the last flower its line goes instead, which a misread line also looks like, so
            // that takes two reads in a row
            let gone = 0;
            const up = waitFor(() => {
                const now = progress().flowers;
                if (now) return now[0] > before[0];
                return before[0] + 1 >= before[1] && ++gone >= 2;
            }, { timeout: BAR_MS, interval: 500 });
            return up ? "destroyed" : "still offered";
        }
        const image = screenshot();
        if (!calm(image) && enemies(image).some((e) => e.dist <= 25)) {
            runSkill("combat", { hp: 0.5, within: 20 });
            continue;
        }
        const f = flowerAt(image);
        if (!f && ++blind > BLIND) break;
        const rel = f ? Math.max(-70, Math.min(70, (f.x - 540) * SCREEN_DEG)) : 0;
        log(`flower: step ${step + 1}${f ? ` toward (${Math.round(f.x)},${Math.round(f.y)}) ${f.n} px, ${Math.round(rel)}°` : ", not in sight"}`);
        runSkill("move", { rel, ms: 400, pickup: false });
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

/** @type {Box} */
const DISC_ROI = [90, 16, 110, 110]; // the minimap disc
const CHEST_MS = 12_000; // walking to the chest's mark before giving up

/**
 * Walk up to the chest by its mark on the minimap (templates/minimap_chest.png, ~1.0 against ~0.45 elsewhere,
 * teaching message 215) until 据点宝箱 is offered: the last steps go by it rather than by the position, which the
 * minimap reference can lose by the chest while the stronghold's orange patch is still over it.
 */
function toChest() {
    const t0 = Date.now();
    while (Date.now() - t0 < CHEST_MS) {
        const image = screenshot();
        if (match("interact_chest.png", { image, roi: LIST_ROI, threshold: 0.8 }).hit) return true;
        const mark = match("minimap_chest.png", { image, roi: DISC_ROI, threshold: 0.8 });
        if (!mark.hit || !mark.box) return false;
        const [x, y] = [mark.box[0] + mark.box[2] / 2, mark.box[1] + mark.box[3] / 2];
        const d = Math.hypot(x - CENTER[0], y - CENTER[1]);
        runSkill("move", { bearing: bearingOf([x, y]), ms: d > 8 ? 600 : 300, pickup: false });
    }
    return false;
}

/** @type {Box} */
const REWARD_ROI = [790, 470, 280, 190]; // 据点奖励: 领取三份, 剩余避战符, 扫荡次数, 消耗心力

/**
 * Open the stronghold chest and take the reward with the panel's defaults, as the teacher agreed (领取三份, 扫荡 as
 * many as the 避战符 left, up to 9; 240 心力): what the panel says is logged, and a panel not on 领取三份 is left open
 * for a person rather than confirmed.
 */
function openChest() {
    if (!tapWhen("interact_chest.png", LIST_ROI, 1500, 10) && !(toChest() && tapWhen("interact_chest.png", LIST_ROI, 2000, 10))) return "chest not offered";
    const panel = waitFor(() => {
        const read = lines(ocr({ image: screenshot(), roi: REWARD_ROI }).results);
        return read.some((l) => l.includes("领取")) ? read : null;
    }, { timeout: 5000, interval: 500 });
    if (!panel) return "no reward panel";
    log(`reward panel: ${panel.join(" / ")}`);
    if (!panel.some((l) => l.includes("三份"))) return `reward panel not on 领取三份 (${panel.join(" / ")}): left open`;
    if (!tapWhen("reward_confirm.png", [800, 640, 280, 80], 3000)) return "no 确认领取";
    let pages = 0;
    while (pages < 6 && tapWhen("result_continue.png", [900, 640, 180, 80], pages ? 3000 : 8000)) {
        pages++;
        sleep(1000);
    }
    return `taken (${pages} result pages)`;
}

/** An enemy waiting there: chase the nearest red mark until locked, then fight. */
function seekFight() {
    // already fighting: combat at once; chasing it meanwhile, the enemy moving about reads as stuck (jumps, detours)
    if (calm(screenshot())) {
        // move answers false instead of its report when run from a pipeline node and nobody was found
        const r = runSkill("move", { enemy: true, sprint: true, ms: 20000, untilFight: true });
        if (!r?.found && r?.why !== "fight" && calm(screenshot())) return `no enemy (${r ? r.why : "none in sight"})`;
    }
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

const RETRIES = 3; // a leg that lost the track, went astray or got stuck: found again and gone on this many times
const AHEAD = 12; // after finding it again, it goes on from the nearest of this many points ahead
const STEP_BACK = 4; // stepBack(): big map steps at most
const STEP_REACH = 3; // px: back on the way this close to one of its points
const FINISH = 2; // at the chest point with no chest: rounds of doing what is left and coming back

/** @param {Point} a @param {Point} b */
const distTo = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** @param {number} a @param {number} b */
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, n) => a + n);

/**
 * Continuous mode (args.locate): legs of move's goto from stop to stop.
 * A fight on the way is fought; then the character is found again on the whole reference (a fight pulls it around,
 * often beyond the search radius) and the leg goes on from the nearest of its points left. A leg that lost the track,
 * went astray or got stuck is found again and gone on the same way, RETRIES times.
 * At the chest point with no chest offered, what the tracker says is left is done first (FINISH rounds): flowers not
 * destroyed on the way are walked back to along the route, enemies left are cleared with the `clear` node (zone mode,
 * StrongholdFight), then back to the chest.
 * @param {{points: {at: Point, name?: string, cam?: number, do?: string}[], from?: number, to?: number, reach?: number, locate: string | string[], start?: Point, check?: boolean | number[], nodo?: boolean, skip?: number[], clear?: string, tracker?: Record<string, string>, layer?: string, stronghold?: any}} args
 */
function follow(args) {
    const P = args.points;
    const from = args.from ?? 1;
    const to = args.to ?? P.length - 1;
    /** @type {Point} */
    let pos = args.start ?? P[from - 1].at;
    /** @type {Record<string, any>[]} */
    const legs = [];
    let maps = 0;
    let fights = 0;
    let relocs = 0;
    /** @type {number | undefined} */
    let k; // the scale of the reference level matched last, for goto's fight check before a leg's first match
    /** @type {string | undefined} */
    let layer = args.layer;
    /** @type {number | null} */
    let camLast = null; // the camera heading goto had at the end of the last leg (the fan, or guessed from the way it
    // ran), for the next leg to start by when the fan is not read there (daytime at 怜花禅院's gate: a dry run's leg
    // after the look at point 17 set off the camera's way, east, away from the gate); dropped when anything turns it
    let bias = 0; // goto's steering bias, carried from leg to leg // the stronghold's state, live | taken, as goto saw it last (picks the reference's levels)
    /** @type {Map<number, boolean>} */
    const flowers = new Map(); // flower point → destroyed
    const t0 = Date.now();
    /** @param {string} msg */
    const fail = (msg) => {
        log(`legs ${JSON.stringify(legs)}`);
        throw new Error(msg);
    };
    /** @param {number} k */
    const away = (k) => distTo(pos, P[k].at);
    /** @param {number} k */
    const named = (k) => `${k} (${P[k].name ?? ""})`;

    /** Find the character on the whole reference; false when it cannot tell. */
    const again = () => {
        let at = relocate(args.locate, undefined, layer, pos);
        if (!at && !inFight()) {
            // the minimap could not tell (a day sky's sun behind it washes the disc out: 酒肉山林's west yard,
            // 2026-10-02, 77 frames unmatched and the whole reference no help): the big map can
            const w = where(args.stronghold);
            maps++;
            if (w) {
                at = [w.x, w.y];
                log(`found again on the big map at ${at.map(Math.round)}`);
            }
        }
        if (!at) return false;
        relocs++;
        log(`found again at ${at.map(Math.round)} (${Math.round(distTo(pos, at))} px from where it was put)`);
        pos = at;
        return true;
    };

    /** A fight: fought by `how`, what it dropped picked up, then what the tracker says. @param {() => any} how */
    const fight = (how) => {
        fights++;
        camLast = null;
        const f = how();
        runSkill("auto_pickup", {});
        const tasks = progress(undefined, args.tracker);
        legs.push({ fight: fights, f, tasks: { foes: tasks.foes, flowers: tasks.flowers } });
        log(`fight ${fights}: ${JSON.stringify(f)}, tracker ${JSON.stringify(tasks.lines)}`);
        return f;
    };

    /**
     * Back onto the way by the big map, the way a survey walks: run toward the nearest of points `ks` for a while and
     * read where() again, STEP_BACK times at most, until within STEP_REACH of it. For a place the minimap reference
     * does not reach (a fight pushed it off the way: 酒肉山林's bonfire field, 15 px east, 2026-10-02), where goto finds
     * no match to go by.
     * @param {number[]} ks
     */
    const stepBack = (ks) => {
        let stuckSteps = 0;
        for (let s = 0; s < STEP_BACK; s++) {
            const k = ks.slice(0, AHEAD).reduce((b, m) => (away(m) < away(b) ? m : b));
            const d = away(k);
            if (d <= STEP_REACH) return;
            const ms = Math.round(Math.max(LEG_MS[0], Math.min(3000, (SHORT * d * 1000) / V_RUN)));
            // a step that did not move it ran into something: the next goes 60° to one side, then the other
            const bearing = (bearingTo(pos, P[k].at) + [0, 60, -60][stuckSteps] + 360) % 360;
            log(`back onto the way: ${Math.round(d)} px to point ${k}, running ${Math.round(bearing)}° for ${ms} ms`);
            runSkill("move", { face: true, bearing, ms, pickup: false });
            const w = where(args.stronghold);
            maps++;
            if (!w) return;
            if (distTo(pos, [w.x, w.y]) < 1.5 && ++stuckSteps > 2) return; // 佛爷寨: the same wall 12 times
            pos = [w.x, w.y];
        }
    };

    /** Walk through the points `ks` (indexes), to the last. @param {number[]} ks */
    const walk = (ks) => {
        let rest = ks;
        for (let tries = 0; ; ) {
            const seg = rest.map((k) => P[k].at);
            let length = 0;
            seg.reduce((a, b) => ((length += distTo(a, b)), b), pos);
            const ms = Math.round(Math.max(GOTO_MS[0], (GOTO_MS[1] * length * 1000) / V_RUN));
            // no sprint on a route: it carries on past the turns and the doors, and the matches fall behind (teacher)
            // points marked door: true (a narrow door): stuck there, it steps aside and runs through (move.js DOOR_STEPS);
            // out: [x, y], where the zoomed-out reference level has the point (move.js outs)
            const doors = rest.filter((k) => P[k].door).map((k) => P[k].at);
            const outs = rest.some((k) => P[k].out) ? rest.map((k) => P[k].out ?? null) : undefined;
            const r = runSkill("move", { goto: seg, ref: args.locate, from: pos, k, bias, layer, reach: args.reach ?? 2, ms, sprint: false, doors, outs, cam0: camLast });
            camLast = r.cam ?? null;
            k = r.k ?? k;
            bias = r.bias ?? bias;
            layer = r.layer ?? layer;
            const j = rest[rest.length - 1];
            /** @type {Record<string, any>} */
            const leg = { i: rest[0], j, why: r.why, ms: r.ms, fixes: r.fixes, misses: r.misses, maxMissRun: r.maxMissRun, stuck: r.stuck.length, taps: r.taps, at: r.at };
            legs.push(leg);
            event("route_leg", leg);
            if (r.at) pos = r.at;
            if (r.why === "arrived") return leg;
            if (r.why === "fight") {
                log(`points ${rest[r.idx]}–${j}: fight`);
                fight(() => runSkill("combat", { hp: 0.5, within: 20 }));
                // back to the point passed last before the fight, then on along the way: a fight can take it far off
                // (locked on a far enemy, 突进 lunges at it: 佛爷寨 2026-10-02) and going on from the nearest point
                // left part of the way out (teacher)
                rest = rest.slice(Math.max(0, r.idx - 1));
                again(); // not found: the reckoned position, looked for wide at the start of the next leg
                if (rest.length > 1) log(`after the fight: back to point ${rest[0]}, ${Math.round(away(rest[0]))} px away`);
                continue;
            } else {
                if (++tries > RETRIES) fail(`points ${rest[0]}–${named(j)}: ${r.why} at ${pos.map(Math.round)}`);
                log(`points ${rest[0]}–${j}: ${r.why} at ${pos.map(Math.round)}, finding it again`);
                if (!again()) fail(`points ${rest[0]}–${named(j)}: ${r.why} at ${pos.map(Math.round)}, not found again`);
                if (r.why === "lost" && !r.fixes) {
                    stepBack(rest);
                    camLast = null;
                }
            }
            // the nearest of the next AHEAD points only: a way out and back passes the same place twice, and the nearest
            // of all was on the way back (酒肉山林 2026-10-02: from the bonfire field it went on at the return, the west
            // yard left out)
            const n = rest.slice(0, AHEAD).reduce((b, k, m) => (away(k) < away(rest[b]) ? m : b), 0);
            rest = rest.slice(n);
        }
    };

    /** Back to point `k` from wherever it is: along the route from the point nearest to it. @param {number} k */
    const walkTo = (k) => {
        if (!again()) log(`to point ${k}: not found again, going by where it was put`);
        const near = range(from - 1, to).reduce((b, m) => (away(m) < away(b) ? m : b));
        walk(near <= k ? range(near, k) : range(k, near).reverse());
    };

    /** At the chest point with no chest: do what the tracker says is left, come back, look again. @param {number} c */
    const finish = (c) => {
        /** @type {string | null} */
        let done = "chest not offered";
        for (let round = 1; round <= FINISH && done === "chest not offered"; round++) {
            const tasks = progress(undefined, args.tracker);
            log(`no chest (round ${round}): tracker ${JSON.stringify(tasks.lines)}`);
            legs.push({ finish: round, tasks: { foes: tasks.foes, flowers: tasks.flowers } });
            // the route's flowers not destroyed on this run, except those skipped on purpose; all of them again when the
            // tracker counts fewer than were destroyed (one taken for destroyed was not); none once its line is gone
            const all = range(from, to).filter((k) => P[k].do === "flower" && !args.skip?.includes(k));
            let left = all.filter((k) => !flowers.get(k));
            const destroyed = all.length - left.length;
            // (its line still there with the count misread, "…毒花" / "…毒花3", is not done: 慈心山院 2026-10-04 left
            // the third flower that way and went to the chest twice)
            const word = args.tracker?.flowers ?? "毒花";
            if (tasks.lines.length && !tasks.flowers && !tasks.lines.some((l) => l.includes(word))) left = [];
            else if (tasks.flowers && tasks.flowers[0] < destroyed) left = all;
            for (const k of left) {
                walkTo(k);
                const r = act(P[k], false).done;
                flowers.set(k, r === "destroyed");
                log(`flower ${named(k)} again: ${r}`);
            }
            if (!tasks.lines.length || tasks.foes) {
                const r = runNode(args.clear ?? "StrongholdFight");
                log(`clearing: ${JSON.stringify(r.nodes.slice(-3))}${r.hit ? "" : " (not cleared)"}`);
                legs.push({ clear: r.hit, nodes: r.nodes.length });
            }
            walkTo(c);
            done = act(P[c], true).done;
        }
        return done;
    };

    const checks = Array.isArray(args.check) ? new Set(args.check) : null;
    /** @param {number} k */
    const checking = (k) => args.check === true || !!checks?.has(k);
    for (let i = from; i <= to; ) {
        let j = i; // the next stop
        while (j < to && !checking(j) && (args.nodo || !P[j].do)) j++;
        const leg = walk(range(i, j));
        const p = P[j];
        if (checking(j)) {
            const w = where(args.stronghold);
            maps++;
            if (w) {
                leg.where = [w.x, w.y];
                leg.err = Math.round(Math.hypot(w.x - p.at[0], w.y - p.at[1]) * 10) / 10; // from the point
                leg.off = Math.round(Math.hypot(w.x - pos[0], w.y - pos[1]) * 10) / 10; // from where locate put it
                pos = [w.x, w.y];
            }
        }
        let cam = null;
        let done = null;
        const nodo = args.nodo || args.skip?.includes(j);
        if (nodo) {
            // walked to only
        } else if (p.do === "fight") {
            done = fight(() => act(p, j === to).done);
            again(); // the fight moved it
        } else ({ cam, done } = act(p, j === to));
        if (!nodo) camLast = null; // the action may turn the camera (faceTo, fights, the chest)
        if (p.do === "flower" && !nodo) flowers.set(j, done === "destroyed");
        if (p.do === "chest" && done === "chest not offered") done = finish(j);
        log(`point ${j} (${p.name ?? ""}) reached at ${pos.map(Math.round)}${leg.err != null ? ` (where() ${leg.where}, ${leg.err} px off)` : ""}${cam != null ? `, camera ${Math.round(cam)}°` : ""}${done ? `: ${done}` : ""}`);
        if (done) legs.push({ i: j, do: p.do, done });
        i = j + 1;
    }
    const out = { at: pos.map((v) => Math.round(v * 10) / 10), maps, fights, relocs, ms: Date.now() - t0, legs };
    log(JSON.stringify(out));
    return out;
}

/** @param {{points: {at: Point, name?: string, cam?: number, do?: string}[], from?: number, to?: number, reach?: number, speed?: number, anchors?: string, dwell?: number, locate?: string | string[], start?: Point, check?: boolean | number[], nodo?: boolean, stronghold?: any}} args */
export default function (args) {
    const cfg = args.stronghold;
    // a stronghold's config gives the route; what the call says (points: a survey's, densified) goes over it
    if (cfg) args = Object.assign({ points: cfg.points, locate: cfg.locate, tracker: cfg.tracker }, args);
    if (args.locate) return follow(/** @type {any} */ (args));
    const reach = args.reach ?? 6;
    const speed = args.speed ?? SPEED;
    const legs = [];
    const from = args.from ?? 1;
    // where it starts: the point before `from` (just teleported to the stone, or just reached), checked on the map
    /** @type {{x: number, y: number, cam?: number | null}} */
    let pos = { x: args.points[from - 1].at[0], y: args.points[from - 1].at[1] };
    let known = false; // pos is trusted
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
        const p = where(args.stronghold);
        if (!p) throw new Error("big map: stronghold icon not found (or standing on it)");
        if (image) {
            anchors.push({ n: maps, seq: image.seq, time: image.time, x: p.x, y: p.y, cam: p.cam });
            log(`anchor ${JSON.stringify(anchors[anchors.length - 1])}`); // kept in the logs if the walk fails later
        }
        known = true;
        if (args.dwell) sleep(args.dwell);
        return p;
    };
    for (let i = from; i <= (args.to ?? args.points.length - 1); i++) {
        const p = args.points[i];
        let tries = 0;
        let away = 0; // big map legs in a row that ended farther from the point
        for (;;) {
            if (++tries > LEGS) throw new Error(`point ${i} (${p.name ?? ""}): not reached after ${LEGS} tries`);
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
