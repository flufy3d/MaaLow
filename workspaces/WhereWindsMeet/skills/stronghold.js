// Stronghold (据点) checks on the minimap, for the pipeline (teaching explore messages 46–58).
//   recognize: the stronghold is cleared, i.e. standing at the middle of its orange patch (all of it in sight) with
//              no red mark on it (StrongholdCleared)
//   where():   where the character stands, in big map px (fully zoomed in) from the stronghold icon, x east / y south:
//              tapping the minimap opens the big map centered on the character (the arrow at PLAYER); the icon is
//              template matched (templates/map_stronghold.png ~0.97; map_stronghold_done.png, the gray icon with an
//              hourglass once taken, ~0.99 / ~0.91 on the live one); null when not found, which includes standing on
//              it (the arrow hides it): no guessing, a wrong position sends a route off in a wrong direction;
//              also the camera heading (compass degrees, from the minimap before opening the map)
//   {where: true}  just report that
//   {locate: ["locate/cixin_mosaic", "locate/cixin_bigmap"], n: 5}  compare locate() (minimap in a reference image,
//                  no big map) with where(): each reference n times, with the time each look took
import { cameraHeading, enemies, onZone, zone } from "./lib/minimap.js";

/** @type {SkillMeta} */
export const meta = { description: "stronghold checks on the minimap", timeout: 60_000 };

/** @type {Point} */
const MINIMAP = [144, 70];
/** @type {Point} */
const PLAYER = [537, 362]; // the arrow on the big map opened from the minimap (533–535, 361–364 seen)
/** @type {Point} */
const MAP_BACK = [1025, 37]; // the big map's back button
const MAP_ROI = /** @type {Box} */ ([0, 60, 1080, 660]);
const ICONS = ["map_stronghold.png", "map_stronghold_done.png"];

/** Open the big map, read the character's position from the stronghold icon, close it. null: icon not found. */
export function where() {
    const c = cameraHeading(screenshot());
    const cam = c == null ? null : Math.round(c);
    click(MINIMAP);
    const hit = waitFor(() => {
        const h = match(ICONS, { image: screenshot(), roi: MAP_ROI, threshold: 0.85 });
        return h.hit ? h : null;
    }, { timeout: 5000, interval: 300 }); // the icons show ~2.5 s after the map
    click(MAP_BACK);
    sleep(800);
    if (!hit) return null;
    const [x, y, w, h] = /** @type {Box} */ (hit.box);
    return { x: PLAYER[0] - (x + w / 2), y: PLAYER[1] - (y + h / 2), cam };
}

/** @param {{zoneAt?: number}} args @param {SkillContext} ctx */
export function recognize(args, ctx) {
    const image = ctx.image ?? screenshot();
    const z = zone(image);
    if (!z || z.dist > (args?.zoneAt ?? 8)) return null;
    if (enemies(image).some((e) => onZone(image, e))) return null;
    return { box: z.box };
}

/** locate() with each reference `n` times against one where(): the readings, their spread and time. */
function compare(refs, n) {
    const out = { where: where(), refs: {} };
    sleep(1500); // the minimap stays zoomed out a moment after the big map closes
    for (const ref of refs) {
        const reads = [];
        for (let i = 0; i < n; i++) {
            const image = screenshot();
            const cam = cameraHeading(image);
            const t0 = Date.now();
            const r = locate(ref, { image, cam, prior: out.where ? [out.where.x, out.where.y] : undefined, radius: 30 });
            reads.push(r ? { x: r.x, y: r.y, score: r.score, second: r.second, zoom: r.zoom, ms: r.ms, call: Date.now() - t0 } : null);
        }
        out.refs[ref] = reads;
    }
    return out;
}

/** Report what the minimap shows: the patch and the enemies on / off it; {where: true}: the position. */
export default function (args = {}) {
    if (args.locate) {
        const out = compare(args.locate, args.n ?? 5);
        log(JSON.stringify(out));
        return out;
    }
    if (args.where) {
        const out = where();
        log(JSON.stringify(out));
        return out;
    }
    const image = screenshot();
    const z = zone(image);
    const foes = enemies(image).map((e) => ({ bearing: Math.round(e.bearing), dist: Math.round(e.dist), on: onZone(image, e) }));
    const out = { zone: z && { bearing: Math.round(z.bearing), dist: Math.round(z.dist), box: z.box }, foes, cleared: !!recognize({}, /** @type {SkillContext} */ ({ image })) };
    log(JSON.stringify(out));
    return out;
}
