// dufu.js's screen reads (combat.js ROIs and masks) and their colour helpers. Every read takes the frame's Image
// explicitly; nothing here touches the scheduler's state.
/** @type {Box} */ export const HP_ROI = [405, 681, 280, 5];
export const HP_LEFT = 415, HP_FULL = 669, HP_GAP = 12, HP_RED_MAX = 0.45;
export const HP_GREY = { lower: [0, 0, 140], upper: [180, 45, 255], method: 40 };
export const HP_RED = { lower: [[0, 100, 165], [174, 100, 165]], upper: [[6, 175, 255], [180, 175, 255]], method: 40 };
/** @type {Box} */ export const QI_ROI = [347, 35, 386, 6]; // the boss's 真气 line
export const QI_HSV = { lower: [88, 30, 150], upper: [108, 130, 255], method: 40 };
/** @type {Box} */ export const LIT_ROI = [815, 575, 36, 36]; // f6.py's lit box (the skill icon's white strokes)
export const ICON_WHITE = { lower: [0, 0, 216], upper: [180, 59, 255], method: 40 };
/** @type {Box} */ export const BOSS_ROI = [347, 27, 386, 6]; // the boss bar
export const BOSS_RED = { lower: [170, 0, 0], upper: [255, 130, 130] };
export const BOSS_FULL = 386;
// 金光 flare rule (f6.py: gold line + orange streak)
export const FLASH = { lower: [8, 25, 235], upper: [35, 255, 255], method: 40 };
/** @type {Box} */ export const FLASH_ROI = [150, 120, 780, 440];
export const STREAK = { lower: [8, 100, 200], upper: [20, 255, 255], method: 40 };
// frame mean estimate: 3 full-width strips x 3 V thresholds (E[V] = 32 + 64*(P64 + P128 + P192))
export const MEAN_STRIPS = /** @type {[number, number][]} */ ([[140, 8], [300, 8], [460, 8]]);
export const MEAN_TH = [64, 128, 192];
// 起幕布 (combat.js)
/** @type {Box} */ export const CURTAIN_ROI = [0, 80, 1080, 150];
export const CURTAIN_DARK = { lower: [0, 0, 0], upper: [180, 255, 30], method: 40 };
/** @type {Box} */ export const EDGE_ROI = [0, 60, 1080, 500];
export const EDGE = { lower: [5, 80, 150], upper: [30, 255, 255], method: 40 };
export const EDGE_H = 70, EDGE_STRIPS = 3, EDGE_OVERLAP = 40;
export const ME_X = 540;

/** The character's health 0-1, or null (combat.js). @param {Image} image */
export function health(image) {
    const read = (/** @type {ColorOptions} */ c) => {
        const hit = color({ ...c, image, roi: HP_ROI, count: 5, connected: true });
        if (!hit.hit) return null;
        const boxes = hit.results.map((m) => m.box).sort((a, b) => a[0] - b[0]);
        if (boxes[0][0] > HP_LEFT + 8) return null;
        let right = boxes[0][0] + boxes[0][2];
        for (const [x, , w] of boxes.slice(1)) {
            if (x - right > HP_GAP) break;
            right = Math.max(right, x + w);
        }
        if (right - HP_LEFT < 4) return null;
        return Math.max(0, Math.min(1, (right - HP_LEFT) / (HP_FULL - HP_LEFT)));
    };
    const grey = read(HP_GREY);
    // Above the red bar's range the grey bar is authoritative and the red mask only sees effects: keep the old
    // one-read path (and its cost) there.
    if (grey != null && grey > HP_RED_MAX) return grey;
    // At/below HP_RED_MAX the bar itself is red. The grey mask (unsaturated + bright) also catches the red bar's
    // white hit flash / bright tip a few px past the fill, so at 17% it can read 21% (737 f5970-6051: seven
    // 21%->17% "hits" against a stable offline 17%). Prefer the red read whenever both are in the low range; the
    // grey read stays the fallback when red cannot be read (the grey bar was the original high-HP source).
    const red = read(HP_RED);
    if (red != null && red <= HP_RED_MAX) return red;
    return grey;
}

/** The boss's 真气 px from the left end; 0 when empty, -1 when not read. @param {Image} im */
export function readQi(im) {
    const hit = color({ ...QI_HSV, image: im, roi: QI_ROI, count: 2, connected: true });
    if (!hit.hit) return -1;
    const boxes = hit.results.map((m) => m.box).sort((a, b) => a[0] - b[0]);
    if (boxes[0][0] > QI_ROI[0] + 6) return -1;
    let right = boxes[0][0] + boxes[0][2];
    for (const [x, , w] of boxes.slice(1)) {
        if (x - right > 8) break;
        right = Math.max(right, x + w);
    }
    return right - QI_ROI[0];
}

