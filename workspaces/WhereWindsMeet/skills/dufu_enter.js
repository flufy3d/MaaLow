// 独夫演练场入口: from the world / menu / any trial page, walk the verified path into the 独夫 training fight
// (追踪图标 → 江湖行 → 试炼 → 开封皇宫 → 独夫 → 演练场 → 开始演练) and return "arena". On the death panel it taps
// 再次训练 (the round scripts' ready.py does the same) and keeps going. The defense itself is dufu.js's job:
//   uv run maalow do skill dufu_enter
// Verified 2026-10-15 against teaching/explore.json steps 0-8 (teacher's own clicks) and re-run live.
// 2.3 (2026-10-16): a trial page now always shows 演练场 for whatever boss is selected (it opens on 清河 / the last
// pick: round 363's re-entry went into 寄棺主's arena), and 开封皇宫 lists 黑衣贼 first. So 演练场 is tapped only when
// the page title reads 独夫 (else: 开封皇宫 tab, then the 独夫 row found by OCR), and 开始演练 only on a panel titled
// 独夫 with 绝境·浴血 / 阶段一 set (else stop: never start another boss or difficulty).
// args.phase (2026-10-23): 1 (default) or 2. The panel must read 绝境·浴血 and 阶段<phase>; showing the other 阶段 it is
// switched (the 演练阶段 dropdown, then its item) and read again before 开始演练. Anything else still stops.
//   uv run maalow do skill dufu_enter --args '{"phase":2}'
/** @type {SkillMeta} */
export const meta = { description: "独夫演练场: enter the 独夫 training fight (args.phase 1 / 2) from wherever we are", timeout: 300_000 };

/** @type {Box} */ const QUEST_ROI = [20, 125, 360, 80]; // tracked quest lines; in the arena: 独夫·绝境·浴血·阶段一 / 击败当前敌人
/** @type {Box} */ const RETRY_ROI = [870, 645, 210, 75]; // 再次训练 on the death panel
/** @type {Box} */ const START_ROI = [850, 645, 230, 75]; // 开始演练 on the 演练场 panel
/** @type {Box} */ const PANEL_TITLE_ROI = [790, 8, 200, 48]; // 独夫 on the 演练场 panel
/** @type {Box} */ const PANEL_DIFF_ROI = [795, 160, 265, 110]; // 绝境·浴血 / 阶段一 on the 演练场 panel
/** @type {Box} */ const PAGE_TITLE_ROI = [370, 85, 300, 50]; // the selected boss on a trial page
/** @type {Box} */ const BOSS_LIST_ROI = [65, 85, 285, 500]; // 镇守 / 野外首领 rows on a trial page
/** @type {Box} */ const FIELD_ROI = [690, 645, 210, 75]; // 演练场 button on the 独夫 trial page
/** @type {Box} */ const REGION_BAR_ROI = [40, 12, 700, 45]; // 清河 开封 河西 不见山 开封皇宫 青州 on the trial pages
/** @type {Box} */ const JH_TITLE_ROI = [60, 140, 230, 90]; // 江湖行, the page title
/** @type {Box} */ const JH_CARDS_ROI = [780, 360, 225, 105]; // the 试炼 card (2.3: 太平武墓 above, 悬赏 below)
/** @type {Box} */ const JH_TILE_ROI = [630, 440, 250, 100]; // the 江湖行 tile in the menu
/** @type {Point} */ const MENU_ICON = [1036, 25]; // the tracked-quest icon that opens the menu (explore step 0)
/** @type {Point} */ const JIANGHU = [728, 485];
/** @type {Point} */ const TRIAL_CARD = [890, 418];
/** @type {Point} */ const TAB_KAIFENG = [346, 39];
/** @type {Point} */ const ROW_DUFU = [140, 238];
/** @type {Point} */ const FIELD_BTN = [760, 680];
/** @type {Point} */ const PANEL_CLOSE = [1035, 40];
/** @type {Point} */ const START_BTN = [985, 679];
/** @type {Point} */ const RETRY_BTN = [992, 679];
// the 演练阶段 dropdown on the 演练场 panel and its items once open (screens verified 2026-10-23)
/** @type {Point} */ const PHASE_DROPDOWN = [925, 246];
/** @type {Record<number, Point>} */ const PHASE_ITEM = { 1: [830, 246], 2: [830, 274] };
/** @type {Record<number, string>} */ const PHASE_TEXT = { 1: "阶段一", 2: "阶段二" };
const PHASE_SWITCH_TRIES = 3, PHASE_MENU_MS = 800, PHASE_PICK_MS = 1200;

/** OCR a text inside roi on the current screen. @param {string} text @param {Box} roi */
function see(text, roi) {
    return ocr({ image: screenshot(), roi }).results.some((m) => (m.text ?? "").includes(text));
}
/** The OCR line in roi that includes text, or null. @param {string} text @param {Box} roi */
function find(text, roi) {
    return ocr({ image: screenshot(), roi }).results.find((m) => (m.text ?? "").includes(text)) ?? null;
}

/** A trial page: the region tabs or the boss list headers (2.3: 不见山 alone was missed right after the tap). */
function trialPage() {
    const bar = ocr({ image: screenshot(), roi: REGION_BAR_ROI }).results.map((m) => m.text ?? "").join("|");
    if (["不见山", "开封皇宫", "清河", "青州"].some((t) => bar.includes(t))) return true;
    const list = ocr({ image: screenshot(), roi: BOSS_LIST_ROI }).results.map((m) => m.text ?? "").join("|");
    return ["野外首领", "镇守", "侠迹"].some((t) => list.includes(t));
}

