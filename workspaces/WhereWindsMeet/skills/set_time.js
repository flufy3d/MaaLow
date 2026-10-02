// The game's time of day (时辰): world → menu (top right) → the clock icon in the menu's right strip → the 时辰 page,
// whose wheel on the right is the twelve 时辰, the selected one in the box; swiping it up moves to a later one (only
// later: down does nothing below the time it is now; past 亥 it goes on into the next day, the box's label 今日 →
// 次日) → 确认更改 → the page's back → the menu's back → the world. Taught 2026-10-03 (explore messages 45, 0010–0025);
// the teacher said to tap 确认更改. Daytime runs (酒肉山林's minimap washed out by the sun) are tried at 午.
//
//   {to: "午"}   a 时辰 (子丑寅卯辰巳午未申酉戌亥), or {hour: 12} (0–23)
//   {read: true} only open the page and read what is selected (left open)

/** @type {SkillMeta} */
export const meta = { description: "set the game's time of day (时辰)", timeout: 90_000 };

const ORDER = "子丑寅卯辰巳午未申酉戌亥";
// OCR's look-alikes on the wheel (卯 came back as 卵 on 2026-10-03)
/** @type {Record<string, string>} */
const ALIKE = { 卵: "卯", 戍: "戌", 戊: "戌", 已: "巳", 己: "巳", 末: "未", 甲: "申", 由: "申", 西: "酉", 于: "子" };
/** @type {Point} */
const MENU = [1039, 22]; // world: the menu button
/** @type {Point} */
const CLOCK = [1046, 182]; // menu: the clock icon in the right strip
/** @type {Box} */
const TITLE_ROI = [62, 18, 60, 32]; // the page's title 时辰
/** @type {Box} */
const SELECTED_ROI = [915, 333, 65, 52]; // the wheel's box: the selected 时辰
/** @type {Box} */
const DAY_ROI = [833, 346, 44, 26]; // left of it: 今日 / 次日
const ROW = 62; // the wheel's rows, px
const WHEEL_X = 950;
const WHEEL_Y = 330; // a swipe up of n rows ends here
/** @type {Point} */
const CONFIRM = [997, 678]; // 确认更改
/** @type {Point} */
const PAGE_BACK = [1032, 33]; // the 时辰 page's back (to the menu)
/** @type {Point} */
const MENU_BACK = [1043, 33]; // the menu's « (to the world)
const MAX_SWIPES = 10;

/** OCR of one small box, the text without spaces ("" when none). @param {Box} roi @param {Image} [image] */
function read(roi, image) {
    const r = ocr({ image: image ?? screenshot(), roi, only_rec: true });
    return (r.text ?? r.results.map((m) => m.text ?? "").join("")).replace(/\s/g, "");
}

/** The selected 时辰 and its day label, from one screenshot. */
function selected() {
    const image = screenshot();
    const s = read(SELECTED_ROI, image);
    const ch = [...s].map((c) => ALIKE[c] ?? c).find((c) => ORDER.includes(c)) ?? null;
    return { ch, raw: s, day: read(DAY_ROI, image) };
}

function onPage() {
    return read(TITLE_ROI).includes("时辰");
}

/** From the world (or the menu) to the 时辰 page. */
function openPage() {
    if (onPage()) return;
    if (!recognize("SignIn_CloseMenu").hit) {
        if (!waitFor("SignIn_InWorld", { timeout: 5000 })) throw new Error("not on the world screen (no menu button)");
        click(...MENU);
        if (!waitFor("SignIn_CloseMenu", { timeout: 5000 })) throw new Error("the menu did not open");
    }
    click(...CLOCK);
    if (!waitFor(() => onPage(), { timeout: 5000 })) throw new Error("the 时辰 page did not open");
    sleep(500);
}

/** The 时辰 page → the menu → the world. */
function closePage() {
    click(...PAGE_BACK);
    if (!waitFor("SignIn_CloseMenu", { timeout: 5000 })) log("the menu did not show after the page's back");
    click(...MENU_BACK);
    if (!waitFor("SignIn_InWorld", { timeout: 5000 })) throw new Error("not back on the world screen");
}

/** Swipe the wheel n rows: up (later) for n > 0, down for n < 0. @param {number} n */
function roll(n) {
    const d = Math.abs(n) * ROW;
    const ms = 300 + 200 * Math.abs(n);
    if (n > 0) swipe([WHEEL_X, WHEEL_Y + d], [WHEEL_X, WHEEL_Y], ms);
    else swipe([WHEEL_X, WHEEL_Y], [WHEEL_X, WHEEL_Y + d], ms);
    sleep(900); // the wheel settles
}

/** @param {{to?: string, hour?: number, read?: boolean}} args */
export default function (args = {}) {
    openPage();
    const now = selected();
    log(`selected: ${now.ch ?? `? (${now.raw})`} ${now.day}`);
    if (args.read) return { selected: now.ch, day: now.day };
    const to = args.to ?? (args.hour != null ? ORDER[Math.floor((args.hour + 1) / 2) % 12] : null);
    if (!to || !ORDER.includes(to) || to.length !== 1) throw new Error(`to: one of ${ORDER} (or hour 0–23), got ${to}`);
    if (!now.ch) throw new Error(`could not read the selected 时辰 (${now.raw})`);
    if (now.ch === to && now.day.includes("今")) {
        closePage();
        return { to, changed: false };
    }
    /** rows from a 时辰 on to `to` @param {string} ch */
    const ahead = (ch) => (ORDER.indexOf(to) - ORDER.indexOf(ch) + 12) % 12;
    let cur = now;
    let left = ahead(now.ch);
    for (let i = 0; i < MAX_SWIPES && cur.ch !== to; i++) {
        const a = ahead(/** @type {string} */ (cur.ch));
        // more rows to go than before: the wheel ran a row or two past it, back down (never below the time it is now)
        const past = a > left;
        roll(past ? a - 12 : Math.min(a, 3));
        if (!past) left = a;
        cur = selected();
        log(`→ ${cur.ch ?? `? (${cur.raw})`} ${cur.day}`);
        if (!cur.ch) throw new Error(`could not read the selected 时辰 (${cur.raw})`);
    }
    if (cur.ch !== to) throw new Error(`the wheel stopped at ${cur.ch}, not ${to}`);
    click(...CONFIRM);
    // the clock turns to it; then the box says 今日 and the 时辰
    const done = waitFor(() => {
        const s = selected();
        return s.ch === to && s.day.includes("今") ? s : null;
    }, { timeout: 15000, interval: 1000 });
    if (!done) throw new Error(`after 确认更改 the page does not show 今日 ${to}`);
    closePage();
    event("time_set", { from: now.ch, to });
    return { from: now.ch, to, changed: true };
}