/** White px in the lit box (colour read for the aux `lit` column). @param {Image} im */
export function litNow(im) {
    const hit = color({ ...ICON_WHITE, image: im, roi: LIT_ROI, count: 1 });
    return hit.hit ? hit.results[0]?.count ?? 0 : 0;
}

/** The boss bar's red extent in px, 0 when none (aux `boss_ratio` / `boss_bar`). @param {Image} im */
export function bossPx(im) {
    const hit = color({ ...BOSS_RED, image: im, roi: BOSS_ROI, count: 1 });
    if (!hit.hit) return 0;
    return Math.max(0, Math.min(BOSS_FULL, (hit.results[0]?.box?.[2] ?? 0) - 1));
}

/** At least n px of colour c in roi of im, in `parts` bands (combat.js). @param {ColorOptions} c @param {Box} roi @param {number} n @param {Image} im @param {number} [parts] */
export function countAtLeast(c, roi, n, im, parts = 2) {
    const [x, y, w, h] = roi;
    let sum = 0;
    for (let i = 0; i < parts; i++) {
        const y0 = y + Math.round((h * i) / parts), y1 = y + Math.round((h * (i + 1)) / parts);
        const r = color({ ...c, image: im, roi: [x, y0, w, y1 - y0], count: 1 });
        sum += r.hit ? r.results[0]?.count ?? 0 : 0;
        if (sum >= n) return true;
    }
    return false;
}

/** The 金光 rule: gold line + orange streak (f6.py's dataset flare flag). @param {Image} im */
export function seeFlash(im) {
    if (!countAtLeast(FLASH, FLASH_ROI, 230, im)) return false;
    const hit = color({ ...FLASH, image: im, roi: FLASH_ROI, count: 150, connected: true });
    if (!(hit.hit && hit.results.some(({ box: [, , w, h], count }) => w >= 230 && w >= 2.5 * h && (count ?? 0) >= 0.15 * w * h))) return false;
    if (!countAtLeast(STREAK, FLASH_ROI, 150, im)) return false;
    const st = color({ ...STREAK, image: im, roi: FLASH_ROI, count: 100, connected: true });
    return st.hit && st.results.some(({ box: [, , w, h] }) => w >= 150 && w >= 2 * h);
}

/** Frame brightness estimate 0-255 (the dataset's mean column is the full-frame gray mean). @param {Image} im */
export function readMean(im) {
    let sum = 0;
    for (const [y, h] of MEAN_STRIPS) {
        const px = 1080 * h;
        let c = 0;
        for (const th of MEAN_TH) {
            const r = color({ method: 40, lower: [0, 0, th], upper: [180, 255, 255], image: im, roi: [0, y, 1080, h], count: 1 });
            c += (r.hit ? r.results[0]?.count ?? 0 : 0) / px;
        }
        sum += 32 + 64 * c;
    }
    return sum / MEAN_STRIPS.length;
}

/** 起幕布's orange edges in EDGE_STRIPS strips (combat.js). @param {Image} im @returns {Match[]} */
export function edgeParts(im) {
    const [x0, y0, W, H] = EDGE_ROI;
    const sw = Math.ceil(W / EDGE_STRIPS);
    /** @type {Match[]} */
    const out = [];
    for (let i = 0; i < EDGE_STRIPS; i++) {
        const a = Math.max(x0, x0 + i * sw - EDGE_OVERLAP), b = Math.min(x0 + W, x0 + (i + 1) * sw + EDGE_OVERLAP);
        for (const m of color({ ...EDGE, image: im, roi: [a, y0, b - a, H], count: 300, connected: true }).results) {
            const [x, , w] = m.box;
            if ((a > x0 && x <= a) || (b < x0 + W && x + w >= b)) continue;
            out.push(m);
        }
    }
    return out;
}

/** The gap to walk into, [left, right], or "covered", or null (combat.js). @param {Image} im @returns {[number, number] | "covered" | null} */
export function gapNow(im) {
    const edges = edgeParts(im)
        .filter(({ box: [, , w, h], count }) => h >= EDGE_H && w <= 30 && (count ?? 0) >= 2.5 * h).map((m) => m.box);
    if (!edges.length) return null;
    const dark = color({ ...CURTAIN_DARK, image: im, roi: CURTAIN_ROI, count: 5000, connected: true });
    if (!dark.hit) return null;
    const panels = dark.results.map((m) => m.box).filter((b, i) => b[2] >= 100 && b[3] >= 100 && (dark.results[i].count ?? 0) >= 0.5 * b[2] * b[3]);
    if (!panels.length) return null;
    const sides = panels.flatMap(([x, , w]) => [x, x + w]);
    if (!edges.some(([x, , w]) => sides.some((s) => Math.abs(x + w / 2 - s) <= 40))) return null;
    const spans = panels.map(([x, , w]) => [x, x + w]).sort((a, b) => a[0] - b[0]);
    /** @type {[number, number][]} */
    const free = [];
    let at = 0;
    for (const [a, b] of spans) {
        if (a - at >= 40) free.push([at, a]);
        at = Math.max(at, b);
    }
    if (1080 - at >= 40) free.push([at, 1080]);
    const inner = free.filter(([a, b]) => a > 0 && b < 1080);
    const cands = inner.length ? inner : free;
    if (!cands.length) return "covered";
    const off = (/** @type {[number, number]} */ [a, b]) => (a <= ME_X && ME_X <= b ? 0 : Math.min(Math.abs(a - ME_X), Math.abs(b - ME_X)));
    return cands.reduce((p, q) => (off(q) < off(p) ? q : p));
}

