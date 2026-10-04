// Stronghold (据点) checks on the minimap, for the pipeline (teaching explore messages 46–58).
//   recognize: the stronghold is cleared, i.e. standing at the middle of its orange patch (all of it in sight) with
//              no red mark on it (StrongholdCleared)
//   where():   where the character stands, in big map px (fully zoomed in) from the stronghold icon, x east / y south:
//              tapping the minimap opens the big map centered on the character (the arrow at PLAYER); the icon is
//              template matched (templates/map_stronghold.png ~0.97; map_stronghold_done.png, the gray icon with an
//              hourglass once taken, ~0.99 / ~0.91 on the live one; positions in taken-icon terms, LIVE_AT); null
//              when not found, which includes standing on it (the arrow hides it): then the name label (慈心山院, 佛爷寨)
//              above it, a fixed step from the icon, is read instead, or (no label: 酒肉山林) the teleport stone, also a
//              fixed step away, when it puts the icon under the arrow; no guessing otherwise, a wrong position sends a
//              route off in a wrong direction;
//              also the camera heading (compass degrees, from the minimap before opening the map; null when the fan
//              is not found, over a bright day sky: the minimap's gold arrow says it is the world screen then)
//   {where: true, stronghold?: <config>}  just report that (the config's label and stone help next to the icon)
//   {locate: ["locate/cixin_mosaic", "locate/cixin_bigmap"], n: 5}  compare locate() (minimap in a reference image,
//                  no big map) with where(): each reference n times, with the time each look took
//   progress():  the stronghold's tasks on the tracker under the minimap (OCR), e.g. 击败绣金卫 3/7
//   waiting:     (recognition stronghold.recognize with {waiting: true}) the stronghold's card on the big map says when
//                it comes back (势力重新占据时间): not refreshed yet; the text is kept in memory for start()
//   {relocate: ["locate/cixin_mosaic", "locate/cixin_bigmap"]}  where the character is from the minimap alone, over the
//                  whole reference (move.js relocate(), used by the route after a fight)
//   {stone: true, stronghold: {label, stone}}  (node Teleport_ClosePanel, filled in by the teleport) on the big map the
//                  stronghold card opened: close its panel and tap the teleport stone nearest the stronghold icon,
//                  zooming in first if the map was left zoomed out
//   {stronghold: <config>}  one-click run (nodes Cixin, Foye, Jiurou: pipeline/stronghold_<id>.json, each its config):
//                  close popups, teleport to the stone (the generic chain StrongholdTeleport with the config's card), stop
//                  with an error if on the way the card said the stronghold has not come back yet (marker node
//                  Teleport_NotRefreshed, recognition waiting), then walk the route (route.js with the config);
//                  route: false stops at the stone (the PC tools' teleport)
//
// A stronghold's config (written by tools/rec_route.py emit; 慈心山院's and 佛爷寨's moved over from their old nodes):
//   id, title (the card's name), card (its title template), stone (the teleport stone from the stronghold icon, big map
//   px: where() falls back on it when the arrow hides the icon; null: not needed), label ({template, at}: the name
//   label above the icon, at its step from it; null: none shows), k ({out, in}: big map px per minimap px), zoom (how
//   the minimap zooms at the gate, for the PC tools), tracker (task words on the tracker), locate (references), checks
//   (points a dry run looks at the big map at), points (the route)
import { arrowShows, cameraHeading, enemies, onZone, zone } from "./lib/minimap.js";
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
// The live icon with its background painted green (green_mask): the plain templates carry 慈心山院's background and
// drop to ~0.83 where the icon stands on a building block (酒肉山林, taken, 2026-10-02); this one scores 0.84–0.91 there
// on both icons, ≤ 0.63 elsewhere. Matched on the taken icon its middle is (−1, −2) from the taken template's, as
// the live icon's is: LIVE_AT holds for it.
const ICON_MASKED = "map_stronghold_m.png";
const MASKED_MIN = 0.8; // the taken icon is see-through: 0.84 at 酒肉山林's chest, on a building block next to the arrow
/**
 * What where() and the stone search need of a stronghold's config: its name label above the icon (慈心山院's 7 big map
 * shots all put it at (53, −50.5)) and its teleport stone (酒肉山林: (102.94, −38.28) from the icon, from the
 * recording's big map frames), each a fixed step from the icon, matched when the arrow hides the icon.
 * @typedef {{label?: {template: string, at: Point} | null, stone?: Point | null}} Marks
 */
