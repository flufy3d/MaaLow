// Reading the minimap (top left). It is fixed north-up and moves with the character: the gold arrow at the center is
// the character, the white fan from it is the camera's view, red marks are enemies (teaching explore messages 4–9).
// Angles are compass degrees: 0 north (up), clockwise.

/** @type {Point} */
export const CENTER = [144, 70]; // the arrow's center, where the fan starts
// The fan is a 60° arc about 30 levels brighter than the map around it; the map itself can be as light (over a bright
// sky it shows through), so no fixed threshold works. It is found by normalized template matching with wedges drawn
// every 10° (templates/minimap_fan/DDD.png: r 7–17 px, the arrow and outside green-masked); scores ≥ ~0.6 when found.
/** @type {Box} */
const FAN_ROI = [123, 49, 43, 43]; // the 37 px templates centered on CENTER, ±3 px
const FAN_MIN = 0.4;

/** Compass angle of `p` seen from the center. */
export function bearingOf([x, y]) {
    return (Math.atan2(x - CENTER[0], CENTER[1] - y) * 180 / Math.PI + 360) % 360;
}

/** Signed difference a − b in (−180, 180]. */
export function angleDiff(a, b) {
    const d = (((a - b) % 360) + 360) % 360;
    return d > 180 ? d - 360 : d;
}

/** @type {Box} */
const MAP_ROI = [90, 16, 110, 110]; // the minimap disc
const RADIUS = 52; // the disc's radius; red outside it is scenery
// Enemy marks are red pins, ~(217,109,109), paled to ~(236,181,181) under the fan; the quest bell is brownish
// (~(154,138,112)). By hue (OpenCV HSV, H 0–180) red is apart from both, and from the gray map (low saturation).
const RED = { lower: [[0, 45, 150], [170, 45, 150]], upper: [[8, 255, 255], [180, 255, 255]], method: 40 };
const PIN = 6; // red blobs this close are parts of one pin (its white middle splits it)

/** Enemies (red marks): bearing (compass degrees) and distance (minimap px) from the character, nearest first. */
export function enemies(image) {
    const hit = color({ ...RED, image, roi: MAP_ROI, count: 2, connected: true });
    if (!hit.hit) return [];
    /** @type {{x: number, y: number, n: number}[]} */
    const pins = [];
    for (const { box: [x, y, w, h] } of hit.results) {
        if (w > 12 || h > 12) continue;
        const cx = x + w / 2;
        const cy = y + h / 2;
        const pin = pins.find((p) => Math.hypot(p.x - cx, p.y - cy) <= PIN);
        if (pin) {
            pin.x = (pin.x * pin.n + cx) / (pin.n + 1);
            pin.y = (pin.y * pin.n + cy) / (pin.n + 1);
            pin.n++;
        } else pins.push({ x: cx, y: cy, n: 1 });
    }
    return pins
        .map(({ x, y }) => ({ x, y, bearing: bearingOf([x, y]), dist: Math.hypot(x - CENTER[0], y - CENTER[1]) }))
        .filter((e) => e.dist <= RADIUS)
        .sort((a, b) => a.dist - b.dist);
}

// A stronghold (据点) shows as an orange patch, its enemies are the red marks on it; those around it are strays
// (teaching explore message 58). The patch ~(187,170,131) is H 20–21 S 69–76 over open ground, darker over the
// buildings inside (H 13–19 S 59–84 V 124–157); the map around it H 27 S 41, dark blue-gray H 70+.
const ZONE = { lower: [12, 55, 110], upper: [23, 110, 225], method: 40 };
const ZONE_PX = 150; // smallest patch; the gold arrow gives stray bits of ~50
const ON_ZONE = 20; // orange px in the 13 px box around a mark on the patch (~150 on it, 0 off it)

/**
 * The stronghold patch on the minimap: its box, the bearing and distance (minimap px) of its middle; null if not in
 * sight. Only the part within the disc shows, so the middle is only right once all of it is in sight.
 */
export function zone(image) {
    const hit = color({ ...ZONE, image, roi: MAP_ROI, count: ZONE_PX, connected: true });
    if (!hit.hit) return null;
    const [x, y, w, h] = hit.results.reduce((a, b) => ((b.count ?? 0) > (a.count ?? 0) ? b : a)).box;
    const mid = /** @type {Point} */ ([x + w / 2, y + h / 2]);
    return { box: /** @type {Box} */ ([x, y, w, h]), x: mid[0], y: mid[1], bearing: bearingOf(mid), dist: Math.hypot(mid[0] - CENTER[0], mid[1] - CENTER[1]) };
}

/** Whether an enemy mark (from enemies()) sits on the stronghold patch. */
export function onZone(image, e) {
    const roi = /** @type {Box} */ ([Math.round(e.x) - 6, Math.round(e.y) - 6, 13, 13]);
    return color({ ...ZONE, image, roi, count: ON_ZONE }).hit;
}

/** Score of the fan template at `deg` (a multiple of 10). */
function fanScore(image, deg) {
    const d = ((deg % 360) + 360) % 360;
    const hit = match(`minimap_fan/${String(d).padStart(3, "0")}.png`, { image, roi: FAN_ROI, threshold: -1, green_mask: true });
    return hit.score ?? -1;
}

/**
 * Where the camera looks (compass degrees), or null when the fan is not found. Each template match costs ~7 ms: with
 * `near` (the last heading) only the templates around it are tried, a full scan only when the fan has moved away.
 * @param {Image} image @param {number | null} [near]
 */
export function cameraHeading(image, near = null) {
    const scores = new Map();
    const at = (d) => {
        d = ((d % 360) + 360) % 360;
        if (!scores.has(d)) scores.set(d, fanScore(image, d));
        return /** @type {number} */ (scores.get(d));
    };
    let best = 0;
    if (near != null) {
        best = Math.round(near / 10) * 10;
        // climb to the local maximum, a few steps at most
        for (let i = 0; i < 3; i++) {
            const step = at(best - 10) > at(best) ? -10 : at(best + 10) > at(best) ? 10 : 0;
            if (!step) break;
            best += step;
        }
    }
    if (near == null || at(best) < FAN_MIN) {
        let top = -1;
        for (let d = 0; d < 360; d += 30) if (at(d) > top) [best, top] = [d, at(d)];
        best = at(best - 10) > at(best) ? best - 10 : at(best + 10) > at(best) ? best + 10 : best;
    }
    const top = at(best);
    if (top < FAN_MIN) return null;
    // refine between the neighbors (parabola through three scores)
    const a = at(best - 10);
    const c = at(best + 10);
    const den = a - 2 * top + c;
    const off = den < 0 ? Math.max(-5, Math.min(5, (5 * (a - c)) / den)) : 0;
    return (best + off + 360) % 360;
}
