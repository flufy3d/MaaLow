// Walking on the world screen. The joystick is floating: pressing (175,569) and dragging R px sets the direction,
// relative to the camera (up = where the camera looks). Holding dodge while moving starts a sprint that lasts until
// the character stops. Contact 0 stays on the joystick the whole time; taps (dodge, pickup) use contact 1, since a
// tap from outside this skill would cancel the held joystick (teaching explore messages 4–9).
//
//   {bearing: 0, ms: 5000}   walk north (compass degrees), steering by the camera direction read from the minimap
//   {rel: 90, ms: 2000}      walk right of the camera, without steering
//   {enemy: true}            run to the nearest red mark on the minimap, turning the camera toward it; within
//                            `lockAt` (25) minimap px tap lock-on until the lock button turns gold (a white dot marks
//                            the enemy, however far); stop `near` (6) minimap px away (sprinting carries it a bit further). Not getting
//                            closer for 1.5 s is stuck (unless locked and within 12 px: arrived): jump, edge around left / right, back off and go wide
//   {zone: true, bearing: 42}  stronghold (据点): chase only the red marks on the orange patch of the minimap, ignoring
//                            strays around it; with none in sight head for the patch's middle, done ("clear") within
//                            `zoneAt` (8) px of it; before the patch shows, run `bearing` (from the big map)
//   untilFight: true         enemy / zone: stop ("fight") once a fight has started (the icons hide), for combat to
//                            take over, rather than keep chasing an enemy that moves about in the fight
//   face: true               keep the camera looking where it runs (within 20°), as when chasing an enemy
//   sprint: true             hold dodge until its icon turns gold (sprinting), then let go; again if it drops;
//                            given up after two presses that did not start one (dungeons may not allow it)
//   {turn: 150}              drag the camera by this many px (right: positive), report the heading before and after
//   {goto: [[-80, 110], [-72, 84]], ref: ["locate/cixin_mosaic", "locate/cixin_bigmap"], from: [-108, 115]}
//                            run through the points and stop at the last (positions: big map px from the stronghold
//                            icon), knowing where it is on every frame without the big map: locate() finds the minimap
//                            in the reference (the next one where the first cannot tell) near where dead reckoning
//                            (camera heading, joystick direction, sprint / run speed) puts it, and a good match resets
//                            the reckoning. Sprints while far, lets go and runs the last stretch so it does not
//                            overshoot. Stuck: the reckoning moves, the matches do not. See goTo()
import { angleDiff, cameraHeading, enemies, onZone, strongholdState, zone } from "./lib/minimap.js";
import { recognize as pickupPoint } from "./auto_pickup.js";
import { calm } from "./lib/hud.js";

/** @type {SkillMeta} */
export const meta = { description: "walk / sprint in a direction on the world screen, picking things up", timeout: 120_000 };

/** @type {Point} */
const STICK = [175, 569];
const R = 83;
/** @type {Point} */
const DODGE = [924, 674];
/** @type {Box} */
const DODGE_ROI = [891, 653, 73, 52];
const GOLD = { lower: [200, 180, 100], upper: [255, 245, 200] }; // cream "疾跑中" button: ~2800 px sprinting, 0 not
/** @type {Point} */
const LOOK = [700, 420]; // camera drags start here, in empty space right of the character
const PICKUP_MS = 500;
const DEG_PX = 0.6; // camera turn per px dragged (100 px ≈ 53–64°, 200 px ≈ 115–126°)
const FACE = 40; // steering: turn the camera toward the target when it is more than this far off
const FACE_RUN = 20; // face: true (routes), a tighter version of the same
const FACE_MS = 1000; // between camera turns
/** @type {Point} */
const LOCK = [1021, 667]; // lock-on: turns gold when locked; with nobody in view it shows "无可锁定目标"
/** @type {Box} */
const LOCK_ROI = [1004, 648, 34, 39];
const LOCK_MS = 800; // between lock taps
const LOCK_PX = 150; // gold px in LOCK_ROI: ~730 locked, ~1 not
/** @type {Point} */
const JUMP = [1029, 576]; // up to three jumps in a row
const HOLD_MS = 2500; // longest dodge press for a sprint; some dungeons do not allow sprinting
const SPRINT_TRIES = 2; // presses that did not start a sprint before giving up on it
const LOCK_CONE = 45; // locked: the locked enemy's mark is within this of the camera direction
const GONE_PX = 12; // locked, a mark last seen this close that disappears: arrived
const SAME_PX = 8; // a mark this close to where the chased one was is the same enemy
const HUD_MS = 400;
const CLEAR_MS = 1500; // zone: this long at the patch's middle with no mark on it is clear
const STUCK_MS = 1500; // chasing: this long without getting 1 minimap px closer is stuck
/**
 * Ways out when stuck, tried in turn (the next one if still stuck): [direction off the target, ms][] with the
 * joystick held; "jump" taps jump. Stuck after the last one ends the run.
 * @type {[number | "jump", number][][]}
 */