/** @param {Marks} [cfg] @returns {[string, Point][]} */
const labelsOf = (cfg) => (cfg?.label ? [[cfg.label.template, cfg.label.at]] : []);
/** @param {Marks} [cfg] @returns {Point[]} */
const stonesOf = (cfg) => (cfg?.stone ? [cfg.stone] : []);
const UNDER_ARROW = 30; // px: an icon this close to the arrow can be hidden by it (21 px at 酒肉山林's west yard was)
const LABEL_AFTER = 3000; // the icons have shown by then
const LABEL_MIN = 0.6; // the same label scores 0.68–1.0 from one look to the next (its text drawn a fraction of a px off); other place names ≤ 0.35
/** @type {Point} */
const LIVE_AT = [-1, -2]; // the live icon's middle from the taken one's: positions are given in taken-icon terms, as
// the label's step and the locate references (surveyed once taken) are; the route points taken live were 1, 2 px off

/**
 * The stronghold icon nearest the arrow (another stronghold's can be on the map too and match better, 佛爷寨 next to
 * 慈心山院's, explore 2026-10-02), from icon or label matches (`at`: the match's middle from the icon's); of those
 * matched at the same place (the live and the taken icon), the better one.
 * @param {{h: Match, at: Point}[]} cands @param {Point} [to] nearest this (default: the arrow)
 */
function nearestIcon(cands, to = PLAYER) {
    const icon = (/** @type {{h: Match, at: Point}} */ c) => [middle(c.h.box)[0] - c.at[0], middle(c.h.box)[1] - c.at[1]];
    const d = (/** @type {{h: Match, at: Point}} */ c, /** @type {number[]} */ p) => Math.hypot(icon(c)[0] - p[0], icon(c)[1] - p[1]);
    const near = cands.reduce((a, c) => (a == null || d(c, to) < d(a, to) ? c : a), /** @type {any} */ (null));
    if (!near) return null;
    const at = icon(near);
    return cands.filter((c) => d(c, at) <= 6).reduce((a, c) => ((c.h.score ?? 0) > (a.h.score ?? 0) ? c : a));
}

/**
 * Open the big map, read the character's position from the stronghold icon nearest it, close it. Standing on or next
 * to the icon, the arrow hides it: then the stronghold's name label is read instead (the config's `label`, a fixed step
 * from its icon), or its teleport stone (`stone`). null: neither found, or not on the world screen (no camera fan and no minimap arrow: a menu, a loading screen,
 * where tapping the minimap's place opens no map and the icons could be matched on something else).
 */
