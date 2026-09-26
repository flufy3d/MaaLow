// Quick pickup: near something pickable, the world screen lists it on the right as dark rows with a white name
// (one row per thing, the list centered on y ≈ 467, rows ~37 px apart; some names carry an element icon after
// them). Tapping just above the list picks up what can be picked quickly; scene interactions (cooking, chests,
// signposts, NPCs) use the same rows but only open when their own row is tapped, so the tap never goes on a row.
// A tap that leaves the list as it was hit only interactions: after TRIES of those it stops until the list changes
// (teaching explore messages 4–99).
//
//   recognize: where to tap, for a pipeline node (AutoPickup, a guard candidate)
//   default:   tap until nothing is left to pick up

/** @type {SkillMeta} */
export const meta = { description: "pick up the items listed on the right of the world screen", timeout: 30_000 };

/** @type {Box} */
const LIST = [698, 375, 110, 185]; // the text column of up to 5 rows; with more, the outer ones show once the first go
const WHITE = { lower: [185, 185, 185], upper: [255, 255, 255] };
const WORLD = "SignIn_InWorld"; // world menu button, top right
const ABOVE = 50; // tap this far above the top row's center: clear of the list, where the teacher tapped
const TRIES = 2; // taps on an unchanged list before giving up on it
const SAME_MS = 3000; // a list seen again within this long counts as unchanged

/** Centers (y) of the rows showing a white name, top first. */
function rows(image) {
    // only on the world screen: popups (the shop banner) can have white text in the same place
    if (!globalThis.recognize(WORLD, { image }).hit) return []; // the export below shadows the global
    // Strokes of the names are small white blobs; bright scenery behind the column gives big ones, which are dropped.
    const hit = color({ ...WHITE, image, roi: LIST, count: 6, connected: true });
    if (!hit.hit) return [];
    const blobs = hit.results.map((m) => m.box).filter(([, , w, h]) => h <= 16 && w <= 40).sort((a, b) => a[1] - b[1]);
    const out = [];
    for (const [x, y, , h] of blobs) {
        const last = out[out.length - 1];
        if (last && y <= last.bottom + 3) {
            last.top = Math.min(last.top, y);
            last.bottom = Math.max(last.bottom, y + h);
            last.left = Math.min(last.left, x);
            last.blobs++;
        } else out.push({ top: y, bottom: y + h, left: x, blobs: 1 });
    }
    return out
        // names start at x ≈ 704–708; white bits of scenery rarely line up there
        .filter((r) => r.blobs >= 2 && r.bottom - r.top >= 8 && r.bottom - r.top <= 18 && r.left >= 702 && r.left <= 712)
        .map((r) => Math.round((r.top + r.bottom) / 2));
}

/** Where to tap: above the list, unless the list has stayed the same through TRIES taps; else null. */
function tapPoint(image) {
    const list = rows(image);
    if (!list.length) {
        if (memory.get("auto_pickup")) memory.delete("auto_pickup");
        return null;
    }
    // Rows are only told apart by position: a list that looks the same again right after a tap is taken as unchanged.
    const sig = list.join(",");
    const now = Date.now();
    const last = memory.get("auto_pickup", null);
    const n = last && last.sig === sig && now - last.time < SAME_MS ? last.n + 1 : 1;
    memory.set("auto_pickup", { sig, n, time: now });
    return n <= TRIES ? [750, list[0] - ABOVE] : null;
}

/** @param {{}} _args @param {SkillContext} ctx */
export function recognize(_args, ctx) {
    const p = tapPoint(ctx.image);
    return p ? { box: [p[0] - 20, p[1] - 5, 40, 10] } : null;
}

/** @param {{max?: number}} args */
export default function (args) {
    let taps = 0;
    for (; taps < (args.max ?? 20); taps++) {
        const p = tapPoint(screenshot());
        if (!p) break;
        click(p);
        sleep(600);
    }
    log(`${taps} taps`);
    return { taps };
}