/** In the arena (pre-engage or engaged): "arena", else "". Phase 2: a quest line reading 阶段一 twice is the
 * phase-one arena, an error (phase 1 keeps its old check: its quest line reads 阶段二 once cleared).
 * @param {number} phase */
function arena(phase) {
    const quest = () => ocr({ image: screenshot(), roi: QUEST_ROI }).results.map((m) => m.text ?? "").join("|");
    const q = quest();
    if (!q.includes("击败当前敌人") && !q.includes("独夫·绝境")) return "";
    if (phase === 2 && q.includes("阶段一") && !q.includes("阶段二") && quest().includes("阶段一")) {
        throw new Error(`in the 独夫 阶段一 arena, asked for 阶段二 (${q}): leave it first`);
    }
    log(`arena: 独夫演练场 (${q})`);
    return "arena";
}

/** @param {{phase?: number}} [args] phase: the 演练阶段 to start, 1 (default) or 2 */
export default function (args = {}) {
    const phase = args.phase === 2 ? 2 : 1;
    const want = PHASE_TEXT[phase], other = PHASE_TEXT[3 - phase];
    runSkill("clear_popups", {});
    let blank = 0, switches = 0;
    for (let i = 0; i < 60; i++) {
        if (remaining() < 30_000) break;
        if (arena(phase)) return "arena";
        if (see("再次训练", RETRY_ROI)) { // died: reset and keep going
            log("death panel: 再次训练");
            click(RETRY_BTN[0], RETRY_BTN[1]);
            sleep(7000);
            continue;
        }
        if (see("开始演练", START_ROI)) { // the practice panel is open: only 独夫 / 绝境·浴血 / 阶段<phase>
            const title = see("独夫", PANEL_TITLE_ROI);
            const diff = ocr({ image: screenshot(), roi: PANEL_DIFF_ROI }).results.map((m) => m.text ?? "").join("|");
            if (!title) { // another boss's panel: close it (its own back arrow), pick 独夫 on the page
                log("演练场 panel of another boss: close");
                click(PANEL_CLOSE[0], PANEL_CLOSE[1]);
                sleep(1500);
                continue;
            }
            if (!diff.includes("绝境")) throw new Error(`独夫 演练场 panel is not 绝境·浴血 (${diff}): not starting`);
            if (!diff.includes(want)) {
                // the other 阶段: open the 演练阶段 dropdown, pick ours, and read the panel again (next pass)
                if (!diff.includes(other) || switches >= PHASE_SWITCH_TRIES) {
                    throw new Error(`独夫 演练场 panel is not 绝境·浴血 ${want} (${diff}${switches ? `, after ${switches} switches` : ""}): not starting`);
                }
                switches++;
                log(`演练场 panel reads ${other}: switch to ${want} (#${switches})`);
                click(PHASE_DROPDOWN[0], PHASE_DROPDOWN[1]);
                sleep(PHASE_MENU_MS);
                click(PHASE_ITEM[phase][0], PHASE_ITEM[phase][1]);
                sleep(PHASE_PICK_MS);
                continue;
            }
            if (diff.includes(other)) { // both read (the dropdown still open?): read again
                if (switches++ >= PHASE_SWITCH_TRIES) throw new Error(`独夫 演练场 panel reads both 阶段 (${diff}): not starting`);
                log(`演练场 panel reads both ${want} and ${other}: read again`);
                sleep(PHASE_PICK_MS);
                continue;
            }
            log(`演练场 panel: ${want}, 开始演练`);
            click(START_BTN[0], START_BTN[1]);
            // the loading screen: touch nothing (live 2026-10-16: the menu-icon fallback hit the arena's exit icon)
            for (let w = 0; w < 25 && remaining() > 30_000; w++) {
                sleep(2000);
                if (arena(phase)) return "arena";
            }
            continue;
        }
        if (trialPage()) { // a trial page (2.3: 演练场 shows for any selected boss)
            if (see("独夫", PAGE_TITLE_ROI) && see("演练场", FIELD_ROI)) {
                log("独夫 page: 演练场");
                click(FIELD_BTN[0], FIELD_BTN[1]);
                sleep(2500);
                continue;
            }
            log("trial page: 开封皇宫 + 独夫");
            click(TAB_KAIFENG[0], TAB_KAIFENG[1]);
            sleep(1500);
            const row = find("独夫", BOSS_LIST_ROI);
            if (row) click(row.box);
            else click(ROW_DUFU[0], ROW_DUFU[1]);
            sleep(1500);
            continue;
        }
        if (see("江湖行", JH_TITLE_ROI)) { // the 江湖行 page (2.3: the small card captions no longer OCR reliably)
            const card = find("试炼", JH_CARDS_ROI);
            log(`江湖行 page: 试炼${card ? "" : " (card caption not read: fixed point)"}`);
            if (card) click(card.box);
            else click(TRIAL_CARD[0], TRIAL_CARD[1]);
            sleep(2000);
            continue;
        }
        if (see("江湖行", JH_TILE_ROI)) { // the menu
            log("menu: 江湖行");
            click(JIANGHU[0], JIANGHU[1]);
            sleep(2000);
            continue;
        }
        const read = ocr({ image: screenshot(), roi: JH_TITLE_ROI }).results.map((m) => m.text ?? "").join("|");
        if (!read && blank++ < 3) { // nothing to read: a loading / fading screen, wait instead of tapping
            log("blank screen: wait");
            sleep(2000);
            continue;
        }
        blank = 0;
        log(`world (or unknown screen): open the menu (read: ${read})`);
        click(MENU_ICON[0], MENU_ICON[1]);
        sleep(1500);
    }
    throw new Error("独夫演练场: never got into the arena");
}