/** @param {Marks} [cfg] */
export function where(cfg) {
    let c = cameraHeading(screenshot());
    if (c == null) {
        sleep(300);
        const image = screenshot();
        c = cameraHeading(image);
        // over a bright day sky the fan can be missed (cam null then); the arrow says it is the world screen
        if (c == null && !arrowShows(image)) return null;
    }
    const cam = c == null ? null : Math.round(c);
    click(MINIMAP);
    const t0 = Date.now();
    const hit = waitFor(() => {
        const image = screenshot();
        const live = match(ICONS[0], { image, roi: MAP_ROI, threshold: 0.85 });
        const done = match(ICONS[1], { image, roi: MAP_ROI, threshold: 0.85 });
        const masked = match(ICON_MASKED, { image, roi: MAP_ROI, threshold: MASKED_MIN, green_mask: true });
        const icon = nearestIcon([...live.results.map((m) => ({ h: m, at: LIVE_AT })), ...masked.results.map((m) => ({ h: m, at: LIVE_AT })),
            ...done.results.map((m) => ({ h: m, at: /** @type {Point} */ ([0, 0]) }))]);
        if (icon) return { ...icon, by: "icon" };
        if (Date.now() - t0 < LABEL_AFTER) return null;
        const label = nearestIcon(labelsOf(cfg).flatMap(([t, at]) => match(t, { image, roi: MAP_ROI, threshold: LABEL_MIN }).results.map((m) => ({ h: m, at }))));
        if (label) return { ...label, by: "label" };
        // no label either (酒肉山林's map shows none): the teleport stone, a fixed step from the icon; only where that
        // puts the icon under the arrow (that is why it was not seen)
        const stones = match("map_teleport_stone.png", { image, roi: MAP_ROI, threshold: 0.8 }).results;
        const stone = nearestIcon(stonesOf(cfg).flatMap((at) => stones.map((m) => ({ h: m, at }))));
        return stone && Math.hypot(middle(stone.h.box)[0] - stone.at[0] - PLAYER[0], middle(stone.h.box)[1] - stone.at[1] - PLAYER[1]) <= UNDER_ARROW
            ? { ...stone, by: "stone" } : null;
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
const STONE_AT = 10; // px: the config's stone this close to its step from the icon
/** @type {Point} */
const CARD_AT = [538, 358]; // where the card puts its stronghold on the map
const CARD_NEAR = 60;

/** @param {Box} b @returns {Point} */
const middle = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];

/** Get the stone's 传送 panel up on the card's big map; an error rather than a tap anywhere else. @param {Marks} [cfg] */
function toStone(cfg) {
    const teleport = () => match("teleport_button.png", { image: screenshot(), roi: TELEPORT_ROI, threshold: 0.8 }).hit;
    click(PANEL_TAP);
    sleep(1500);
    let missed = "the stronghold icon never matched (zoomed out)";
    for (let i = 0; i < STONE_TRIES; i++) {
        if (teleport()) return "stone";
        const image = screenshot();
        // the card's stronghold is the icon in the middle (another one can be in sight and match better); with the
        // character standing by it, the arrow hides it: its name label then
        const mid = (/** @type {{h: Match, at: Point}[]} */ cands) => {
            const c = nearestIcon(cands, CARD_AT);
            return c && Math.hypot(middle(c.h.box)[0] - c.at[0] - CARD_AT[0], middle(c.h.box)[1] - c.at[1] - CARD_AT[1]) <= CARD_NEAR ? c : null;
        };
        // 0.8: standing by the stronghold, the arrow covers a corner of its icon (0.82–0.84, 酒肉山林 2026-10-02, which
        // has no label to fall back on); only matches near where the card puts it count, so this is still the icon
        const icon = mid([...match(ICONS, { image, roi: MAP_LEFT, threshold: 0.8 }).results.map((m) => ({ h: m, at: /** @type {Point} */ ([0, 0]) })),
            ...match(ICON_MASKED, { image, roi: MAP_LEFT, threshold: 0.85, green_mask: true }).results.map((m) => ({ h: m, at: LIVE_AT }))])
            ?? mid(labelsOf(cfg).flatMap(([t, at]) => match(t, { image, roi: MAP_LEFT, threshold: 0.75 }).results.map((m) => ({ h: m, at }))))
            // the arrow over it and no label (酒肉山林, standing 18 px from it): a stone just where its step from the
            // card's middle puts it says the map is fully zoomed in and the icon is there
            ?? mid(stonesOf(cfg).flatMap((at) => match("map_teleport_stone.png", { image, roi: MAP_LEFT, threshold: 0.7 }).results
                .filter((m) => Math.hypot(middle(m.box)[0] - at[0] - CARD_AT[0], middle(m.box)[1] - at[1] - CARD_AT[1]) <= 8)
                .map((m) => ({ h: m, at }))));
        if (!icon) {
            runSkill("pinch", { center: CARD_AT, times: 4 }); // zoomed out: in, around where the card put it
            sleep(1000);
            continue;
        }
        const c = [middle(icon.h.box)[0] - icon.at[0], middle(icon.h.box)[1] - icon.at[1]];
        const stones = match("map_teleport_stone.png", { image, roi: MAP_LEFT, threshold: 0.7 }).results
            .map((m) => ({ box: m.box, score: m.score ?? 0, d: Math.hypot(middle(m.box)[0] - c[0], middle(m.box)[1] - c[1]) }));
        // the config's stone (its step from the icon, from the recording): the teacher's stone, not just the nearest one
        // (龙虎寨's is 99 px off, inside STONE_PX[0]; the nearest past that, 145 px east, landed somewhere else and the
        // route was lost from the start, 2026-10-04); the nearest one only if it is not seen by the last try
        const step = stonesOf(cfg)[0];
        const off = (/** @type {{box: Box}} */ s) => (step ? Math.hypot(middle(s.box)[0] - c[0] - step[0], middle(s.box)[1] - c[1] - step[1]) : 0);
        const mine = step ? stones.filter((s) => off(s) <= STONE_AT).sort((a, b) => off(a) - off(b)) : [];
        const near = step && (mine.length || i < STONE_TRIES - 1) ? mine
            : stones.filter((s) => s.d >= STONE_PX[0] && s.d <= STONE_PX[1]).sort((a, b) => a.d - b.d);
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

const TELEPORT = "StrongholdTeleport";

/**
 * Close popups and teleport to the stone (the generic chain, the config's card and marks filled in); `refreshed`:
 * false when the card said the stronghold has not come back yet (`wait`: what it said).
 * @param {{title: string, card: string} & Marks} cfg
 */
function start(cfg) {
    runSkill("clear_popups", {});
    memory.delete(WAIT_KEY);
    const nodes = { Teleport_Card: { template: cfg.card }, Teleport_ClosePanel: { custom_action_param: { stone: true, stronghold: { label: cfg.label ?? null, stone: cfg.stone ?? null } } } };
    const node = `${TELEPORT} (${cfg.title})`;
    let r = runNode(TELEPORT, { nodes });
    if (!r.hit && !r.nodes.includes(NOT_BACK)) {
        log(`${node} did not get there (${r.nodes.slice(-3).join(" → ")}), once more from this page`);
        r = runNode(TELEPORT, { nodes }); // a page that did not come up in time (the menu, 江湖行): the teleport goes on from any of them
    }
    if (!r.hit && !r.nodes.includes(NOT_BACK)) throw new Error(`${node} did not get to the stone: ${r.nodes.slice(-4).join(" → ")}`);
    const refreshed = !r.nodes.includes(NOT_BACK);
    return { nodes: r.nodes, refreshed, ...(refreshed ? {} : { wait: memory.get(WAIT_KEY, "") }) };
}

/** @param {{zoneAt?: number}} args @param {SkillContext} ctx */
export function recognize(args, ctx) {
    // the app registers one custom recognition per skill (stronghold.recognize): {waiting: true} picks that one
    if (args?.waiting) return waiting(args, ctx);
    const image = ctx.image ?? screenshot();
    const z = zone(image);
    if (!z || z.dist > (args?.zoneAt ?? 8)) return null;
    if (enemies(image).some((e) => onZone(image, e))) return null;
    return { box: z.box };
}

/**
 * locate() with each reference `n` times against one where(): the readings, their spread and time.
 * @param {string[]} refs @param {number} n @param {Marks} [cfg]
 */
function compare(refs, n, cfg) {
    /** @type {{where: any, refs: Record<string, any[]>}} */
    const out = { where: where(cfg), refs: {} };
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
 * @param {{where?: boolean, locate?: string[], n?: number, stronghold?: any, route?: boolean, relocate?: string[], stone?: boolean}} args
 */
export default function (args = {}) {
    if (args.stone) return toStone(args.stronghold);
    if (args.stronghold && !args.where && !args.locate) {
        const t = start(args.stronghold);
        if (args.route === false) return t; // the PC tools: dry runs are made before it comes back
        if (!t.refreshed) throw new Error(`stronghold not refreshed yet (${t.wait}), stopped at the stone`);
        return runSkill("route", { stronghold: args.stronghold });
    }
    if (args.relocate) return { at: relocate(args.relocate) };
    if (args.locate) {
        const out = compare(args.locate, args.n ?? 5, args.stronghold);
        log(JSON.stringify(out));
        return out;
    }
    if (args.where) {
        const out = where(args.stronghold);
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
