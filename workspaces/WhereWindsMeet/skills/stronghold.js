// Stronghold (据点) checks on the minimap, for the pipeline (teaching explore messages 46–58).
//   recognize: the stronghold is cleared, i.e. standing at the middle of its orange patch (all of it in sight) with
//              no red mark on it (StrongholdCleared)
//   where():   where the character stands, in big map px (fully zoomed in) from the stronghold icon, x east / y south:
//              tapping the minimap opens the big map centered on the character (the arrow at PLAYER); the icon is
//              template matched (templates/map_stronghold.png ~0.97; map_stronghold_done.png, the gray icon with an
//              hourglass once taken, ~0.99 / ~0.91 on the live one; positions in taken-icon terms, LIVE_AT); null
//              when not found, which includes standing on it (the arrow hides it): then the name label (慈心山院)
//              above it, a fixed step from the icon, is read instead; no guessing otherwise, a wrong position sends a
//              route off in a wrong direction;
//              also the camera heading (compass degrees, from the minimap before opening the map)
//   {where: true}  just report that
//   {locate: ["locate/cixin_mosaic", "locate/cixin_bigmap"], n: 5}  compare locate() (minimap in a reference image,
//                  no big map) with where(): each reference n times, with the time each look took
//   progress():  the stronghold's tasks on the tracker under the minimap (OCR), e.g. 击败绣金卫 3/7
//   waiting:     (recognition) the stronghold's card on the big map says when it comes back (势力重新占据时间): not
//                refreshed yet; the text is kept in memory for start()
//   {relocate: ["locate/cixin_mosaic", "locate/cixin_bigmap"]}  where the character is from the minimap alone, over the
//                  whole reference (move.js relocate(), used by the route after a fight)
//   {stone: true}  (node Teleport_ClosePanel) on the big map the stronghold card opened: close its panel and tap the
//                  teleport stone nearest the stronghold icon, zooming in first if the map was left zoomed out
//   {teleport: "CixinTeleport"}  one-click start (node Cixin): close popups, run the teleport node to the stone, and
//                  stop with an error if on the way the card said the stronghold has not come back yet (its marker node
//                  Teleport_NotRefreshed, recognition waiting); the route node goes on from there
import { cameraHeading, enemies, onZone, zone } from "./lib/minimap.js";
import { relocate } from "./move.js";

/** @type {SkillMeta} */
export const meta = { description: "stronghold checks on the minimap", timeout: 180_000 };

/** @type {Point} */
const MINIMAP = [144, 70];
/** @type {Point} */
const PLAYER = [537, 362]; // the arrow on the big map opened from the minimap (533–535, 361–364 seen)
/** @type {Point} */
const MAP_BACK = [1025, 37]; // the big map's back button
const MAP_ROI = /** @type {Box} */ ([0, 60, 1080, 660]);
const ICONS = ["map_stronghold.png", "map_stronghold_done.png"];
const LABEL = "map_label_cixin.png"; // 慈心山院 over the stronghold (a label per stronghold: one reference for now)
/** @type {Point} */
const LABEL_AT = [53, -50.5]; // the label's middle from the icon's (7 big map shots, all the same)
const LABEL_AFTER = 3000; // the icons have shown by then
/** @type {Point} */
const LIVE_AT = [-1, -2]; // the live icon's middle from the taken one's: positions are given in taken-icon terms, as
// the label's step and the locate references (surveyed once taken) are; the route points taken live were 1, 2 px off

/**
 * Open the big map, read the character's position from the stronghold icon, close it. Standing on or next to the
 * icon, the arrow hides it: then the stronghold's name label is read instead (templates/map_label_cixin.png, always
 * LABEL_AT from the icon). null: neither found, or not on the world screen (no camera fan: a menu, a loading screen,
 * where tapping the minimap's place opens no map and the icons could be matched on something else).
 */
export function where() {
    let c = cameraHeading(screenshot());
    if (c == null) {
        sleep(300);
        c = cameraHeading(screenshot());
        if (c == null) return null;
    }
    const cam = Math.round(c);
    click(MINIMAP);
    const t0 = Date.now();
    const hit = waitFor(() => {
        const image = screenshot();
        const live = match(ICONS[0], { image, roi: MAP_ROI, threshold: 0.85 });
        const done = match(ICONS[1], { image, roi: MAP_ROI, threshold: 0.85 });
        if (live.hit && (!done.hit || (live.score ?? 0) >= (done.score ?? 0))) return { h: live, at: LIVE_AT, by: "icon" };
        if (done.hit) return { h: done, at: [0, 0], by: "icon" };
        if (Date.now() - t0 < LABEL_AFTER) return null;
        const l = match(LABEL, { image, roi: MAP_ROI, threshold: 0.7 });
        return l.hit ? { h: l, at: LABEL_AT, by: "label" } : null;
    }, { timeout: 6000, interval: 300 }); // the icons show ~2.5 s after the map
    click(MAP_BACK);
    sleep(800);
    if (!hit) return null;
    const [x, y, w, h] = /** @type {Box} */ (hit.h.box);
    return { x: PLAYER[0] - (x + w / 2 - hit.at[0]), y: PLAYER[1] - (y + h / 2 - hit.at[1]), cam, by: hit.by };
}

