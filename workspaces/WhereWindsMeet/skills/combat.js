// Fighting what SeekEnemy found, with the 陌刀 / 横刀 rotation (replay 战斗技能, teacher's notes):
//   陌刀: 奇术 (箫吟千浪), 2 s later 卸势 cuts its long recovery; 增益; switch weapon (the bar on the right)
//   横刀: 突进, 爆发 (the 突进 button shows a swirl while it plays, then the 伤害 arrow), 伤害; switch back at once
//   陌刀: the buff is short, so 蓄力 held 3 s, three times in a row; then 轻击 until 20 s have passed since the switch,
//         when everything is off cooldown again and the round starts over
// 奇术 goes whenever it is lit (grey without 精力, a countdown while cooling), always followed by 卸势. A skill pressed
// while being hit may not come out: a press counts once its button changes (a countdown shows, or the icon becomes
// the next one), otherwise it is pressed again. Below `hp` health the potion next to the bar is tapped.
// 处决 is tapped whenever a look sees it (teacher, recording 酒肉山林 frame 2427): a gold diamond above 奇术, always in
// the same place, there for about a second (frames 2412–2444, 4156–4176) and finishing the enemy. The 3 s 蓄力 holds
// and the wait before 卸势 are not cut short for it (teacher, 2026-10-02).
// The fight is over when no red mark has been on the minimap (within `within` minimap px, if given) and nothing
// locked for `idleMs`; at a stronghold the rest of its enemies may be in sight but too far to be part of this fight.
// Sooner: in a fight the game hides the icons at the top right; once they have been hidden, their coming back for
// `calmMs` ends it (teacher, explore message after 85: stuck fighting in an empty room with red marks around).
// Enemy behind: in a fight with no enemy health bar on screen for BAR_MS (the thin red line over its head: teacher,
// recording 酒肉山林 frame 3040), the camera turns to the nearest red mark on the minimap when that is more than
// BAR_TURN off the camera; with no mark it stays (no blind turns).
// 金光 is dodged (teacher: 燕云 is 金光闪避，红光卸势; recording 镇守挑战-镇关吼): a thin gold line across the enemy,
// 1–4 frames, the blow lands ~0.5 s later. Every wait (the 3 s 蓄力 holds too) looks for it every ~30 ms; a held
// 蓄力 is let go for the dodge. 红光 → 卸势 waits for a recording that has one.
// Out of reach (teacher: locked on and too far, the blows hit air; 蓄力 can be held while walking): when the
// enemy's health (in a boss fight the bar at the top, else the bars over their heads) has not gone down for WHIFF_MS while
// locked, the joystick is held forward (contact 0) until it does.
// Bosses (args.boss): the fight is not over while the boss bar shows (lock-on and minimap marks come and go in the
// cut scenes); once the bar is used up the boss keeps that last bit (pale left end) until its last move, whose
// gold diamond (化解, where 处决 is) is tapped like 处决.
// 独夫 (args.foe "dufu", 试炼 → 开封皇宫 → 独夫 → 演练场; recording 20261010-171738, research in data/tmp/dufu): the boss
// is gold and orange all over, so the orange-burst 警戒 and the look at the sky are off (51 bursts and 2 sky looks read
// in one fight, none a tell: it stood on guard most of the time). Its 金光 is a flare, a white star with an orange
// streak across the screen (9 frames); the gold line rule alone also took our own gold for it, so the streak must be
// there too. 红光 → 卸势 (none in round 1; in round 2 its red crescent sweeps, 4 of them). Most of its damage came from
// plain blows with no tell, in combos of 3–4 about 0.5–1 s apart: hit by one, 卸势 for the next (args.parryHits; off:
// round 2 was hit as often with it). 重伤 ends the fight ("dead"): the arena starts over by itself. 起幕布: two dark curtains with glowing orange edges sweep at the character three times
// (~1.6 s each) and burn whoever they cover; walked into the gap between them. At most 3 potions a fight (teacher;
// args.potions), counted when the health goes up. 陌刀's 突进 closes in when it is far (teacher, explore 0030).
import { calm as hudCalm } from "./lib/hud.js";
import { angleDiff, cameraHeading, enemies } from "./lib/minimap.js";
import { turn } from "./move.js";

/** @type {SkillMeta} */
export const meta = { description: "fight the enemies around with the 陌刀 / 横刀 rotation, healing below half health", timeout: 600_000 };

/** @type {Point} */ const LIGHT = [945, 592]; // 轻击 (横刀: 轻蓄力)
/** @type {Point} */ const CHARGE = [1020, 478]; // 陌刀 蓄力 (横刀: 重击)
/** @type {Point} */ const PARRY = [952, 495]; // 卸势
/** @type {Point} */ const QISHU = [881, 525]; // 奇术
/** @type {Point} */ const DASH = [833, 593]; // 陌刀 突进 = 武学技 燃此魂 (closes in, 荡八荒·极); 横刀 突进 → 伤害 (its two-stage martial skill)
/** @type {Point} */ const BUFF = [825, 668]; // 陌刀 增益 = 特殊技 唤千军 (铁衣戎魂, the opener); 横刀 爆发 = 特殊技 飞鸿踏雪
/** @type {Point} */ const SWITCH = [993, 320]; // weapon bar
/** @type {Point} */ const POTION = [700, 690];
/** @type {Point} */ const EXECUTE = [852, 430]; // 处决
/** @type {Point} */ const LOCK = [1021, 667];
/** @type {Box} */ const LOCK_ROI = [1004, 648, 34, 39];
const GOLD = { lower: [200, 180, 100], upper: [255, 245, 200] };

/** Templates (templates/combat/, cut from the replay) and where to look for them. */
const T = {
    qishu: ["combat/qishu_ready.png", [848, 493, 64, 64]],
    modao: ["combat/modao_charge.png", [988, 446, 64, 68]],
    hengdao: ["combat/hengdao_heavy.png", [988, 446, 64, 68]],
    dash: ["combat/hengdao_dash.png", [801, 561, 64, 64]],
    damage: ["combat/hengdao_damage.png", [801, 561, 64, 64]], // swirl: 爆发 still playing
    strike: ["combat/hengdao_strike.png", [801, 561, 64, 64]], // arrow: 伤害 ready (teaching message 2)
    burst: ["combat/hengdao_burst.png", [793, 635, 64, 64]],
    buff: ["combat/modao_buff.png", [793, 635, 64, 64]],
    // inside of the diamond (the white rim pulses): 0.78 the frame it comes up, 0.85–1.0 after; ≤ 0.55 everywhere
    // else in that recording and ≤ 0.49 in ~22000 frames of other runs
    execute: ["combat/execute.png", [815, 391, 75, 75]],
    // the 「气竭」 banner under the boss bar (teaching/独夫/0236.png): rounds 81–83 showed it 2–3 times a round for 83–88
    // frames (~2.9 s), each time when a blow hit us 14–24 frames after our 卸势 (a hit of 10–12%), never in the
    // boss's 衰弱期: our own exhaustion after a failed 卸势, it seems. Logged (qijie events) to learn what follows
    qijie: ["combat/qijie.png", [470, 80, 150, 50]],
    // a boss's last move: 化解 in the same diamond (镇关吼 frames 3479–3501, ≥ 0.95; none in the stronghold runs)
    ultimate: ["combat/ultimate.png", [815, 391, 75, 75]],
    // 陌刀's 突进 (裂石钧, explore 0030): ≥ 0.9 in all 1379 陌刀 frames of 独夫 20261010-171738, ≤ 0.42 with 横刀
    mdash: ["combat/modao_dash.png", [801, 561, 64, 64]],
    // a good 卸势 (teacher, explore 0042): the blue-white 重击派生 diamond where 处决 shows, and 轻击 turns into 反击;
    // ≤ 0.42 / ≤ 0.49 in ~3100 frames of three other recordings
    parryOk: ["combat/parry_ok.png", [815, 391, 75, 75]],
    counter: ["combat/counter.png", [913, 560, 64, 64]],
};
const THRESHOLD = 0.7;
const ICON_WHITE = { lower: [0, 0, 216], upper: [180, 59, 255], method: 40 }; // HSV: a lit skill icon's strokes
const QISHU_LIT_PX = 30;

/**
 * Health bar: light grey on row 683 from x 415, 669 when full (replay frames 130–1300); it goes white for a moment
 * when hit, and effects can cover it. A reading only counts when the bar's left end is there, and low has to be read
 * twice in a row.
 */
/** @type {Box} */ const HP_ROI = [405, 681, 280, 5];
const HP_LEFT = 415;
const HP_FULL = 669;
const HP_GREY = { lower: [0, 0, 140], upper: [180, 45, 255], method: 40 }; // HSV: unsaturated, bright
// below ~30% the bar turns red (H 0–4 / 178–179, S 125–150, V 180–200; the empty part V 70–90, the ring at its left
// S 222): read as none it was never healed (独夫, frames 4766–5010: 27% to dead with 4 potions left). Only up to
// HP_RED_MAX counts (241 frames of it there, none above 30%)
const HP_RED = { lower: [[0, 100, 165], [174, 100, 165]], upper: [[6, 175, 255], [180, 175, 255]], method: 40 };
const HP_RED_MAX = 0.45;
const HP_GAP = 12;

const ROUND_MS = 20_000; // 陌刀 part of a round, from switching back
const CHARGE_MS = 3000;
// 蓄力 released when the 陌刀 turns red (teacher, 2026-10-10: 3 s is long, red is enough, ~2.5 s): in round 33 red
// (H <= 6 / >= 172, S >= 150, V >= 140) came up in the scene 2.2–2.3 s after the press in 6 of 10 holds; it is looked
// for from CHARGE_RED_FROM, released at CHARGE_RED_MAX at the latest
const CHARGE_RED_FROM = 1800;
const CHARGE_RED_MAX = 2600;
const CHARGE_RED_PX = 120;
const CHARGE_RED = { lower: [[0, 150, 140], [172, 150, 140]], upper: [[6, 255, 255], [180, 255, 255]], method: 40 };
/** @type {Box} */ const CHARGE_RED_ROI = [150, 80, 780, 560];
// the 蓄力 must come out (teacher, round 34: 输出全靠陌刀蓄力, 没打出来亏大): of 12 holds in round 34 only 2 hurt the
// boss; one was pressed while knocked down (731), and sched tapped 轻击 right after the release, while the red slash
// (~0.5 s after letting go, 4062 → 4077) was still coming. So: not pressed within CHARGE_AFTER_HIT_MS of a hit, nothing
// tapped for CHARGE_FOLLOW_MS after the release, no potion meanwhile unless urgent
const CHARGE_AFTER_HIT_MS = 700;
const CHARGE_FOLLOW_MS = 900;
// round 35: 13 holds, 8 hurt the boss (11–26 px); the misses: hit / knocked down while holding (3: 2688, 3648, 3742),
// the boss striking meanwhile (794, 2993), the boss off to the side / far (2402, 2688). So a 蓄力 starts when no blow
// is coming (ttc p(k 5–17) below CHARGE_SAFE_P, waited for up to CHARGE_WAIT_MS, 卸势 meanwhile as always) or at
// once after a good 卸势 (the boss staggered); hit while holding, it is let go (lost anyway) and tried again
// rounds 34–37: 29% of the time in a 蓄力 (hold + slash) took 44% of the damage (2.8 %/s, else 1.4–1.5): a stricter
// quiet moment to start one (args.chargeSafeP)
const CHARGE_SAFE_P = 0.3; // back from 0.2 (rounds 38–41 no better)
const CHARGE_WAIT_MS = 800; // round 36: 18 waits, only 6 longer than 100 ms (max 1390)
// rounds 34–40, 94 holds: started within 4 s of a good 卸势 (29) the boss hit us while holding 27% of the time, else
// 69% (a low ttc p at the start did not help: round 40's holds hit 10–22 frames in had p 1–25). So a 蓄力 waits up to
// args.chargeOkWait ms for a good 卸势 (卸势 / dodges go on meanwhile), then starts on a quiet moment as before
const CHARGE_OK_WINDOW_MS = 4000;
// round 41 waited 3 s for one 9 times of 13 and got 3 holds hit-free in 146 s: no forced wait (0); a good 卸势 within
// CHARGE_OK_WINDOW_MS still starts one at once
const CHARGE_OK_WAIT_MS = 0;
const CHARGE_AFTER_PARRY_MS = 800;
const CHARGES = 3;
const STRIKE_MS = 3500; // waiting for the 伤害 arrow: ~0.8 s after the second 突进, 2.3 s after the swirl
const DASH_BACK_MS = 3000; // after 爆发, waiting for 突进's second charge to show
// a 突进 takes its icon away for 23 frames (0.77 s, 横刀连续技 51–73); back later, it is the second charge, so a
// press only counts as missed when the icon never went within this
const DASH_GONE_MS = 600;
// a tap lights its button white for 3–4 frames (the icon gone) even when nothing comes out (镇守-横刀验证
// 20261010-125301: 突进 tapped while 爆发 plays): gone counts only when still gone this much later
const GLOW_MS = 200;
// 突进 taps are swallowed while 爆发 plays: the teacher's second 突进 came 2.6 s after it, ours took at 2.4 s
const DASH_AFTER_BURST = 2000;
const PARRY_AFTER = 2000; // 奇术 recovery cut by 卸势 after this
const POTION_MS = 3000; // between potion taps
// a drink shows as the health going up within this long of the tap (独夫: from 32% to 89% over 1 s); with a limit on
// drinks (args.potions) no new tap meanwhile: of 11 taps in that fight 4 were drunk
const POTION_TOOK_MS = 4000;
const POTION_TOOK = 0.1;
const LOCK_MS = 2000; // between lock taps when enemies are around but nothing is locked
const EXECUTE_MS = 300; // between 处决 taps while it still shows
// The enemy health bar: red, 2 px high, ~55 px long when full (H 174–1, S 120–141, V 147–170); a line at least
// 25 px long, at most 3 high and filled 70% is one. In the recording's 1231 world frames 89 show one, all in or by
// the fights (shorter red bits of walls and effects, 12–18 px, are not)
const BAR = { lower: [[0, 100, 110], [170, 100, 110]], upper: [[10, 255, 255], [180, 255, 255]], method: 40 };
/** @type {Box} */ const BAR_ROI = [150, 100, 780, 460]; // the scene, off the minimap, the buttons and the chat
const BAR_MS = 1500;
const BAR_TURN = 45; // degrees: the mark this far off the camera is turned to
const TURN_MS = 2000; // between such turns
const DEG_PX = 0.6; // camera turn per px dragged (move.js)

/** @type {Point} */ const DODGE = [924, 674];
/** @type {Point} */ const STICK = [175, 569]; // joystick middle (move.js)
const STICK_R = 83; // joystick radius
const CREEP = 0.5; // joystick push while 蓄力 is held
// 金光: a connected run of warm bright px (HSV, so snow and white clouds, bluish, are not) at least 230 px wide, 3.5
// times as wide as high and filled ≥ 15%. The first frame is a flare (~350 x 100 with its glow), then a thin line.
// In the two 镇关吼 recordings it caught 5 of the 6, all but one in their first frame (missed: a white one over white
// clouds); in the three stronghold recordings 3 places (酒肉山林 2445, maybe a real one; 怜花禅院 our own gold
// swirl, 3156 and 3227). The first try (RGB, ≤ 20–60 high) caught the run's two only in their last frame.
const FLASH = { lower: [8, 25, 235], upper: [35, 255, 255], method: 40 };
/** @type {Box} */ const FLASH_ROI = [150, 120, 780, 440];
const FLASH_MS = 600; // one dodge per flash
const GAP_LOG_MS = 150;
// after a dodge no blows for this long: the first live dodges were cut short by the next 轻击 (run 2, frames 716–720)
const DODGE_REST_MS = 700;
/** @type {Point} */ const BACKWARD = [175, 652];
const DODGE_AGAIN_MS = 300; // between dodges in a row
const FLASH_DODGES = 5; // after a 金光: 0–1.2 s, the ground attack's blows up to ~+44 frames
const BURST = { lower: [10, 90, 110], upper: [24, 255, 255], method: 40 }; // HSV: the boss's orange burst
const ALERT_MS = 4000; // 警戒 with no 金光 seen
const OWN_FX_MS = 1500; // after our 爆发 (and the like) its gold ribbons last ~1 s: no burst read meanwhile
const HENGDAO_FX_MS = 2000; // after the 横刀 part, its gold lingers this long
const STILL_MS = 600; // after a skill press, no walking this long
const BURST_MS = 6000; // 爆发 tapped this long at most until it goes out
const BURST_TAP_MS = 350; // between 爆发 taps
const LEAP_MS = 2000; // a 金光 this soon after the burst is the leap's (~1 s; the ground attack's ~3 s)
const LEAP_DELAY = 280; // the leap: from seeing its 金光 to the dodge press (it lights ~3 frames after; lands +16–19)
const EARLY_MS = 550; // 警戒: dodge this long after the burst anyway: the leap's claw slam lands 21–23 frames after
// the burst, its 金光 ~30 (research 2, 2026-10-10: the slam took 51–55 HP in two runs; 850 ms was after it)
const SKY = { lower: [0, 0, 171], upper: [180, 255, 255], method: 40 }; // HSV: bright (looking up at the sky)
/** @type {Box} */ const SKY_ROI = [200, 100, 700, 300];
const SKY_GUARD_MS = 6500; // the longest a look up is guarded
const SKY_LATE = 4900; // looking up this long with no 金光 seen: dodge anyway (the drop lands ~5.0–5.5 s in)
const DOWN_MS = 1000; // 重伤 looked for this often
const SKY_DELAY = 370; // the drop lands 19–22 frames after its small 金光: dodge ~12–14 frames after (the teacher's
// at +8 was too soon)
const ALERT_AFTER = 1300; // 警戒 on after the 金光 (the ground attack's last blow ~+38 frames)
const HUD_MS = 500; // boss fight: the top right icons (the end) looked at this often, not every look
// boss health: red from the left. Only looked at in boss fights: red timber at the top of the screen in the
// strongholds reads the same (634 frames of 酒肉山林)
/** @type {Box} */ const BOSS_ROI = [347, 27, 386, 6];
const BOSS_RED = { lower: [170, 0, 0], upper: [255, 130, 130] };
/** @type {Box} */ const BOSS_LAST_ROI = [349, 27, 16, 6]; // used up: the left end pale lilac until the last move
const BOSS_LAST = { lower: [150, 140, 200], upper: [225, 225, 255] }; // white (loading) is not it
const WHIFF_MS = 3000;
const BOSS_WHIFF_MS = 1000;
const BOSS_GONE_MS = 5000; // boss fight: the bar gone this long (and the icons back) is the end
/** @type {Box} */ const DOWN_ROI = [930, 650, 140, 60]; // 重伤: 疗伤 at the bottom right

