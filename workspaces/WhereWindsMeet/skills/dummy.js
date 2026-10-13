// The 木桩 (试剑 → 木桩练习, 伤害·试剑首领木桩 96 级): measure what moves do. Optionally 重置场地 first (the dummy's
// bars, the damage count and the lock go), then the steps one by one, each timed and followed by a read of the boss
// bar and its 真气 (px, as combat.js reads them; the bars only show once it has been hit), then wait for the hits to
// stop, open the damage breakdown (the list button by the total) and OCR its table, then close it.
//
//   {steps: [...], reset: true, read: true, settle: 2000, trace: true}
//   steps:
//     {tap: "light" | "dash" | "burst" | "buff" | "heavy" | "qishu" | "parry" | "strike" | "mstrike", ms?: 50, sure?: true}
//         sure: tapped again (up to 4 times) until its icon goes (burst / buff / dash / strike / qishu / mdash)
//     {hold: "heavy" | "light" | ..., ms: N}    held N ms, let go
//     {charge: "red" | N, from?: 1800, max?: 2600}    陌刀 蓄力: let go when the blade turns red (looked for from
//         `from` ms, let go at `max` at the latest), or after N ms
//     {switch: "modao" | "hengdao"}  {wait: ms}  {lock: true}
//     {swap: true, ms?: 200, after?: 300}   易武技: the weapon bar (1031,318) dragged to (965,317) over ms (combat.js's
//         switchTo taps the bar at (993,320) instead: a plain switch)
//     {walk: ms, back?: true}   joystick forward (locked: to the dummy; it stops against it) or back
//   prep: steps before the clock starts (switch weapon, {icon: "burst", ms: 25000} for a cooldown), not timed
//   approach: ms walked to the dummy before the first step (default 2500; 重置场地 does not move the character, and
//     陌刀 突进 runs straight on through it, out of the ring)
//     {icon: "strike" | "dash" | "burst" | ... | [...], ms?: 4000}   wait for a button's icon (one of them) to show
//     {ring: true, ms?: 8000}   wait for the dummy's red ring (训练设置 首领伤害 on), ringAt
//     {watch: ms, onOk?: true}   look for a good 卸势 (diamond / 横刀 swirl: okAt, ok), a hit on us (hitAt, hpMin);
//         onOk taps the diamond (860,430) or the swirl (重击)
//     {loop: [...steps], until: ms, qi?: px}   the steps again and again while less than `until` ms have passed since
//         the first (and, with qi, until the 真气 read after a step is that low)
//     {until: ms}   wait until this long since the first step
//   处决 (the gold diamond, combat.js's template) is looked for in every wait: when it first showed (execute), saved
//     to captures/dummy_execute.png.
//   刀势 (blades over the weapon bar, 0–6) read before (ds0) and after (ds) every step.
//   counter: the total counter read after every step too (counter), for per-step damage.
//   trace: the total counter (top left) read in every wait: when the damage went up (hits).
//   window: ms; the total counter (top left, "15.7K", 100 resolution) and the bars read once that long after the first
//     step (in a wait or a 蓄力), for a fixed-time total; hits landing later still go into the panel's total.
//   The result: the table rows {skill, count, dps, total, share}, the total, the panel's 用时, our own ms, the bars
//   before / after each step / at the end, the hits traced.

/** @type {SkillMeta} */
export const meta = { description: "measure moves on the 木桩: damage breakdown, boss bar and 真气", timeout: 300_000 };