const UNSTICK = [
    // a low wall or fence: back off, run at it and jump before it (jumping up against it, the eaves above stop the
    // jump: teacher, 2026-10-02)
    [[180, 600], [0, 250], ["jump", 400], ["jump", 500]],
    [[-60, 1000]], // edge around the left
    [[60, 1000]], // or the right
    [[180, 800], [-90, 1500]], // back off, go wide left
    [[180, 800], [90, 1500]], // back off, go wide right
];

/** The joystick point for a direction relative to the camera. */
function stickAt(rel) {
    const t = (rel * Math.PI) / 180;
    return /** @type {Point} */ ([Math.round(STICK[0] + R * Math.sin(t)), Math.round(STICK[1] - R * Math.cos(t))]);
}

function tap(p, contact = 1, ms = 50) {
    touch.down(p, contact);
    sleep(ms);
    touch.up(contact);
}

/** Drag the camera horizontally by dx px with contact 1. */
export function turn(dx, ms = 300) {
    const steps = Math.max(3, Math.round(ms / 30));
    touch.down(LOOK, 1);
    for (let i = 1; i <= steps; i++) {
        sleep(ms / steps);
        touch.move([LOOK[0] + Math.round((dx * i) / steps), LOOK[1]], 1);
    }
    sleep(50);
    touch.up(1);
}

/** Minimap offset of a mark from the character. */
function offset(e) {
    const t = (e.bearing * Math.PI) / 180;
    return [e.dist * Math.sin(t), -e.dist * Math.cos(t)];
}

/**
 * The mark to chase. Locked on, the game keeps the camera on the locked enemy: the mark nearest the camera direction.
 * Before that, the one chased last (the mark nearest where it was), so two enemies at similar distances do not take
 * turns; the nearest when it is gone.
 */
function pick(foes, last, cam, lock) {
    if (!foes.length) return null;
    if (lock && cam != null) {
        const ahead = foes.filter((e) => Math.abs(angleDiff(e.bearing, cam)) <= LOCK_CONE);
        if (ahead.length) return ahead.reduce((a, b) => (Math.abs(angleDiff(b.bearing, cam)) < Math.abs(angleDiff(a.bearing, cam)) ? b : a));
    }
    if (last) {
        const [lx, ly] = offset(last);
        const d = (e) => {
            const [x, y] = offset(e);
            return Math.hypot(x - lx, y - ly);
        };
        const same = foes.reduce((a, b) => (d(b) < d(a) ? b : a));
        if (d(same) <= SAME_PX) return same;
    }
    return foes[0];
}

/** Run the moves of one way out, relative to the target direction `rel`. */
function unstick(moves, rel) {
    for (const [dir, ms] of moves) {
        if (dir === "jump") {
            touch.move(stickAt(rel), 0);
            tap(JUMP);
        } else touch.move(stickAt(rel + dir), 0);
        sleep(ms);
    }
}

/** The dodge button turns gold while sprinting. */
function sprinting(image) {
    return color({ ...GOLD, image, roi: DODGE_ROI, count: 1000 }).hit;
}

/** The lock button is gold while an enemy is locked. */
function locked(image) {
    return color({ ...GOLD, image, roi: LOCK_ROI, count: LOCK_PX }).hit;
}