// 独夫 (args.foe "dufu"). Its 金光 flare's streak: orange (H 8–20, S ≥ 100, V ≥ 200), a run at least 150 wide and
// twice as wide as high, on the frame the gold rule fires. Together they caught all 9 flares of the recording on their
// first frame and none of the 7 times our own gold (yellower, H 22–30) passed the gold rule
const STREAK = { lower: [8, 100, 200], upper: [20, 255, 255], method: 40 };
// 红光: the same, red (H ≤ 7 / ≥ 172): a run ≥ 150 wide, 3 times as wide as high. 0 frames in that fight (the red
// glow of the boss's glaive, 1097–1100, is ≤ 102 wide)
const RED = { lower: [[0, 120, 200], [172, 120, 200]], upper: [[7, 255, 255], [180, 255, 255]], method: 40 };
const RED_DELAY = 150; // 卸势 this long after it (when the blow lands is not known: a 金光's lands +15–25 frames)
const RED_MS = 800; // one 卸势 per 红光
// plain blows: hit (health down this much at once) with no 金光 dodge just before, 卸势 PARRY_HIT_DELAY later for the
// combo's next blow (13–34 frames after the last, mostly ~22, in that fight)
const HIT_DROP = 0.025;
const PARRY_HIT_DELAY = 300;
const PARRY_HIT_MS = 800;
// 起幕布 (frames 3312–3495): two dark curtains (V ≤ 30 over the top of the screen; the sky in the gap between them
// is V ~50) with glowing orange edges (H 5–30, ≥ 120 high, ≤ 30 wide) sweep at the character three times, 3325–3356,
// 3387–3424, 3449–3486, and flames burst where they went 10–12 frames after they pass (3368: 7% off, the character
// covered; in the gap at 3424 nothing). Seen in 105 frames, all of them those (none elsewhere in the fight).
/** @type {Box} */ const CURTAIN_ROI = [0, 80, 1080, 150];
const CURTAIN_DARK = { lower: [0, 0, 0], upper: [180, 255, 30], method: 40 };
/** @type {Box} */ const EDGE_ROI = [0, 60, 1080, 500];
const EDGE = { lower: [5, 80, 150], upper: [30, 255, 255], method: 40 };
// round 3's second 起幕布 came from far (edges 74–119 high, 5088–5104): ≥ 70 (8 single-frame misreads in 190 s,
// none twice in a row)
const EDGE_H = 70;
const ME_X = 540; // the character, on screen (the camera behind it)
const GAP_IN = 20; // within the gap this far from its sides counts as in it
const GAP_PUSH = 120; // px off the gap's middle for a full push of the joystick sideways
const CURTAIN_MS = 9000; // the longest a 起幕布 is guarded (three sweeps took 5.7 s)
const CURTAIN_GONE_MS = 1500; // not seen this long: over (the sweeps came 25–31 frames apart)
// looked for on every look but the 红光 ones (round 3: every 150 ms and two in a row, the first sweep was seen ~1 s
// late, the character still attacking, and burned)
const CURTAIN_EVERY = 0;
// rounds 63–71: 12 of 33 起幕布 the device saw had no curtain in the recording (dark sky + gold edges), and 26 of the
// 59 hits counted as 幕布 came in those (guarding: no 卸势); in the real ones the first sweep hit us 31–39 frames after
// it first showed (8 of 21). So a 起幕布 is taken as one only when seen on CURTAIN_CONFIRM looks in a row, and the first
// sweep is dodged CURTAIN_FIRST_DODGE_MS after it first showed unless we are in the gap by then
const CURTAIN_CONFIRM = 3;
const CURTAIN_FIRST_DODGE_MS = 950;
const CURTAIN_CONFIRM_MS = 1000;
const CURTAIN_HIT_PX = 90; // a curtain side this close to us (screen px): it is reaching us
const CURTAIN_DODGE_GAP_MS = 700;
const LUNGE_MS = 6000; // 陌刀 突进 to close in at most this often
/** @type {Box} */ const MDASH_LIT_ROI = [815, 575, 36, 36]; // 陌刀 突进's icon: white px, 107–111 lit, 0 grey
const DASH_LIT_PX = 40;
const OPEN_WAIT_MS = 4000; // the opening 突进 waits this long at most for its icon
// its second part, this long after the first went out (the icon turns into a countdown at once: round 6, 4118–4124)
const DASH2_MS = 500;
const OPEN_BOSS_MS = 15_000; // the opening 突进 waits this long at most for the boss bar
/** @type {Point} */ const LEFT = [175 - 83, 569]; // joystick for a dodge to the left / right (teacher: some blows
/** @type {Point} */ const RIGHT = [175 + 83, 569]; // are only dodged sideways)
// defend (practice): 卸势 after a hit at these delays in turn, and blind ones at these gaps in turn when nothing
// happens; walked in after a dodge and now and then (no blows, so "out of reach" cannot be read)
// (round 19: 0 / 150 / 300 / 450 / 600 worked 5/7, 6/7, 4/6, 4/7, 7/7)
// rounds 88–93: the next contact of a combo came 15–20 or 24–36 frames after one (glow-aligned); the 卸势 after a hit
// showed at +15–21 (150 ms after it was seen) and +30–36 (600 ms): 15/90 and 17/83 worked. 350 ms puts the second at
// ~+23–29, 5–10 before the 30–36 ones (teacher: the 卸势 timing on plain combos is what is off)
// (350 in rounds 97–102: 9.1 hits a minute, 卸势仍挨 4.5; back to 600 in 103–105: 7.4, 3.2: 600 again)
const DEFEND_HIT_DELAYS = [150, 600];
const DEFEND_BLIND_MS = [1500, 2000, 2500];
// the scene moving (defend's wind-up cue): mid-bright px (V 80–149) counted in a 3 x 2 grid over the scene, the sum
// of how much each cell's count changed since the last look, per frame (33 ms). On the practice recording
// (20261010-182856) the scene's frame difference ≥ 18 (its mean over a 195 x 130 copy) came 5–21 frames before 90%
// of the boss's 52 blows, at 41 a minute (by chance 32%); the gold growing caught 52%. On round 15 these counts
// follow that difference (r 0.80; at 18 the counts moved 8000–12000)
/** @type {Box} */ const MOTION_ROI = [150, 80, 780, 520];
const MOTION_HSV = { lower: [0, 0, 80], upper: [180, 255, 149], method: 40 };
// round 16 (defend, 20261010-195605): ≥ 8000 came 5–21 frames before 94% of its 63 blows at 55 a minute (chance
// 40%)
// (round 18 read lower on the device than offline: per-second highs median 2100, 75th 6000; 8000 left 8 cues in
// 133 s. 2500 is what 5000 offline (68 a minute there, 97% of blows) reads like on the device)
// (round 22, read on every screenshot: 卸势 at < 4000 worked 8/27, 4000–8000 6/28, 8000–16000 5/13, ≥ 16000 5/9; the
// failed ones left it open: 41% of the damage came 2–21 frames after a 卸势)
const MOTION_TH = 8000;
const MOTION_MS = 400; // one 卸势 per this long at most
const DEFEND_QUIET_MS = 150; // defend: not this soon after our dodge (300 until round 71: 10 of 58 uncovered hits came just after one)
const MOTION_EVERY = 100; // the fight: looked at this often (the app's leak is fixed)
// 独夫 wind-up classifier (args.yolo, off by default; data/tmp/dufu_yolo): NeuralNetworkClassify on the scene, labels
// idle / windup (a blow lands in 5–21 frames). Offline on two held-out practice recordings, every 2nd frame, p >= 0.5:
// ~52 triggers a minute, 76–77% of blows had one 5–21 frames before (random at that rate 36–43%, the frame-diff rule
// 54–72% at 58–74 a minute); device: ~23 ms a call
const YOLO_MODEL = "dufu/windup.onnx"; // under model/classify/
/** @type {Box} */ const YOLO_ROI = [120, 40, 840, 620]; // what it was trained on: off the minimap, quest text, buttons, own hp bar
const YOLO_TH = 0.5;
// 独夫 frames-to-contact net (args.ttc; data/tmp/dufu_yolo/train_ttc.py): MobileNetV3-small on the gray 96x96 of
// TTC_ROI, frames n-4, n-2, n as channels (normalized inside the model), softmax over k 0–4, 5–10, 11–17, 18–25,
// farther. Rounds 25–27: a 卸势 pressed 0–17 frames before the contact worked about half the time (0–4 30/47, 5–10
// 26/48, 11–17 24/49), 18–25 5/28, earlier 0/177; the look is ~2 frames old when pressed: 卸势 when p(k 5–17) >=
// TTC_TH. Held-out recordings, every 2nd frame: 32–39 a minute, 81–84% of blows had one 2–19 frames before (the
// windup classifier 44–46 a minute, 83–92%); 5–6 ms on the device (windup 27–40)
// v2 (data/tmp/dufu_yolo/train_ttc2.py, rounds 16–27 and 63–79): rounds 81–83 11.2 hits a minute against 12.2 with v1
// (72–77), 没覆盖 5.3 → 3.4
const TTC_MODEL = "dufu/ttc2.onnx";
/** @type {InferOptions} */
const TTC_OPTS = { roi: [240, 30, 600, 600], size: 96, color: "gray", frames: [-4, -2, 0], frame_ms: 1000 / 30, post: "softmax" };
const TTC_BINS = [1, 2];
const TTC_TH = 0.6;
// rounds 63–65 (defend): of the hits taken right after a ttc 卸势, most came 12–20 frames after the press (too early:
// good ones were 0–14 before the contact, mostly 3–8); at those presses the model had p(k 11–17) 0.42 against
// p(k 5–10) 0.26 (good ones 0.33 / 0.36). So when the far bin leads, the press waits until the near one does, up to
// TTC_HOLD_MS (args.ttcHold, 0 = off)
const TTC_HOLD_MS = 170;
const TTC_HOLD_NEAR = 1; // no hold when the near bin is this high already (0.35 in rounds 78–80, with reparry: no better; off)
// rounds 75–77: of 118 high ttc reads held back "after a tap" (most 80–150 ms after it), 36 were hit within 25 frames,
// 25 of them after a 卸势 that had not worked: one that shows no sign of working may be pressed again this soon
// rounds 78–80 with 250 ms: 13.1 hits a minute (72–77 without it 12.3), 卸势仍挨 4.8 against 4.2–4.4: off (0)
const REPARRY_MS = 0;
// okEscape (defend, args.okEscape): rounds 72–83, 41% of the hits were the next blow of a combo (24% after one that hit
// us, 17% after one we 卸势'd; a good 卸势 was followed by a hit within 40 frames 29% of the time); guides: 卸掉第一下
// 可闪开拉开. So right after a 卸势 seen to work (a fresh diamond or a 真气 step, not one left from before), one dodge
// away (no hit-stun then, so it comes out at once)
const OK_ESCAPE_MS = 1200; // at most one per this long
const FAIL_ESCAPE_MS = 250;
const TTC_TICK_MS = 30; // ttcTick() between screenshots: one of its own when the last is this old
const TTC_FRESH_MS = 70; // a p older than this is not acted on
// defend + punish: 衰弱期 (真气 empty) all out. Round 27 (20261010-222904, the first one seen): 真气 0 from frame
// 6482, 处决 showed at the diamond's place 6488 and was tapped (boss bar 383 → 324, -15%), its scene 6497–6530; the
// boss glowed white and struck nothing until 真气 came back (6596–6626, full in 1 s) and its next blow at ~6684:
// ~2 s to hit after the 处决 scene. 横刀 then: 突进, 爆发, 伤害 when they show, else 轻击, until 真气 is back (at most
// PUNISH_MS)
const PUNISH_MS = 6000;
// teacher (2026-10-10, after round 31): 衰弱期 has a countdown; all out, and 处决 only when it is about to run out.
// Not found in the recordings yet (both 处决 were tapped at once: round 27 ~0.3 s, round 31 ~0.2 s after the button
// showed; nothing else on screen counted down), so by time: 衰弱 lasted 3.2 s (round 31, 真气 0 → back) and 3.8 s
// (round 27) from 真气 empty, and the device reads empty 0–1 s early (31: 真气 read 2–3 px from 6874, 0 from 6922). 处决
// is held until EXEC_AFTER_MS after 衰弱 was read; 真气 coming back first lets the plain 处决 tap go at once
const EXEC_AFTER_MS = 2000;
// sched (args.sched): the fight by cooldowns instead of the fixed 20 s 陌刀 part (teacher, 2026-10-10: that wait is
// for 横刀's 爆发 to cool down, and dodges / 卸势 count toward it). Measured on round 31's 横刀 buttons: 爆发 20 s
// (6927 → lit again 7530), 突进 ~12.5 s (6910 → 7285); 陌刀's 增益 / 奇术 by their buttons (cooldowns not measured)
const BURST_CD_MS = 20_000;
// sched window (args.window, default with sched; guides 17173 / 游民 via the teacher, 2026-10-11): 横刀's 爆发 is its
// special skill 飞鸿踏雪 (20 s cooldown, measured): the boss takes +12% for 7 s (胆寒) and our 陌刀 蓄力 charges 50% faster
// (热血难凉); the 突进 → 伤害 button is its two-stage martial skill (stage 2 under 热血难凉 adds 惧刃: 胆寒 → 20%). Then 陌刀:
// its special (增益, 铁衣) and a martial skill (陌刀 突进) into 破阵 (蓄力 +30% for 12 s), and 蓄力 after 蓄力 while
// those last, each one's recovery cut by 卸势 (or a roll). Outside the window no 蓄力 (it is weak there): defence only
// (卸势 / dodges), which also wears 真气 down
const WINDOW_MS = 8000; // 蓄力 for this long from switching to 陌刀 after 横刀 (破阵 12 s from the 陌刀 skill; 胆寒 7 s from 爆发)
const WINDOW_RED_FROM = 1100; // 蓄力 50% faster: red from ~1.5 s
// outside the window (teacher, 2026-10-11): 横刀. 冢上霜 = 轻击 held briefly (under 1 s in practice) and let go: a
// four-hit thrust forward; it refreshes the 重击派生 拨雪寻春 (the diamond at HEAVY, as after a good 卸势): the two in
// turn (args.outside: "tang"; "idle" = defence only). Hold time not measured yet (no long 轻击 in the recordings)
const TANG_HOLD_MS = 700;
const TANG_FOLLOW_MS = 900; // the four hits
const CANCEL_MS = 1000; // a released 蓄力's slashes, then 卸势 cuts the recovery (0.8 s in rounds 48–50: no better)
const RESERVE_QI = 60; // 真气 this low (px of 385): 增益 / 爆发 kept for the 衰弱期
// 衰弱期 plan (weakPlan; teacher: the damage is a buffed 陌刀 蓄力, as many buffs as the time allows, the 蓄力
// always, 处决 last). Its length without 处决 is not known: 3.2 / 3.8 s 真气 empty → back with 处决 at once (31, 27)
// rounds 51, 52 (the first 衰弱期 in the fight): 4.8 / 4.2 s from 衰弱 read to 真气 back; 处决 showed 0–1.4 s after 真气 hit 0
// (one frame: tapped at once) and 衰弱 went on ~3–3.5 s after it (27: 3.5, 31: 1.8, 51: 3.5, 52: 3.0 s); 处决 took 50–62 px
// (13–16%) in two blows ~40 frames apart; the boss struck nothing meanwhile
const WEAK_MS = 4500;
const EXEC_MARGIN_MS = 600; // 处决 this long before the end at the latest
/** @type {Record<string, number>} */ const BUFF_COST_MS = { buff: 700, burst: 900, strike: 700 }; // press + animation, about
const SWITCH_COST_MS = 700;
// the grab (金光, lunge at +15–20, us thrown and down, the stab ~3.97 s after the first hit lands, rounds 28–37: hit2 -
// hit1 108–131 frames, median 119; no prompt on screen, the buttons stay): args.grabEscape tries a dodge GRAB_DODGE_MS
// after a hit seen within GRAB_HIT_MS of a 金光 dodge (the device sees hits ~10 frames late)
const GRAB_HIT_MS = 1500;
const GRAB_DODGE_MS = 3300;
// dodges (teacher, explore 0145: a dodge costs stamina, the gold arc left of the character; one that worked needs no
// more): after the first one of a 金光, more only when hit meanwhile, within SMART_DODGE_MS
const SMART_DODGE_MS = 1000;
/** @type {Box} */ const STAMINA_ROI = [335, 390, 35, 60];
const STAMINA_FULL_PX = 44;
const STAMINA_KEEP = 0.35; // below: no extra dodges (one is kept for the next 金光)
const MOTION_QUIET_MS = 500; // not this soon after our own dodge / step / 卸势 (the camera moves) // (round 5 had 700–1300: 5 of 113 worked)
const DEFEND_WALK_MS = 600; // walk in this long after a dodge
const DEFEND_STEP_EVERY = 3000; // and this often when not hit for a while
const DEFEND_STEP_MS = 400;
/** @type {Point} */ const HEAVY = [860, 430]; // 重击派生 (the diamond after a good 卸势)
// 卸势 on the boss's wind-up (独夫, practice recording 20261010-182856): the 8 good 卸势 there (the 重击派生 diamond
// came 1–14 frames after the press, and stayed 87–210 frames) were all pressed while the boss was close and moving;
// before its blows the gold of its armour and cape in the middle of the screen grows (it closes in, raises the
// glaive). Gold here ≥ CUE_GOLD px and ≥ CUE_RISE times what the last look saw (≤ 250 ms before): a 卸势, at most
// every CUE_MS. On that recording such a rule fired 33 times a minute and came 7–21 frames before 27 of the 52 blows
// (52%; chance at that rate 24%); blind 卸势 there worked 5 times in 113, after a hit 3 in 36
// the boss's 真气: the light blue line under its health bar (teacher; explore 0042: H 98, S ~68, V ~200, rows 36–39,
// 385 px full). Each good 卸势 took 10–25 px in the practice recording (385 → 227 over 8; it did not come back);
// empty, the boss is weakened (衰弱期): all out then, no 卸势. Empty was never seen yet: how long 衰弱 lasts is not
// known, it lasts while the line reads empty (QI_EMPTY px or less) with the health bar there
/** @type {Box} */ const QI_ROI = [347, 35, 386, 6];
const QI_HSV = { lower: [88, 30, 150], upper: [108, 130, 255], method: 40 };
const QI_EMPTY = 4;
const QI_MS = 300; // read this often
const QI_STEP = 8; // a 卸势 that took this much 真气 worked (陌刀)
const ESCAPE_MS = 1200; // one escape per combo at most
/** @type {Point} */ const FORWARD = [175, 569 - 83]; // a dodge through the boss (dodgeDir "forward")
/** @type {Box} */ const PULL_ROI = [0, 60, 1080, 560];
const PULL_HSV = { lower: [[0, 150, 150], [172, 150, 150]], upper: [[6, 255, 255], [180, 255, 255]], method: 40 };
const PULL_RED = 8000; // px (median 6 in round 9, 95th percentile 3500)
const PULL_MS = 2500;
const ESCAPE_DODGES = 2;
/** @type {Box} */ const CUE_ROI = [250, 120, 580, 440];
const CUE_GOLD_HSV = { lower: [15, 80, 100], upper: [35, 255, 255], method: 40 };
const CUE_GOLD = 11000;
const CUE_RISE = 1.3;
const CUE_MS = 500;
const PARRY_OK_MS = 1500; // a 卸势 is looked at for the diamond this long
const RED_EVERY = 200; // 红光 looked for this often (that look skips 起幕布)
// 金光 seen: dodge this much later. Was 230 (round 19: 200–260 ms took nothing back or left); rounds 16–24 offline
// (data/tmp/dufu_moves): the grab (拉人倒地被刺, 12–14 of ~25 金光) lunges in on frame 12–14 after the flare's first,
// and with 0 ms our dodge shows on frame 8–10, with 230 ms on 15–21: too late for it. So 0 (defend tries 0 / 50)
// rounds 28–37 (174 金光 with a dodge, frame of its first press from the flare's first frame, glow-aligned): +3–8 hit
// after 52% (4.4% lost on average), +9–11 45% (2.9%); the grab (拉人倒地被刺) caught us with the dodge at +4–9 in 30 of
// 34 cases (its lunge lands +15–20: a dodge that early is over by then). So a little later: 80 ms (~+9–11)
const FLARE_DELAY = 80;
const FLARE_AGAIN_MS = 250; // and the next ones this far apart
// 重伤 (dead): the screen goes grey (S ≤ 30 over ≥ 85% of the scene; ≤ 40% in all fight frames of round 2, 77–100%
// from the first frame of both deaths, 2123 and 3450), the boss bar and the health bar gone. The arena then starts
// over by itself (black 2302–2357, full health at 2358): round 2 fought on into a second life
/** @type {Box} */ const GREY_ROI = [100, 100, 880, 500];
const GREY = { lower: [0, 0, 0], upper: [180, 30, 255], method: 40 };
const DEAD_MS = 400; // looked for this often
const BOSS_FULL = 378; // the boss bar full (383 px), back after a restart
const BOSS_DOWN = 365; // and it had been down to this
// drinking (独夫): a tap while hit or mid-move is lost (round 2: 9 taps, 2 drunk; no cooldown shows on the button):
// stand still, tap every DRINK_TAP_MS until the health goes up (32% → 89% took 1 s), for DRINK_MS at most
const DRINK_TAP_MS = 900;
// round 3: 3 of 6 drinks came 3–4 s after the first tap, after giving up at 3 s (counted as not drunk: 6 drunk with a
// limit of 3); a rise up to DRINK_LATE_MS after giving up still counts
const DRINK_MS = 5000;
// (round 10: 8 s after giving up it never tapped again and died at 7–24%: 3 s, and never below DRINK_URGENT)
const DRINK_LATE_MS = 3000;
const DRINK_URGENT = 0.3;
const POTION_CD_MS = 18_000;
const POTION_RISE = 0.2; // a drink: the health this far above its low of the last RISE_MS (they gave 45–57%)
const RISE_MS = 4000;
const RISE_READS = 3;
const DRINK_GAP_MS = 5000; // one drink counted per this long (one fills over ~1.5 s)
// closeIn: before the 横刀 part and before each 蓄力 hold, the boss not hurt this long: 突进 (陌刀) or walk in first
// (round 13: 64 of 139 s striking with no damage, the boss away)
const CLOSE_MS = 1500;
const CLOSE_WALK_MS = 1500;