/** @type {Record<string, Point>} */
const BTN = {
    light: [945, 592], // 轻击 (横刀: 轻蓄力 when held, 冢上霜)
    heavy: [1020, 478], // 陌刀 蓄力, 横刀 重击
    parry: [952, 495], // 卸势
    qishu: [881, 525], // 奇术
    dash: [833, 593], // 陌刀 燃此魂, 横刀 突进 → 伤害
    strike: [833, 593], // 横刀 伤害 (arrow)
    mstrike: [833, 593], // 陌刀 燃此魂 → 伤害
    buff: [825, 668], // 陌刀 唤千军, 横刀 爆发
    burst: [825, 668],
    switch: [993, 320], // weapon bar
    lock: [1021, 667],
};
// Top left, once there is damage: the total ("15.7K 总伤害", the list button right after it: its x moves with the
// number's width), up to three skill lines under it (most damage first), then 重置场地 (lower with more lines)
/** @type {Box} */ const HUD_ROI = [70, 55, 220, 150];
const LIST_ICON = "combat/dummy_list.png"; // its middle at (200, 76) with 15.7K, (213, 76) with 101.2K
/** @type {Box} */ const LIST_ROI = [150, 58, 130, 36];
/** @type {Point} */ const CLOSE = [80, 509]; // the breakdown's 关闭
/** @type {Point} */ const SWAP_FROM = [1031, 318]; // weapon bar dragged left: 易武技 (a switch with a blow)
/** @type {Point} */ const SWAP_TO = [965, 317];
/** @type {Box} */ const COUNT_ROI = [76, 60, 130, 32];
/** @type {Point} */ const STICK = [175, 569]; // joystick (locked on: forward is toward the dummy)
const STICK_R = 83;
/** @type {Box} */ const P_TOTAL_ROI = [326, 206, 150, 42]; // panel: "15684总伤害" ("10万" from 100000: the rows' sum then)
/** @type {Box} */ const P_TIME_ROI = [130, 456, 140, 26]; // panel: "用时 00:06"
/** @type {Box} */ const P_CLOSE_ROI = [30, 494, 102, 30];
/** @type {Box} */ const P_TABLE_ROI = [333, 352, 577, 136]; // rows under the 技能 / 次数 / 秒伤 / 总伤 / 占比 header
const COLS = [500, 610, 715, 820]; // column borders (x of a cell's middle)
const COUNT_X = 557; // 次数's middle
/** @type {Box} */ const LOCK_ROI = [1004, 648, 34, 39];
/** @type {Box} */ const HP_ROI = [405, 681, 280, 5]; // our health (combat.js)
/** @type {Box} */ const RING_ROI = [150, 160, 780, 440];
const RING_RED = { lower: [[0, 120, 150], [172, 120, 150]], upper: [[6, 255, 255], [180, 255, 255]], method: 40 };
const RING_PX = 1500; // idle ≤ 100; the ring 854 → 1794 → 4080 px over its first frames (recording 20261012-013640)
/** @type {Point} */ const DIAMOND = [860, 430]; // 重击派生 after a good 卸势 (combat.js HEAVY)
const HP_LEFT = 415;
const HP_FULL = 669;
const HP_GREY = { lower: [0, 0, 140], upper: [180, 45, 255], method: 40 };
const DAOSHI_X = [971, 982, 993, 1005, 1016, 1027];
const DAOSHI_LIT = { lower: [80, 20, 160], upper: [125, 120, 255], method: 40 };
const DAOSHI_PX = 12;
const GOLD = { lower: [200, 180, 100], upper: [255, 245, 200] };
/** @type {Box} */ const BOSS_ROI = [347, 27, 386, 6];
const BOSS_RED = { lower: [170, 0, 0], upper: [255, 130, 130] };
/** @type {Box} */ const QI_ROI = [347, 35, 386, 6];
const QI_HSV = { lower: [88, 30, 150], upper: [108, 130, 255], method: 40 };
const CHARGE_RED = { lower: [[0, 150, 140], [172, 150, 140]], upper: [[6, 255, 255], [180, 255, 255]], method: 40 };
// combat.js's roi [150, 80, 780, 560] takes in the chat's red badge (429–443, 623–638: ~127 px, more than its 120), so
// "red" came at once at 1.8 s; here off the chat and the top left counters, wider to the left (the blade swings out
// there): 0–20 px until ~2.3 s, 308 at 2.66 s, 574 at 3.0 s (data/tmp/dummy/charge)
/** @type {Box} */ const CHARGE_RED_ROI = [0, 160, 930, 430];
const CHARGE_RED_PX = 60;
/** Button icons (combat.js's T). */
/** @type {Record<string, [string, Box]>} */
const T = {
    modao: ["combat/modao_charge.png", [988, 446, 64, 68]],
    hengdao: ["combat/hengdao_heavy.png", [988, 446, 64, 68]],
    swirl: ["combat/hengdao_swirl.png", [988, 446, 64, 68]],
    mdash: ["combat/modao_dash.png", [801, 561, 64, 64]],
    dash: ["combat/hengdao_dash.png", [801, 561, 64, 64]],
    damage: ["combat/hengdao_damage.png", [801, 561, 64, 64]],
    strike: ["combat/hengdao_strike.png", [801, 561, 64, 64]],
    // 陌刀 燃此魂's second press, 伤害 (荡八荒): its icon ~0.2 s after the first and while it runs; pressed during
    // 唤千军's animation it was lost and the run went on straight out of the ring (2026-10-11)
    mstrike: ["combat/modao_ranshi_strike.png", [801, 561, 64, 64]],
    burst: ["combat/hengdao_burst.png", [793, 635, 64, 64]],
    buff: ["combat/modao_buff.png", [793, 635, 64, 64]],
    qishu: ["combat/qishu_ready.png", [848, 493, 64, 64]],
    parryOk: ["combat/parry_ok.png", [815, 391, 75, 75]],
    execute: ["combat/execute.png", [815, 391, 75, 75]],
};