// goto: where it is, frame by frame (route.js locate mode; measured on the 2026-09-30 survey, tools/wwm_locate.py)
const V_SPRINT = 8; // big map px per second sprinting (steady ~8)
const V_RUN = 4.6; // running, not sprinting (12 px in 2.6 s)
const COAST_MS = 500; // a sprint carries on ~3 px after the joystick is let go (up to ~7 outside)
const V_COAST = 6;
const FIX_MIN = 0.4; // a match counts from this score, and this far above the best elsewhere (on the survey's
const FIX_MARGIN = 0.1; // frames: 2 wrong among 243 taken with the stitched reference)
const SEARCH = [10, 8, 40]; // search radius around the reckoning: px, + px per second without a match, at most
// a match this far from the reckoning (px, + sprint speed × the time since the last match) is not taken while that
// last match is recent: a jump no run can make (酒肉山林's gate, the minimap zooming in: 0.41 for a place 10 px off,
// a quarter of a second after a good match; it then steered by that into the wall and was lost)
const GATE_PX = 4;
const GATE_MS = 1500;
const LOST_MS = 3000; // no match this long: lost
// No running on the reckoning alone: before the first match of a leg it stands (where it was put can be wrong: a
// resumed route set off west from a misread place and ran off 酒肉山林's west yard, over the edge), and with no match
// for STALL_MS it stops until one comes (or LOST_MS: lost, the route finds it again)
const STALL_MS = 1500;
const EVENT_MS = 2000; // the trace sent as a "goto" event this often
const PASS = 2.5; // a point on the way counts as passed this close,
const PASS_SIDE = 6; // or once past it (over the line across the way there) no farther than this to the side
const LOOKAHEAD = 3; // steering: at the point this far ahead along the way from where it is across the leg (big map px)
const REACH_BACK = 3; // the last point: within this and getting farther again (it went by), arrived too
const LOOK_MS = 1500; // at the last point with no match this long (the reckoning alone is no arrival: up stairs it
// runs slower than reckoned, 2 px/s at the chest; after a fight matches can drop out): look wider
const SPRINT_STOP = 12; // let go of a sprint this far from the last point, then run the rest
// Sprint only on the minimap's zoomed-out level (the way to the gate); in a courtyard (zoomed in: small doors, tight
// turns) it runs: sprinting it carries on past the turns and through the matches (teacher, 2026-10-02)
const SPRINT_ZOOM = "out";
const BRAKE_MS = 350; // how long the joystick is let go to end the sprint
const SPRINT_AFTER = 300; // the joystick held this long before dodge is pressed for a sprint: pressed with it, before
// the character runs, dodge is a roll that sets it 2–3 px off the way (酒肉山林 point 11→12, into a wall's corner)
const GO_STUCK_MS = 2000; // not 1 px closer to the point this long: stuck
const ASTRAY = 15; // this much farther from the point than the closest it got: astray
const SETTLE_MS = 600; // at the end: coasting, then the match that says it is there
// Steering bias: the way it actually runs (two matches BIAS_MS apart) against the way it was steered. The camera
// heading read from the fan can be ~30° off over a bright day sky (酒肉山林 2026-10-02: steered 244°, ran 278°, into a
// wall's corner 4 px off the way), and the joystick goes by it; the difference, smoothed, is taken off the steering.
const BIAS_MS = 600;
const BIAS_RUN = 0.7; // only while it runs at least this share of the speed (sliding along a wall is slower)
const BIAS_GAIN = 0; // off (teacher, 2026-10-02): with bad matches it learns a wrong bias and steers off the way the
// whole leg (酒肉山林's 4th live run went 8 px south of the road, 37° off, onto the rocks before the gate)
const BIAS_MAX = 60;
const FIGHT_BIG = 30; // the top right icons hidden and a red mark this close (big map px): a fight; in minimap px
// (by the k of the level matched last) that is ~26 in the courtyard but ~13 outside, so the enemies behind the wall
// that spot it at the gate do not stop it
const STATE_MS = 500; // between looks at the stronghold's state (strongholdState()), which picks the reference's
// layer; it changes once two looks in a row agree

/** @param {Point} from @param {Point} to */
const bearingTo = (from, to) => (Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180 / Math.PI + 360) % 360;
/** @param {Point} a @param {Point} b */
const distTo = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * locate() near `prior` (null: the whole reference) in each reference in turn (a stitched one where it was surveyed,
 * the big map where not), only the levels of `layer` and those with none (no layer: all); the first match that can
 * be trusted, else null. A mosaic's zoomed-in levels can be split by the stronghold's state, "live" (its orange zone
 * over most of it) and "taken"; frames of either state match their own much better (酒肉山林's held-out live frames:
 * live level only 75% trusted, 0.52 px median, 23 over 4 px; both levels, best score 77%, 1.15 px, 181; taken level
 * only 54%). Levels with no layer are tried either way, so one-layer references are not affected.
 * @param {string | string[]} ref @param {Image} image @param {number | null} cam @param {Point | null} prior @param {number} radius @param {string} [layer]
 */
function fix(ref, image, cam, prior, radius, layer) {
    for (const one of Array.isArray(ref) ? ref : [ref]) {
        const r = locate(one, { image, wedge: cam, prior: prior ?? undefined, radius, layer });
        if (r && r.score >= FIX_MIN && r.score - r.second >= FIX_MARGIN) return r;
    }
    return null;
}

const RELOCATE_PX = 4; // relocate: two looks in a row this close agree
const RELOCATE_NEAR = 25; // relocate: first within this of where it was put (px), the whole reference after half the time

/**
 * Where the character is from the minimap alone, with nothing to go by (a fight pulled it around, the track was
 * lost): locate() over the whole of each reference, taken once two looks in a row agree; null if none do in `ms`.
 * `layer`: the stronghold's state if known (see fix()); `near`: where it was put (looked around first).
 * @param {string | string[]} ref @param {number} [ms] @param {string} [layer] @param {Point} [near]
 * @returns {Point | null}
 */