// combat.js's own match() / color() / sleep() run `tick` first (ttc: the frames-to-contact net wants a screenshot every
// ~30 ms, round 31 had 1545 gaps of 70+ ms in 3924 looks with ticks only at screenshots and seen())
let tick = () => {};
const globalMatch = globalThis.match, globalColor = globalThis.color, globalSleep = globalThis.sleep;
/** @type {typeof globalMatch} */
// @ts-ignore
const match = (t, o) => (tick(), globalMatch(t, o));
/** @type {typeof globalColor} */
const color = (o) => (tick(), globalColor(o));
/** sleep, ticking every ~30 ms. @param {number} ms */
const sleep = (ms) => {
    const end = Date.now() + ms;
    for (;;) {
        tick();
        const left = end - Date.now();
        if (left <= 0) return;
        globalSleep(Math.min(left, 25));
    }
};

function tap(p, ms = 50) {
    touch.down(p, 1);
    sleep(ms);
    touch.up(1);
}

class Over extends Error {}

/** The character's health 0–1 on this screenshot, or null when the bar cannot be read. @param {Image} image */
export function health(image) {
    const read = (c) => {
        const hit = color({ ...c, image, roi: HP_ROI, count: 5, connected: true });
        if (!hit.hit) return null;
        const boxes = hit.results.map((m) => m.box).sort((a, b) => a[0] - b[0]);
        if (boxes[0][0] > HP_LEFT + 8) return null;
        // the run from the left end, gaps up to HP_GAP (the tick in the bar): a bright background behind the empty
        // part read as more (独夫 round 4: 100% for 7 frames at 54%, a drink counted that never was; 7 such in that
        // fight, none read this way)
        let right = boxes[0][0] + boxes[0][2];
        for (const [x, , w] of boxes.slice(1)) {
            if (x - right > HP_GAP) break;
            right = Math.max(right, x + w);
        }
        if (right - HP_LEFT < 4) return null; // only the left end: covered (a red screen read as 0% four times, run 10)
        return Math.max(0, Math.min(1, (right - HP_LEFT) / (HP_FULL - HP_LEFT)));
    };
    const grey = read(HP_GREY);
    if (grey != null) return grey;
    const red = read(HP_RED); // low: the bar is red
    return red != null && red <= HP_RED_MAX ? red : null;
}

/**
 * @param {{hp?: number, idleMs?: number, calmMs?: number, ms?: number, within?: number, probe?: boolean,
 *   dodge?: boolean, boss?: boolean, foe?: string, potions?: number, parryHits?: boolean, red?: boolean,
 *   curtain?: boolean, lunge?: boolean, defend?: boolean, dodgeDir?: string, cue?: boolean, escape?: boolean, pull?: boolean, flareDelay?: number, closeIn?: boolean, motion?: boolean, blind?: boolean, motionDelays?: number[], weapon?: string, flareDelays?: number[], motionTh?: number, chargeSafeP?: number, ttcFar?: number, hitParryMs?: number[], flare2?: boolean, curtainDodge?: boolean, ttcInput?: InferOptions, ttcHold?: number, reparryMs?: number, okEscape?: boolean, okEscapeDir?: string, failEscape?: boolean, chargeOkWait?: number, window?: boolean, windowMs?: number, outside?: string, tangHoldMs?: number, tangHeavy?: string, qishuParryMs?: number, grabEscape?: boolean, grabDodgeMs?: number, yolo?: boolean | string, yoloTh?: number, yoloDelay?: number, punish?: boolean, execAfter?: number, sched?: boolean, weakMs?: number, weakBuffs?: string[], weakPlan?: boolean, execLate?: boolean, smartDodge?: boolean, ttc?: boolean | string, ttcBins?: number[], ttcTh?: number}} [args]  probe: only report what is seen; dodge: false leaves 金光 alone;
 *   boss: a boss fight (over when its bar is gone and the icons are back); foe: "dufu" (独夫: no burst / sky
 *   警戒, its flare for 金光, the rest below on but parryHits; over when dead); potions: drinks at most (独夫 3); parryHits: 卸势 the blow after
 *   a plain hit; red: 红光 → 卸势; curtain: 起幕布 → into the gap; lunge: 陌刀 突进 to close in
 *   defend: practice, no blows, only 卸势 at varied times and dodges, every press marked with its time;
 *   dodgeDir: back | side | cycle, the way 金光 dodges go (defend: cycle); cue: 卸势 on the boss's wind-up (独夫);
 *   escape: hit, dodge sideways out of the rest of the combo (独夫, off); pull: after a 金光 dodge, the red stab
 *   seen, dodge again sideways (独夫, on); closeIn: before 横刀 / 蓄力 with the boss unhurt 1.5 s, 突进 or walk in; flareDelay: ms from a 金光 to its dodge (独夫 0); dodgeDir also forward
 */