/**
 * OCR results as lines of text: grouped by their middles (within 10 px of height), left to right, joined.
 * @param {Match[]} results
 */
export function lines(results) {
    /** @type {{y: number, parts: Match[]}[]} */
    const rows = [];
    for (const m of results) {
        const y = m.box[1] + m.box[3] / 2;
        const row = rows.find((r) => Math.abs(r.y - y) <= 10);
        if (row) row.parts.push(m);
        else rows.push({ y, parts: [m] });
    }
    return rows.sort((a, b) => a.y - b.y).map((r) => r.parts.sort((a, b) => a.box[0] - b.box[0]).map((m) => m.text ?? "").join(""));
}

// The tracker under the minimap: inside a stronghold it shows its name and tasks (慈心山院 / 击败绣金卫 0/7 /
// 销毁禅院中的曼陀罗毒花 0/4). A line goes once its count is full, the whole block once all are done (back to the
// story quest, explore messages 204 and 213); outside the stronghold it shows the story quest as well.
/** @type {Box} */
const TRACKER_ROI = [20, 130, 330, 90];
const TASKS = { foes: "绣金卫", flowers: "毒花" };

/**
 * The stronghold's tasks on the tracker: [done, of] per task (TASKS: a word of its line), null when its line is not
 * there (done, or not inside the stronghold), and the lines read.
 * @param {Image} [image] @param {Record<string, string>} [tasks]
 */
export function progress(image, tasks = TASKS) {
    const read = lines(ocr({ image: image ?? screenshot(), roi: TRACKER_ROI }).results);
    /** @type {Record<string, any>} */
    const out = { lines: read };
    for (const [k, word] of Object.entries(tasks)) {
        const m = read.find((l) => l.includes(word))?.match(/(\d+)\s*[/／]\s*(\d+)/);
        out[k] = m ? [Number(m[1]), Number(m[2])] : null;
    }
    return out;
}

/** @type {Box} */
const PANEL_ROI = [790, 340, 290, 320]; // the stronghold panel on the big map (under the picture and story)
const WAIT_KEY = "stronghold_wait";
const NOT_BACK = "Teleport_NotRefreshed";

/** Recognition: the card says when the stronghold comes back (not refreshed yet); the text goes to memory. */
export function waiting(args, ctx) {
    const read = lines(ocr({ image: ctx.image ?? screenshot(), roi: ctx.roi ?? PANEL_ROI }).results);
    const i = read.findIndex((l) => l.includes("重新占据"));
    if (i < 0) return null;
    memory.set(WAIT_KEY, read.slice(i, i + 2).join(" ")); // the time may be on the line below
    return { box: ctx.roi ?? PANEL_ROI };
}

// The big map the stronghold card opens (centered on it, its panel on the right) keeps the zoom it was last left at.
// Fully zoomed in, the stone is the teleport stone icon nearest the stronghold's, 155 px away (it still matches ~0.78
// with the character's arrow over it); zoomed out, both icons are smaller and match nothing, so it pinches in first.
/** @type {Point} */
const PANEL_TAP = [434, 476]; // closes the panel; on a zoomed-in map it is the stone itself (then 传送 shows)
/** @type {Box} */
const MAP_LEFT = [0, 60, 900, 600]; // the map, left of the buttons on the right
const STONE_PX = [100, 220]; // the stone from the stronghold icon, fully zoomed in
/** @type {Box} */
const TELEPORT_ROI = [850, 640, 150, 70]; // 传送 on the stone's panel
const STONE_TRIES = 3;

/** @param {Box} b @returns {Point} */
const middle = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];