export function relocate(ref, ms = 4000, layer, near) {
    const t0 = Date.now();
    /** @type {Point | null} */
    let last = null;
    while (Date.now() - t0 < ms) {
        const image = screenshot();
        // near where it was first (a fight seldom pushes it 20 px): over the whole reference two looks in a row once
        // agreed on a place 77 px off (佛爷寨, 2026-10-02, a look-alike corner)
        const wide = !near || Date.now() - t0 > ms / 2;
        const r = fix(ref, image, cameraHeading(image), wide ? null : near, wide ? SEARCH[2] : RELOCATE_NEAR, layer);
        if (r) {
            if (last && distTo(last, [r.x, r.y]) <= RELOCATE_PX) return [r.x, r.y];
            last = [r.x, r.y];
        } else last = null;
        sleep(200);
    }
    return null;
}

/**
 * Run through `args.goto` (big map px from the stronghold icon), stopping at the last point.
 * Every frame: dead reckoning moves the position along the direction steered (camera + joystick) at the speed of the
 * moment (sprinting: the dodge button is gold; running; coasting a moment after letting go), then locate() looks for
 * the minimap near it, within a radius that grows while nothing matches; a trusted match replaces the position.
 * Points on the way are passed within PASS, or once past them (turning early cut the corners: into the statue by the
 * steps at 石像旁); the last is run to within `reach` (or went by it within REACH_BACK): sprinting (while more than
 * SPRINT_STOP + 6 px off), letting go at SPRINT_STOP to end the sprint, running the rest.
 * Picks up what it passes (pickup: false to leave it).
 * Ends: arrived | stuck (no closer for GO_STUCK_MS after every way out) | astray | lost (no match for LOST_MS) |
 * fight (the top right icons hide) | time.
 * `k`: the scale matched last (the result's `k`, carried from leg to leg) for the fight check until this leg matches.
 * `bias`: the steering bias (see BIAS_MS) carried from leg to leg too; the result's `bias` is where it ended.
 * `layer`: the stronghold's state known so far ("live" | "taken", carried from leg to leg like `k`); it changes when
 * the minimap shows the other (strongholdState(), two looks in a row), and picks the reference levels tried (fix()).
 * @param {{goto: Point[], ref: string | string[], from?: Point, k?: number, bias?: number, layer?: string, reach?: number, ms?: number, sprint?: boolean, face?: boolean, pickup?: boolean}} args
 */