export default function (args = {}) {
    const dufu = args.foe === "dufu";
    const hpMin = args.hp ?? 0.5;
    const idleMs = args.idleMs ?? 4000;
    const dodgeOn = args.dodge ?? true;
    const tells = args.boss && !dufu; // the orange burst and the look at the sky (镇关吼's)
    const maxDrinks = args.potions ?? (dufu ? 3 : Infinity);
    const parryHitsOn = args.parryHits ?? false; // round 2: no fewer hits after it (12 of 20 hit again within 1 s; 26 of 48 without)
    const redOn = args.red ?? dufu;
    const curtainOn = args.curtain ?? dufu;
    const defendOn = !!args.defend; // practice: no blows, only 卸势 / dodges, every press marked
    const lungeOn = args.lunge ?? (dufu && !defendOn);
    // which way a 金光 dodge goes: back, side (left / right in turn), cycle (back, left, right in turn)
    // round 19 (defend): 金光 dodged back or left at 200–260 ms took nothing (4 of 4), right ones 8–12% (3 of 3)
    // (round 20: 230 ms back 3 hit in 10, left 5 in 10: back only)
    // 独夫: sideways (guides: 金光 cannot be 卸势'd, dodge late and to the side; the grab too), else back
    const dodgeDir = args.dodgeDir ?? (dufu ? "side" : "back");
    // 卸势 on the boss's wind-up (gold growing): practice only by default (round 6 with it: 24% of the boss in 125 s,
    // against 41% in 73 s and 73% in 176 s without; one 卸势 seen to work)
    // defend: 卸势 on the scene moving (the boss winding up), not on its gold growing
    const motionOn = args.motion ?? (defendOn || !!args.ttc);
    const motionFight = motionOn && !defendOn; // the fight with motion 卸势 between blows
    const cueOn = args.cue ?? (defendOn && !motionOn);
    const blindOn = args.blind ?? !motionOn; // defend: blind 卸势 now and then
    const motionTh = args.motionTh ?? MOTION_TH;
    // ms from the cue to the 卸势, in turn (round 19: 0 / 100 / 200 worked 7/13, 6/11, 7/12: no difference)
    /** @type {number[]} */ const motionDelays = args.motionDelays ?? [100];
    const defendWeapon = args.weapon ?? "hengdao"; // defend holds this weapon (横刀: a good 卸势 shows the diamond)
    const closeOn = args.closeIn ?? false; // before 横刀 / 蓄力, the boss not hurt for CLOSE_MS: close in first
    const pullOn = args.pull ?? (dufu && !defendOn); // 金光 then the red stab: dodge again (pullGuard)
    const flareDelay = args.flareDelay ?? FLARE_DELAY; // ms from seeing a 金光 to the dodge (独夫)
    // defend: in turn (round 16: 0 ms hit 4 of 6, 130 ms 1 of 4, 260 ms 1 of 3)
    /** @type {number[]} */ const flareDelays = args.flareDelays ?? [80, 130];
    // hit: dodge out of the rest of the combo at once (dufu): half of all the damage in rounds 3, 4, 6 and 7 came from
    // blows 8–40 frames after another one landed
    // round 8 with it on: 25 escapes, pressed ~10 frames after the hit, hit again within 40 frames after 14 of them
    // (as often as without), and the boss lost 50% in 161 s against 70% in 134 s: off
    const escapeOn = args.escape ?? false;
    // yolo: true (or a model path under model/classify/): 卸势 on the wind-up classifier instead of the scene moving
    // (defend, where motion is on); yoloTh: p(windup) to press at; yoloDelay: ms from seeing it to the 卸势
    const yoloModel = args.yolo === true ? YOLO_MODEL : args.yolo || null;
    const yoloTh = args.yoloTh ?? YOLO_TH;
    const yoloDelay = args.yoloDelay ?? 0;
    // ttc: true (or a model path under model/): 卸势 on the frames-to-contact net (defend; over yolo); ttcBins: the bins
    // whose p adds up, ttcTh: the sum to press at
    const ttcModel = args.ttc === true ? TTC_MODEL : args.ttc || null;
    const ttcBins = args.ttcBins ?? TTC_BINS;
    const ttcTh = args.ttcTh ?? TTC_TH;
    let ttcLooks = 0, ttcReady = 0, ttcMs = 0;
    let ttcSeq = -1; // the frame ttcTick() last ran on
    let ttcAt = 0; // when
    let ttcGaps = 0; // ticks more than 70 ms after the last one (not ready then)
    /** @type {number | null} */ let ttcP = null; // the highest p(ttcBins) since windupNow() last read it
    let ttcPAt = 0;
    let ttcLastP = /** @type {number | null} */ (null); // the latest p(ttcBins), not consumed
    /** @type {number[] | null} */ let ttcProbs = null; // the latest probs (all bins)
    let ttcHoldSince = 0; // a press held back since (the far bin leading)
    /** @type {Record<string, number>} */ const ttcBlocked = {}; // ttc over its threshold but no 卸势: why (looks)
    let ttcBlockMarkAt = 0;
    const ttcHold = args.ttcHold ?? TTC_HOLD_MS;
    const ttcFar = args.ttcFar ?? 0; // 0 = off; e.g. 0.12
    /** @type {number[]} */ const hitDelays = args.hitParryMs ?? DEFEND_HIT_DELAYS; // defend: 卸势 after a hit, ms, in turn
    // a ttc model with another input (data/tmp/dufu_yolo/train_var.py): its infer() options over TTC_OPTS, e.g.
    // { roi: [120, 0, 840, 720], size: [112, 96] } or { frames: [-14, -12, ..., 0] } or { size: 128, color: "rgb" }
    /** @type {InferOptions} */ const ttcInput = args.ttcInput ?? {};
    const reparryMs = args.reparryMs ?? REPARRY_MS; // 0: no early second 卸势
    // rounds 85–87 with it: 10.3 hits a minute (81–83: 11.2), and after the 16 escapes of round 87 only 2 hits within 40
    // frames (29% after a good 卸势 without): on by default in defend
    const okEscape = args.okEscape ?? defendOn; // defend: dodge away right after a good 卸势
    // failEscape (off): a ttc 卸势 with no sign of working FAIL_ESCAPE_MS after it while ttc still says a blow is near:
    // dodge (rounds 85–87: 66 of 233 failed ttc 卸势 were hit within 30 frames, 20 of them 12–17 frames after the press)
    // (rounds 88–90 with it: 7.8 hits a minute against 10.3, 没覆盖 4.2 → 2.1, lives 303–406 s: on by default in defend)
    const failEscape = args.failEscape ?? defendOn;
    let failEscapes = 0;
    const okEscapeDir = args.okEscapeDir ?? "back";
    let diamondAtTap = false;
    let okEscapeAt = 0;
    let okEscapes = 0;
    let qijieOn = false; // the 「气竭」 banner showing
    let qijieAt = 0;
    let ttcLastAt = 0;
    const punishOn = args.punish ?? false; // defend: all out in 衰弱期 (处决 is tapped in any mode)
    const execAfter = args.execAfter ?? EXEC_AFTER_MS; // punish without plan: 处决 this long after 衰弱 was read
    const schedOn = args.sched ?? false; // the fight by cooldowns (schedRound), 衰弱期 by plan
    const weakMs = args.weakMs ?? WEAK_MS; // the 衰弱期 plan's length
    /** @type {string[]} */ const weakBuffs = args.weakBuffs ?? ["buff", "burst", "strike"]; // in this order, as time allows (唤千军 first: no switch from 陌刀)
    const planOn = args.weakPlan ?? schedOn; // 衰弱期: buffs + 陌刀 蓄力 + 处决 (else punish: 横刀 all out)
    const smartDodge = args.smartDodge ?? dufu;
    // rounds 97–99 with flare2 + curtainDodge: 金光 2.1 → 1.7 hits a minute; 9 起幕布 took 4 hits (0.4 each; ~2.2 each in
    // rounds 63–80): both on by default (独夫)
    const flare2 = args.flare2 ?? dufu;
    // curtainDodge (args.curtainDodge; teacher: no time to reach the gap, dodge the moment the curtain reaches you): no
    // walking to the gap, a dodge whenever a curtain side comes within CURTAIN_HIT_PX of us or we are covered; a curtain
    // is taken when seen CURTAIN_CONFIRM times within CURTAIN_CONFIRM_MS (the fire-wall one of round 93, 7306–7480, was
    // seen on and off, never 3 looks in a row)
    const curtainDodge = args.curtainDodge ?? dufu;
    const grabEscape = args.grabEscape ?? false;
    const grabDodgeMs = args.grabDodgeMs ?? GRAB_DODGE_MS;
    let flareDodgeAt = 0; // a 金光 dodge went
    let grabDodgeAt = 0; // grabEscape: dodge then
    const chargeSafeP = args.chargeSafeP ?? CHARGE_SAFE_P;
    const chargeOkWait = args.chargeOkWait ?? CHARGE_OK_WAIT_MS;
    const windowOn = args.window ?? true; // sched: 蓄力 in the buff window only (see WINDOW_MS)
    const windowMs = args.windowMs ?? WINDOW_MS;
    // sched window: between windows "idle" (defence only, default) or "tang" (横刀 冢上霜 / 拨雪寻春: rounds 57–62 no better,
    // and the 重击 after it took 0 px; kept as an option until the teacher's demo)
    const outsideMode = args.outside ?? "idle";
    const tangHoldMs = args.tangHoldMs ?? TANG_HOLD_MS;
    let tangs = 0, tangHeavies = 0;
    // 奇术 (箫吟千浪): its recovery cut by 卸势 this long after the tap (teacher: ~1.5 s may do; it was 2 s); cast only in
    // a quiet moment, else later (teacher: hit a lot while casting it)
    // 1.5 s (rounds 38–41) took 7.4% of our health per cast in the 3 s after it, 2 s (33–37) 4.3%: back to 2 s
    const qishuParryMs = args.qishuParryMs ?? 2000;
    let burstAt = 0; // 横刀 爆发 went out
    let inWindow = false; // sched window: the 横刀 part and the 蓄力 after it
    let execHold = false; // punish: 处决 seen is not tapped yet
    if (ttcModel) tick = () => ttcTick();
    const start = Date.now();
    /** @type {[number, number, string, string][]} */ const events = []; // [epoch ms, ms since start, kind, detail]
    const until = start + (args.ms ?? 300_000);
    let lastFoe = start;
    let fought = false; // the top right icons have been hidden
    let calmSince = 0; // since when they are back
    let lastPotion = 0;
    let lastLock = 0;
    let lastExecute = 0;
    let lows = 0;
    let lastBar = start; // an enemy health bar was on screen
    let lastTurn = 0;
    let lastDodge = 0;
    let foeHp = null; // enemy health (px of bar) last read
    let lastHit = start; // when it last went down
    let bossSeen = 0; // when the boss bar last showed
    let walking = false; // walking in at full push
    let charging = false; // 蓄力 held (creeping forward)
    let slashUntil = 0; // a released 蓄力's slash still coming
    let stillUntil = 0; // no walking until then (a skill going off)
    let stick = 0; // joystick push now, 0–1
    let turns = 0;
    let rounds = 0;
    let potions = 0;
    let executions = 0;
    let dodges = 0;
    let walks = 0;
    let usedUp = false; // the boss's bar used up: blows do nothing, wait for its last move
    let lastCheck = 0; // 金光 looked for; the longest gap between looks is reported
    let maxGap = 0;
    let lastAt = ""; // where the last look for 金光 was
    let skySince = 0; // the camera has looked up at the sky since
    let skyDone = false; // that look up has been guarded
    let downAt = 0; // 重伤 last looked for
    let lastOrange = 0; // orange px the last look saw
    let ownFxUntil = 0; // our own skill's gold effect on screen until then
    let alerts = 0;
    let calm = false; // the top right icons show (out of a fight), as of calmAt
    let calmAt = 0;
    let drinks = 0; // potions that took (the health went up after the tap)
    /** @type {number | null} */ let tapHp = null; // health at the last potion tap, until it took or POTION_TOOK_MS passed
    /** @type {number | null} */ let lastHp = null; // health last read
    let hitAt = 0; // a plain blow last seen landing (health down at once)
    let lastParry = 0;
    let lastRed = 0;
    let parries = 0;
    let curtains = 0;
    let curtainAt = 0; // looked for last
    let redAt = 0; // 红光 looked for last
    let deadAt = 0; // the grey screen of 重伤 looked for last
    let deadSeen = 0; // looks in a row that saw it
    let drinking = false;
    let guarding = false; // in 起幕布
    let lateFrom = 0; // a drink given up on then, may still come
    let lateHp = 0; // health then
    let lateUp = 0; // reads in a row above it
    /** @type {[number, number][]} */ let riseLows = []; // [ms, health] of the last RISE_MS
    let riseUp = 0;
    let drinkCountedAt = 0;
    let closeIns = 0;
    let lastLunge = 0;
    let lastHitTaken = 0; // health last went down at once
    let parryTapAt = 0; // 卸势 last tapped (any reason)
    let parryWhy = "";
    let parryOkSeen = 0; // that 卸势 was seen to work
    let parriesOk = 0;
    let pulls = 0;
    let lastMotionParry = 0;
    let motionMax = 0;
    let windupSeq = -1; // the frame the classifier last looked at
    let motionAt2 = 0;
    /** @type {{seq: number, time: number, cells: number[]} | null} */ let motionPrev = null;
    let motionLogAt = 0;
    let lastStepAt = 0;
    let motionParries = 0;
    let redBurstAt = 0; // looked for last
    let lastRedBurst = 0;
    let escapedHit = 0; // the hit last escaped from
    let lastEscape = 0;
    let escapes = 0;
    let qiAtTap = -1; // 真气 when the last 卸势 was tapped
    let bossLow = Infinity; // the boss bar's lowest reading (the restart check)
    let qi = -1; // the boss's 真气 px, as last read (-1: not yet)
    let qiAt = 0;
    let qiLogged = -100;
    let weak = false; // 衰弱期: 真气 empty
    let weakSince = 0;
    let weakEmpties = 0; // reads in a row at empty
    let weaks = 0;
    let cueGold = 0; // gold px the last look saw, and when
    let cueAt = 0;
    let lastCue = 0;
    let cues = 0;
    let heavies = 0;
    let flashes = 0; // 金光 dodged (for the way the next goes)
    let lunges = 0;
    let img = screenshot();

    const seen = (k) => match(T[k][0], { image: img, roi: T[k][1], threshold: THRESHOLD }).hit;

    const hp = () => health(img);

    /** Enemy health bars on the current screenshot: their total length, 0 if none. */
    function bars() {
        const hit = color({ ...BAR, image: img, roi: BAR_ROI, count: 25, connected: true });
        if (!hit.hit) return 0;
        return hit.results
            .filter(({ box: [, , w, h], count }) => w >= 25 && h <= 3 && (count ?? 0) >= 0.7 * w * h)
            .reduce((s, { box: [, , w] }) => s + w, 0);
    }

    /** The boss bar: px of red left, 0 when used up (pale left end), null when there is none. */
    function boss() {
        const red = color({ ...BOSS_RED, image: img, roi: BOSS_ROI, count: 10, connected: true });
        if (red.hit && Math.min(...red.results.map(({ box: [x] }) => x)) <= BOSS_ROI[0] + 2)
            return Math.max(...red.results.map(({ box: [x, , w] }) => x + w)) - BOSS_ROI[0];
        if (color({ ...BOSS_LAST, image: img, roi: BOSS_LAST_ROI, count: 48 }).hit) return 0;
        return null;
    }

    /** Hold the joystick forward (locked on, that is toward the enemy), or let go. */
    /** Push the joystick forward this much (0–1); 0 lets go. */
    function stride(v) {
        if (v === stick) return;
        if (v === 0) touch.up(0);
        else {
            if (stick === 0) touch.down(STICK, 0);
            touch.move([STICK[0], Math.round(STICK[1] - STICK_R * v)], 0);
        }
        stick = v;
    }

    /**
     * Walk in (locked on, that is toward the enemy), or not. While 蓄力 is held the joystick is pushed half way
     * anyway (teacher, 2026-10-10: the first 蓄力 usually hits air; creeping forward while charging does no harm, and
     * locked on, forward turns into circling the boss once close).
     */
    function walk(on) {
        if (Date.now() < stillUntil) on = false; // a skill going off: no walking (it cut 突进 short)
        if (on && !walking) {
            log("out of reach: walking in");
            walks++;
            if (lunge()) on = false; // walked on once it is out
        }
        walking = on;
        stride(on ? 1 : charging && Date.now() >= stillUntil ? CREEP : 0);
    }

    /**
     * Far (starting to walk in): 陌刀's 突进 closes in faster than walking (teacher, explore 0030: at the start, or when
     * far). Not while 蓄力 is held, at most every LUNGE_MS (out of reach also reads after every dodge).
     */
    function lunge() {
        const now = Date.now();
        // not before the boss bar shows (rounds 7, 8: tapped while it still stood on its steps)
        if (!lungeOn || charging || (args.boss && !bossSeen) || now - lastLunge < LUNGE_MS || !seen("mdash")) return false;
        if (schedOn && windowOn && !inWindow) return false; // 燃此魂 is kept for the window
        log("far: 突进 in");
        lastLunge = now;
        lunges++;
        stillUntil = Math.max(stillUntil, now + STILL_MS);
        tap(DASH);
        mark("dash", "far");
        return true;
    }

    /**
     * A press, for lining up with the recording (dufu): logged as "@<epoch ms> +<ms since start> kind detail" (the
     * recording's meta.started is epoch ms too: frame = (epoch - started) * 30 / 1000), and returned in events.
     */
    function mark(kind, detail = "") {
        if (!dufu) return;
        const t = Date.now();
        events.push([t, t - start, kind, detail]);
        log(`@${t} +${t - start} ${kind}${detail ? " " + detail : ""}`);
    }

    /** 陌刀's 突进 can be pressed: the icon white (ready), not grey (another skill playing; 镇关吼 3127–3567). */
    function dashLit() {
        return seen("mdash") && color({ ...ICON_WHITE, image: img, roi: MDASH_LIT_ROI, count: DASH_LIT_PX }).hit;
    }

    /**
     * The opening 突进 (teacher, round 4: it was tapped while 奇术 still played, nothing came out): wait for the icon
     * to be white again, tap, and count it out once the icon has gone grey or changed (GLOW_MS later still); a second
     * tap if not. What the icon does after a 突进 is not in any recording yet: the log says which it was.
     */
    function openLunge() {
        if (!waitFor(() => { look(); return dashLit(); }, { timeout: OPEN_WAIT_MS, interval: 10 })) {
            log("opening 突进: the icon never lit");
            return;
        }
        for (let i = 0; i < 2; i++) {
            stillUntil = Math.max(stillUntil, Date.now() + STILL_MS);
            walk(false);
            tap(DASH);
            mark("dash", `opening ${i + 1}`);
            lastLunge = Date.now();
            lunges++;
            if (waitFor(() => { look(); return !dashLit(); }, { timeout: 700, interval: 10 })) {
                watch(GLOW_MS);
                look();
                if (!dashLit()) {
                    log(`opening 突进 out after ${i + 1} taps`);
                    // its second part (teacher, round 6): there, tapped again, it cuts the boss
                    watch(DASH2_MS);
                    look();
                    tap(DASH);
                    mark("dash", "opening, second part");
                    return;
                }
            }
        }
        log("opening 突进: the icon stayed lit after 2 taps");
    }

    /** Let go of a held 蓄力 and of the joystick. */
    function letGo() {
        touch.up(1);
        charging = false;
        walk(false);
    }

    /** Note how long since the last look for 金光; a long one is logged with where it came from and went to. */
    function gap(now) {
        const at = (new Error().stack ?? "").split(String.fromCharCode(10)).slice(2, 4).map((l) => l.trim().replace(/^at /, "")).join(" < ");
        if (lastCheck) {
            const ms = now - lastCheck;
            maxGap = Math.max(maxGap, ms);
            if (args.boss && !defendOn && ms > GAP_LOG_MS) log(`no look for 金光 in ${ms} ms: ${lastAt} → ${at}`);
        }
        lastCheck = now;
        lastAt = at;
    }

    /** A 金光 line on the current screenshot (boss fights: as wide as 2.5 times as high, 1–3 frames sooner). */
    function seeFlash() {
        const hit = color({ ...FLASH, image: img, roi: FLASH_ROI, count: 150, connected: true });
        const ratio = args.boss ? 2.5 : 3.5;
        if (!(hit.hit && hit.results.some(({ box: [, , w, h], count }) => w >= 230 && w >= ratio * h && (count ?? 0) >= 0.15 * w * h))) return false;
        return !dufu || streak(STREAK, 150, 2); // 独夫: the flare's orange streak, not our own gold
    }

    /** A run of colour c over the scene at least minW wide and ratio times as wide as high. */
    function streak(c, minW, ratio) {
        const hit = color({ ...c, image: img, roi: FLASH_ROI, count: 100, connected: true });
        return hit.hit && hit.results.some(({ box: [, , w, h] }) => w >= minW && w >= ratio * h);
    }

    /**
     * 红光 (独夫, args.red): a red streak like the 金光 flare's orange one: 卸势 RED_DELAY after it (teacher: 红光卸势).
     * No recording has one yet, so where in its blow the 卸势 has to come is a guess.
     */
    function red() {
        const now = Date.now();
        if (!redOn || weak || now - lastRed < RED_MS) return false;
        redAt = now;
        if (!streak(RED, 150, 3)) return false;
        log("红光: 卸势");
        lastRed = now;
        letGo();
        if (watchFor(RED_DELAY)) return true; // a 金光 meanwhile: dodged instead
        parryTap("红光");
        lastParry = Date.now();
        parries++;
        lastCheck = Date.now();
        lastAt = "a 卸势";
        return true;
    }

    /**
     * The 独夫 checks besides 金光, at most one a look (round 2: with both on every look, a look took 150–267 ms):
     * 红光 every RED_EVERY, else 起幕布.
     */
    function extra() {
        const now = Date.now();
        // a 蓄力 held or its slash coming (a big red arc of our own): only 金光 may cut it (teacher); 起幕布 still
        if (charging || now < slashUntil) return curtainOn && now - curtainAt >= CURTAIN_EVERY ? curtain() : false;
        if (pullOn && now - redBurstAt >= RED_EVERY) {
            redBurstAt = now;
            if (redBurst()) return true;
        }
        if (redOn && now - redAt >= RED_EVERY) return red();
        if (curtainOn && now - curtainAt >= CURTAIN_EVERY) return curtain();
        return false;
    }

    /** Wait ms looking for 金光 only (dodging it); true if it did. */
    function watchFor(ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            img = shot();
            deadCheck();
            if (flash()) return true;
        }
        return false;
    }

    /**
     * 起幕布 on the current screenshot (独夫): the gap to walk into, [left, right] on screen, or "covered" (curtains
     * all over, no gap in sight), or null when there are none. Curtains: dark (V ≤ 30) runs over the top of the screen,
     * ≥ 100 x 100 and half filled, with a glowing orange edge (≥ 120 high, ≤ 30 wide) by one of their sides; the gap:
     * the clear run between two of them nearest the character, else the clear run at a screen side.
     */
    function curtainGap() {
        // the edges first: in 113 frames of the first fight, the dark parts in 77% of them
        const edges = color({ ...EDGE, image: img, roi: EDGE_ROI, count: 300, connected: true }).results
            .filter(({ box: [, , w, h], count }) => h >= EDGE_H && w <= 30 && (count ?? 0) >= 2.5 * h).map((m) => m.box);
        if (!edges.length) return null;
        const dark = color({ ...CURTAIN_DARK, image: img, roi: CURTAIN_ROI, count: 5000, connected: true });
        if (!dark.hit) return null;
        const panels = dark.results.map((m) => m.box).filter((b, i) => b[2] >= 100 && b[3] >= 100 && (dark.results[i].count ?? 0) >= 0.5 * b[2] * b[3]);
        if (!panels.length) return null;
        const sides = panels.flatMap(([x, , w]) => [x, x + w]);
        if (!edges.some(([x, , w]) => sides.some((s) => Math.abs(x + w / 2 - s) <= 40))) return null;
        const spans = panels.map(([x, , w]) => [x, x + w]).sort((a, b) => a[0] - b[0]);
        /** @type {[number, number][]} */ const free = [];
        let at = 0;
        for (const [a, b] of spans) {
            if (a - at >= 40) free.push([at, a]);
            at = Math.max(at, b);
        }
        if (1080 - at >= 40) free.push([at, 1080]);
        const inner = free.filter(([a, b]) => a > 0 && b < 1080);
        const cands = inner.length ? inner : free;
        if (!cands.length) return "covered";
        const off = ([a, b]) => (a <= ME_X && ME_X <= b ? 0 : Math.min(Math.abs(a - ME_X), Math.abs(b - ME_X)));
        return cands.reduce((p, q) => (off(q) < off(p) ? q : p));
    }

    /**
     * 起幕布 (独夫, args.curtain): seen once, at once let go of everything and push the joystick sideways
     * toward the gap's middle (the camera stays on the boss, locked on), standing still once in it; when the curtains
     * have gone by (two looks without them) and the character was not in the gap, dodge (the flames burst 10–12
     * frames after they pass). Over when none have been seen for CURTAIN_GONE_MS (they come three times).
     */
    let curtainSeenN = 0; // looks in a row the curtain was seen on (not confirmed yet)
    /** @type {number[]} */ let curtainSeen = []; // curtainDodge: when it was seen lately
    let curtainDodgeAt = 0;
    let curtainFirstAt = 0;
    function curtain() {
        if (!curtainOn || !args.boss || usedUp) return false;
        const t = Date.now();
        if (t - curtainAt < CURTAIN_EVERY) return false;
        curtainAt = t;
        if (!curtainGap()) {
            if (!curtainDodge) curtainSeenN = 0;
            return false;
        }
        if (curtainDodge) {
            curtainSeen.push(t);
            while (curtainSeen.length && t - curtainSeen[0] > CURTAIN_CONFIRM_MS) curtainSeen.shift();
            if (curtainSeen.length === 1) curtainFirstAt = t;
            else curtainFirstAt = curtainSeen[0];
            if (curtainSeen.length < CURTAIN_CONFIRM) return false;
            curtainSeen = [];
        } else {
            if (++curtainSeenN === 1) curtainFirstAt = t;
            if (curtainSeenN < CURTAIN_CONFIRM) return false; // not sure yet: the fight goes on (卸势 too)
            curtainSeenN = 0;
        }
        // at once (teacher, round 3: the first sweep burned it, busy attacking): not seen again on the next two
        // looks, a misread, back to the fight
        log("起幕布: into the gap");
        mark("curtain", "start");
        curtains++;
        letGo();
        guarding = true;
        const t0 = Date.now();
        let lastSeen = t0;
        let seenN = 1;
        let misses = 0;
        let inGap = false;
        let firstDodged = false;
        let push = 0; // sideways, -1..1
        const dx0 = (a, b) => (a + b) / 2 - ME_X;
        const side = (v) => {
            if (v === push) return;
            if (v === 0) touch.up(0);
            else {
                if (push === 0) touch.down(STICK, 0);
                touch.move([Math.round(STICK[0] + STICK_R * v), STICK[1]], 0);
            }
            push = v;
        };
        while (Date.now() - t0 < CURTAIN_MS) {
            img = shot();
            const now = Date.now();
            gap(now);
            deadCheck();
            heal();
            const g = curtainGap();
            if (!g) {
                if (++misses === 2 && seenN < 2) {
                    log("起幕布: not seen again, back to the fight");
                    curtains--;
                    break;
                }
                if (misses === 2 && seenN >= 3 && !inGap && now - lastSeen < 600) {
                    log("起幕布: went by out of the gap, dodging");
                    side(0);
                    dodge(2);
                }
                if (now - lastSeen > CURTAIN_GONE_MS) break;
                continue;
            }
            misses = 0;
            lastSeen = now;
            seenN++;
            if (g === "covered") {
                inGap = false;
                if (curtainDodge && now - curtainDodgeAt > CURTAIN_DODGE_GAP_MS) {
                    firstDodged = true;
                    curtainDodgeAt = now;
                    dodge(1, FLARE_AGAIN_MS, "back", "幕布 covering us");
                    continue;
                }
                if (!firstDodged && now - curtainFirstAt >= CURTAIN_FIRST_DODGE_MS) {
                    firstDodged = true;
                    side(0);
                    dodge(1, FLARE_AGAIN_MS, "back", "幕布 first sweep (covered)");
                }
                continue; // keep going the way it was
            }
            const [a, b] = g;
            inGap = a - GAP_IN <= ME_X && ME_X <= b + GAP_IN;
            if (curtainDodge) { // no walking to the gap: dodge when a side reaches us
                const near = Math.min(Math.abs(a - ME_X), Math.abs(b - ME_X)) <= CURTAIN_HIT_PX;
                if ((near || (!firstDodged && now - curtainFirstAt >= CURTAIN_FIRST_DODGE_MS && !inGap)) &&
                    now - curtainDodgeAt > CURTAIN_DODGE_GAP_MS) {
                    firstDodged = true;
                    curtainDodgeAt = now;
                    dodge(1, FLARE_AGAIN_MS, "back", near ? "幕布 reaching us" : "幕布 first sweep");
                }
                continue;
            }
            if (!firstDodged && now - curtainFirstAt >= CURTAIN_FIRST_DODGE_MS) {
                firstDodged = true;
                if (!inGap) {
                    log("起幕布: first sweep, not in the gap: dodging");
                    side(0);
                    dodge(1, FLARE_AGAIN_MS, dx0(a, b) < 0 ? "left" : "right", "幕布 first sweep");
                    continue;
                }
            }
            const dx = (a + b) / 2 - ME_X;
            const margin = Math.max(GAP_IN, (b - a) / 4);
            side(Math.abs(dx) <= margin ? 0 : Math.max(-1, Math.min(1, Math.round((dx / GAP_PUSH) * 4) / 4)) || 0);
        }
        side(0);
        guarding = false;
        stick = 0;
        walking = false;
        lastHit = Date.now();
        lastCheck = Date.now();
        lastAt = "起幕布";
        log(`起幕布 over after ${Date.now() - t0} ms`);
        return true;
    }

    /**
     * Dodge now, backwards (the joystick pulled back with it), and again every DODGE_AGAIN_MS: a ground attack lands
     * 4–5 blows from 12 to ~38 frames after its 金光 (research on the five 镇关吼 recordings, 2026-10-10); two dodges
     * left the blows at +34 and +44 to land (run 6), so after a 金光 FLASH_DODGES of them.
     */
    function dodge(times = 2, again = DODGE_AGAIN_MS, dir = "back", why = "") {
        letGo(); // a held 蓄力
        touch.down(STICK, 0);
        touch.move(dir === "left" ? LEFT : dir === "right" ? RIGHT : dir === "forward" ? FORWARD : BACKWARD, 0);
        const smart = smartDodge && why.startsWith("金光");
        // flare2 (args.flare2): the second 金光 dodge goes whatever happened (the grab lunges at +15–20, after the first
        // one is over; the hit that would make smartDodge go again is seen too late, ~+25–30)
        const firstSmart = flare2 && why.startsWith("金光") ? 2 : 1;
        let h0 = smart ? hp() : null;
        let t0 = Date.now();
        for (let i = 0; i < times; i++) {
            if (i >= firstSmart && smart) {
                // one that worked needs no more (teacher): again only when hit since, and stamina left
                let hitSince = false;
                while (Date.now() - t0 < SMART_DODGE_MS) {
                    img = shot();
                    const h = hp();
                    if (h0 != null && h != null && h < h0 - 0.025) {
                        hitSince = true;
                        break;
                    }
                    globalSleep(20);
                }
                const st = stamina();
                if (!hitSince || (st != null && st < STAMINA_KEEP)) {
                    mark("dodge", `stop after ${i} (${hitSince ? "hit" : "not hit"}, stamina ${st == null ? "?" : Math.round(st * 100)})`);
                    break;
                }
                // the next one is judged from here (round 38: against the health before the first, every check after
                // one hit read "hit" and it dodged 4 more times in 0.2 s)
                h0 = hp();
                t0 = Date.now();
            } else if (i) sleep(again);
            touch.down(DODGE, 2);
            sleep(50);
            touch.up(2);
            mark("dodge", `${dir} ${i + 1}/${times}${why ? " " + why : ""}`);
        }
        touch.up(0);
        lastDodge = Date.now();
        lastCheck = lastDodge; // the dodging is not a gap
        lastHit = 0; // dodged back, out of reach: walk in again at once
        img = shot();
        heal();
        lastAt = "a dodge";
        dodges++;
    }

    /**
     * 金光 on the current screenshot: dodge, then strike nothing for a while. Out of a 警戒 (below) a dodge comes late:
     * every live one was hit (pressed 3–10 frames after the flash, the blows land from +12; one during a held 蓄力
     * did not come out; 卸势 first only cost 2–3 frames more).
     */
    function flash() {
        const now = Date.now();
        gap(now);
        if (!dodgeOn || now - lastDodge < FLASH_MS) return false;
        if (!seeFlash()) return false;
        log("金光: dodge");
        // 独夫: its blows land +16–26 frames after the flare; our dodges showing at +6–8 were all hit (5 of 5), the
        // ones at +12–13 were not (2 of 2): a moment later, and closer together
        // defend: the delay cycles too (flareDelays; changing every 3 so each meets each way), to learn which works
        const fd = defendOn ? flareDelays[Math.floor(flashes / 3) % flareDelays.length] : flareDelay;
        if (dufu) sleep(fd);
        flareDodgeAt = Date.now();
        dodge(FLASH_DODGES, dufu ? FLARE_AGAIN_MS : DODGE_AGAIN_MS, nextDir(), `金光 +${fd}`);
        const rest = Date.now() + DODGE_REST_MS;
        while (Date.now() < rest) {
            img = shot();
            execute();
        }
        // (a 2.5 s watch for the red stab after each 金光 was here: it looked for nothing else and struck nothing,
        // round 11: 金光 unwatched for 2.4 s; the stab is looked for on every look instead, redBurst())
        lastCheck = Date.now();
        lastAt = "a dodge";
        return true;
    }

    /**
     * The boss winding up (cueOn): its gold in the middle of the screen grown at once since the last look: 卸势
     * (letting go of a held 蓄力 first). Not in 起幕布, while drinking, in the 横刀 part (its gold is ours then), just
     * after a dodge, or while the 重击派生 diamond of the last one is still to be tapped.
     */
    function cue() {
        if (!cueOn || weak) return false;
        const now = Date.now();
        const hit = color({ ...CUE_GOLD_HSV, image: img, roi: CUE_ROI, count: 1 });
        const n = hit.hit ? hit.results[0]?.count ?? 0 : 0;
        const prev = cueGold;
        const fresh = now - cueAt <= 250;
        cueGold = n;
        cueAt = now;
        if (!fresh || n < CUE_GOLD || n < CUE_RISE * Math.max(prev, 1) || now - lastCue < CUE_MS) return false;
        if (guarding || drinking || now < ownFxUntil || stillUntil === Infinity || now - lastDodge < 400) return false;
        if (parryOkSeen && now - parryOkSeen < 3000) return false;
        lastCue = now;
        cues++;
        letGo();
        parryTap(`wind-up (gold ${prev}→${n})`);
        parries++;
        return true;
    }

    /** The boss's 真气 px on the current screenshot: the run from the left end; 0 when empty. */
    function readQi() {
        const hit = color({ ...QI_HSV, image: img, roi: QI_ROI, count: 2, connected: true });
        if (!hit.hit) return 0;
        const boxes = hit.results.map((m) => m.box).sort((a, b) => a[0] - b[0]);
        if (boxes[0][0] > QI_ROI[0] + 6) return 0;
        let right = boxes[0][0] + boxes[0][2];
        for (const [x, , w] of boxes.slice(1)) {
            if (x - right > 8) break;
            right = Math.max(right, x + w);
        }
        return right - QI_ROI[0];
    }

    /**
     * 真气 (dufu, with the boss bar there, b its red px): read every QI_MS; marked when it moves 10 px; empty on two
     * reads in a row is 衰弱 (all out: no 卸势) until it reads more again.
     */
    function qiCheck(b) {
        const now = Date.now();
        if (!dufu || b == null || now - qiAt < QI_MS) return;
        qiAt = now;
        const q = readQi();
        qi = q;
        if (Math.abs(q - qiLogged) >= 10) {
            mark("qi", `${q}`);
            qiLogged = q;
        }
        weakEmpties = q <= QI_EMPTY ? weakEmpties + 1 : 0;
        if (!weak && weakEmpties >= 2) {
            weak = true;
            weakSince = now;
            weaks++;
            log("真气 empty: 衰弱, all out");
            mark("weak", "start");
        } else if (weak && q > QI_EMPTY) {
            weak = false;
            log(`衰弱 over after ${now - weakSince} ms`);
            mark("weak", `end after ${now - weakSince} ms`);
        }
    }

    /**
     * 独夫: dead, the arena then starts over by itself: end here. The grey screen (boss bar and health bar gone,
     * looked at every DEAD_MS), or, missed (round 6: both deaths went by while it was in a drink's loop, which looked
     * for nothing but 金光; the grey lasted 3.7 and 6 s), the restart itself: the boss bar back to full
     * (≥ BOSS_FULL px) and our health full after the bar had been down to ≤ BOSS_DOWN. Called from every loop.
     * @param {number | null | undefined} [b] the boss bar's red px if just read
     */
    function deadCheck(b) {
        if (!dufu) return;
        const now = Date.now();
        if (now - deadAt < DEAD_MS) return;
        deadAt = now;
        if (b === undefined) b = boss();
        if (b != null) {
            bossLow = Math.min(bossLow, b);
            if (b >= BOSS_FULL && bossLow <= BOSS_DOWN && (hp() ?? 0) >= 0.95) {
                log("the arena started over (dead, not seen)");
                throw new Over("dead");
            }
            deadSeen = 0;
            return;
        }
        const grey = color({ ...GREY, image: img, roi: GREY_ROI, count: Math.round(0.85 * GREY_ROI[2] * GREY_ROI[3]) }).hit;
        deadSeen = grey && hp() == null ? deadSeen + 1 : 0;
        if (deadSeen >= 2) throw new Over("dead");
    }

    /**
     * escapeOn: a blow just landed (health down at once): dodge sideways (left and right in turn), twice, before the
     * rest of its combo comes (they came 8–40 frames apart). Not in 起幕布 or while drinking.
     */
    function escape() {
        const now = Date.now();
        if (!escapeOn || !lastHitTaken || lastHitTaken === escapedHit || now - lastHitTaken > 400) return false;
        escapedHit = lastHitTaken;
        if (guarding || drinking || now - lastEscape < ESCAPE_MS || now - lastDodge < 400) return false;
        lastEscape = now;
        escapes++;
        dodge(ESCAPE_DODGES, FLARE_AGAIN_MS, escapes % 2 ? "left" : "right", "hit");
        return true;
    }

    /** Tap 卸势 and watch the looks after it for whether it worked (parryOk). */
    function parryTap(why) {
        diamondAtTap = dufu && seen("parryOk"); // a diamond still up from an earlier one does not count as this one's
        tap(PARRY);
        parryTapAt = Date.now();
        qiAtTap = qi;
        parryWhy = why;
        parryOkSeen = 0;
        mark("parry", why);
    }

    /**
     * Within PARRY_OK_MS of a 卸势: the 重击派生 diamond (or 反击 on the 轻击 button) means it worked: marked
     * "parry ok". In the fight (not defend) the diamond is tapped when there is room for it: not in 起幕布, not
     * drinking, not just after a dodge (teacher: 有空档就点).
     */
    function parryOk() {
        const now = Date.now();
        if (!dufu || !parryTapAt || now - parryTapAt > PARRY_OK_MS) return false;
        const diamond = seen("parryOk");
        // 陌刀: no diamond (teacher: only 横刀 shows 重击派生): the 真气 line down a step after it (good 卸势 took
        // 10–25 px in the practice recording; nothing else took any there)
        const qiStep = !diamond && qiAtTap > 0 && qi >= 0 && qiAtTap - qi >= QI_STEP && now - parryTapAt >= 200;
        if (!diamond && !qiStep && (parryOkSeen || !seen("counter"))) return false;
        if (!parryOkSeen) {
            parryOkSeen = now;
            parriesOk++;
            const how = diamond ? "" : qiStep ? ` (真气 ${qiAtTap}→${qi})` : " (反击 only)";
            mark("parry ok", `${parryWhy}, ${now - parryTapAt} ms after${how}, 真气 ${qi}`);
            const fresh = qiStep || (diamond && !diamondAtTap);
            if (okEscape && defendOn && fresh && !guarding && !drinking && !weak && now - okEscapeAt > OK_ESCAPE_MS) {
                okEscapeAt = now;
                okEscapes++;
                dodge(1, FLARE_AGAIN_MS, okEscapeDir === "side" ? (okEscapes % 2 ? "left" : "right") : okEscapeDir, "卸开后闪开");
                return true;
            }
        }
        if (defendOn || !diamond || guarding || drinking || now - lastDodge < 500) return false;
        tap(HEAVY);
        heavies++;
        mark("heavy", "重击派生");
        parryTapAt = 0;
        return true;
    }

    /**
     * The 金光 that pulls the character in, knocks it down and stabs it (teacher, round 9: never dodged). Which 金光
     * it is could not be told from the flare itself; after it the stab shows as a red crescent / red burst over the
     * screen (≥ PULL_RED px, H ≤ 6 or ≥ 172, S and V ≥ 150; round 9: after 6 of its 11 flares, 7–68 frames on, and
     * those 6 cost 5–17% each, the 5 others 0–14%). Watched for PULL_MS after the dodges: seen, dodge again
     * sideways at once (twice), the other way than the last.
     */
    function pullGuard() {
        const end = Date.now() + PULL_MS;
        while (Date.now() < end) {
            img = shot();
            deadCheck();
            const red = color({ ...PULL_HSV, image: img, roi: PULL_ROI, count: PULL_RED }).hit;
            if (red) {
                pulls++;
                lastRedBurst = Date.now();
                log("金光 then the red stab: dodging again");
                dodge(2, FLARE_AGAIN_MS, pulls % 2 ? "left" : "right", "红刺");
                return;
            }
            heal();
        }
    }

    /**
     * The red stab seen at any time (round 10: the pull and stab at 744–760 came with no 金光 before it): dodge
     * sideways, at most every PULL_MS.
     */
    function redBurst() {
        const now = Date.now();
        if (guarding || now - lastRedBurst < PULL_MS || now - lastDodge < 400) return false;
        if (!color({ ...PULL_HSV, image: img, roi: PULL_ROI, count: PULL_RED }).hit) return false;
        lastRedBurst = now;
        pulls++;
        log("red stab: dodging");
        dodge(2, FLARE_AGAIN_MS, pulls % 2 ? "left" : "right", "红刺");
        return true;
    }

    /** The way the next 金光 dodge goes (args.dodgeDir). */
    function nextDir() {
        const n = flashes++;
        if (dodgeDir === "side") return n % 2 ? "right" : "left";
        if (dodgeDir === "forward") return "forward";
        if (dodgeDir === "backleft") return n % 2 ? "left" : "back";
        if (dodgeDir === "cycle") return ["back", "left", "right"][n % 3];
        return "back";
    }

    /**
     * The boss's orange burst, the tell before a 金光 (research, 2026-10-10): 30–31 frames before a leap-and-slam,
     * 90–99 before a ground attack after a roar; caught before all 13 such flashes in the five recordings (none before
     * the one white flash). Orange (HSV H 10–24, S ≥ 90, V ≥ 110) over the scene, ≥ 1250 px spread at least 200 wide
     * and 200 high from near its top, and twice what the last look saw. It lasts 3–4 frames: run 6 missed two (one
     * 233 wide under the first rule, one between looks 400 ms apart). Over the seven recordings: 17 of 17 tells, 9
     * wrong (~one a fight: 4 s without blows).
     */
    function burst() {
        const hit = color({ ...BURST, image: img, roi: FLASH_ROI, count: 1, connected: false });
        const n = hit.hit ? hit.results[0]?.count ?? 0 : 0;
        const prev = lastOrange;
        lastOrange = n;
        if (Date.now() < ownFxUntil) return false; // our own gold (横刀 爆发's ribbons) reads as a burst (teacher)
        if (n < 1250 || n < 2 * Math.max(prev, 375)) return false;
        const [, y, w, h] = /** @type {Box} */ (hit.results[0].box);
        return y <= 240 && h >= 200 && w >= 200;
    }

    /**
     * 从天而降 (boss fights): the camera looks up at the boss on top of an ice pillar for a while, then its small 金光
     * (1–2 frames) and 19–22 frames later the drop. From the camera looking up to that 金光 took 135–143 frames in 6
     * of the 9 drops recorded (2026-10-10). While looking up: strike nothing, look for only that 金光 (~35 ms a look),
     * dodge SKY_DELAY after it; no 金光 seen by SKY_LATE, dodge on the clock (twice) instead. A look at the sky costs
     * 15 ms; once a look up has been guarded, it is not again until the camera has come down.
     */
    function skyGuard() {
        if (!dodgeOn || !tells || usedUp) return false;
        const up = color({ ...SKY, image: img, roi: SKY_ROI, count: 0.75 * SKY_ROI[2] * SKY_ROI[3], connected: false }).hit;
        const now = Date.now();
        if (!up) {
            skySince = 0;
            skyDone = false;
            return false;
        }
        skySince ||= now;
        if (skyDone) return false;
        skyDone = true;
        log("looking up (从天而降 coming): on guard");
        letGo();
        alerts++;
        let n = 0;
        let downSince = 0;
        while (Date.now() - skySince < SKY_GUARD_MS) {
            img = shot();
            const t = Date.now();
            gap(t);
            heal();
            // (a window "not before 3.8 s after looking up" was tried and both drops hit: looking up is seen late at
            // times, so the 金光 can come sooner by the clock; reverted 2026-10-10)
            if (seeNarrow()) {
                log(`金光 from the sky ${t - skySince} ms after looking up: dodge a moment later`);
                sleep(SKY_DELAY);
                dodge(2);
                return true;
            }
            if (t - skySince >= SKY_LATE) {
                log("looking up: no 金光 seen, dodging on the clock");
                dodge(2);
                return true;
            }
            if (++n % 6 === 0) { // still looking up?
                const still = color({ ...SKY, image: img, roi: SKY_ROI, count: 0.75 * SKY_ROI[2] * SKY_ROI[3], connected: false }).hit;
                if (still) downSince = 0;
                else if ((downSince ||= t) && t - downSince > 400) return true; // came down: something else
            }
        }
        return true;
    }

    /** The small 金光 of 从天而降 on the current screenshot (looking up). */
    function seeNarrow() {
        const hit = color({ ...FLASH, image: img, roi: FLASH_ROI, count: 60, connected: true });
        return hit.hit && hit.results.some(({ box: [, , w, h], count }) => w >= 40 && w >= 5 * h && (count ?? 0) >= 0.15 * w * h);
    }

    /**
     * 警戒 after a burst: let go of everything, strike nothing, only watch for the 金光 (a look every ~30 ms) and
     * dodge it the moment it shows (teacher: be ready beforehand, press nothing else, dodge when it comes); over
     * ALERT_AFTER after the flash, or ALERT_MS after the burst with no flash.
     */
    function alert() {
        if (!dodgeOn || !tells || !burst()) return false;
        const t0 = Date.now();
        log("金光 tell (orange burst): on guard");
        letGo();
        alerts++;
        let end = t0 + ALERT_MS;
        let flashed = false;
        let early = false;
        while (Date.now() < end) {
            img = shot();
            const now = Date.now();
            // the leap's 金光 comes ~1 s after its burst and it lands 0.5 s after: out of the way before the flash
            // (the teacher's one clean dodge was pressed before it; run 5 dodged at the flash and was hit)
            if (!flashed && !early && now - t0 >= EARLY_MS) {
                log("on guard: early dodge (a leap's 金光 is due)");
                dodge();
                early = true;
                continue;
            }
            gap(now);
            if (!flashed && seeFlash()) {
                // a leap (its 金光 ~1 s after the burst) lands and bursts 16–19 frames after the flash: dodges then,
                // not at once (run 10: dodges at +4 and +14 were hit at +19; the one at +15 in run 10's next leap
                // was not); a ground attack's blows start at +12, dodge at once
                const leap = now - t0 < LEAP_MS;
                log(`金光 ${now - t0} ms after the tell: ${leap ? "a leap, dodge as it lands" : "dodge"}`);
                if (leap) sleep(LEAP_DELAY);
                dodge(leap ? 3 : FLASH_DODGES);
                flashed = true;
                end = Date.now() + ALERT_AFTER;
                continue;
            }
            execute();
            heal();
        }
        lastOrange = 0;
        lastCheck = Date.now();
        lastAt = "a dodge";
        return true;
    }

    /** Wait ms, looking for 金光 (and 处决 / 化解) all the while; true if it dodged (the wait ends there). */
    function watch(ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            img = shot();
            if (skyGuard() || alert() || flash() || extra() || grabCheck()) return true;
            ttcTick();
            execute();
            if (!parryOk()) cue();
            if (motionFight && motionCue()) return true;
            if (defendOn && motionOn) defendMotion();
            if (escapeOn) {
                heal();
                if (escape()) return true;
            }
            if (!dodgeOn) sleep(50);
        }
        return false;
    }

    /** No bar in sight: the enemy is behind; turn to the nearest red mark (within `within`) if it is off the camera. */
    function behind() {
        const foe = enemies(img).find((e) => e.dist <= (args.within ?? Infinity));
        const cam = cameraHeading(img);
        if (!foe || cam == null) return;
        const d = angleDiff(foe.bearing, cam);
        if (Math.abs(d) <= BAR_TURN) return;
        log(`no health bar in sight: turning ${Math.round(d)}° to the mark`);
        turn(Math.max(-300, Math.min(300, Math.round(d / DEG_PX))));
        lastTurn = Date.now();
        lastBar = lastTurn;
        turns++;
        img = shot();
    }

    /** 处决 (or a boss's last move, in the same diamond) on the current screenshot: tap it. */
    function execute() {
        const now = Date.now();
        if (now - lastExecute < EXECUTE_MS) return false;
        const k = seen("execute") ? "处决" : usedUp && seen("ultimate") ? "化解" : null;
        if (!k) return false;
        if (k === "处决" && execHold && weak) return false; // punish: later (EXEC_AFTER_MS)
        log(k);
        touch.up(1); // a 蓄力 held meanwhile is let go
        charging = false;
        walk(walking);
        tap(EXECUTE);
        lastExecute = now;
        executions++;
        return true;
    }

    /** New screenshot; dodge, 处决, heal, keep the lock, walk in, and end the fight when it is over. */
    function look() {
        img = shot();
        if (skyGuard() || alert() || flash() || extra()) img = shot();
        ttcTick();
        execute();
        if (!parryOk()) cue();
        const now = Date.now();
        if (now - downAt >= DOWN_MS) {
            downAt = now;
            if (match("down_heal.png", { image: img, roi: DOWN_ROI, threshold: 0.8 }).hit) throw new Over("down");
        }
        const locked = color({ ...GOLD, image: img, roi: LOCK_ROI, count: 150 }).hit;
        // a boss fight looks for less each time (the minimap only before the lock, the icons now and then), so 金光
        // is looked for more often
        const foes = args.boss && locked ? 0 : enemies(img).filter((e) => e.dist <= (args.within ?? Infinity)).length;
        if (foes || locked) lastFoe = now;
        // the icons (77 ms to read): in a boss fight only once its bar has been gone a while (the end)
        if (!args.boss || (bossSeen && now - bossSeen > BOSS_GONE_MS / 2 && now - calmAt >= HUD_MS)) {
            calm = hudCalm(img);
            calmAt = now;
        }
        const b = args.boss ? boss() : null;
        deadCheck(b);
        if (b != null) bossSeen = now;
        if (b != null) usedUp = b === 0;
        qiCheck(b);
        if (dufu) {
            const q = seen("qijie");
            if (q !== qijieOn) {
                qijieOn = q;
                mark("qijie", q ? "气竭 banner on" : `气竭 banner off after ${Date.now() - qijieAt} ms`);
                if (q) qijieAt = Date.now();
            }
        }
        ttcTick();
        if (args.boss) {
            // the fight lasts as long as the boss bar shows; not seen within a minute, there is no boss
            if (!bossSeen && now - start > 60_000) throw new Over("no boss bar");
            if (bossSeen && now - bossSeen > BOSS_GONE_MS && calm) throw new Over("boss gone");
        } else {
            if (now - lastFoe > idleMs) throw new Over("no enemies");
            if (!calm) {
                fought = true;
                calmSince = 0;
            } else if (fought) {
                calmSince ||= now;
                if (now - calmSince > (args.calmMs ?? 1500)) throw new Over("out of combat");
            }
        }
        if (now > until) throw new Over("time");
        const len = args.boss ? 0 : bars();
        // locked on, the game holds the camera on the locked enemy: a turn is pulled back (佛爷寨: 6 turns of 64°)
        if (len || locked) lastBar = now;
        else if (fought && !calm && now - lastBar > BAR_MS && now - lastTurn > TURN_MS) behind();
        // a boss is ahead on landing, maybe not on the minimap yet: lock on whatever is in view
        // a boss fight: keep it locked, whatever the minimap shows (walking in goes where the camera looks)
        if ((foes || args.boss) && !locked && now - lastLock > LOCK_MS) {
            tap(LOCK);
            lastLock = now;
        }
        // out of reach: the enemy's health has not gone down for a while (more of it: a new enemy or phase)
        const fh = b ?? (len || null);
        if (b === 0) lastHit = now; // used up: blows do nothing until the last move
        else if (fh != null) {
            const down = foeHp != null && fh < foeHp - 1;
            if (foeHp == null || down || fh > foeHp + 20) {
                foeHp = fh;
                lastHit = now;
            }
            if (down) walk(false);
        }
        // a boss fight walks in sooner (teacher, 2026-10-10: 蓄力 hit air a lot, the backward dodges leave it far)
        // (sched window: not between windows; we strike nothing then, so "out of reach" fired all the time: round 48
        // walked in 56 times, into the boss, and spent 燃此魂 on it before the windows)
        const idleNow = schedOn && windowOn && !inWindow && outsideMode !== "tang"; // (冢上霜 wants the boss in reach)
        if (!defendOn && !idleNow) walk((locked || (args.boss && !bossSeen)) && now - lastHit > (args.boss ? BOSS_WHIFF_MS : WHIFF_MS));
        heal();
        escape();
        grabCheck();
        counter();
        ttcTick();
    }

    /**
     * Below hpMin, the potion. A boss fight takes it on one low reading (a covered bar reads as none, not 0%) and
     * looks during the dodging too: a blow takes 40–75% at once, two readings and only between blows had it drink at
     * 29% (teacher, 2026-10-10: 喝血不及时).
     */
    function heal() {
        const h = hp();
        if (h == null) return; // covered: no reading, no potion (a stale low one had it drink at "0%")
        const now = Date.now();
        // a plain blow (parryHits): down at once, no 金光 dodged just before (more than a third at once is a white
        // flash read as full a moment before: round 2, 3120)
        if (lastHp != null && h < lastHp - HIT_DROP && h > lastHp - 0.35) {
            lastHitTaken = now;
            if (grabEscape) {
                if (grabDodgeAt && now > grabDodgeAt - 1500) grabDodgeAt = 0; // the stab itself (or later): over
                else if (now - flareDodgeAt < GRAB_HIT_MS) {
                    grabDodgeAt = now + grabDodgeMs;
                    mark("grab", `hit ${now - flareDodgeAt} ms after the 金光 dodge: dodge in ${grabDodgeMs} ms`);
                }
            }
            if (defendOn) mark("hit", `${Math.round(lastHp * 100)}→${Math.round(h * 100)}%`);
            if (now - lastDodge > 1500 || defendOn) hitAt = now;
        }
        lastHp = h;
        if (Number.isFinite(maxDrinks)) riseCheck(h, now);
        if (drinking) return;
        if (Number.isFinite(maxDrinks)) {
            if (lateFrom && now - lateFrom > DRINK_LATE_MS) lateFrom = 0;
            if (guarding || (lateFrom && h >= DRINK_URGENT)) return; // not in 起幕布; a late one may still come
            if ((charging || now < slashUntil) && h >= DRINK_URGENT) return; // a 蓄力 held: after its slash
            lows = h < hpMin ? lows + 1 : 0;
            // the potion has a cooldown after a drink (round 18: taps 14–27 s after one did nothing, 12 of them;
            // round 13 drank again after 19 s)
            if (drinks < maxDrinks && lows >= 1 && now - lastPotion > POTION_MS && now - drinkCountedAt > POTION_CD_MS) drink(h);
            return;
        }
        // the last tap took: the health went up (a limit on drinks counts these)
        if (tapHp != null) {
            if (h > tapHp + POTION_TOOK) {
                drinks++;
                tapHp = null;
                if (Number.isFinite(maxDrinks)) log(`potion drunk (${drinks}/${maxDrinks})`);
            } else if (now - lastPotion > POTION_TOOK_MS) tapHp = null;
        }
        lows = h < hpMin ? lows + 1 : 0;
        if (drinks >= maxDrinks) return;
        if (Number.isFinite(maxDrinks) && tapHp != null) return; // the last tap may still take
        if (lows >= (args.boss ? 1 : 2) && now - lastPotion > POTION_MS) {
            log(`health ${Math.round(h * 100)}%: potion`);
            tap(POTION);
            lastPotion = now;
            tapHp = h;
            potions++;
        }
    }

    /**
     * closeIn: the boss not hurt for CLOSE_MS (lastHit, its bar last went down): 陌刀's 突进 if lit, else walk in at
     * full push until its bar goes down or CLOSE_WALK_MS, looking all the while.
     */
    function closeIn(why) {
        const now = Date.now();
        if (!closeOn || !bossSeen || usedUp || now - lastHit < CLOSE_MS) return;
        closeIns++;
        if (weapon() === "modao" && dashLit() && now - lastLunge > 1500) {
            tap(DASH);
            lastLunge = now;
            lunges++;
            mark("dash", `close in (${why})`);
            watch(STILL_MS);
            look();
            return;
        }
        mark("walk", `close in (${why})`);
        const keep = stillUntil;
        stillUntil = 0;
        const end = now + CLOSE_WALK_MS;
        while (Date.now() < end && Date.now() - lastHit >= CLOSE_MS) {
            stride(1);
            if (watch(100)) break;
            look();
        }
        stride(0);
        walking = false;
        stillUntil = keep;
    }

    /**
     * A drink is the health going up (only potions heal in the arena): POTION_RISE above the lowest reading of the
     * last RISE_MS, read on RISE_READS looks in a row; one count per DRINK_GAP_MS (round 13: 4 rises, 3 counted, the
     * late one missed, a 4th potion drunk).
     */
    function riseCheck(h, now) {
        riseLows = riseLows.filter(([t]) => now - t <= RISE_MS);
        riseLows.push([now, h]);
        const low = Math.min(...riseLows.map(([, v]) => v));
        riseUp = h >= low + POTION_RISE ? riseUp + 1 : 0;
        if (riseUp >= RISE_READS && now - drinkCountedAt > DRINK_GAP_MS) countDrink(`${Math.round(low * 100)}→${Math.round(h * 100)}%`);
    }

    function countDrink(why) {
        const now = Date.now();
        if (now - drinkCountedAt <= DRINK_GAP_MS) return;
        drinkCountedAt = now;
        drinks++;
        lateFrom = 0;
        riseUp = 0;
        riseLows = [];
        lastPotion = Math.max(lastPotion, now - POTION_MS + 1000);
        log(`potion drunk (${drinks}/${maxDrinks}, ${why})`);
        mark("drunk", `${drinks}/${maxDrinks}`);
    }

    /**
     * A limit on drinks (独夫): stand still and tap the potion until the health goes up (read twice), a tap every
     * DRINK_TAP_MS (not sooner: a second drink must not go), for DRINK_MS at most; 金光 is still dodged meanwhile.
     */
    function drink(h0) {
        drinking = true;
        letGo();
        stillUntil = Math.max(stillUntil, Date.now() + DRINK_MS);
        log(`health ${Math.round(h0 * 100)}%: potion`);
        const end = Date.now() + DRINK_MS;
        const t0Drink = Date.now();
        let last = h0 < DRINK_URGENT ? 0 : Date.now() - DRINK_TAP_MS; // the first tap waits up to one more DRINK_TAP_MS for a quiet moment
        let up = 0;
        let taps = 0;
        let took = false;
        while (Date.now() < end) {
            // low health: no waiting for a quiet moment (round 38)
            if (Date.now() - last >= DRINK_TAP_MS && (!ttcModel || h0 < DRINK_URGENT || quiet() || Date.now() - last >= 2 * DRINK_TAP_MS)) {
                tap(POTION);
                mark("potion", `${Math.round(h0 * 100)}%`);
                taps++;
                potions++;
                last = Date.now();
            }
            img = shot();
            deadCheck();
            if (flash()) continue;
            // (卸势 in a drink, rounds 72–74: they cut the drink; round 72's third took 9 taps over 19 s: dropped)
            const h = hp();
            up = h != null && h > h0 + POTION_TOOK ? up + 1 : 0;
            if (h != null) riseCheck(h, Date.now());
            if (drinkCountedAt >= t0Drink) {
                took = false; // counted by riseCheck already
                break;
            }
            if (up >= 3) {
                took = true;
                break;
            }
        }
        const counted = drinkCountedAt >= t0Drink;
        if (took) countDrink("in the drink");
        else if (!counted) {
            lateFrom = Date.now();
            lateHp = h0;
        }
        log(took || counted ? `potion drunk after ${taps} taps` : `potion: not drunk after ${taps} taps`);
        drinking = false;
        lastPotion = Date.now();
        stillUntil = Date.now();
        lastHp = hp();
        lastCheck = Date.now();
        lastAt = "a drink";
    }

    /**
     * parryHits: a plain blow just landed (no 金光 before it): 卸势 PARRY_HIT_DELAY later for the next of its combo
     * (teacher: other blows can be taken with 卸势). Not in the 横刀 part (its presses would be lost).
     */
    function counter() {
        const now = Date.now();
        if (!parryHitsOn || weak || !hitAt || now - hitAt > 500 || stillUntil === Infinity) return;
        hitAt = 0;
        if (now - lastParry < PARRY_HIT_MS || now - lastDodge < 1500) return;
        letGo();
        if (watch(PARRY_HIT_DELAY)) return; // dodged something meanwhile
        log("hit: 卸势 for the next blow");
        parryTap("after a hit");
        lastParry = Date.now();
        parries++;
    }

    /** Press p until done() (on a fresh screenshot) says it came out. */
    function press(p, done, name, tries = 4, wait = 300) {
        mark("skill", name);
        for (let i = 0; i < tries; i++) {
            if (p === BUFF || p === DASH) ownFxUntil = Math.max(ownFxUntil, Date.now() + OWN_FX_MS); // gold effects
            // let go of the joystick first and keep still while it goes off (teacher, 2026-10-10: 突进 tapped while
            // walking did not come out)
            stillUntil = Math.max(stillUntil, Date.now() + STILL_MS);
            walk(false);
            tap(p);
            watch(wait);
            look();
            if (done()) return true;
        }
        log(`${name}: no change after ${tries} presses`);
        return false;
    }

    /**
     * 突进: tapped until its icon goes, looking all the while (a look can take 300+ ms, and press() checking once
     * after the wait could find the second charge back and spend it too).
     */
    function dash(name, tries = 4) {
        mark("skill", name);
        for (let i = 0; i < tries; i++) {
            ownFxUntil = Math.max(ownFxUntil, Date.now() + OWN_FX_MS);
            stillUntil = Math.max(stillUntil, Date.now() + STILL_MS);
            walk(false);
            tap(DASH);
            if (waitFor(() => { look(); return !seen("dash"); }, { timeout: DASH_GONE_MS, interval: 10 }) && gone("dash")) {
                if (i) log(`${name} out after ${i + 1} taps`);
                return true;
            }
        }
        log(`${name}: no change after ${tries} presses`);
        return false;
    }

    /** The button seen gone on the last look is still gone GLOW_MS later (not just the white glow of a tap). */
    function gone(key) {
        watch(GLOW_MS);
        look();
        return !seen(key);
    }

    function weapon() {
        return seen("modao") ? "modao" : seen("hengdao") ? "hengdao" : null;
    }

    function switchTo(w) {
        if (weapon() === w) return true;
        return press(SWITCH, () => weapon() === w, `switch to ${w}`, 4, 600);
    }

    /** 奇术 if lit, then 卸势 once its recovery has run for a while (not after a dodge: that ended it). */
    /**
     * 奇术 can be cast: its button there and its icon lit. Without 精力 the same icon shows gray (it still matches the
     * template): white px in the middle of the button, 60–80 lit, 0 gray (2026-10-10 captures); pressed then it was
     * tapped three times for nothing (teacher).
     */
    function qishuLit() {
        const hit = match(T.qishu[0], { image: img, roi: T.qishu[1], threshold: THRESHOLD });
        if (!hit.hit || !hit.box) return false;
        const [x, y, w, h] = hit.box;
        const cx = Math.round(x + w / 2), cy = Math.round(y + h / 2);
        return color({ ...ICON_WHITE, image: img, roi: [cx - 18, cy - 18, 36, 36], count: QISHU_LIT_PX }).hit;
    }

    function qishu() {
        if (!qishuLit()) return false;
        if (ttcModel && !weak && !quiet()) { // not safe now: later (teacher)
            mark("skill", `奇术 put off (p ${ttcLastP == null ? "?" : Math.round(ttcLastP * 100)})`);
            return false;
        }
        const t0 = Date.now();
        if (!press(QISHU, () => !qishuLit(), "奇术", 3)) return false;
        if (!watch(Math.max(0, qishuParryMs - (Date.now() - t0)))) parryTap(`after 奇术 +${Date.now() - t0}`);
        look();
        return true;
    }

    /** The boss's bar used up: no more blows (teacher: they do nothing, and the last move must not be missed). */
    function hold() {
        log("boss bar used up: waiting for its last move");
        while (usedUp) {
            watch(150);
            look();
        }
    }

    /**
     * 陌刀 蓄力 held until the blade turns red (CHARGE_RED_*), or a dodge / alert cuts it; returns how long it was held
     * (ms) and marks charge / release.
     */
    /** grabEscape: the dodge before the stab, when due. */
    function grabCheck() {
        if (!grabDodgeAt || Date.now() < grabDodgeAt) return false;
        grabDodgeAt = 0;
        dodge(1, FLARE_AGAIN_MS, "left", "插地");
        return true;
    }

    /** No blow coming: ttc's latest p(ttcBins) below chargeSafeP, or a good 卸势 just now (the boss staggered). */
    function quiet() {
        if (parryOkSeen && Date.now() - parryOkSeen < CHARGE_AFTER_PARRY_MS) return true;
        return ttcLastP != null && Date.now() - ttcLastAt < 150 && ttcLastP < chargeSafeP;
    }

    /** @param {string} why @param {{force?: boolean, redFrom?: number, cancel?: boolean, noHitAbort?: boolean}} [o] */
    function chargeHold(why, o = {}) {
        const sinceHit = Date.now() - lastHitTaken;
        if (!o.force && sinceHit < CHARGE_AFTER_HIT_MS) watch(CHARGE_AFTER_HIT_MS - sinceHit); // still staggered / down
        // a quiet moment: right after a good 卸势, or no blow coming (ttc), waited for a while
        if (ttcModel && !weak && !o.force) {
            const w0 = Date.now();
            const okRecent = () => parryOkSeen > 0 && Date.now() - parryOkSeen < CHARGE_OK_WINDOW_MS;
            while (!okRecent() && Date.now() - w0 < chargeOkWait) { // a good 卸势 first (the boss staggered)
                if (watch(60)) break;
            }
            if (okRecent()) why += ` (卸势 ok ${Date.now() - parryOkSeen} ms ago)`;
            else {
                const w1 = Date.now();
                while (Date.now() - w1 < CHARGE_WAIT_MS) {
                    if (quiet()) break;
                    if (watch(60)) break;
                }
            }
            if (Date.now() - w0 >= 100) why += ` (waited ${Date.now() - w0} ms)`;
            why += ` p ${ttcLastP == null ? "?" : Math.round(ttcLastP * 100)}`;
        }
        // the health read now, so a blow taken before the press does not count as one while holding (round 39: 9 of 14
        // "hit while holding" came within 0.08–0.31 s of the press, from blows before it)
        img = shot();
        heal();
        // (in the window only a blow this moment holds it back: round 47 took ~4 s per 蓄力 there, 2 in 8 s)
        const hitWait = CHARGE_AFTER_HIT_MS; // (0.3 s in the window, rounds 48–50: more holds hit and lost)
        if (Date.now() - lastHitTaken < hitWait) watch(hitWait - (Date.now() - lastHitTaken));
        const hit0 = lastHitTaken;
        /** @type {number[]} */ const pre = []; // boss bar reads over the hold (the last ones are the baseline)
        touch.down(CHARGE, 1);
        mark("charge", why);
        charging = true;
        walk(walking);
        const t0 = Date.now();
        let how = "time";
        for (;;) {
            const held = Date.now() - t0;
            if (held >= CHARGE_RED_MAX) break;
            if (watch(Math.min(60, CHARGE_RED_MAX - held))) {
                how = "cut short";
                break;
            }
            heal(); // reads the health: a hit shows in lastHitTaken (no potion while holding unless urgent)
            if (args.boss) {
                const bv = boss();
                if (bv != null) pre.push(bv);
            }
            if (lastHitTaken !== hit0 && !o.noHitAbort) { // hit / knocked down: this one is lost
                how = "hit";
                break;
            }
            if (Date.now() - t0 >= (o.redFrom ?? CHARGE_RED_FROM) &&
                color({ ...CHARGE_RED, image: img, roi: CHARGE_RED_ROI, count: CHARGE_RED_PX }).hit) {
                how = "red";
                break;
            }
        }
        const held = Date.now() - t0;
        if (how !== "cut short") letGo();
        mark("release", `${why} ${how} ${held} ms${lastHitTaken !== hit0 ? ", hit while holding" : ""}`);
        // the slash comes out ~0.5 s after letting go: nothing tapped meanwhile (dodges for 金光 still go)
        const follow = how === "hit" ? 200 : o.cancel ? CANCEL_MS : CHARGE_FOLLOW_MS;
        slashUntil = Date.now() + follow;
        // what the slash took off the boss bar: baseline = median of the last 5 reads while holding (we strike nothing
        // then), after = 2nd lowest read 0.3–1.4 s after letting go (one stray low read does not count); the device's
        // single read 0.9 s after disagreed with the recording (round 40: 0 for a 16 px slash)
        const r0 = Date.now();
        /** @type {number[]} */ const post = [];
        while (Date.now() - r0 < (o.cancel ? follow : Math.max(follow, 1400))) {
            watch(60);
            if (Date.now() - r0 >= 300 && args.boss) {
                const bv = boss();
                if (bv != null) post.push(bv);
            }
            if (how === "hit" && Date.now() - r0 >= follow) break;
        }
        look();
        const base = pre.slice(-5).sort((x, y) => x - y)[Math.floor(Math.min(5, pre.length) / 2)];
        post.sort((x, y) => x - y);
        const after = post.length >= 2 ? post[1] : post[0];
        if (base != null && after != null) mark("charge hit", `${Math.max(0, base - after)} px (${pre.length}/${post.length} reads)`);
        if (o.cancel && how !== "hit") parryTap("cancel 蓄力 recovery");
        return held;
    }

    /**
     * The 横刀 part (teacher, 2026-10-10): 突进, 爆发, 突进 again, then the 突进 button turns into 伤害 (a swirl, then
     * the arrow), 伤害, and back to 陌刀. 爆发 counts as out once its own button goes (cooldown).
     */
    function hengdaoPart() {
        closeIn("横刀");
        if (!switchTo("hengdao")) return false;
        {
            // the whole 横刀 part throws gold about (爆发's ribbons outlast 1.5 s): no burst read until it is over
            // (teacher, 2026-10-10: it dodged its own 爆发 again); the 金光 line is still watched for
            ownFxUntil = Infinity;
            stillUntil = Infinity; // no walking for the whole 横刀 part
            walk(false);
            if (seen("dash")) dash("突进");
            // 爆发 must go out (teacher, 2026-10-10: hit meanwhile, its taps were swallowed, it gave up after four and
            // stood there): tapped every BURST_TAP_MS until its button goes (cooldown), for up to BURST_MS
            let burst = !seen("burst");
            if (!burst) {
                const until = Date.now() + BURST_MS;
                let n = 0;
                while (Date.now() < until) {
                    ownFxUntil = Infinity;
                    tap(BUFF);
                    if (n === 0) mark("skill", "爆发");
                    n++;
                    watch(BURST_TAP_MS);
                    look();
                    if (!seen("burst") && gone("burst")) {
                        burst = true;
                        break;
                    }
                }
                if (burst) burstAt = Date.now();
                log(burst ? (n > 1 ? `爆发 out after ${n} taps` : "爆发") : `爆发: not out after ${n} taps`);
            }
            // 伤害 comes after the second 突进 (突进 has two charges): the teacher's recording 横刀连续技
            // (20261010-124059) goes 突进 (54) → its icon back (78) → 爆发 (84) → 突进 again (168) → the button turns
            // into the 伤害 arrow (192–204, hengdao_strike 0.83) → 伤害 (210). Both 突进 came 3.7 s apart there and in
            // our good rounds; 4.7 s apart the second charge was gone (a long cooldown, no 伤害: 镇守-横刀验证2 6310).
            // 爆发 pressed while the first 突进 still cools turns the button into the swirl, then the arrow, with no
            // second 突进 (same recording, 2508–2598).
            if (burst) {
                const next = waitFor(() => { look(); return seen("dash") || seen("damage") || seen("strike"); },
                    { timeout: DASH_BACK_MS, interval: 10 });
                if (next && seen("dash")) {
                    const until = Date.now() + DASH_AFTER_BURST;
                    while (Date.now() < until) {
                        watch(until - Date.now());
                        look();
                    }
                    dash("突进 again", 6); // more tries: 爆发 may play longer
                }
                // neither: the first 突进 went on its long cooldown (11 s, 镇守-横刀验证3 4215), no 伤害 this round
                if (!next) log("突进: no second charge in sight");
                else if (waitFor(() => { look(); return seen("strike"); }, { timeout: STRIKE_MS, interval: 10 })) {
                    press(DASH, () => !seen("strike") && gone("strike"), "伤害");
                } else log("伤害: never showed");
            }
            ownFxUntil = Date.now() + HENGDAO_FX_MS;
            stillUntil = Date.now() + STILL_MS;
        }
        return true;
    }

    /**
     * sched: one decision of the fight. 衰弱期 → weakPlan; 横刀 when 爆发 is cool (BURST_CD_MS since it went out, the
     * dodges and 卸势 meanwhile included) and 真气 is not low (RESERVE_QI: kept for the 衰弱期); else 陌刀: 增益 /
     * 奇术 when lit (not when keeping), a 蓄力 (CHARGE_MS), a few 轻击. Blows are dodged / 卸势'd in the waits as
     * always (watch(): 金光, ttc).
     */
    /**
     * The buff window after 横刀 (飞鸿踏雪 out at burstAt): 陌刀, its special 唤千军 (增益 button → 铁衣戎魂) and martial
     * skill 燃此魂 (突进 button: closes in, 荡八荒·极; → 破阵) when lit,
     * then 蓄力 after 蓄力 for windowMs, each started at once (the buffs are running) and its recovery cut
     * by 卸势.
     */
    function buffWindow() {
        switchTo("modao");
        const end = Date.now() + windowMs;
        mark("sched", `window: ${end - Date.now()} ms left`);
        if (seen("buff")) press(BUFF, () => !seen("buff"), "唤千军 (铁衣戎魂)", 2, 250);
        if (dashLit()) {
            tap(DASH);
            mark("skill", "燃此魂 (荡八荒·极)");
            watch(500);
            look();
        }
        let n = 0;
        let lost = false;
        while (Date.now() < end - 1000 && !weak && !usedUp) {
            closeIn("蓄力");
            const h0 = lastHitTaken;
            chargeHold(`window ${++n} (${end - Date.now()} ms left)`, { force: !lost, redFrom: WINDOW_RED_FROM, cancel: true });
            lost = lastHitTaken !== h0;
        }
        mark("sched", `window over: ${n} 蓄力`);
    }

    /**
     * Between windows (outside: "tang"): 横刀, 冢上霜 (轻击 held tangHoldMs, let go, its four hits), then 拨雪寻春 (the
     * 重击派生 diamond) when it shows. 卸势 (ttc) and 金光 dodges go on in the waits; a hit while holding lets go.
     */
    function tangTurn() {
        if (!switchTo("hengdao")) {
            watch(300);
            look();
            return;
        }
        const sinceHit = Date.now() - lastHitTaken;
        if (sinceHit < CHARGE_AFTER_HIT_MS) watch(CHARGE_AFTER_HIT_MS - sinceHit);
        touch.down(LIGHT, 1);
        charging = true; // a dodge lets go of it; no potion / 卸势 meanwhile
        const t0 = Date.now();
        const cut = watch(tangHoldMs);
        if (!cut) letGo();
        tangs++;
        mark("skill", `冢上霜 ${cut ? "cut short" : "out"} (${Date.now() - t0} ms held)`);
        slashUntil = Date.now() + TANG_FOLLOW_MS;
        watch(TANG_FOLLOW_MS);
        look();
        // rounds 57–59: the diamond showed after 1 of 45 冢上霜 (the 横刀 buttons looked the same before and after), so
        // 拨雪寻春 may be the 重击 button (CHARGE, (1020,478) on 横刀): tapped when there is no diamond (args.tangHeavy:
        // "heavy", default; "diamond": only the diamond)
        if (seen("parryOk")) {
            tap(HEAVY);
            tangHeavies++;
            heavies++;
            mark("heavy", "拨雪寻春 (diamond, after 冢上霜)");
            watch(500);
            look();
        } else if ((args.tangHeavy ?? "heavy") === "heavy") {
            const b0 = args.boss ? boss() : null;
            tap(CHARGE);
            tangHeavies++;
            watch(900);
            look();
            const b1 = args.boss ? boss() : null;
            mark("heavy", `拨雪寻春? (重击 after 冢上霜${b0 != null && b1 != null ? `, boss ${b0 - b1} px` : ""})`);
        } else mark("skill", "拨雪寻春: no diamond after 冢上霜");
    }

    function schedRound() {
        if (usedUp) return hold();
        if (rounds === 0 && dufu && args.boss && !bossSeen) {
            waitFor(() => { look(); return bossSeen > 0; }, { timeout: OPEN_BOSS_MS, interval: 10 });
        }
        if (!weapon() || !seen("qishu")) {
            tap(LIGHT);
            watch(300);
            look();
        }
        if (weak) {
            weakPlan();
            return;
        }
        const keep = qi >= 0 && qi <= RESERVE_QI;
        if (rounds === 0) {
            switchTo("modao");
            qishu();
            if (lungeOn) openLunge();
        }
        if (!keep && Date.now() - burstAt >= BURST_CD_MS) {
            mark("sched", `横刀 (爆发 cool, 真气 ${qi})`);
            if (windowOn && weapon() === "modao") qishu(); // 奇术 (+20% for 12 s) first, in a quiet moment
            inWindow = true;
            hengdaoPart();
            if (Date.now() - burstAt > 10_000) burstAt = Date.now() - BURST_CD_MS + 5000; // 爆发 did not go: again in 5 s
            else if (windowOn) buffWindow();
            inWindow = false;
            rounds++;
            return;
        }
        if (windowOn) { // outside the window: no 陌刀 蓄力; 横刀 冢上霜 / 拨雪寻春 (or defence only)
            if (outsideMode === "tang") tangTurn();
            else {
                switchTo("modao");
                watch(300);
                look();
            }
            return;
        }
        switchTo("modao");
        if (!keep && seen("buff")) press(BUFF, () => !seen("buff"), "唤千军");
        if (!keep && weapon() === "modao") qishu();
        // the 陌刀 part is 蓄力 (teacher): one each turn, 横刀 a few hundred ms late rather than a 蓄力 lost; no 轻击
        const cool = BURST_CD_MS - (Date.now() - burstAt);
        closeIn("蓄力");
        chargeHold(`sched (爆发 in ${Math.max(0, cool)} ms${keep ? ", keeping" : ""})`);
    }

    function round() {
        if (schedOn) return schedRound();
        if (usedUp) return hold();
        // 独夫 comes down from its steps first: 奇术 and the opening 突进 once its bar shows (rounds 7, 8: both parts
        // of 突进 went before it, the second cut nothing)
        if (dufu && rounds === 0 && args.boss && !bossSeen) {
            waitFor(() => { look(); return bossSeen > 0; }, { timeout: OPEN_BOSS_MS, interval: 10 });
        }
        if (!weapon() || !seen("qishu")) {
            tap(LIGHT); // out of a fight only 轻击 shows; it brings back the other buttons
            watch(300);
            look();
        }
        switchTo("modao");
        qishu();
        // the opening: 奇术, then 突进 at the boss at once (teacher, round 3)
        if (lungeOn && rounds === 0) openLunge();
        if (seen("buff")) press(BUFF, () => !seen("buff"), "唤千军");

        // 横刀 (teacher, again 2026-10-10): 突进, 爆发, 突进 again, then the 突进 button turns into 伤害 (same place: a
        // swirl, then the arrow), 伤害, and back to 陌刀. 爆发 counts as out once its own button goes (cooldown).
        hengdaoPart();

        switchTo("modao");
        const t0 = Date.now();
        for (let i = 0; i < CHARGES && !usedUp; i++) {
            closeIn("蓄力");
            chargeHold(`${i + 1}/${CHARGES}`); // creeps forward while charging
        }
        while (Date.now() - t0 < ROUND_MS && !usedUp) {
            tap(LIGHT);
            watch(200);
            look();
            if (weapon() === "modao") qishu();
        }
        rounds++;
    }

    /**
     * Practice (args.defend, teacher round 4: 不打，只卸势和闪避, to learn the timing from the recording): no blows at
     * all. Locked on; walked in DEFEND_WALK_MS after a dodge, and DEFEND_STEP_MS every DEFEND_STEP_EVERY when not hit
     * for a while (no blows, so "out of reach" cannot be read). 卸势: after each hit at the next of DEFEND_HIT_DELAYS,
     * else blind every next of DEFEND_BLIND_MS; 金光 dodged as always, the way cycling (back, left, right); 红光,
     * 起幕布, potions and the end on death as always. Every press is marked (see mark()).
     */
    /** MOTION_HSV counts in a 3 x 2 grid over the scene of image im. @param {Image} im */
    function motionCellsOf(im) {
        const [x0, y0, w, h] = MOTION_ROI;
        const cw = Math.floor(w / 3), ch = Math.floor(h / 2);
        const cells = [];
        for (let j = 0; j < 2; j++) {
            for (let i = 0; i < 3; i++) {
                const hit = color({ ...MOTION_HSV, image: im, roi: [x0 + i * cw, y0 + j * ch, cw, ch], count: 1 });
                cells.push(hit.hit ? hit.results[0]?.count ?? 0 : 0);
            }
        }
        return cells;
    }

    /**
     * How much the scene moves now, per frame: the counts of the current screenshot against a new one taken at once
     * (round 16: compared with the last look's, 150+ ms apart, it read on 1 look in 170 s).
     */
    function motionNow() {
        // the last one's counts when it was 1–3 frames ago (no screenshot more: the app leaks memory per capture,
        // 2026-10-10), else the counts now and of the next frame of the capture stream (not the same one again:
        // round 17, back to back they were often one frame and read 0)
        let a, t0, s0;
        if (motionPrev && img.seq === motionPrev.seq) return null; // the same frame as last time
        if (motionPrev && img.seq - motionPrev.seq >= 1 && img.seq - motionPrev.seq <= 3) {
            a = motionPrev.cells;
            t0 = motionPrev.time;
        } else {
            a = motionCellsOf(img);
            t0 = img.time;
            s0 = img.seq;
            sleep(25);
            img = shot();
            if (img.seq === s0) {
                sleep(15);
                img = shot();
            }
            if (img.seq === s0) return null;
        }
        const b = motionCellsOf(img);
        motionPrev = { seq: img.seq, time: img.time, cells: b };
        const dt = img.time - t0;
        if (dt <= 0 || dt > 150) return null;
        return Math.round((b.reduce((s, c, k) => s + Math.abs(c - a[k]), 0) * 33) / Math.max(dt, 20));
    }

    /**
     * The fight with args.motion: the scene moving (the boss winding up) while nothing of ours is going: 卸势, and its
     * 重击派生 is tapped when it shows (parryOk). Not during a 蓄力 hold (it would be lost), the 横刀 part, 衰弱, 起幕布,
     * a drink, or soon after our own dodge; looked at every MOTION_EVERY.
     */
    /**
     * defend: the scene moving on this screenshot (against the last one, 1–3 frames before): 卸势 motionDelays later.
     * Round 20: 36 blows had no 卸势 before them though the scene moved a lot (35000 offline, median) before 12 of them:
     * it was read once a loop (a look takes 100+ ms) and kept off 0.5 s after each step and dodge; now on every
     * screenshot of every wait, 0.3 s after a dodge, steps do not count.
     */
    function defendMotion() {
        if (yoloModel || ttcModel) return defendWindup();
        const now = Date.now();
        if (guarding || drinking || (punishOn && weak)) return false;
        const mv = motionNow();
        if (mv != null) motionMax = Math.max(motionMax, mv);
        if (now - motionLogAt >= 1000) { // the largest of each second, for calibration
            mark("motion", `${motionMax}`);
            motionLogAt = now;
            motionMax = 0;
        }
        if (mv == null || mv < motionTh) return false;
        if (now - lastDodge < DEFEND_QUIET_MS || now - parryTapAt < MOTION_MS || now - lastMotionParry < MOTION_MS) return false;
        lastMotionParry = now;
        stride(0);
        const d = motionDelays[motionParries % motionDelays.length];
        if (d) sleep(d);
        parryTap(`motion ${mv} +${d}`);
        parries++;
        motionParries++;
        return true;
    }

    /**
     * ttc: infer() on a screenshot (im, or one of its own when the last tick is TTC_TICK_MS old). Its frames n-4, n-2
     * come from this run's screenshots, so a turn of the loop (100+ ms with all the looks) is too sparse (ttc_probe:
     * ready on 98% of looks 40 ms apart, 80% at 70 ms, 1% at 110 ms; a call takes 5–9 ms with its screenshot; round
     * 30, 3–5 ticks a turn at fixed places: ready 65%): every screenshot goes through it (shot()), and every seen()
     * ticks when due.
     */
    function ttcTick(im = /** @type {Image | null} */ (null)) {
        if (!ttcModel) return;
        const now = Date.now();
        if (!im) {
            if (now - ttcAt < TTC_TICK_MS) return;
            // its own screenshot becomes the one everything looks at: only the last 8 are kept, an older img held
            // across 8 ticks would be gone ("image N is gone")
            im = img = screenshot();
        }
        if (im.seq === ttcSeq) return;
        if (ttcAt && now - ttcAt > 70) ttcGaps++;
        ttcSeq = im.seq;
        ttcAt = now;
        const r = infer(ttcModel, { ...TTC_OPTS, ...ttcInput, image: im });
        ttcLooks++;
        ttcMs += r.ms.total;
        if (r.ready && r.probs) {
            ttcReady++;
            const pr = r.probs;
            const p = ttcBins.reduce((a, b) => a + (pr[b] ?? 0), 0);
            ttcLastP = p;
            ttcLastAt = Date.now();
            ttcProbs = pr;
            if (ttcP == null || p >= ttcP || Date.now() - ttcPAt > TTC_FRESH_MS) {
                ttcP = p;
                ttcPAt = Date.now();
            }
        }
    }

    /** A screenshot into img, through ttcTick() too (its earlier frames come from this run's screenshots). */
    function shot() {
        const im = screenshot();
        ttcTick(im);
        return im;
    }

    /**
     * Stamina 0–1 from the gold arc left of the character (teacher, explore 0145: rows ~400–443 near x 351–358, gold H
     * ~23 S ~92 V ~215, fills from the bottom); null when not seen (full, or moved with the camera; not calibrated, only
     * used to skip extra 金光 dodges): the tallest thin gold piece in STAMINA_ROI over STAMINA_FULL_PX.
     */
    function stamina() {
        const r = globalColor({ lower: [17, 55, 170], upper: [30, 150, 255], method: 40, image: img, roi: STAMINA_ROI, count: 12, connected: true });
        const b = r.results.map((m) => m.box).filter((x) => x && x[3] >= 6 && x[2] <= 14 && x[3] >= 1.5 * x[2]).sort((p, q) => (q?.[3] ?? 0) - (p?.[3] ?? 0))[0];
        return b ? Math.min(1, b[3] / STAMINA_FULL_PX) : null;
    }

    /** p(windup) on this screenshot; null on the frame looked at last time. */
    function windupNow() {
        if (img.seq === windupSeq) return null;
        windupSeq = img.seq;
        if (ttcModel) {
            ttcTick();
            const p = ttcP != null && Date.now() - ttcPAt <= TTC_FRESH_MS ? ttcP : null;
            ttcP = null;
            return p;
        }
        const r = reco("NeuralNetworkClassify", { model: yoloModel, labels: ["idle", "windup"] }, { image: img, roi: YOLO_ROI });
        return r.label === "windup" ? r.score ?? 0 : 1 - (r.score ?? 1);
    }

    /** defend with args.yolo: like defendMotion, the classifier saying a blow is coming instead of the scene moving. */
    function defendWindup() {
        const now = Date.now();
        if (guarding || drinking || (punishOn && weak)) return false;
        const p = windupNow();
        if (p != null) motionMax = Math.max(motionMax, Math.round(p * 100));
        if (now - motionLogAt >= 1000) { // the highest p of each second (%), for calibration
            mark("windup", `${motionMax}`);
            motionLogAt = now;
            motionMax = 0;
        }
        if (p == null || p < (ttcModel ? ttcTh : yoloTh)) {
            if (ttcHoldSince && now - ttcHoldSince > 2 * ttcHold) ttcHoldSince = 0;
            return false;
        }
        if (failEscape && parryTapAt && !parryOkSeen && parryWhy.startsWith("ttc") && now - parryTapAt >= FAIL_ESCAPE_MS &&
            now - parryTapAt < FAIL_ESCAPE_MS + 300 && now - lastDodge > 1000) {
            failEscapes++;
            parryTapAt = 0;
            dodge(1, FLARE_AGAIN_MS, failEscapes % 2 ? "left" : "right", `卸势没卸住 (ttc ${Math.round(p * 100)})`);
            return true;
        }
        // a 卸势 that has shown no sign of working (no diamond / 真气 step yet) may be followed by another after reparryMs
        const cool = reparryMs > 0 && !parryOkSeen ? reparryMs : MOTION_MS;
        const block = now - lastDodge < DEFEND_QUIET_MS ? "after a dodge" : now - parryTapAt < cool ? "after a tap" :
            now - lastMotionParry < cool ? "after a ttc 卸势" : "";
        if (block) {
            ttcBlocked[block] = (ttcBlocked[block] ?? 0) + 1;
            if (ttcModel && p >= 0.7 && now - ttcBlockMarkAt > 500) {
                ttcBlockMarkAt = now;
                mark("ttc blocked", `${Math.round(p * 100)} ${block}`);
            }
            return false;
        }
        let held = "";
        // (rounds 66–68: 卸势仍挨 5.6 → 3.5 a minute with the hold. Holding on the 18–25 bin too (69–71) made it worse:
        // 13.6 hits a minute against 12.3, fewer good 卸势; back to the 11–17 bin only)
        // ttcFar (args.ttcFar, p of the 18–25 bin): rounds 97–102 offline, at the ttc 卸势 that were hit 15+ frames
        // after them that bin was 0.17 against 0.055 at the good ones; held while it is that high (same ttcHold limit)
        const farHold = ttcFar > 0 && ttcProbs && (ttcProbs[3] ?? 0) >= ttcFar;
        if (ttcModel && ttcHold > 0 && ttcProbs && (((ttcProbs[2] ?? 0) > (ttcProbs[1] ?? 0) && (ttcProbs[1] ?? 0) < TTC_HOLD_NEAR) || farHold)) {
            if (!ttcHoldSince) ttcHoldSince = now;
            if (now - ttcHoldSince < ttcHold) { // the blow is still a little far: a moment later
                ttcBlocked.hold = (ttcBlocked.hold ?? 0) + 1;
                return false;
            }
            held = ` held ${now - ttcHoldSince}`;
        } else if (ttcHoldSince) held = ` held ${now - ttcHoldSince}`;
        ttcHoldSince = 0;
        lastMotionParry = now;
        stride(0);
        if (yoloDelay) sleep(yoloDelay);
        parryTap(`${ttcModel ? "ttc" : "windup"} ${Math.round(p * 100)} +${yoloDelay}${held}`);
        parries++;
        motionParries++;
        return true;
    }

    function motionCue() {
        const now = Date.now();
        if (!ttcModel && now - motionAt2 < MOTION_EVERY) return false;
        motionAt2 = now;
        // ttc in the fight (args.ttc without defend): its p instead of the scene moving, looked at on every turn
        const p = ttcModel ? windupNow() : null;
        if (charging || now < slashUntil || weak || guarding || drinking || stillUntil === Infinity || usedUp) return false;
        if (now - lastDodge < MOTION_QUIET_MS || now - parryTapAt < MOTION_QUIET_MS || now - lastMotionParry < MOTION_MS) return false;
        const mv = ttcModel ? (p == null ? null : Math.round(p * 100)) : motionNow();
        if (mv == null || mv < (ttcModel ? ttcTh * 100 : motionTh)) return false;
        lastMotionParry = now;
        letGo();
        const d = ttcModel ? 0 : motionDelays[motionParries % motionDelays.length];
        if (d) sleep(d);
        parryTap(`${ttcModel ? "ttc" : "motion"} ${mv} +${d}`);
        parries++;
        motionParries++;
        return false; // the wait goes on (the diamond is looked for on the next looks)
    }

    /** defend + punish, 衰弱期: 横刀 突进 / 爆发 / 伤害 as they show, else 轻击, until 真气 is back or PUNISH_MS. */
    /**
     * 衰弱期 by plan: as many of weakBuffs as fit before a 陌刀 蓄力 (switch + CHARGE_MS) and 处决 (EXEC_MARGIN_MS) in
     * weakMs from 衰弱 read; then the 蓄力, then 处决 (held until then). Every step marked with its ms into 衰弱.
     */
    function weakPlan() {
        const t0 = weakSince || Date.now();
        const left = () => weakMs - (Date.now() - t0);
        const at = () => `${Date.now() - t0} ms`;
        mark("punish", `plan start, ${left()} ms left`);
        stride(0);
        // 处决 is tapped when it shows (it showed for one frame at a time; 衰弱 lasted ~3–3.5 s after it), not held
        execHold = !!args.execLate;
        const chargeCost = () => (weapon() === "modao" ? 0 : SWITCH_COST_MS) + CHARGE_RED_MAX + EXEC_MARGIN_MS;
        for (const b of weakBuffs) {
            if (!weak) break;
            const hd = b === "burst" || b === "strike";
            const cost = (BUFF_COST_MS[b] ?? 700) + (hd !== (weapon() === "hengdao") ? SWITCH_COST_MS : 0);
            if (left() - cost < chargeCost()) {
                mark("punish", `${b}: no time (${left()} ms left)`);
                continue;
            }
            if (hd) {
                if (!switchTo("hengdao")) continue;
                if (b === "burst" && seen("burst")) {
                    tap(BUFF);
                    burstAt = Date.now();
                    ownFxUntil = Date.now() + HENGDAO_FX_MS;
                    mark("skill", `爆发 (衰弱) at ${at()}`);
                    watch(BUFF_COST_MS.burst - 100);
                } else if (b === "strike" && seen("strike")) {
                    tap(DASH);
                    mark("skill", `伤害 (衰弱) at ${at()}`);
                    watch(BUFF_COST_MS.strike - 100);
                } else mark("punish", `${b}: not lit`);
            } else {
                if (!switchTo("modao")) continue;
                if (seen("buff")) press(BUFF, () => !seen("buff"), `唤千军 (衰弱) at ${at()}`, 2, 300);
                else mark("punish", `${b}: not lit`);
            }
            look();
        }
        if (weak && switchTo("modao")) chargeHold(`衰弱 at ${at()}`, { force: true, noHitAbort: true }); // the boss strikes nothing in 衰弱
        execHold = false;
        mark("punish", `处决 free at ${at()}`);
        const until = Date.now() + 1500;
        while (Date.now() < until && !execute()) {
            watch(60);
            look();
        }
        while (weak && Date.now() - t0 < PUNISH_MS) { // what is left: 轻击
            tap(LIGHT);
            watch(150);
            look();
        }
        mark("punish", `end after ${at()} (${weak ? "time" : "真气 back"})`);
    }

    function punish() {
        if (planOn) {
            weakPlan();
            if (defendWeapon !== "any") switchTo(defendWeapon);
            return;
        }
        const t0 = Date.now();
        let light = 0;
        let seenAt = 0;
        mark("punish", "start");
        stride(0);
        execHold = true;
        while (weak && Date.now() - t0 < PUNISH_MS) {
            const now = Date.now();
            if (execHold && seen("execute")) {
                if (!seenAt) {
                    seenAt = now;
                    mark("punish", `处决 shows ${now - weakSince} ms into 衰弱`);
                }
                if (now - weakSince >= execAfter) {
                    execHold = false;
                    mark("punish", `处决 at ${now - weakSince} ms`);
                    execute();
                    watch(100);
                    look();
                    continue;
                }
            }
            if (seen("strike")) press(DASH, () => !seen("strike"), "伤害 (衰弱)", 2, 150);
            else if (seen("dash")) dash("突进 (衰弱)", 1);
            else if (seen("burst")) {
                ownFxUntil = Date.now() + HENGDAO_FX_MS;
                tap(BUFF);
                mark("skill", "爆发 (衰弱)");
                watch(120);
                look();
            } else {
                tap(LIGHT);
                light++;
                watch(120);
                look();
            }
        }
        execHold = false;
        mark("punish", `end after ${Date.now() - t0} ms (${weak ? "time" : "真气 back"}), ${light} 轻击`);
    }

    function defend() {
        let hi = 0;
        let bi = 0;
        if (defendWeapon !== "any") switchTo(defendWeapon);
        let nextBlind = Date.now() + DEFEND_BLIND_MS[0];
        let lastStep = Date.now();
        let stepUntil = 0;
        log(`defend: practice, no blows (skill started at epoch ${start})`);
        for (;;) {
            look();
            if (punishOn && weak) {
                punish();
                continue;
            }
            const now = Date.now();
            if (hitAt && now - hitAt < 400) {
                const d = hitDelays[hi++ % hitDelays.length];
                const at = hitAt;
                hitAt = 0;
                stride(0);
                if (!watch(d)) {
                    parryTap(`hit +${d} (hit seen +${at - start})`);
                    parries++;
                }
                nextBlind = Date.now() + DEFEND_BLIND_MS[bi++ % DEFEND_BLIND_MS.length];
                continue;
            }
            if (motionOn && defendMotion()) continue;
            if (blindOn && now >= nextBlind) {
                const gapMs = DEFEND_BLIND_MS[bi++ % DEFEND_BLIND_MS.length];
                stride(0);
                parryTap(`blind (next in ${gapMs})`);
                parries++;
                nextBlind = now + gapMs;
            }
            // keep close: in after a dodge, and a step now and then when nothing hit for a while
            const hitLately = now - lastHitTaken < 1500;
            if (now - lastDodge > 300 && now - lastDodge < 300 + DEFEND_WALK_MS && !hitLately) {
                if (stick !== 1) mark("walk", "after a dodge");
                lastStepAt = now;
                stride(1);
            } else if (!hitLately && now - lastStep > DEFEND_STEP_EVERY) {
                lastStep = now;
                stepUntil = now + DEFEND_STEP_MS;
                lastStepAt = stepUntil;
                mark("walk", "step");
                stride(1);
            } else if (now > stepUntil) stride(0);
            watch(motionOn ? 150 : 40);
        }
    }

    if (args.probe) {
        const fl = color({ ...FLASH, image: img, roi: FLASH_ROI, count: 150, connected: true });
        const out = { weapon: weapon(), hp: hp(), foes: enemies(img).length, boss: args.boss ? boss() : null, bars: bars(),
            flash: fl.results.map(({ box, count }) => [...box, count]),
            orange: color({ ...BURST, image: img, roi: FLASH_ROI, count: 1, connected: false }).results.map(({ box, count }) => [...box, count]) };
        if (dufu) Object.assign(out, { curtain: curtainGap(), red: streak(RED, 150, 3), streak: streak(STREAK, 150, 2), flare: seeFlash() });
        for (const k of Object.keys(T)) out[k] = Math.round((match(T[k][0], { image: img, roi: T[k][1], threshold: -1 }).score ?? 0) * 100) / 100;
        return out;
    }

    let why = "";
    try {
        look();
        if (defendOn) defend();
        else for (;;) round();
    } catch (e) {
        if (!(e instanceof Over)) throw e;
        why = e.message;
    } finally {
        tick = () => {};
        letGo();
    }
    const more = dufu ? `, ${parries} 卸势 (${cues} on a wind-up, ${parriesOk} ok, ${heavies} 重击派生), ${weaks} 衰弱, 真气 ${qi}, ${escapes} escapes, ${pulls} 红刺, ${closeIns} close-ins, ${curtains} 起幕布, ${lunges} 突进 in` : "";
    log(`fight over (${why}): ${rounds} rounds, ${potions} potions (${drinks} drunk), ${executions} 处决, ${dodges} dodges (${alerts} on guard), ${walks} walks in, ${turns} turns to an enemy behind${more}, 金光 looked for at most ${maxGap} ms apart`);
    if (schedOn && windowOn) log(`outside: ${outsideMode}, ${tangs} 冢上霜, ${tangHeavies} 拨雪寻春 after them`);
    if (ttcModel) log(`ttc: ${ttcReady}/${ttcLooks} looks ready, ${ttcLooks ? Math.round(ttcMs / ttcLooks * 10) / 10 : 0} ms each`);
    return { reason: why, ttc: ttcModel ? { blocked: ttcBlocked, looks: ttcLooks, ready: ttcReady, gaps: ttcGaps, ms: ttcLooks ? Math.round(ttcMs / ttcLooks * 10) / 10 : 0 } : undefined, rounds, potions, drinks, executions, dodges, alerts, walks, turns, parries, curtains, lunges, parriesOk, heavies, cues, weaks, qi, escapes, pulls, closeIns, motionParries, maxGap, start, events };
}