/** @param {string} k @param {Image} [image] */
const seen = (k, image) => match(T[k][0], { image, roi: T[k][1], threshold: 0.7 }).hit;

/** OCR of a box: its pieces, left to right. @param {Box} roi @param {Image} [image] @param {boolean} [rec] */
function read(roi, image, rec = true) {
    const r = ocr({ image: image ?? screenshot(), roi, only_rec: rec });
    if (rec) return (r.text ?? r.results.map((m) => m.text ?? "").join("")).replace(/\s/g, "");
    return r.results.filter((m) => m.text).map((m) => ({ text: /** @type {string} */ (m.text).replace(/\s/g, ""), box: m.box }));
}

/** Run of matching px from the bar's left end (gaps up to `gap`), null when it does not start there. */
function run(hit, x0, gap, slack) {
    if (!hit.hit) return null;
    const boxes = hit.results.map((m) => m.box).sort((a, b) => a[0] - b[0]);
    if (boxes[0][0] > x0 + slack) return null;
    let right = boxes[0][0] + boxes[0][2];
    for (const [x, , w] of boxes.slice(1)) {
        if (x - right > gap) break;
        right = Math.max(right, x + w);
    }
    return right - x0;
}

/** Boss bar and 真气 px (null: not shown), and our health 0–1 (combat.js's health(), grey bar only). @param {Image} image */
function bars(image) {
    const boss = run(color({ ...BOSS_RED, image, roi: BOSS_ROI, count: 10, connected: true }), BOSS_ROI[0], 12, 2);
    const qi = boss == null ? null : run(color({ ...QI_HSV, image, roi: QI_ROI, count: 2, connected: true }), QI_ROI[0], 8, 6) ?? 0;
    const h = run(color({ ...HP_GREY, image, roi: HP_ROI, count: 5, connected: true }), HP_LEFT, 12, 8);
    return { boss, qi, hp: h == null ? null : Math.round(Math.min(1, h / (HP_FULL - HP_LEFT)) * 1000) / 1000 };
}

/**
 * 刀势 (teacher, 2026-10-11): the row of small blades over the weapon bar (965,298,71,16), some skills use them, some
 * give them back; a 陌刀 蓄力 with fewer than two is a plain single 重击 (no stages, the blade never turns red). Six
 * blades at x 971…1027; lit ones are pale blue (H ~100, S ~60, V ~205, ~25 px each). Returns how many are lit.
 * @param {Image} image
 */
function daoshi(image) {
    let n = 0;
    for (const x of DAOSHI_X) {
        if (color({ ...DAOSHI_LIT, image, roi: [x - 5, 298, 10, 14], count: DAOSHI_PX }).hit) n++;
    }
    return n;
}

/** 刀势 as the median of three reads (effects over the bar flicker it by one). @param {Image} [first] */
function dsMedian(first) {
    const v = [daoshi(first ?? screenshot())];
    for (let i = 0; i < 2; i++) {
        sleep(30);
        v.push(daoshi(screenshot()));
    }
    return v.sort((a, b) => a - b)[1];
}

/** @param {Image} [image] */
function weapon(image) {
    const im = image ?? screenshot();
    if (seen("modao", im)) return "modao";
    if (seen("hengdao", im)) return "hengdao";
    return seen("mdash", im) ? "modao" : seen("swirl", im) || seen("dash", im) || seen("strike", im) || seen("damage", im) ? "hengdao" : null;
}

const locked = (image) => color({ ...GOLD, image, roi: LOCK_ROI, count: 150 }).hit;

