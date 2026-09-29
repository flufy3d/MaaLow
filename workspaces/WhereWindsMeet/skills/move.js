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
//   sprint: true             hold dodge until its icon turns gold (sprinting), then let go; again if it drops;
//                            given up after two presses that did not start one (dungeons may not allow it)
//   {turn: 150}              drag the camera by this many px (right: positive), report the heading before and after
import { angleDiff, cameraHeading, enemies } from "./lib/minimap.js";
import { recognize as pickupPoint } from "./auto_pickup.js";

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
const STUCK_MS = 1500; // chasing: this long without getting 1 minimap px closer is stuck
/**
 * Ways out when stuck, tried in turn (the next one if still stuck): [direction off the target, ms][] with the
 * joystick held; "jump" taps jump. Stuck after the last one ends the run.
 * @type {[number | "jump", number][][]}
 */
const UNSTICK = [
    [["jump", 300], ["jump", 500]], // a low wall or fence: climb it
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

/**
 * @param {{bearing?: number, rel?: number, enemy?: boolean, near?: number, lockAt?: number, capture?: boolean, ms?: number, sprint?: boolean,
 *          pickup?: boolean, turn?: number, step?: number}} args
 * @param {SkillContext} [ctx]
 */
export default function (args, ctx) {
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
        while (Date.now() - t0 < ms) {
            const image = screenshot();
            const now = Date.now();
            let bearing = args.bearing;
            if (args.enemy || bearing != null) cam = cameraHeading(image, cam);
            if (args.enemy) {
                const was = lock;
                lock = locked(image);
                if (lock && !was && args.capture) saveImage(image, "captures/locked.png");
                const prev = foe;
                foe = pick(enemies(image), foe, cam, lock);
                if (foe && prev) {
                    const [ax, ay] = offset(foe);
                    const [bx, by] = offset(prev);
                    if (Math.hypot(ax - bx, ay - by) > SAME_PX) {
                        closest = Infinity; // another enemy: progress counts from here
                        level = 0;
                    }
                }
                if (foe) {
                    lastSeen = now;
                    bearing = foe.bearing;
                    if (foe.dist <= (args.near ?? 6)) {
                        why = "near";
                        break;
                    }
                    if (foe.dist < closest - 1) {
                        closest = foe.dist;
                        since = now;
                        level = 0;
                    } else if (now - since > STUCK_MS && cam != null) {
                        if (lock && foe.dist <= GONE_PX) {
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
                        unstick(UNSTICK[level++], angleDiff(foe.bearing, cam));
                        since = Date.now(); // `closest` stays: only getting past it counts as progress
                        continue;
                    }
                    if (!lock && foe.dist <= (args.lockAt ?? 25) && !holding && now - lastLock >= LOCK_MS) {
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
                } else if (now - lastSeen > 2000) {
                    why = lock ? "locked" : "no_enemy";
                    break;
                }
            }
            if (bearing != null && cam != null) rel = angleDiff(bearing, cam);
            touch.move(stickAt(rel), 0);
            // chasing: keep the camera on the target, so it is in view for lock-on
            if (args.enemy && !lock && cam != null && Math.abs(rel) > FACE && !holding && now - lastFace >= FACE_MS) {
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
                    ...(foe ? { foe: [Math.round(foe.bearing), Math.round(foe.dist)] } : {}),
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
    return out;
}
