// Stronghold (据点) checks on the minimap, for the pipeline (teaching explore messages 46–58).
//   recognize: the stronghold is cleared, i.e. standing at the middle of its orange patch (all of it in sight) with
//              no red mark on it (StrongholdCleared)
//   where():   where the character stands, in big map px (fully zoomed in) from the stronghold icon, x east / y south:
//              tapping the minimap opens the big map centered on the character (the arrow at PLAYER); the icon is
//              template matched (templates/map_stronghold.png, ~0.97; hidden under the arrow when standing on it);
//              also the camera heading (compass degrees, from the minimap before opening the map)
//   {where: true}  just report that
import { cameraHeading, enemies, onZone, zone } from "./lib/minimap.js";

/** @type {SkillMeta} */
export const meta = { description: "stronghold checks on the minimap", timeout: 10_000 };

/** @type {Point} */
const MINIMAP = [144, 70];
/** @type {Point} */
const PLAYER = [537, 362]; // the arrow on the big map opened from the minimap (533–535, 361–364 seen)
/** @type {Point} */
const MAP_BACK = [1025, 37]; // the big map's back button
const MAP_ROI = /** @type {Box} */ ([0, 60, 1080, 660]);

/** Open the big map, read the character's position from the stronghold icon, close it. null: icon not in sight. */
export function where() {
    const c = cameraHeading(screenshot());
    const cam = c == null ? null : Math.round(c);
    click(MINIMAP);
    const hit = waitFor(() => {
        const h = match("map_stronghold.png", { image: screenshot(), roi: MAP_ROI, threshold: 0.85 });
        return h.hit ? h : null;
    }, { timeout: 5000, interval: 300 }); // the icons show ~2.5 s after the map
    // under the arrow: standing on the icon (the map opened, the back button shows)
    const opened = hit || match("map_stronghold.png", { roi: MAP_ROI, threshold: 0.5 }).hit;
    click(MAP_BACK);
    sleep(800);
    if (!hit) return opened ? { x: 0, y: 0, cam, hidden: true } : null;
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

/** Report what the minimap shows: the patch and the enemies on / off it; {where: true}: the position. */
export default function (args = {}) {
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