/** "15,684" / "2,350" → number, "100.0%" with dec (null when none). @param {string} s */
function num(s, dec = false) {
    const m = s.replace(dec ? /[,，]/g : /[,，.。]/g, "").match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
}

/** "101.2K总伤害" → 101200, "4873" → 4873 (null when none). @param {string} raw */
function count(raw) {
    const m = raw.replace(/[,，]/g, "").match(/(\d+(?:\.\d+)?)\s*([KkMm万]?)/);
    if (!m) return null;
    return Math.round(Number(m[1]) * (({ K: 1e3, k: 1e3, M: 1e6, m: 1e6, 万: 1e4 })[m[2]] ?? 1));
}

/** The top left: where the list button and 重置场地 are (null: not shown, no damage yet). @param {Image} image */
function hud(image) {
    const pieces = /** @type {{text: string, box: Box}[]} */ (read(HUD_ROI, image, false));
    // the list button by its icon (OCR ran "100.9K总伤害" and the button together into one piece)
    const icon = match(LIST_ICON, { image, roi: LIST_ROI, threshold: 0.6 });
    const reset = pieces.find((p) => p.text.includes("重置") || p.text.includes("场地"));
    return {
        list: icon.hit && icon.box ? /** @type {Point} */ ([icon.box[0] + 10, icon.box[1] + 10]) : null,
        // (whole px: a click at 138.5 did nothing)
        reset: reset ? /** @type {Point} */ ([Math.round(reset.box[0] + reset.box[2] / 2), Math.round(reset.box[1] + reset.box[3] / 2)]) : null,
    };
}

/** OCR's slips in the skill names. @param {string} s */
const fixName = (s) => s.replace("家上霜", "冢上霜").replace(/^[萧箫]吟[干千]浪$/, "箫吟千浪").replace(/[》〉刁乃]/g, "刀").replace(/^陌[^刀·]?·/, "陌刀·").replace(/[.。・•]/g, "·");

/**
 * The breakdown table on screen: the rows found by detection over the table (their y), then each row's strip detected
 * again and its pieces put in columns by x. Cells read on their own were worse: a lone "1" in 次数 came back as "",
 * "11" or "冏一" depending on the crop; detected over the whole row it is right. A cell still missing is read from a
 * tight crop.
 */
function tableRows(image) {
    const pieces = /** @type {{text: string, box: Box}[]} */ (read(P_TABLE_ROI, image, false));
    /** @type {number[]} */ const ys = [];
    for (const p of pieces) {
        const cy = p.box[1] + p.box[3] / 2;
        if (!ys.some((y) => Math.abs(y - cy) < 9)) ys.push(cy);
    }
    return ys.sort((a, b) => a - b).map((y) => {
        const y0 = Math.round(y - 11);
        /** @type {string[][]} */ const cells = [[], [], [], [], []];
        const strip = /** @type {{text: string, box: Box}[]} */ (read([P_TABLE_ROI[0], y0, P_TABLE_ROI[2], 22], image, false));
        for (const p of strip.sort((a, b) => a.box[0] - b.box[0])) {
            const cx = p.box[0] + p.box[2] / 2;
            const col = COLS.findIndex((x) => cx < x);
            cells[col < 0 ? 4 : col].push(p.text);
        }
        const text = cells.map((c) => c.join(""));
        if (!text[1]) text[1] = read([COUNT_X - 20, y0, 40, 22], image); // 次数
        for (const i of [2, 3, 4]) {
            if (!text[i]) text[i] = read([COLS[i - 1], y0, (COLS[i] ?? P_TABLE_ROI[0] + P_TABLE_ROI[2]) - COLS[i - 1], 22], image);
        }
        const [skill, count, dps, total, share] = text;
        // a lone "1" read as a stroke ("J" once)
        const n = num(count) ?? (/^[lIJj|丨!]$/.test(count) ? 1 : null);
        return { skill: fixName(skill), count: n, countRaw: count, dps: num(dps), total: num(total), share: num(share, true), y: Math.round(y) };
    }).filter((r) => r.skill);
}