function goTo(args) {
    const path = args.goto;
    const reach = args.reach ?? 2;
    const ms = args.ms ?? 60000;
    const t0 = Date.now();
    let cam = cameraHeading(screenshot());
    /** @type {Point | null} */
    let pos = args.from ? [args.from[0], args.from[1]] : null;
    let wide = true; // the widest radius on the next look (the whole reference with no position yet)
    let lastFix = t0;
    let fixes = 0;
    let misses = 0;
    let gated = 0; // matches not taken: too far from where it could be
    /** @type {string | null} */
    let zoomAt = null; // the zoom level matched last
    let missRun = 0;
    let maxMissRun = 0;
    let idx = 0;
    let held = false; // the joystick is down
    let heldAt = 0; // since
    let holding = 0; // dodge pressed for a sprint since
    let sprintFails = 0;
    let fast = false;
    let slow = false; // the sprint was let go near the end: run from here
    let brakeAt = 0;
    let releasedAt = 0;
    let coastFast = false;
    /** @type {number | null} */
    let dir = null; // compass direction steered
    let bias = args.bias ?? 0; // the way it runs minus the way it is steered (degrees)
    /** @type {{t: number, p: Point, dir: number} | null} */
    let ran = null; // the last match it measured the way it runs from
    let lastT = t0;
    let closest = Infinity;
    let nearest = Infinity; // the last point: closest so far, to the fraction
    let lookSince = 0; // stopped at the last point to see it matched
    let lastPickup = 0;
    let taps = 0; // pickups on the way
    let k = args.k ?? null; // big map px per minimap px, of the level matched last (none yet: no fight check)
    /** @type {string | undefined} */
    let layer = args.layer;
    /** @type {string | null} */
    let seen = null; // the last look's state
    let lastState = 0;
    /** @type {[number, string][]} */
    const layers = []; // [ms, layer] each time it changed
    let since = t0;
    let level = 0;
    let lastHud = 0;
    let hudMiss = 0;
    let lastFace = 0;
    let rel = 0;
    let why = "time";
    const stuck = [];
    /** @type {Record<string, any>[]} */
    const trace = [];
    const start = pos;
    /**
     * The point to steer at: where `p` is across the leg into point `i`, LOOKAHEAD px on along the way (into the next
     * legs; not past the last point). Steering at the next point instead, a point passed a step off to the side, or a
     * sideways drift, put it a few px off the leg for the whole of the next one: the planned legs keep ~1 px from what
     * was walked, so that ran it into a pocket of the wall (酒肉山林 points 11→12, 19→20, 2026-10-02).
     * @param {Point} p @param {number} i @returns {Point}
     */
    const aim = (p, i) => {
        const a = i ? path[i - 1] : start ?? p;
        const b = path[i];
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const l2 = vx * vx + vy * vy;
        const t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 1;
        /** @type {Point} */
        let cur = [a[0] + t * vx, a[1] + t * vy];
        let k = i;
        let rest = LOOKAHEAD;
        for (;;) {
            const end = path[k];
            const d = distTo(cur, end);
            if (rest <= d || k >= path.length - 1) {
                const f = d > 1e-6 ? Math.min(1, rest / d) : 1;
                return [cur[0] + (end[0] - cur[0]) * f, cur[1] + (end[1] - cur[1]) * f];
            }
            rest -= d;
            cur = end;
            k++;
        }
    };
    /** One line of the trace every 250 ms. @param {Image} image @param {Located | null} r @param {number} dist */
    const note = (image, r, dist) => {
        const now = Date.now();
        if (!pos || (trace.length && now - t0 - trace[trace.length - 1].t < 250)) return;
        trace.push({ t: now - t0, seq: image.seq, x: Math.round(pos[0] * 10) / 10, y: Math.round(pos[1] * 10) / 10, sc: r ? Math.round(r.score * 100) / 100 : null, ...(r ? { lv: r.layer ?? r.zoom } : {}), ...(bias ? { b: Math.round(bias) } : {}), i: idx, d: Math.round(dist), ...(fast ? { fast } : {}), ...(slow ? { slow } : {}) });
        // the trace as it goes, as events (/events): a run stopped by the teacher returns no logs
        if (now - sentAt >= EVENT_MS) {
            event("goto", { goal: path[path.length - 1], trace: trace.slice(sent) });
            sent = trace.length;
            sentAt = now;
        }
    };
    let sent = 0;
    let sentAt = 0;
    /**
     * Point k is behind: close to it, or past the line across the way at it (and not far off to the side).
     * @param {Point} at @param {number} k
     */
    const passed = (at, k) => {
        const d = distTo(at, path[k]);
        if (d <= PASS) return true;
        const prev = k ? path[k - 1] : start;
        if (!prev || d > PASS_SIDE) return false;
        return (at[0] - path[k][0]) * (path[k][0] - prev[0]) + (at[1] - path[k][1]) * (path[k][1] - prev[1]) >= 0;
    };
    const release = () => {
        if (holding) touch.up(1);
        holding = 0;
        if (held) touch.up(0);
        held = false;
    };
    const press = () => {
        touch.down(STICK, 0);
        sleep(50);
        touch.move(stickAt(rel), 0);
        held = true;
        heldAt = Date.now();
    };
    try {
        while (Date.now() - t0 < ms) {
            const image = screenshot();
            const now = Date.now();
            const dt = (now - lastT) / 1000;
            lastT = now;
            cam = cameraHeading(image, cam);
            // dead reckoning
            if (pos && dir != null) {
                const v = held ? (fast ? V_SPRINT : V_RUN) : now - releasedAt < COAST_MS ? (coastFast ? V_COAST : 1) : 0;
                const t = (dir * Math.PI) / 180;
                pos = [pos[0] + v * dt * Math.sin(t), pos[1] - v * dt * Math.cos(t)];
            }
            const radius = wide ? SEARCH[2] : Math.min(SEARCH[2], SEARCH[0] + (SEARCH[1] * (now - lastFix)) / 1000);
            if (now - lastState >= STATE_MS) {
                lastState = now;
                const look = strongholdState(image);
                if (look && look !== layer && look === seen) {
                    layer = look;
                    layers.push([now - t0, look]);
                }
                seen = look;
            }
            let r = fix(args.ref, image, cam, pos, radius, layer);
            if (r && pos && !wide && now - lastFix < GATE_MS && distTo(pos, [r.x, r.y]) > GATE_PX + (V_SPRINT * (now - lastFix)) / 1000) {
                gated++;
                r = null;
            }
            wide = false;
            if (r) {
                const at = /** @type {Point} */ ([r.x, r.y]);
                // the steering bias, from the way it ran since the last sample (steered the same way, running)
                if (held && !holding && dir != null && ran && now - ran.t >= BIAS_MS) {
                    const d = distTo(ran.p, at);
                    if (Math.abs(angleDiff(dir, ran.dir)) < 15 && d >= Math.max(1.5, (BIAS_RUN * (fast ? V_SPRINT : V_RUN) * (now - ran.t)) / 1000)) {
                        bias = Math.max(-BIAS_MAX, Math.min(BIAS_MAX, bias + BIAS_GAIN * angleDiff(bearingTo(ran.p, at), ran.dir)));
                    }
                    ran = null;
                }
                if (!ran && held && dir != null) ran = { t: now, p: at, dir };
                pos = at;
                k = r.k;
                zoomAt = r.zoom;
                lastFix = now;
                fixes++;
                missRun = 0;
            } else {
                misses++;
                maxMissRun = Math.max(maxMissRun, ++missRun);
                if (now - lastFix > LOST_MS || !pos) {
                    why = "lost";
                    break;
                }
            }
            if (now - lastHud >= HUD_MS) {
                lastHud = now;
                // the icons also drop out against a bright sky: a fight needs an enemy close by too
                if (k != null && !calm(image) && enemies(image).some((e) => e.dist * /** @type {number} */ (k) <= FIGHT_BIG)) {
                    if (++hudMiss >= 2) {
                        why = "fight";
                        break;
                    }
                } else hudMiss = 0;
            }
            // the point to run to: points on the way are passed
            while (idx < path.length - 1 && passed(pos, idx)) {
                idx++;
                closest = Infinity;
                level = 0;
            }
            const goal = path[idx];
            const last = idx === path.length - 1;
            const dist = distTo(pos, goal);
            if (last && (dist <= reach || (dist <= REACH_BACK && dist > nearest + 1))) {
                // there: stop, and take it once a match after it has stood still (coasting) says so; a match that puts
                // it elsewhere goes on from there, none for a while looks wider, none for LOST_MS is lost (the route
                // finds it on the whole reference then)
                if (!lookSince) {
                    lookSince = now;
                    if (held) {
                        releasedAt = now;
                        coastFast = fast;
                        release();
                    }
                }
                if (r && now - lookSince >= SETTLE_MS) {
                    why = "arrived";
                    break;
                }
                if (now - lastFix > LOOK_MS) wide = true;
                note(image, r, dist);
                continue;
            }
            lookSince = 0;
            if (last && r) nearest = Math.min(nearest, dist); // by matches only: the reckoning can be off by more
            if (dist < closest - 1) {
                closest = dist;
                since = now;
                level = 0;
            } else if (dist > closest + ASTRAY) {
                why = "astray";
                break;
            } else if (now - since > GO_STUCK_MS && held) {
                if (level >= UNSTICK.length) {
                    why = "stuck";
                    break;
                }
                if (holding) {
                    touch.up(1);
                    holding = 0;
                }
                stuck.push([now - t0, level, Math.round(pos[0]), Math.round(pos[1])]);
                unstick(UNSTICK[level++], rel);
                since = Date.now();
                lastT = Date.now(); // the way out's moves are not reckoned: look wide next
                wide = true;
                continue;
            }
            // near the end of a sprint: let go so it stops sprinting, then run the rest
            if (fast && !slow && ((last && dist <= SPRINT_STOP) || (zoomAt != null && zoomAt !== SPRINT_ZOOM))) {
                slow = true;
                coastFast = true;
                releasedAt = brakeAt = now;
                release();
                continue;
            }
            if (!fixes || now - lastFix > STALL_MS) {
                if (held) {
                    releasedAt = now;
                    coastFast = fast;
                    release();
                }
                note(image, r, dist);
                continue;
            }
            if (!held && (!brakeAt || now - brakeAt >= BRAKE_MS)) {
                if (cam != null) rel = angleDiff(bearingTo(pos, aim(pos, idx)) - bias, cam);
                press();
                ran = null;
            }
            const bearing = bearingTo(pos, aim(pos, idx));
            if (cam != null) {
                rel = angleDiff(bearing - bias, cam);
                if (dir != null && Math.abs(angleDiff(bearing, dir)) >= 15) ran = null; // steered another way: start over
                dir = bearing;
            }
            if (held) touch.move(stickAt(rel), 0);
            // keep the camera on the way ahead (not while dodge is held: the turn uses contact 1 too)
            if (args.face !== false && cam != null && Math.abs(rel) > FACE_RUN && !holding && now - lastFace >= FACE_MS && held) {
                const dx = Math.max(-300, Math.min(300, Math.round(rel / DEG_PX)));
                turn(dx);
                cam = (cam + dx * DEG_PX + 360) % 360;
                lastFace = Date.now();
                ran = null; // the run during a turn sweeps round
                continue;
            }
            fast = sprinting(image);
            const far = !slow && (zoomAt == null || zoomAt === SPRINT_ZOOM) && (!last || dist > SPRINT_STOP + 6);
            if (args.sprint !== false && far && held && now - heldAt >= SPRINT_AFTER && sprintFails < SPRINT_TRIES && !holding && !fast) {
                touch.down(DODGE, 1);
                holding = now;
            } else if (holding && (fast || now - holding > HOLD_MS)) {
                touch.up(1);
                holding = 0;
                if (fast) sprintFails = 0;
                else sprintFails++;
            }
            // pick up what lies on the way (a tap above the list on the right, contact 1: not while dodge is held)
            if (args.pickup !== false && !holding && now - lastPickup >= PICKUP_MS) {
                lastPickup = now;
                const hit = pickupPoint({}, /** @type {SkillContext} */ ({ image }));
                if (hit) {
                    const [x, y, w, h] = hit.box;
                    tap([x + w / 2, y + h / 2]);
                    taps++;
                }
            }
            note(image, r, dist);
        }
    } finally {
        release();
    }
    const out = { ms: Date.now() - t0, why, at: pos && [Math.round(pos[0] * 10) / 10, Math.round(pos[1] * 10) / 10], k, bias: Math.round(bias), layer, layers, idx, fixes, misses, gated, maxMissRun, stuck, taps, trace };
    log(JSON.stringify(out));
    return out;
}

