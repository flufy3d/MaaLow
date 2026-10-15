// 独夫演练场入口: from the world / menu / any trial page, walk the verified path into the 独夫 training fight
// (追踪图标 → 江湖行 → 试炼 → 开封皇宫 → 独夫 → 演练场 → 开始演练) and return "arena". On the death panel it taps
// 再次训练 (the round scripts' ready.py does the same) and keeps going. The defense itself is dufu.js's job:
//   uv run maalow do skill dufu_enter
// Verified 2026-10-15 against teaching/explore.json steps 0-8 (teacher's own clicks) and re-run live.
/** @type {SkillMeta} */
export const meta = { description: "独夫演练场: enter the 独夫 training fight from wherever we are", timeout: 300_000 };

/** @type {Box} */ const QUEST_ROI = [20, 125, 360, 80]; // tracked quest lines; in the arena: 独夫·绝境·浴血·阶段一 / 击败当前敌人
/** @type {Box} */ const RETRY_ROI = [870, 645, 210, 75]; // 再次训练 on the death panel
/** @type {Box} */ const START_ROI = [850, 645, 230, 75]; // 开始演练 on the 演练场 panel
/** @type {Box} */ const FIELD_ROI = [690, 645, 210, 75]; // 演练场 button on the 独夫 trial page
/** @type {Box} */ const REGION_BAR_ROI = [40, 12, 700, 45]; // 清河 开封 河西 不见山 开封皇宫 青州 on the trial pages
/** @type {Box} */ const JH_TITLE_ROI = [60, 140, 230, 90]; // 江湖行, the page title
/** @type {Box} */ const JH_CARDS_ROI = [740, 320, 300, 170]; // 太平武墓 / 试炼 cards (not on the menu)
/** @type {Box} */ const JH_TILE_ROI = [630, 440, 250, 100]; // the 江湖行 tile in the menu
/** @type {Point} */ const MENU_ICON = [1036, 25]; // the tracked-quest icon that opens the menu (explore step 0)
/** @type {Point} */ const JIANGHU = [728, 485];
/** @type {Point} */ const TRIAL_CARD = [890, 418];
/** @type {Point} */ const TAB_KAIFENG = [346, 39];
/** @type {Point} */ const ROW_DUFU = [140, 238];
/** @type {Point} */ const FIELD_BTN = [760, 680];
/** @type {Point} */ const START_BTN = [985, 679];
/** @type {Point} */ const RETRY_BTN = [992, 679];

/** OCR a text inside roi on the current screen. @param {string} text @param {Box} roi */
function see(text, roi) {
    return ocr({ image: screenshot(), roi }).results.some((m) => (m.text ?? "").includes(text));
}

export default function () {
    runSkill("clear_popups", {});
    for (let i = 0; i < 60; i++) {
        if (remaining() < 30_000) break;
        if (see("击败当前敌人", QUEST_ROI) || see("独夫·绝境", QUEST_ROI)) { // the fight is up (pre-engage or engaged)
            log("arena: 独夫演练场");
            return "arena";
        }
        if (see("再次训练", RETRY_ROI)) { // died: reset and keep going
            log("death panel: 再次训练");
            click(RETRY_BTN[0], RETRY_BTN[1]);
            sleep(7000);
            continue;
        }
        if (see("开始演练", START_ROI)) { // the practice panel is open
            log("演练场 panel: 开始演练");
            click(START_BTN[0], START_BTN[1]);
            sleep(6000);
            continue;
        }
        if (see("演练场", FIELD_ROI)) { // 独夫 selected on its trial page
            log("独夫 page: 演练场");
            click(FIELD_BTN[0], FIELD_BTN[1]);
            sleep(2500);
            continue;
        }
        if (see("不见山", REGION_BAR_ROI)) { // a trial page: pick the region, then the boss
            log("trial page: 开封皇宫 + 独夫");
            click(TAB_KAIFENG[0], TAB_KAIFENG[1]);
            sleep(1500);
            click(ROW_DUFU[0], ROW_DUFU[1]);
            sleep(1500);
            continue;
        }
        if (see("太平武墓", JH_CARDS_ROI) && see("江湖行", JH_TITLE_ROI)) { // the 江湖行 page
            log("江湖行 page: 试炼");
            click(TRIAL_CARD[0], TRIAL_CARD[1]);
            sleep(2000);
            continue;
        }
        if (see("江湖行", JH_TILE_ROI)) { // the menu
            log("menu: 江湖行");
            click(JIANGHU[0], JIANGHU[1]);
            sleep(2000);
            continue;
        }
        log("world (or unknown screen): open the menu");
        click(MENU_ICON[0], MENU_ICON[1]);
        sleep(1500);
    }
    throw new Error("独夫演练场: never got into the arena");
}