/** Open the breakdown, read it (scrolling the table when it is longer), close it. */
function breakdown() {
    const open = () => read(P_CLOSE_ROI).includes("关闭");
    for (let i = 0; i < 3 && !open(); i++) {
        const { list } = hud(screenshot());
        if (!list) throw new Error("no total on screen (no damage?)");
        click(...list);
        waitFor(open, { timeout: 3000, interval: 200 });
    }
    if (!open()) throw new Error("the breakdown did not open");
    sleep(600);
    let image = screenshot();
    const totalRaw = read(P_TOTAL_ROI, image);
    let total = totalRaw.includes("万") ? null : num(totalRaw);
    const timeRaw = read(P_TIME_ROI, image);
    const tm = timeRaw.match(/(\d+)[:：](\d+)/);
    /** @type {any[]} */ const rows = [];
    for (let page = 0; page < 5; page++) {
        const got = tableRows(image);
        let added = 0;
        for (const r of got) {
            // the same row again (OCR may spell a name differently from one read to the next: total and count too)
            if (rows.some((o) => o.skill === r.skill || (o.total === r.total && o.count === r.count))) continue;
            rows.push(r);
            added++;
        }
        if (got.length < 4 || (page > 0 && !added)) break;
        // only 4 rows show (the ▼ under them): drag the table up ~3.5 rows, slowly (Maa's swipe and a tap on ▼ did
        // nothing)
        dragSlow([620, 465], [620, 365], 900);
        sleep(600);
        image = screenshot();
    }
    click(...CLOSE);
    if (!waitFor(() => !open(), { timeout: 4000, interval: 200 })) log("the breakdown is still open after 关闭");
    sleep(400);
    const sum = rows.reduce((s, r) => s + (r.total ?? 0), 0);
    // "16万": the rows' sum is the total; else they should add up to it (a row missed or misread when not)
    const sumOk = total == null ? null : Math.abs(sum - total) <= Math.max(2, total * 0.001);
    if (total == null) total = sum;
    return { total, totalRaw, sumOk, time: tm ? Number(tm[1]) * 60 + Number(tm[2]) : null, timeRaw, rows: rows.map(({ y, ...r }) => r), rowsSum: sum };
}

/** 重置场地 (when shown: there was damage; the breakdown closed first), wait for it to go, lock on. */
function reset() {
    if (read(P_CLOSE_ROI).includes("关闭")) {
        click(...CLOSE);
        sleep(800);
    }
    const { reset: at } = hud(screenshot());
    if (at) {
        // tapped again when it stays (a tap while hits were still landing was lost now and then)
        let ok = false;
        for (let i = 0; i < 3 && !ok; i++) {
            click(...(hud(screenshot()).reset ?? at));
            ok = !!waitFor(() => !hud(screenshot()).reset, { timeout: 4000, interval: 300 });
        }
        if (!ok) throw new Error("重置场地 did not clear");
        sleep(1500);
    }
    lockOn();
}

function lockOn() {
    if (locked(screenshot())) return true;
    click(...BTN.lock);
    sleep(700);
    const ok = locked(screenshot());
    if (!ok) log("not locked after tapping the lock");
    return ok;
}

/** A drag held down all the way, in steps (Maa's swipe did not scroll the table). @param {Point} a @param {Point} b @param {number} ms */
function dragSlow(a, b, ms, holdEnd = 150) {
    const n = Math.max(4, Math.min(20, Math.round(ms / 15)));
    touch.down(a, 2);
    for (let i = 1; i <= n; i++) {
        sleep(ms / n);
        touch.move([Math.round(a[0] + (b[0] - a[0]) * i / n), Math.round(a[1] + (b[1] - a[1]) * i / n)], 2);
    }
    if (holdEnd) sleep(holdEnd);
    touch.up(2);
}

/** Joystick held up (dy < 0, toward the locked dummy) or down for ms. @param {number} ms @param {number} dy @param {(ms: number) => void} [pause] */
function walk(ms, dy, pause = sleep) {
    touch.down(STICK, 0);
    touch.move([STICK[0], STICK[1] + dy], 0);
    pause(ms);
    touch.up(0);
}