/**
 * @param {{face?: boolean, bearing?: number, rel?: number, enemy?: boolean, zone?: boolean, untilFight?: boolean, zoneAt?: number, near?: number, lockAt?: number, capture?: boolean, ms?: number, sprint?: boolean,
 *          pickup?: boolean, turn?: number, step?: number, goto?: Point[], ref?: string | string[], from?: Point, k?: number, layer?: string, reach?: number}} args
 * @param {SkillContext} [ctx]
 */
export default function (args, ctx) {
    if (args.goto) return goTo(/** @type {any} */ (args));
    if (args.turn != null) {
        const before = cameraHeading(screenshot());
        turn(args.turn);
        sleep(400);
        const after = cameraHeading(screenshot());
        const out = { before, after, turned: before == null || after == null ? null : angleDiff(after, before) };
        log(JSON.stringify(out));
        return out;
    }
    const ms = args.ms ?? 5000;
    const step = args.step ?? 100;
    const trace = [];
    let taps = 0;
    let lastPickup = 0;
    let lastLock = 0;
    let lastFace = 0;
    let lock = false; // the lock button is gold
    let locks = 0;
    let holding = 0; // when the dodge press for a sprint started, 0 if not pressed
    let lastSeen = Date.now(); // enemy mode: last time a red mark showed
    let sprintFails = 0;
    let closest = Infinity; // chasing: nearest the target has been
    let since = Date.now(); // when it last got closer, or the last way out ended
    let level = 0; // next way out to try
    const stuck = []; // [ms, way out] tried
    let why = "time";
    const t0 = Date.now();
    touch.down(STICK, 0);
    try {
        sleep(50);
        let rel = args.rel ?? 0;
        let cam = null;
        let foe = null;
        let target = null; // foe, or the patch's middle
        let clearSince = 0; // zone: at its middle with no mark on it, since
        let lastHud = 0; // untilFight: last look at the top right icons
        let hudMiss = 0; // untilFight: looks in a row without them
        while (Date.now() - t0 < ms) {
            const image = screenshot();
            const now = Date.now();
            let bearing = args.bearing;
            const chase = args.enemy || args.zone;
            if (chase || bearing != null) cam = cameraHeading(image, cam);
            if (chase) {
                const was = lock;
                lock = locked(image);
                if (lock && !was && args.capture) saveImage(image, "captures/locked.png");
                let foes = enemies(image);
                let goal = null; // zone: no enemy on the patch in sight, head for its middle
                if (args.untilFight && now - lastHud >= HUD_MS) {
                    lastHud = now;
                    if (!calm(image)) {
                        if (++hudMiss >= 2) {
                            why = "fight";
                            break;
                        }
                    } else hudMiss = 0;
                }
                if (args.zone) {
                    const z = zone(image);
                    foes = z ? foes.filter((e) => onZone(image, e)) : [];
                    if (!foes.length && !lock && z) {
                        // marks can drop out for a frame or two (under the arrow, the fan): clear only when it holds
                        if (z.dist <= (args.zoneAt ?? 8)) {
                            clearSince ||= now;
                            if (now - clearSince >= CLEAR_MS) {
                                why = "clear";
                                break;
                            }
                        } else clearSince = 0;
                        goal = z;
                    } else clearSince = 0;
                }
                const prev = target;
                foe = pick(foes, foe, cam, lock);
                target = foe ?? goal;
                if (target && prev) {
                    const [ax, ay] = offset(target);
                    const [bx, by] = offset(prev);
                    if (Math.hypot(ax - bx, ay - by) > SAME_PX) {
                        closest = Infinity; // another enemy: progress counts from here
                        level = 0;
                    }
                }
                if (target) {
                    lastSeen = now;
                    bearing = target.bearing;
                    if (foe && foe.dist <= (args.near ?? 6)) {
                        why = "near";
                        break;
                    }
                    if (target.dist < closest - 1) {
                        closest = target.dist;
                        since = now;
                        level = 0;
                    } else if (now - since > STUCK_MS && cam != null) {
                        if (lock && foe && foe.dist <= GONE_PX) {
                            why = "near"; // up against the locked enemy: not stuck (teaching message 2)
                            break;
                        }
                        if (level >= UNSTICK.length) {
                            why = "stuck";
                            break;
                        }
                        if (holding) {
                            touch.up(1);
                            holding = 0;
                        }
                        stuck.push([now - t0, level]);
                        unstick(UNSTICK[level++], angleDiff(target.bearing, cam));
                        since = Date.now(); // `closest` stays: only getting past it counts as progress
                        continue;
                    }
                    if (foe && !lock && foe.dist <= (args.lockAt ?? 25) && !holding && now - lastLock >= LOCK_MS) {
                        lastLock = now;
                        tap(LOCK);
                        locks++;
                        if (args.capture) {
                            sleep(250);
                            saveImage(screenshot(), `captures/lock_${locks}.png`);
                        }
                    }
                } else if (lock && closest <= GONE_PX) {
                    why = "near"; // close by, the mark goes under the arrow or the crowd
                    break;
                } else if (args.zone) {
                    // the patch is not in sight yet: keep to `bearing`
                    if (bearing == null && now - lastSeen > 2000) {
                        why = "no_zone";
                        break;
                    }
                } else if (now - lastSeen > 2000) {
                    why = lock ? "locked" : "no_enemy";
                    break;
                }
            }
            if (bearing != null && cam != null) rel = angleDiff(bearing, cam);
            touch.move(stickAt(rel), 0);
            // chasing: keep the camera on the target, so it is in view for lock-on
            // face: on a route too, so the camera looks where the run goes (teacher after message 132)
            const faceAt = foe ? FACE : args.face ? FACE_RUN : null;
            if (faceAt != null && bearing != null && !lock && cam != null && Math.abs(rel) > faceAt && !holding && now - lastFace >= FACE_MS) {
                const dx = Math.max(-300, Math.min(300, Math.round(rel / DEG_PX)));
                turn(dx);
                cam = (cam + dx * DEG_PX + 360) % 360; // where tracking starts looking for the fan
                lastFace = Date.now();
                continue;
            }
            const fast = args.sprint ? sprinting(image) : false;
            if (args.sprint && sprintFails < SPRINT_TRIES && !holding && !fast && now - t0 > 200) {
                touch.down(DODGE, 1);
                holding = now;
            } else if (holding && (fast || now - holding > HOLD_MS)) {
                touch.up(1);
                holding = 0;
                if (fast) sprintFails = 0;
                else if (++sprintFails >= SPRINT_TRIES) log("no sprint here");
            }
            if (args.pickup !== false && !holding && now - lastPickup >= PICKUP_MS) {
                lastPickup = now;
                const hit = pickupPoint({}, /** @type {SkillContext} */ ({ image }));
                if (hit) {
                    const [x, y, w, h] = hit.box;
                    tap([x + w / 2, y + h / 2]);
                    taps++;
                }
            }
            if (trace.length === 0 || now - t0 - trace[trace.length - 1].t >= 500) {
                trace.push({
                    t: now - t0,
                    cam: cam == null ? null : Math.round(cam),
                    rel: Math.round(rel),
                    ...(args.sprint ? { fast } : {}),
                    ...(foe ? { foe: [Math.round(foe.bearing), Math.round(foe.dist)] } : target ? { goal: [Math.round(target.bearing), Math.round(target.dist)] } : {}),
                    ...(lock ? { lock } : {}),
                });
            }
            sleep(step);
        }
    } finally {
        if (holding) touch.up(1);
        touch.up(0);
    }
    // found: locked on (the teacher's test for "found an enemy")
    const out = { ms: Date.now() - t0, why, found: lock, taps, locks, stuck, trace };
    log(JSON.stringify(out));
    // a pipeline node (SeekEnemy) fails when nobody was found
    if (ctx?.trigger === "pipeline" && args.enemy && !lock) return false;
    // a stronghold node goes on when an enemy there is locked or none is left
    if (ctx?.trigger === "pipeline" && args.zone && !lock && why !== "clear") return false;
    return out;
}