// phase-2 red line (data/tmp/p2timing flags2.py: bright red HSV, a row of >= 220 px spanning >= 300 px in x 150-930,
// rows 18-30 px above / below < 30% of it). The device read (data/tmp/p2timing/rl/emu4.py, replayed on 7.6k video frames
// of 29 rounds) avoids the 780 x 440 scan (~33 ms like seeFlash): two 4 px columns at RL_COLS (a >= 300 px line in
// x 150-930 crosses at least one) give thin components (h <= RL_THIN) as candidate rows (at most RL_MAX_CANDS, by px);
// each is checked by a 120 px strip around its column on the component's rows (fill >= 50%, span >= 80%), then by a
// 3-row band over the full width (>= RL_ROW_PX px, span >= RL_SPAN) and the two 12-row side bands 18-30 px above /
// below (mean row < RL_SIDE x the band's mean row; a burst / glow fills them). Rows RL_Y0-RL_Y1 (lines above the
// arena centre, boss in the air, are tilted and not covered). Recall of the 161 true red tells' onsets within +2 f:
// 0.62 (0.66 of those in the row band); frames firing where the offline rule does not: 0.7%.
export const RED_HSV = { lower: [[0, 60, 200], [170, 60, 200]], upper: [[9, 255, 255], [180, 255, 255]], method: 40 };
export const RL_COLS = [400, 680], RL_COL_W = 4, RL_Y0 = 152, RL_Y1 = 470, RL_THIN = 20, RL_MAX_CANDS = 3;
export const RL_X0 = 150, RL_W = 780, RL_QUICK = 60, RL_ROW_PX = 220, RL_SPAN = 300, RL_SIDE = 0.25;

/** Count and box width of colour c in roi (one non-connected read). @param {ColorOptions} c @param {Box} roi @param {Image} im */
function spanRead(c, roi, im) {
    const r = color({ ...c, image: im, roi, count: 1 });
    const m = r.hit ? r.results[0] : null;
    return { n: m?.count ?? 0, w: m?.box?.[2] ?? 0 };
}

/**
 * The phase-2 red line: its row y, or null; calls = color() reads used (cost: ~2 per frame, 3-6 with a candidate).
 * @param {Image} im @returns {{y: number | null, calls: number}}
 */
export function redLine(im) {
    let calls = 0;
    /** @type {{cx: number, y: number, h: number, n: number}[]} */
    const cands = [];
    for (const cx of RL_COLS) {
        calls++;
        const r = color({ ...RED_HSV, image: im, roi: [cx - RL_COL_W / 2, RL_Y0, RL_COL_W, RL_Y1 - RL_Y0], count: 3, connected: true });
        if (r.hit) for (const m of r.results) if (m.box[3] <= RL_THIN) cands.push({ cx, y: m.box[1], h: m.box[3], n: m.count ?? 0 });
    }
    cands.sort((a, b) => b.n - a.n);
    /** @type {number[]} */
    const seen = [];
    for (const c of cands) {
        const yc = c.y + Math.floor(c.h / 2);
        if (seen.some((v) => Math.abs(v - yc) <= 6)) continue;
        seen.push(yc);
        if (seen.length > RL_MAX_CANDS) break;
        if (yc - 32 < 120 || yc + 32 > 560) continue;
        const a = Math.max(RL_X0, c.cx - RL_QUICK), b = Math.min(RL_X0 + RL_W, c.cx + RL_QUICK);
        calls++;
        const q = spanRead(RED_HSV, [a, c.y, b - a, c.h], im);
        if (q.n < 0.5 * (b - a) || q.w < 0.8 * (b - a)) continue;
        calls++;
        const band = spanRead(RED_HSV, [RL_X0, yc - 1, RL_W, 3], im);
        if (band.n < RL_ROW_PX || band.w < RL_SPAN) continue;
        let ok = true;
        for (const s0 of [yc - 30, yc + 18]) {
            calls++;
            if (spanRead(RED_HSV, [RL_X0, s0, RL_W, 12], im).n / 12 > RL_SIDE * (band.n / 3)) {
                ok = false;
                break;
            }
        }
        if (ok) return { y: yc, calls };
    }
    return { y: null, calls };
}