/** @param {{steps?: any[], reset?: boolean, read?: boolean, settle?: number, trace?: boolean, save?: string, window?: number, probe?: boolean, cells?: Box[], approach?: number, prep?: any[], drag?: any[], counter?: boolean, fast?: boolean}} args */
export default function (args = {}) {
    if (args.drag) { // [[x0, y0], [x1, y1], ms]: a slow drag in 20 steps (the table scroll)
        dragSlow(args.drag[0], args.drag[1], args.drag[2] ?? 800);
        sleep(600);
        return tableRows(screenshot());
    }
    if (args.cells) { // OCR check of the count column, crops of several widths
        const im = screenshot();
        return args.cells.map((/** @type {Box} */ box) => [box, read(box, im), read(box, im, false)]);
    }
    if (args.probe) return { pieces: read(HUD_ROI, screenshot(), false), hud: hud(screenshot()), count: read(COUNT_ROI) }; // OCR check
    const steps = args.steps ?? [];
    const settle = args.settle ?? 2000;
    const trace = args.trace ?? true;
    if (args.reset ?? true) reset();
    else if (steps.length) lockOn();
    // 重置场地 does not move the character: walk up to the dummy (it stops against it; 3 s from the ring's slope)
    const approach = args.approach ?? (steps.length ? 2500 : 0);
    if (approach > 0) {
        walk(approach, -STICK_R);
        sleep(300);
        if (!locked(screenshot())) lockOn();
    }
    const first = screenshot();
    const before = { ...bars(first), weapon: weapon(first), ds: daoshi(first) };
    /** @type {{t: number, total: number}[]} */ const hits = [];
    let recent = trace ? String(count(read(COUNT_ROI, first)) ?? "") : "";
    let lastHit = 0;
    let t0 = 0;
    const now = () => Date.now() - t0;

    /**
     * The total counter: a new value read twice in a row is a hit (OCR slips on half-drawn digits now and then),
     * timed at the first of the two reads; 100 resolution from 10K.
     */
    let cand = "", candAt = 0;
    /** @type {{t: number, raw: string, total: number | null, boss: number | null, qi: number | null} | null} */
    let atWindow = null;
    /** args.window: the total counter (and the bars) read once that long after the first step. @param {Image} image */
    function windowCheck(image) {
        if (!args.window || atWindow || !t0 || now() < args.window) return;
        const raw = read(COUNT_ROI, image);
        atWindow = { t: now(), raw, total: count(raw), ...bars(image) };
        log(`window ${atWindow.t} ms: ${raw} → ${atWindow.total}`);
    }
    /** @type {{t: number, qi: number | null} | null} */ let execAt = null; // 处决 (the gold diamond) first seen
    let lastQi = /** @type {number | null} */ (null);
    /** @type {[number, number][]} */ const dsTrace = []; // [ms, 刀势] whenever a read in a wait or 蓄力 differs
    /** @param {Image} image */
    function dsCheck(image) {
        const n = daoshi(image);
        if (!dsTrace.length || dsTrace[dsTrace.length - 1][1] !== n) dsTrace.push([t0 ? now() : -1, n]);
    }
    function poll(image) {
        windowCheck(image);
        dsCheck(image);
        if (!execAt && seen("execute", image)) {
            execAt = { t: now(), qi: bars(image).qi };
            saveImage(image, "captures/dummy_execute.png");
            log(`处决 shows at ${execAt.t} ms`);
        }
        if (!trace) return;
        const n = String(count(read(COUNT_ROI, image)) ?? "");
        if (!n || n === recent) {
            cand = "";
            return;
        }
        if (n !== cand) {
            cand = n;
            candAt = now();
            return;
        }
        recent = n;
        lastHit = candAt;
        hits.push({ t: candAt, total: Number(n) });
        cand = "";
    }

    /** Wait ms, polling. */
    function wait(ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const s0 = Date.now();
            // a poll (OCR) takes ~100–200 ms: not in the last 250 ms, so the next step goes on time
            if ((trace || args.window) && end - s0 > 250) poll(screenshot());
            const left = end - Date.now();
            if (left <= 0) break;
            sleep(Math.min(left, Math.max(0, 60 - (Date.now() - s0))));
        }
    }

    /** @param {string} name @param {number} ms */
    function holdBtn(name, ms) {
        const p = BTN[name];
        if (!p) throw new Error(`no button ${name}`);
        touch.down(p, 1);
        wait(ms);
        touch.up(1);
    }

    /** 陌刀 蓄力: until red (from `from` ms) or `max`; N ms if a number. Returns [ms held, how]. */
    function charge(how, from = 1800, max = 2600, probe = false) {
        const c0 = Date.now();
        touch.down(BTN.heavy, 1);
        let why = "time";
        const limit = typeof how === "number" ? how : max;
        /** @type {[number, number][]} */ const red = []; // probe: [ms, red px] per look
        for (;;) {
            const held = Date.now() - c0;
            if (held >= limit) break;
            const image = screenshot();
            windowCheck(image);
            dsCheck(image);
            if (probe) {
                const r = color({ ...CHARGE_RED, image, roi: CHARGE_RED_ROI, count: 1 });
                red.push([Date.now() - c0, r.hit ? r.results.reduce((a, m) => a + (m.count ?? 0), 0) : 0]);
                if (probe === "save") saveImage(image, `captures/dummy_charge_${Date.now() - c0}.png`);
            }
            if (how === "red" && Date.now() - c0 >= from &&
                color({ ...CHARGE_RED, image, roi: CHARGE_RED_ROI, count: CHARGE_RED_PX }).hit) {
                why = "red";
                break;
            }
            sleep(Math.min(30, Math.max(0, limit - (Date.now() - c0))));
        }
        touch.up(1);
        return [Date.now() - c0, why, red];
    }

    /** @param {string} name */
    function tapBtn(name, ms = 50, sure = false) {
        const p = BTN[name];
        if (!p) throw new Error(`no button ${name}`);
        const icon = name === "burst" ? "burst" : name === "buff" ? "buff" : name === "qishu" ? "qishu" :
            name === "strike" ? "strike" : name === "mstrike" ? "mstrike" : name === "dash" ? (weapon() === "modao" ? "mdash" : "dash") : null;
        for (let i = 0; i < (sure && icon ? 4 : 1); i++) {
            touch.down(p, 1);
            sleep(ms);
            touch.up(1);
            if (!sure || !icon) return 1;
            wait(350);
            if (!seen(icon, screenshot()) && (sleep(200), !seen(icon, screenshot()))) return i + 1;
        }
        return -4; // never went
    }

    /** @type {any[]} */ const log_ = [];
    /** @param {any} st */
    function step(st) {
        const s0 = now();
        /** @type {any} */ const rec = { step: st, t: s0 };
        if (!st.loop && !args.fast) rec.ds0 = dsMedian(); // (fast: no 刀势 reads, ~200 ms a step)
        rec.at = now(); // when its action starts (after the 刀势 read)
        if (st.tap) rec.taps = tapBtn(st.tap, st.ms ?? 50, !!st.sure);
        else if (st.hold) holdBtn(st.hold, st.ms ?? 700);
        else if (st.charge != null) {
            const [held, how, red] = charge(st.charge, st.from, st.max, st.probe);
            rec.held = held;
            rec.how = how;
            if (st.probe) rec.red = red;
        } else if (st.switch) {
            let w = weapon();
            for (let i = 0; i < 4 && w !== st.switch; i++) {
                click(...BTN.switch);
                wait(600);
                w = weapon();
            }
            rec.weapon = w;
            if (w !== st.switch) log(`switch to ${st.switch}: still ${w}`);
        } else if (st.swap) {
            // 易武技 (teacher, 2026-10-11): drag the weapon bar left instead of tapping it, the switch with a blow
            const w0 = weapon();
            // the small diamond left of the idle weapon (958,323): lit when 易武 is ready? (px of bright gold / white)
            const im0 = screenshot();
            rec.diamond = [GOLD, { lower: [200, 200, 200], upper: [255, 255, 255] }].map((c) => {
                const h = color({ ...c, image: im0, roi: [954, 319, 24, 24], count: 1 });
                return h.hit ? h.results.reduce((a, m) => a + (m.count ?? 0), 0) : 0;
            });
            saveImage(im0, `captures/dummy_swap_${now()}.png`);
            dragSlow(SWAP_FROM, SWAP_TO, st.ms ?? 200, 0);
            wait(st.after ?? 300);
            rec.weapon = weapon();
            rec.from = w0;
            if (rec.weapon === w0) log(`swap: still ${w0}`);
        } else if (st.ring) {
            // 首领伤害 on: the dummy's red ring (from its foot outward, every ~6 s; reaches us ~0.4–0.6 s after it shows)
            // (the last one gone first: one fills the ground for ~3 s)
            const red = () => color({ ...RING_RED, image: screenshot(), roi: RING_ROI, count: RING_PX }).hit;
            waitFor(() => !red(), { timeout: 4000, interval: 30 });
            rec.ringAt = waitFor(() => (red() ? now() : null), { timeout: st.ms ?? 8000, interval: 10 });
        } else if (st.watch != null) {
            // after a 卸势: the 重击派生 diamond (陌刀) / the swirl on 横刀's 重击, our health and 真气; onOk taps it
            const until = Date.now() + st.watch;
            const b0 = bars(screenshot());
            rec.hp0 = b0.hp;
            rec.qi0 = b0.qi;
            while (Date.now() < until) {
                const im = screenshot();
                if (!rec.okAt && (seen("parryOk", im) || seen("swirl", im))) {
                    rec.okAt = now();
                    rec.ok = seen("parryOk", im) ? "diamond" : "swirl";
                    if (st.onOk) {
                        const p = rec.ok === "diamond" ? DIAMOND : BTN.heavy;
                        touch.down(p, 1);
                        sleep(50);
                        touch.up(1);
                        rec.okTap = now();
                    }
                }
                const b = bars(im);
                if (b.hp != null && rec.hp0 != null && b.hp < rec.hp0 - 0.01 && !rec.hitAt) rec.hitAt = now();
                if (b.hp != null) rec.hpMin = Math.min(rec.hpMin ?? 1, b.hp);
                sleep(20);
            }
        } else if (st.wait != null) wait(st.wait);
        else if (st.until != null && !st.loop) wait(Math.max(0, st.until - now()));
        else if (st.lock) rec.locked = lockOn();
        else if (st.walk != null) walk(st.walk, st.back ? STICK_R : -STICK_R, wait);
        else if (st.icon) {
            const icons = [].concat(st.icon);
            rec.seen = waitFor(() => {
                const im = screenshot();
                return icons.find((k) => seen(k, im)) ?? null;
            }, { timeout: st.ms ?? 4000, interval: 30 });
        } else if (st.loop) {
            let n = 0;
            // qi: stop once the 真气 read after a step is this low or less (the 衰弱期 test)
            while (now() < st.until && !(st.qi != null && lastQi != null && lastQi <= st.qi)) {
                for (const s of st.loop) {
                    if (now() >= st.until || (st.qi != null && lastQi != null && lastQi <= st.qi)) break;
                    step(s);
                }
                n++;
            }
            rec.rounds = n;
        } else throw new Error(`unknown step ${JSON.stringify(st)}`);
        rec.done = now();
        if (!st.loop) {
            const image = screenshot();
            poll(image);
            Object.assign(rec, bars(image));
            if (!args.fast) rec.ds = dsMedian(image);
            if (args.counter) rec.counter = count(read(COUNT_ROI, image)); // per-step totals (args.counter)
            if (rec.qi != null && rec.boss != null) lastQi = rec.qi;
        }
        log_.push(rec);
        log(`${rec.t}–${rec.done} ms ${JSON.stringify(st)}${rec.held ? ` held ${rec.held} (${rec.how})` : ""} boss ${rec.boss} qi ${rec.qi} 刀势 ${rec.ds0}→${rec.ds}`);
    }

    // prep: untimed steps first (weapon, waiting for cooldowns: {icon: "burst", ms: 25000}); no damage meant
    for (const st of args.prep ?? []) step(st);
    const prep = log_.splice(0);
    hits.length = 0;
    dsTrace.length = 0;
    t0 = Date.now();
    for (const st of steps) step(st);
    const stepsEnd = now();
    // the hits stop: the 最近一招 line unchanged for `settle` ms (12 s at most)
    if (trace) {
        const e0 = Date.now();
        while (Date.now() - e0 < 12000 && now() - Math.max(lastHit, stepsEnd) < settle) wait(100);
    } else wait(settle);
    const last = screenshot();
    if (args.save) saveImage(last, `captures/dummy_${args.save}.png`);
    const end = { ...bars(last), weapon: weapon(last), t: now(), counter: count(read(COUNT_ROI, last)), ds: daoshi(last) };
    /** @type {any} */ const out = { t0, prep, before, steps: log_, stepsEnd, lastHit, end, hits, window: atWindow, execute: execAt, dsTrace };
    if (args.read ?? true) {
        out.panel = breakdown();
        const p = out.panel;
        if (p.total != null && lastHit > 0) out.dps = Math.round(p.total / (lastHit / 1000));
    }
    return out;
}