/** Get the stone's 传送 panel up on the card's big map; an error rather than a tap anywhere else. */
function toStone() {
    const teleport = () => match("teleport_button.png", { image: screenshot(), roi: TELEPORT_ROI, threshold: 0.8 }).hit;
    click(PANEL_TAP);
    sleep(1500);
    let missed = "the stronghold icon never matched (zoomed out)";
    for (let i = 0; i < STONE_TRIES; i++) {
        if (teleport()) return "stone";
        const image = screenshot();
        const icon = match(ICONS, { image, roi: MAP_LEFT, threshold: 0.9 });
        if (!icon.hit || !icon.box) {
            runSkill("pinch", { center: [538, 358], times: 4 }); // zoomed out: in, around where the card put it
            sleep(1000);
            continue;
        }
        const c = middle(icon.box);
        const stones = match("map_teleport_stone.png", { image, roi: MAP_LEFT, threshold: 0.7 }).results
            .map((m) => ({ box: m.box, score: m.score ?? 0, d: Math.hypot(middle(m.box)[0] - c[0], middle(m.box)[1] - c[1]) }));
        const near = stones.filter((s) => s.d >= STONE_PX[0] && s.d <= STONE_PX[1]).sort((a, b) => a.d - b.d);
        const seen = stones.map((s) => `${middle(s.box).map(Math.round)} ${Math.round(s.score * 100) / 100} ${Math.round(s.d)} px`).join("; ");
        log(`stone: icon at ${c.map(Math.round)}, stones: ${seen || "none"}`);
        if (!near.length) {
            missed = `no teleport stone near the stronghold icon at ${c.map(Math.round)} (${seen || "none"})`;
            sleep(1000); // the map's icons fade in a while after it opens
            continue;
        }
        click(near[0].box);
        if (waitFor(teleport, { timeout: 3000, interval: 300 })) return "stone";
        missed = "no 传送 after tapping the stone";
    }
    throw new Error(`big map: ${missed} (${STONE_TRIES} tries)`);
}

/** Close popups and teleport to the stone; an error if the stronghold has not come back yet. @param {string} node */
function start(node) {
    runSkill("clear_popups", {});
    memory.delete(WAIT_KEY);
    let r = runNode(node);
    if (!r.hit && !r.nodes.includes(NOT_BACK)) {
        log(`${node} did not get there (${r.nodes.slice(-3).join(" → ")}), once more from this page`);
        r = runNode(node); // a page that did not come up in time (the menu, 江湖行): the teleport goes on from any of them
    }
    if (r.nodes.includes(NOT_BACK)) throw new Error(`stronghold not refreshed yet (${memory.get(WAIT_KEY, "")}), stopped at the stone`);
    if (!r.hit) throw new Error(`${node} did not get to the stone: ${r.nodes.slice(-4).join(" → ")}`);
    return { nodes: r.nodes };
}

/** @param {{zoneAt?: number}} args @param {SkillContext} ctx */
export function recognize(args, ctx) {
    const image = ctx.image ?? screenshot();
    const z = zone(image);
    if (!z || z.dist > (args?.zoneAt ?? 8)) return null;
    if (enemies(image).some((e) => onZone(image, e))) return null;
    return { box: z.box };
}

/**
 * locate() with each reference `n` times against one where(): the readings, their spread and time.
 * @param {string[]} refs @param {number} n
 */
function compare(refs, n) {
    /** @type {{where: any, refs: Record<string, any[]>}} */
    const out = { where: where(), refs: {} };
    sleep(1500); // the minimap stays zoomed out a moment after the big map closes
    for (const ref of refs) {
        const reads = [];
        for (let i = 0; i < n; i++) {
            const image = screenshot();
            const cam = cameraHeading(image);
            const t0 = Date.now();
            const r = locate(ref, { image, wedge: cam, prior: out.where ? [out.where.x, out.where.y] : undefined, radius: 30 });
            reads.push(r ? { x: r.x, y: r.y, score: r.score, second: r.second, zoom: r.zoom, ms: r.ms, call: Date.now() - t0 } : null);
        }
        out.refs[ref] = reads;
    }
    return out;
}

/**
 * Report what the minimap shows: the patch and the enemies on / off it, and the tasks on the tracker; {where: true}:
 * the position.
 * @param {{where?: boolean, locate?: string[], n?: number, teleport?: string, relocate?: string[], stone?: boolean}} args
 */
export default function (args = {}) {
    if (args.stone) return toStone();
    if (args.teleport) return start(args.teleport);
    if (args.relocate) return { at: relocate(args.relocate) };
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
    const out = { zone: z && { bearing: Math.round(z.bearing), dist: Math.round(z.dist), box: z.box }, foes, cleared: !!recognize({}, /** @type {SkillContext} */ ({ image })), tasks: progress(image) };
    log(JSON.stringify(out));
    return out;
}
