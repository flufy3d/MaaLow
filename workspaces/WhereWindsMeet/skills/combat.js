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
// (~1.6 s each) and burn whoever they cover; walked into the gap between them. At most 1 potion a fight (teacher, 2026-10-11; was 3;
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
    // 横刀's 重击 button after a good 卸势: a light blue disc with a swirl, labelled 爆发 (rounds 129–139: each of round
    // 137's 10 runs of it began 0–30 frames after a "parry ok" and lasted 1–9 s, 衰弱 or not). Cut from round 137 frame
    // 6000; ≥ 0.8 on most frames with neither weapon's button, ≤ 0.31 on 陌刀 / 横刀 frames (rounds 134, 137, 138)
    swirl: ["combat/hengdao_swirl.png", [988, 446, 64, 68]],
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
const CHARGE_RED = { lower: [[0, 150, 140], [172, 150, 140]], upper: [[6, 255, 255], [180, 255, 255]], method: 40 };
// (dummy runs, data/tmp/dummy: [150, 80, 780, 560] took in the chat's red badge, 429–443 x 623–638, ~127 px over the 120
// asked, so "red" came at 1.8 s whenever the chat had one; off the chat and the top left counters, wider to the left
// where the blade swings out, 60 px: dummy.js's)
const CHARGE_RED_PX = 60;
/** @type {Box} */ const CHARGE_RED_ROI = [0, 160, 930, 430];
// 刀势 (teacher): the 5 small blades on the weapon bar (965,298,71,16); some skills spend them, some give them back; a
// 蓄力 with fewer than 2 is a plain 重击. A blade counts with ≥ 3 px at V ≥ 200, S ≤ 70 in its box (rows 302–308):
// as the offline count (8 brightest px ≥ 190) on 97–99% of 1241 frames of rounds 132, 137, 139. Rounds 131–140: ≥ 2 at
// all 84 蓄力 starts; a full one took 1 (0–2), one hit while held none
/** @type {[number, number][]} */ const DAOSHI_SLOTS = [[980, 6], [990, 7], [1001, 6], [1011, 7], [1021, 7]];
const DAOSHI_HSV = { lower: [0, 0, 200], upper: [180, 70, 255], method: 40 };
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
const EDGE_STRIPS = 3; // edgeParts()
const EDGE_OVERLAP = 40; // > 30, the widest edge
const ME_X = 540; // the character, on screen (the camera behind it)
const GAP_IN = 20; // within the gap this far from its sides counts as in it
const GAP_PUSH = 120; // px off the gap's middle for a full push of the joystick sideways
const CURTAIN_MS = 9000; // the longest a 起幕布 is guarded (three sweeps took 5.7 s)
const CURTAIN_GONE_MS = 1500; // not seen this long: over (the sweeps came 25–31 frames apart)
// looked for on every look but the 红光 ones (round 3: every 150 ms and two in a row, the first sweep was seen ~1 s
// late, the character still attacking, and burned)
// (until round 156 every look, 0; a look took 150–260 ms then. Now every CURTAIN_EVERY ms (args.curtainEvery), and
// every look while a sighting waits for its confirmation. Rounds 162–164 (90 ms asked): 600 looks in 265 s, one per
// ~440 ms as it took turns with 红光, its edges 51 ms a read (the most blamed for ttc gaps): 400, as often as it got)
const CURTAIN_EVERY = 400;
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
// ttc misses (offline, rounds 162–170: about half of "p ≥ 0.5 seen on the device, no 卸势" had no reason in the events:
// "ttc blocked" only at p ≥ 0.7, nothing for ttcHold or defendWindup's early returns). A run of reads ≥ ttcTh (gaps up
// to MISS_GAP_MS, MISS_MAX_MS at most) is one episode; the decision points note why they did not press; one that ends
// with no 卸势 pressed is marked "ttc miss": its reasons (×times, detail), the state and where the code was when it
// began ("unseen": no decision point read it)
const MISS_GAP_MS = 120;
const MISS_MAX_MS = 2000;
const GAP_MARK_MS = 100; // a ttc gap this long is marked ("ttc gap": the slowest call in it, where it ended)
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
// rounds 113–120 (data/tmp/dufu_yolo/win_phase.py --weak): 处决 was 94% of a 衰弱's damage (50–56 px each time, the
// 蓄力 5–20); 真气 came back 1.5–4.6 s after 处决's first blow, and round 118 tapped it 3 s late with the boss still
// glowing white, striking nothing: 衰弱 lasts until 处决. So the plan starts when 处决 shows and holds it
// EXEC_PLAN_AFTER_MS (args.execAfter) while it strikes, never longer than EXEC_HOLD_MAX_MS. Round 120: 真气 read 0 at
// 4881–5149 with no 衰弱 (a 穿喉 banner, the bar glowing red, the boss striking; 处决 showed 5.8 s later): 真气 empty
// with no 处决 yet is guarded as usual (weakNow). The rounds 118–120 plan (4.5 s from 真气 empty, buffs costed with a
// switch each) skipped every buff and ran twice in a 衰弱, the second 蓄力 after it
// rounds 126, 127: 处决 showed 8–10 frames before 真气 read empty twice (5545 / 5852, 衰弱 read 5553 / 5862) and was
// tapped at once, the plan never ran (衰弱 2.2 s); so 处决 seen with 真气 low starts 衰弱 itself (EXEC_QI_MAX).
// Round 128: the plan started 522 ms after 处决 showed, 1966 ms left, and found no time for a 蓄力 (4200 ms needed);
// measured: a switch ~700 ms, red 1.4–1.6 s under 热血难凉 (47), 2.1–2.3 s without, the slash ~0.5 s after letting go;
// in 衰弱 the boss strikes nothing, so a 蓄力 let go early still counts (a guess; 141 says no, below). 处决 at 2677 ms
// still took 57 px (118: 3 s late too); args.execAfter / args.execHoldMax (the cap), defaults below
// round 129 (execAfter = execHoldMax = 5500): 处决 went 3263 ms after it showed, not tapped; 衰弱 without it 7623 ms,
// the boss striking nothing. Rounds 126–129, 横刀 in 衰弱: its 重击 button turns into a blue swirl (hengdao_heavy ≤ 0.2,
// so weapon() read none: 128 "?"), 突进's icon stays (hengdao_dash 0.92; 陌刀 113–114 kept its 蓄力 button); and 129's
// switch to 陌刀 right after its 爆发 (4478) came only at ~4550, as 爆发 played (~2.4 s: its swirl swallows taps), the
// whole 处决 time spent waiting for it (switchTo: 4 presses). So no 爆发 before a switch, the switch tapped once and
// waited PLAN_SWITCH_MS at most, else 横刀 strikes. After 处决 (its scene ~1.1 s) 衰弱 went on 1.5–2.5 s (128: tapped
// 2677, 真气 back 4963): struck on until 真气 is back (POST_EXEC_MS at most)
// rounds 141, 142 (teacher: the 重击 was not done when 处决 went, there was time): 141 switched, held a cold 蓄力 1491 ms
// (cut to fit 2600 ms) and tapped 处决 0.8 s after letting go: the slash took 0 px, 处决 61. The button stayed on until
// tapped (2.7–2.8 s; ≥ 0.87 bar single frames of a switch / skill effect), 衰弱 went on 3.2–3.4 s after 处决 (5.9 / 6.2 s
// in all; 7.6 s with no 处决, 129). 129 read it gone at 3263 ms and it was not seen again in the 1.5 s after (130: gone
// 1173 → back 1842, covered): it seems to go ~3.3 s after it shows, so 处决 by 3150 at the latest (args.execHoldMax).
// 141's switch to 陌刀 took ~310 ms (tap 109 → 蓄力 423 ms): WEAK_SWITCH_MS. So a hot 蓄力 fits from 横刀 when the plan
// starts within ~200 ms, a cold one (to red) only from 陌刀
// Now a 蓄力 only whole (hot: hotHoldMs, else to red ~2.3 s) and 处决 at once after its slash; else strikes until
// execAfter. A 处决 not seen is looked for on while 真气 is empty
const EXEC_PLAN_AFTER_MS = 2700;
const EXEC_HOLD_MAX_MS = 3150;
const WEAK_SWITCH_MS = 400;
const PLAN_SWITCH_MS = 1000;
const EXEC_SCENE_MS = 1100;
const POST_EXEC_MS = 4500;
const PLAN_MAX_MS = 9000; // the whole plan from 处决 showing (衰弱 7.6 s without 处决, 129)
const EXEC_QI_MAX = 20;
// 热血难凉 (dummy runs): ~14 s after 爆发; then 焚此心 spends no 刀势 and the hold time decides the damage: 600 ms 12K, 900
// 14K, 1200 30K, 1500 19–76K, 1800 65–81K (~75K), 2100–2400 52–82K; red shows at 1.0–1.5 s and letting go then gave
// 41.9K on average. Without it, to red (~2.3 s) 45.7K, 1.5 s about half. So under it a fixed hold (args.hotHoldMs),
// no red; the slash is out ~0.5 s after letting go, before the window's 卸势 at CANCEL_MS
const HOT_MS = 13_000;
const HOT_HOLD_MS = 1800;
const WEAK_COLD_HOLD_MS = 2300;
const WEAK_SLASH_MS = 600;
/** @type {Record<string, number>} */ const BUFF_COST_MS = { buff: 700, burst: 900, strike: 700, ranshi: 600 }; // press + animation, about
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
const STAMINA_HSV = { lower: [17, 55, 170], upper: [30, 150, 255], method: 40 };
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
// 红光 / 红刺 looked for this often (that look skips 起幕布; args.redEvery). Was 200; rounds 162–164 got one per ~376 ms
// (705 in 265 s, 40 ms each, two hue ranges over FLASH_ROI): 350, as often as it got, the reads now apart
const RED_EVERY = 350;
// 金光 seen: dodge this much later. Was 230 (round 19: 200–260 ms took nothing back or left); rounds 16–24 offline
// (data/tmp/dufu_moves): the grab (拉人倒地被刺, 12–14 of ~25 金光) lunges in on frame 12–14 after the flare's first,
// and with 0 ms our dodge shows on frame 8–10, with 230 ms on 15–21: too late for it. So 0 (defend tries 0 / 50)
// rounds 28–37 (174 金光 with a dodge, frame of its first press from the flare's first frame, glow-aligned): +3–8 hit
// after 52% (4.4% lost on average), +9–11 45% (2.9%); the grab (拉人倒地被刺) caught us with the dodge at +4–9 in 30 of
// 34 cases (its lunge lands +15–20: a dodge that early is over by then). So a little later: 80 ms (~+9–11)
const FLARE_DELAY = 80;
const FLARE_AGAIN_MS = 250; // and the next ones this far apart
// flareClass (args.flareClass, off): which 金光 it is, by a 3-class net on the ttc input (same infer() options;
// data/tmp/dufu_ml/flare3_cnn.py, 766 金光 of 53 rounds: other / grab / slam; the grab's pounce lands ~+13 frames from
// the flare's first, the slam ~+19), run on the frame it is seen on and up to FLARE_MORE_FRAMES after it, averaged,
// decided before the plain dodge is due. grab (p ≥ FLARE_P): one dodge sideways (left / right in turn) showing at
// +FLARE_GRAB_AT frames (flare2's second one does not help against it); slam: one dodge showing at +FLARE_SLAM_AT,
// back and sideways in turn (to compare); else as before. Timed from the frame's capture (Image.time − age_ms; with a
// look on every frame the flare is seen 0–1 frame late), pressed FLARE_LAG_MS before it should show (capture → press
// seen 100–150 ms, 3–4.5 frames, ~20–40 ms of that before the press: a guess, the marks have what to check it by)
const FLARE_MODEL = "dufu/flare3.onnx"; // under model/
const FLARE_P = 0.5; // slam
// grab (args.flareGrabTh): rounds 168–170 on the device, the kinds all right by the frames, but one real grab at
// p 0.53 taken for other (grabs 0 of 8 caught, 33% before; slams 2 of 14 hit, 78% before; others 5 of 23): 0.35
const FLARE_GRAB_TH = 0.35;
// sweepNet (args.sweepNet; 独夫 default since rounds 195–206, false turns it off): frames to 起幕布's sweep
// by a net on the ttc input (same infer() options, every ttc inference, ~5 ms; data/tmp/dufu_ml, softmax over 0–4,
// 5–8, 9–12, 13–20 frames, far / none). p(0–8) ≥ SWEEP_DODGE_P: one dodge back at once (the joystick SWEEP_LAG_MS
// before the tap, the offline LAT 5.5 frames counted with it), at most every SWEEP_GAP_MS; p(0–12) ≥ SWEEP_QUIET_P: no
// 卸势 (a sweep is not parried). Held-out 14 rounds offline: 81% of the dodges in the window, 0.62 false a minute.
// On the device (180–182, 195–204: 7 rounds): 黑场扫击 hit 10 of 49 (20%) against 41 of 67 (61%) without it; 0.72
// false a minute, nearly all around a 起幕布, none followed by a hit. A false one often comes ~33 frames before the
// sweep and the real one at −4…−1 after SWEEP_GAP_MS: keep that gap
const SWEEP_MODEL = "dufu/sweep.onnx";
const SWEEP_DODGE_P = 0.6;
const SWEEP_QUIET_P = 0.5;
const SWEEP_GAP_MS = 1000;
const SWEEP_LAG_MS = 50;
const SWEEP_FRESH_MS = 70; // its p is acted on this long
const SWEEP_LATE_MS = 120; // a dodge not started within this of its read is dropped (the window is ~6 frames)
// okRepress (args.okRepress, off; data/tmp/dufu_ml/after_ok*.py): a 卸势 seen to work (fresh) is pressed again
// okRepressMs after the first press when ttc p ≥ OK_REPRESS_P then, past ttcHold and the cooldowns (after a 卸势
// that did not work, again 4–11 frames later was hit 24% of the time against 6%: only after good ones); offline
// ~0.27 fewer hits a minute. okEscape is off with it
const OK_REPRESS_MS = 400;
const OK_REPRESS_P = 0.5;
const OK_REPRESS_LATE_MS = 250; // seen to work this late after it was due: not pressed
const FLARE_MORE_FRAMES = 2;
const FLARE_GRAB_AT = 9; // frames, aiming at +8…+10
const FLARE_SLAM_AT = 15; // +14…+16
// other (args.flareOtherAt): its first dodge at a frame too, with the same flareLagMs (offline, rounds 165–175: showing
// at +9…+11 hit 8%, +12…+14 29%, +15…+17 80%); the plain delay (flareDelays) only when the kind could not be read
const FLARE_OTHER_AT = 9;
// a 金光 seen during another dodge (failEscape, okEscape, 幕布, 红刺…) is dodged after it at its kind's frame
// (offline: the 6 金光 really missed were all −7…+5 frames from such a dodge: FLASH_MS kept them unlooked-for);
// FLASH_MS now only after a 金光 dodge
const FLARE_PENDING_MS = 300;
const FLARE_LAG_MS = 110;
// 重伤 (dead): the screen goes grey (S ≤ 30 over ≥ 85% of the scene; ≤ 40% in all fight frames of round 2, 77–100%
// from the first frame of both deaths, 2123 and 3450), the boss bar and the health bar gone. The arena then starts
// over by itself (black 2302–2357, full health at 2358): round 2 fought on into a second life
/** @type {Box} */ const GREY_ROI = [100, 100, 880, 500];
const GREY = { lower: [0, 0, 0], upper: [180, 30, 255], method: 40 };
const DEAD_MS = 400; // looked for this often
const BOSS_FULL = 378; // the boss bar full (383 px), back after a restart
const BOSS_DOWN = 365; // and it had been down to this
const BOSS_FULL_READS = 2; // full on this many reads in a row (DEAD_MS apart)
const BOSS_GAP = 12;
// phase one cleared (round 113, 20261011-175734): the boss bar ≤ 16 px from ~9015, gone in the cut scene 9250–9276,
// then a full bar (383) and the quest line 「独夫·绝境·浴血·阶段二」 (9280 on); combat.js took the refill for the arena
// starting over ("dead") and drank the phase-two refill as a potion. A refill after the bar was down to CLEAR_LOW_PX
// (CLEAR_LOW_READS reads in a row), or 二 in the quest line on two looks in a row, is "cleared". 二 / 一 by their
// strokes (white, S ≤ 70, V ≥ 190): 一 is one stroke on rows 145–146 (x 220–235), 二 two on 141–142 and 148–149; this
// rule held on 89 of the 91 phase-two frames and 1 single frame of ~78000 phase-one frames (rounds 105–113)
const CLEAR_LOW_PX = 38; // 10% of 383
const CLEAR_LOW_READS = 3;
const QUEST_WHITE = { lower: [0, 0, 190], upper: [180, 70, 255], method: 40 };
/** @type {Box} */ const PHASE2_TOP = [222, 140, 12, 4]; // ≥ 8 px
/** @type {Box} */ const PHASE2_BOTTOM = [220, 147, 16, 4]; // ≥ 10 px
/** @type {Box} */ const PHASE1_MID = [220, 144, 16, 3]; // ≤ 2 px (looked at in deadCheck, every DEAD_MS)
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

// pacing (ttc gaps, rounds 130–155): the loops look at each new frame once (~35 ms apart at the stream's 26–29 fps),
// waiting for it at most NEXT_MS (a still screen has none)
const NEXT_MS = 50;
// a look checks 金光 again halfway when the last check is this old (its reads took 150–260 ms in rounds 141–155)
const FLASH_EVERY = 40;
const TICK_COST = 12; // a tick: screenshot ~4 ms + infer ~5–6 ms (infer_bench p50 9 ms, p95 11)
const QIJIE_MS = 250; // the 「气竭」 banner (logged only) looked for this often (was every look)

/** Names of the colour reads for the timing table (by their lower bound, the same array in every copy of the spec). */
const COLOR_NAMES = new Map([
    [GOLD.lower, "lock"], [ICON_WHITE.lower, "icon lit"], [HP_GREY.lower, "hp"], [HP_RED.lower, "hp red"],
    [CHARGE_RED.lower, "charge red"], [DAOSHI_HSV.lower, "daoshi"], [BAR.lower, "bars"], [FLASH.lower, "flash"],
    [BURST.lower, "burst"], [SKY.lower, "sky"], [BOSS_RED.lower, "boss"], [BOSS_LAST.lower, "boss last"],
    [STREAK.lower, "streak"], [RED.lower, "red"], [CURTAIN_DARK.lower, "curtain dark"], [EDGE.lower, "curtain edge"],
    [MOTION_HSV.lower, "motion"], [QI_HSV.lower, "qi"], [PULL_HSV.lower, "red burst"], [CUE_GOLD_HSV.lower, "cue"],
    [GREY.lower, "dead grey"], [QUEST_WHITE.lower, "phase2"], [STAMINA_HSV.lower, "stamina"],
]);

// combat.js's own match() / color() / sleep() run `tick` first (ttc: the frames-to-contact net wants a screenshot every
// ~30 ms, round 31 had 1545 gaps of 70+ ms in 3924 looks with ticks only at screenshots and seen())
// (rounds 130–155 still had 260–770 gaps of 70+ ms a fight, ready 85–93%, 金光 looked for 150–260 ms apart in sched:
// a look / a watch turn took that long. Now reads tick after the call too (touches never: a press is not held up for
// a tick), sleeps wake when the next tick is due, and every call is timed (prof, returned) to find what is slow)
let tick = () => {};
let tickIn = () => 25; // ms until the next tick is due
const globalMatch = globalThis.match, globalColor = globalThis.color, globalSleep = globalThis.sleep;
const globalTouch = globalThis.touch, globalScreenshot = globalThis.screenshot;

// Timing: per call kind [calls, wall ms, native ms (Hit.ms), longest wall ms]; and since the last ttc tick the time
// in timed calls and the slowest of them (blamed for a gap of 70+ ms)
/** @type {Record<string, number[]>} */ let prof = {};
let sinceSum = 0, sinceTopMs = -1, sinceTop = "";
/** @param {string} name @param {number} ms @param {number} [native] */
function profAdd(name, ms, native = 0) {
    const e = (prof[name] ??= [0, 0, 0, 0]);
    e[0]++;
    e[1] += ms;
    e[2] += native;
    if (ms > e[3]) e[3] = ms;
    sinceSum += ms;
    if (ms > sinceTopMs) {
        sinceTopMs = ms;
        sinceTop = name;
    }
}
/** fn(), timed as name. @template T @param {string} name @param {() => T} fn @returns {T} */
function timed(name, fn) {
    const t0 = Date.now();
    try {
        return fn();
    } finally {
        profAdd(name, Date.now() - t0);
    }
}
/** @param {string} t */
const tplName = (t) => "match " + t.replace(/^.*\//, "").replace(/\.png$/, "");
/** @param {ColorOptions} o */
const colorName = (o) => (COLOR_NAMES.get(o.lower) ?? `color ${o.roi ?? ""}`) + (o.connected ? " (parts)" : "");
/** @type {typeof globalMatch} */
// @ts-ignore
const match = (t, o) => {
    releaseDue();
    tick();
    const t0 = Date.now();
    const r = globalMatch(t, o);
    profAdd(tplName(String(t)), Date.now() - t0, r.ms ?? 0);
    tick();
    return r;
};
/** @type {typeof globalColor} */
const color = (o) => {
    releaseDue();
    tick();
    const t0 = Date.now();
    const r = globalColor(o);
    profAdd(colorName(o), Date.now() - t0, r.ms ?? 0);
    tick();
    return r;
};
/** A screenshot, timed. */
const snap = () => timed("screenshot", () => globalScreenshot());
/** The capture stream's latest frame number (no screenshot). */
const frameSeq = () => timed("frame", () => frame().seq);
/** globalSleep, timed (no ticks). @param {number} ms */
const nap = (ms) => timed("nap", () => globalSleep(ms));
// fastTap (args.fastTap; 独夫 default with ttcFast, rounds 183–194): tap() puts the finger down and returns; the lift comes when due (upDue), from the reads,
// sleeps and frame waits, or first thing on the next touch of that contact (which waits out the press time, as the
// blocking tap did). The blocking tap held the loop ~100 ms after the button lit (its mark ~3 frames late): down, 50 ms
// of sleep with ticks, up
let fastTapOn = false;
/** @type {{c: number, at: number} | null} */ let upDue = null;
/** fastTap: lift the tap's finger if due (wait: once its press time is out). */
function releaseDue(wait = false) {
    if (!upDue) return;
    const left = upDue.at - Date.now();
    if (left > 0) {
        if (!wait) return;
        globalSleep(left);
    }
    const c = upDue.c;
    upDue = null;
    timed("touch", () => globalTouch.up(c));
}
/** @param {number | undefined} c */
const releaseFor = (c) => {
    if (upDue && upDue.c === (c ?? 0)) releaseDue(true);
};
/** touches, timed; no ticks around them (a press, a dodge's stick + button, is not held up for one) */
const touch = {
    /** @param {Target} p @param {number} [c] */
    down: (p, c) => (releaseFor(c), timed("touch", () => globalTouch.down(p, c))),
    /** @param {Target} p @param {number} [c] */
    move: (p, c) => (releaseFor(c), timed("touch", () => globalTouch.move(p, c))),
    /** @param {number} [c] */
    up: (c) => (releaseFor(c), timed("touch", () => globalTouch.up(c))),
};
/** sleep, ticking when due (~30 ms); none in its last TICK_COST ms (a press after it is not held up for one). @param {number} ms */
const sleep = (ms) => {
    const end = Date.now() + ms;
    for (;;) {
        releaseDue();
        if (end - Date.now() >= TICK_COST) tick();
        const left = end - Date.now();
        if (left <= 0) return;
        globalSleep(Math.max(1, Math.min(left, tickIn(), upDue ? upDue.at - Date.now() : 25)));
    }
};

/** Tap p (contact 1) for ms; returns when the finger is (fastTap: will be) up. */
let tapDown = false; // a blocking tap's finger is down (ttcFast does not tap then)
function tap(p, ms = 50) {
    touch.down(p, 1);
    if (fastTapOn) {
        upDue = { c: 1, at: Date.now() + ms };
        return upDue.at;
    }
    tapDown = true;
    try {
        sleep(ms);
    } finally {
        tapDown = false;
    }
    touch.up(1);
    return Date.now();
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
 *   curtain?: boolean, lunge?: boolean, defend?: boolean, dodgeDir?: string, cue?: boolean, escape?: boolean, pull?: boolean, flareDelay?: number, closeIn?: boolean, motion?: boolean, blind?: boolean, motionDelays?: number[], weapon?: string, flareDelays?: number[], motionTh?: number, chargeSafeP?: number, ttcFar?: number, hitParryMs?: number[], flare2?: boolean, curtainDodge?: boolean, ttcInput?: InferOptions, ttcHold?: number, reparryMs?: number, okEscape?: boolean, okEscapeDir?: string, failEscape?: boolean, chargeOkWait?: number, window?: boolean, windowMs?: number, outside?: string, windowGuard?: boolean, hotHoldMs?: number, tangHoldMs?: number, tangHeavy?: string, qishuParryMs?: number, grabEscape?: boolean, grabDodgeMs?: number, yolo?: boolean | string, yoloTh?: number, yoloDelay?: number, punish?: boolean, execAfter?: number, execHoldMax?: number, sched?: boolean, weakPlan?: boolean, smartDodge?: boolean, ttc?: boolean | string, ttcBins?: number[], ttcTh?: number, curtainEvery?: number, pre?: boolean, flareClass?: boolean | string, flareGrabAt?: number, flareSlamAt?: number, flareLagMs?: number, flareGrabTh?: number, flareOtherAt?: number, sweepNet?: boolean | string, okRepress?: boolean, okRepressMs?: number, ttcFast?: boolean, redEvery?: number, waitGuard?: boolean, okFreshQi?: boolean, fastTap?: boolean}} [args]  probe: only report what is seen; dodge: false leaves 金光 alone;
 *   boss: a boss fight (over when its bar is gone and the icons are back); foe: "dufu" (独夫: no burst / sky
 *   警戒, its flare for 金光, the rest below on but parryHits; over when dead); potions: drinks at most (独夫 1); parryHits: 卸势 the blow after
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
    const maxDrinks = args.potions ?? (dufu ? 1 : Infinity);
    const parryHitsOn = args.parryHits ?? false; // round 2: no fewer hits after it (12 of 20 hit again within 1 s; 26 of 48 without)
    const redOn = args.red ?? dufu;
    const curtainOn = args.curtain ?? dufu;
    const defendOn = !!args.defend; // practice: no blows, only 卸势 / dodges, every press marked
    // sched with outside "defend" (see outsideMode): defend()'s guarding between windows (and in them, windowGuard)
    const guardOn = !!args.sched && (args.window ?? true) && (args.outside ?? "defend") === "defend";
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
    /** @type {number[]} */ const flareDelays = args.flareDelays ?? [80]; // (130 dropped, rounds 165–175: late)
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
    /** @type {{t0: number, last: number, pMax: number, n: number, why: Record<string, number>, det: Record<string, string>, state: string, where: string, pressed: boolean} | null} */
    let miss = null; // the open ttc episode (p ≥ ttcTh)
    /** @type {Record<string, number>} */ const missCounts = {}; // episodes with no 卸势, by their main reason
    let flashResting = false; // in the rest after a 金光 dodge
    let windupStaleMs = 0; // windupNow(): its p ≥ ttcTh was this old (not acted on), 0 if not
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
    const okEscape = args.okEscape ?? (defendOn || guardOn); // defend: dodge away right after a good 卸势
    // failEscape (off): a ttc 卸势 with no sign of working FAIL_ESCAPE_MS after it while ttc still says a blow is near:
    // dodge (rounds 85–87: 66 of 233 failed ttc 卸势 were hit within 30 frames, 20 of them 12–17 frames after the press)
    // (rounds 88–90 with it: 7.8 hits a minute against 10.3, 没覆盖 4.2 → 2.1, lives 303–406 s: on by default in defend)
    const failEscape = args.failEscape ?? (defendOn || guardOn);
    let failEscapes = 0;
    const okEscapeDir = args.okEscapeDir ?? "back";
    let diamondAtTap = false;
    let okFreshDone = false; // okFreshQi: this 卸势's fresh sign has come
    let qiTap = -1; // okFreshQi: 真气 read right after the tap
    let qiFreshRead = "";
    let inDodge = false; // waitGuard: in dodge() (no failEscape from its waits)
    let dodgePressAt = 0; // the last dodge press
    let okEscapeAt = 0;
    let okEscapes = 0;
    let qijieOn = false; // the 「气竭」 banner showing
    let qijieAt = 0;
    let qijieLookAt = 0;
    let ttcLastAt = 0;
    const punishOn = args.punish ?? false; // defend: all out in 衰弱期 (处决 is tapped in any mode)
    const schedOn = args.sched ?? false; // the fight by cooldowns (schedRound), 衰弱期 by plan
    const planOn = args.weakPlan ?? schedOn; // 衰弱期: 横刀 skills / 陌刀 蓄力, then 处决 (else punish: 横刀 all out)
    // 处决 held this long: plan, from when it shows (EXEC_PLAN_AFTER_MS); punish without plan, from 衰弱 read
    const execAfter = args.execAfter ?? (planOn ? EXEC_PLAN_AFTER_MS : EXEC_AFTER_MS);
    const execHoldMax = args.execHoldMax ?? EXEC_HOLD_MAX_MS; // plan: 处决 held this long at most (from when it shows)
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
    // flareClass: true (or a model path under model/), 独夫 only; flareGrabAt / flareSlamAt: frames from the flare's
    // first to the dodge showing; flareLagMs: press → seen on screen
    // (on by default for 独夫 since rounds 168–170; false turns it off)
    const flareModel = !dufu || args.flareClass === false ? null : typeof args.flareClass === "string" ? args.flareClass : FLARE_MODEL;
    const flareGrabTh = args.flareGrabTh ?? FLARE_GRAB_TH;
    const sweepModel = !dufu || args.sweepNet === false ? null : typeof args.sweepNet === "string" ? args.sweepNet : SWEEP_MODEL;
    /** @type {number[] | null} */ let sweepProbs = null; // its latest probs, when
    let sweepAt = 0;
    let sweepDue = 0; // a dodge to go (the read's time), 0: none
    let sweepDodgeAt = 0;
    let sweepTriggers = 0, sweepDodges = 0, sweepSkips = 0;
    const nearLabel = "sweep coming"; // the reason no 卸势 went
    const okRepress = args.okRepress ?? dufu; // (rounds 174–176 with okFreshQi: 8.5 hits a minute against 10.1 / 10.2)
    const okRepressMs = args.okRepressMs ?? OK_REPRESS_MS;
    // ttcFast (独夫 default, with fastTap; rounds 174–176: 17.4 "unseen" episodes a minute, 50 of them hit within 20 frames: p ≥ ttcTh read
    // inside 金光 / 红刺 / 幕布 reads, flareKind, a look… and gone before a decision point): defendWindup's decision in
    // ttcTick() itself, when guarding and in none of: a dodge, a 金光 (from seeing it to the end of its rest), a drink,
    // 起幕布, 衰弱 / its plan, a blocking tap's finger down, 红光's wait; the blocks (just pressed, dodge, sweep coming,
    // ttcHold) as always, failEscape's case left to defendWindup. Pressed: "ttc fast …" (fastTap keeps it from holding
    // ttc up 50 ms). Rounds 183–194 (6 against 6): 7.7 hits a minute against 7.4, but without 金光 5.6 against 6.3:
    // 按了·晚 0.79 → 0.47, 被挡 0.64 → 0.44, model ≥ 0.5 → button lit median 5 → 4 frames; the 金光 that ate it were
    // slams (0.66 a slam against 0.20; 0.62 over rounds 195–206 without ttcFast: the 0.20 was luck)
    const ttcFast = args.ttcFast ?? dufu;
    let ttcBusy = false; // ttcTick() running its fast decision (no tick inside it)
    let flaring = false; // flash() from seeing a 金光 to the end of its rest
    let hitParryTapping = false; // hitParry() pressing its 卸势
    let redWaiting = false; // red(): between 红光 and its 卸势
    let fastPresses = 0;
    let parryPressAt = 0; // the last 卸势's press (parryTapAt is when its finger is up)
    let repressDue = 0; // okRepress: the second press is due then (0: none)
    let represses = 0;
    const flareGrabAt = args.flareGrabAt ?? FLARE_GRAB_AT;
    const flareSlamAt = args.flareSlamAt ?? FLARE_SLAM_AT;
    const flareOtherAt = args.flareOtherAt ?? FLARE_OTHER_AT;
    let lastFlareDodge = 0; // a 金光 dodge ended (FLASH_MS from it)
    /** @type {{tf: number, age: number, seenAt: number, fk: {kind: string, p: number[] | null, n: number} | null} | null} */
    let flarePending = null; // a 金光 seen during another dodge
    const flareLagMs = args.flareLagMs ?? FLARE_LAG_MS;
    /** @type {Record<string, number>} */ const flareKinds = {}; // 金光 by kind (other / grab / slam / ? not ready)
    let flareGrabs = 0, flareSlams = 0;
    let grabDodgeAt = 0; // grabEscape: dodge then
    const chargeSafeP = args.chargeSafeP ?? CHARGE_SAFE_P;
    const chargeOkWait = args.chargeOkWait ?? CHARGE_OK_WAIT_MS;
    const windowOn = args.window ?? true; // sched: 蓄力 in the buff window only (see WINDOW_MS)
    const windowMs = args.windowMs ?? WINDOW_MS;
    const hotHoldMs = args.hotHoldMs ?? HOT_HOLD_MS; // 蓄力 under 热血难凉: held this long, no red
    // sched window: between windows "idle" (defence only) or "tang" (横刀 冢上霜 / 拨雪寻春: rounds 57–62 no better,
    // and the 重击 after it took 0 px; kept as an option until the teacher's demo)
    // "defend": defend()'s loop between windows (guardOut: 卸势 after hits at hitParryMs, ttc 卸势 with ttcHold,
    // okEscape / failEscape, its steps in, no blows) on args.weapon (横刀: a good 卸势 shows the diamond at once, 陌刀
    // only a 真气 step read every QI_MS, late for okEscape). Rounds 109–111 (defend) ~8.4 hits a minute; idle outside lost
    // 1.0–1.8 %/s (51–53) with motionCue (no hold, no escapes, no 卸势 after hits)
    const outsideMode = args.outside ?? "defend"; // rounds 118–123: 16.0 hits a minute against 18.9, 1.45%/s against 1.67 (idle 112–117)
    // windowGuard (default with outside "defend"): the same in the window (横刀 part, between 蓄力), never while a 蓄力
    // is held or its slash is coming (guardNow)
    const windowGuard = args.windowGuard ?? guardOn;
    const tangHoldMs = args.tangHoldMs ?? TANG_HOLD_MS;
    let tangs = 0, tangHeavies = 0;
    // 奇术 (箫吟千浪): its recovery cut by 卸势 this long after the tap (teacher: ~1.5 s may do; it was 2 s); cast only in
    // a quiet moment, else later (teacher: hit a lot while casting it)
    // 1.5 s (rounds 38–41) took 7.4% of our health per cast in the 3 s after it, 2 s (33–37) 4.3%: back to 2 s
    const qishuParryMs = args.qishuParryMs ?? 2000;
    let burstAt = 0; // 横刀 爆发 went out
    let inWindow = false; // sched window: the 横刀 part and the 蓄力 after it
    let execHold = false; // punish: 处决 seen is not tapped yet
    let execShownAt = 0; // plan: 处决 first seen in this 衰弱 (the plan's clock; 0: not yet)
    let execFree = true; // plan: 处决 may be tapped (else held, up to execHoldMax)
    let execTapAt = 0;
    let execMiss = 0; // looks in a row without 处决 since it showed (held)
    let execMissAt = 0;
    let execQiMarkAt = 0;
    let planRan = false; // the plan has run in this 衰弱 (once each)
    let planning = false;
    const curtainEvery = args.curtainEvery ?? CURTAIN_EVERY;
    const redEvery = args.redEvery ?? RED_EVERY;
    // waitGuard (独夫 default; offline attribution data/tmp/dufu_attr: 「被挡·原因不明」 0.71 a minute, most in a 金光 dodge's
    // rest, around steps and dodges): defendWindup() (ttcHold, failEscape) on every new frame of the waits that did
    // not look for blows: smartDodge's wait for the health (1 s) and the rest after a 金光 dodge. Inside a dodge no
    // failEscape (its own dodges go on), and "after a dodge" counts from the last dodge press. (A step / the walk after
    // a dodge is no such wait: stride() and then watch(), which runs it already). Rounds 196–205 (4 against 4 + 6):
    // 「unread: 金光 rest」 2.6–3.0 a minute → 0.04, 「unread: dodge」 3.3–4.0 → 1.5, 被挡 0.64–1.07 → 0.23; its 71 卸势
    // in those waits hit 14%, no failEscape there. In all 8.3 a minute against 9.3 (both in the noise)
    const waitGuard = args.waitGuard ?? dufu;
    // okFreshQi (独夫 default, with okRepress): a 卸势 seen to work counts as fresh (okEscape, okRepress) also when 真气 read right after the
    // tap has gone down QI_STEP since (rounds 85–111: 59% of the good ones had the diamond still up from the last one
    // at the press, 13% showed only 反击: neither counted). 真气 is read on every look while pending, PARRY_OK_MS at most
    const okFreshQi = args.okFreshQi ?? dufu;
    fastTapOn = args.fastTap ?? dufu;
    upDue = null;
    // pre (default on): a connected colour read over a big part of the screen (金光, 红光) is done only when a plain
    // count of that colour there could pass it (a part w px wide has at least w px). Lossless. Rounds 162–164: the
    // count let 金光 through 48% of the time (22 ms the count, 32 the parts), 红光 0.5% (40 / 47); the curtains' dark
    // 96% and the orange streak 94%: dropped there. The counts go in halves (exact; ttc ticks between)
    const preOn = args.pre ?? true;
    prof = {};
    sinceSum = 0;
    sinceTopMs = -1;
    sinceTop = "";
    /** ms histograms, 5 ms buckets (the last: 1 s and over) */
    const hist = () => ({ b: new Array(201).fill(0), n: 0, max: 0 });
    /** @param {{b: number[], n: number, max: number}} h @param {number} ms */
    const histAdd = (h, ms) => {
        h.b[Math.min(200, Math.max(0, Math.floor(ms / 5)))]++;
        h.n++;
        if (ms > h.max) h.max = ms;
    };
    /** @param {{b: number[], n: number, max: number}} h */
    const histOut = (h) => {
        const q = (p) => {
            let c = 0;
            for (let i = 0; i < h.b.length; i++) if ((c += h.b[i]) >= p * h.n) return Math.min(h.max, (i + 1) * 5);
            return h.max;
        };
        const over = (ms) => h.b.slice(Math.floor(ms / 5)).reduce((a, b) => a + b, 0); // (≥ ms, to 5 ms)
        return h.n ? { n: h.n, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: h.max, over70: over(70), over100: over(100), over150: over(150) } : { n: 0 };
    };
    const ttcHist = hist(); // ms between ttc inferences
    const flashHist = hist(); // ms between looks for 金光 (gap())
    /** @type {Record<string, number[]>} */ const ttcBlame = {}; // a gap of 70+ ms: "slowest call | where" → [gaps, ms, max ms, slowest call ms]
    let ttcUntracked = 0; // ms of those gaps outside timed calls (JS, waits of the prelude, the OS)
    // stream frames skipped between two inferences: 0, 1, 2, 3, 4, 5+ (at 26–29 fps one skipped is a 70–76 ms gap)
    const ttcSkips = [0, 0, 0, 0, 0, 0];
    let ttcSeq0 = -1, ttcT0 = 0; // the first frame inferred, when (the stream's frames over the run: its fps)
    /** @type {Record<string, number>} */ const ttcMissing = {}; // not ready: which frame offset was missing
    if (ttcModel) {
        tick = () => ttcTick();
        tickIn = () => Math.max(3, Math.min(25, ttcAt + TTC_TICK_MS - Date.now()));
    }
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
    let ownDrinks = 0; // drinks after a tap of ours: args.potions limits these (the game drinks by itself at low health too)
    /** @type {number | null} */ let tapHp = null; // health at the last potion tap, until it took or POTION_TOOK_MS passed
    /** @type {number | null} */ let lastHp = null; // health last read
    let hitAt = 0; // a plain blow last seen landing (health down at once)
    let hitParrying = false; // hitParry() waiting (its watch() does not start another)
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
    let potionTapAt = 0; // our last potion tap (a drink with none before it is the game's own)
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
    /** @type {number | null} */ let bossLeft = null; // the boss bar's last reading (px of 383), returned
    let bossLowReads = 0; // reads in a row at ≤ CLEAR_LOW_PX
    let bossFullReads = 0; // and at ≥ BOSS_FULL
    let bossLast = false; // the bar has been down to its last 10% (a refill now is phase two)
    let phase2N = 0; // looks in a row whose quest line read 阶段二
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
    let img = snap();
    let loopSeq = -1; // the newest frame a loop turn has started on (nextShot)

    // reads kept per frame (Image.seq: the same frame, the same pixels): weapon(), parryOk(), parryTap() and the like
    // read the same buttons again on one frame
    /** @type {Map<string, [number, any]>} */ const memo = new Map();
    /** fn() on img, once per frame. @template T @param {string} key @param {(im: Image) => T} fn @returns {T} */
    const perFrame = (key, fn) => {
        const im = img;
        const m = memo.get(key);
        if (m && m[0] === im.seq) return m[1];
        const v = fn(im);
        memo.set(key, [im.seq, v]);
        return v;
    };

    const seen = (k) => perFrame(k, (im) => match(T[k][0], { image: im, roi: T[k][1], threshold: THRESHOLD }).hit);

    const hp = () => perFrame("hp", (im) => health(im));

    /** Enemy health bars on the current screenshot: their total length, 0 if none. */
    function bars() {
        const hit = color({ ...BAR, image: img, roi: BAR_ROI, count: 25, connected: true });
        if (!hit.hit) return 0;
        return hit.results
            .filter(({ box: [, , w, h], count }) => w >= 25 && h <= 3 && (count ?? 0) >= 0.7 * w * h)
            .reduce((s, { box: [, , w] }) => s + w, 0);
    }

    /**
     * The boss bar: px of red left, 0 when used up (pale left end), null when there is none. The run from the left
     * end, gaps up to BOSS_GAP (round 115: red bits of the frame's right end, lit by our 爆发, read as a full bar
     * (323 → 384) right after a drink to 100%, and the restart check ended the fight as "dead"; round 113 read 372 for
     * 25 this way; the rightmost bit was taken then).
     */
    function boss() {
        return perFrame("boss", bossOn);
    }
    /** @param {Image} im */
    function bossOn(im) {
        const red = color({ ...BOSS_RED, image: im, roi: BOSS_ROI, count: 10, connected: true });
        if (red.hit) {
            const boxes = red.results.map((m) => m.box).sort((p, q) => p[0] - q[0]);
            if (boxes[0][0] <= BOSS_ROI[0] + 2) {
                let right = boxes[0][0] + boxes[0][2];
                for (const [x, , w] of boxes.slice(1)) {
                    if (x - right > BOSS_GAP) break;
                    right = Math.max(right, x + w);
                }
                return right - BOSS_ROI[0];
            }
        }
        if (color({ ...BOSS_LAST, image: im, roi: BOSS_LAST_ROI, count: 48 }).hit) return 0;
        return null;
    }

    /** 刀势: blades lit on the weapon bar, 0–5 (DAOSHI_*). */
    function daoshi() {
        const im = img;
        return DAOSHI_SLOTS.filter(([x, w]) => color({ ...DAOSHI_HSV, image: im, roi: [x, 302, w, 7], count: 3 }).hit).length;
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
        const im = img; // (a read may tick: the next one on the same frame)
        return seen("mdash") && color({ ...ICON_WHITE, image: im, roi: MDASH_LIT_ROI, count: DASH_LIT_PX }).hit;
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
        const at = args.boss && !defendOn ? (new Error().stack ?? "").split(String.fromCharCode(10)).slice(2, 4).map((l) => l.trim().replace(/^at /, "")).join(" < ") : "";
        if (lastCheck) {
            const ms = now - lastCheck;
            maxGap = Math.max(maxGap, ms);
            histAdd(flashHist, ms);
            if (args.boss && !defendOn && ms > GAP_LOG_MS) log(`no look for 金光 in ${ms} ms: ${lastAt} → ${at}`);
        }
        lastCheck = now;
        lastAt = at;
    }

    /** A 金光 line on the current screenshot (boss fights: as wide as 2.5 times as high, 1–3 frames sooner). */
    function seeFlash() {
        const im = img; // (a read may tick: the streak on the same frame)
        if (!enough(FLASH, FLASH_ROI, 230, im)) return false; // a part ≥ 230 wide
        const hit = color({ ...FLASH, image: im, roi: FLASH_ROI, count: 150, connected: true });
        const ratio = args.boss ? 2.5 : 3.5;
        if (!(hit.hit && hit.results.some(({ box: [, , w, h], count }) => w >= 230 && w >= ratio * h && (count ?? 0) >= 0.15 * w * h))) return false;
        return !dufu || streak(STREAK, 150, 2, im, false); // 独夫: the flare's orange streak, not our own gold
    }

    /** A run of colour c over the scene at least minW wide and ratio times as wide as high. */
    function streak(c, minW, ratio, im = img, pre = true) {
        if (pre && !enough(c, FLASH_ROI, Math.max(minW, 100), im)) return false;
        const hit = color({ ...c, image: im, roi: FLASH_ROI, count: 100, connected: true });
        return hit.hit && hit.results.some(({ box: [, , w, h] }) => w >= minW && w >= ratio * h);
    }

    /**
     * pre: at least n px of colour c in roi of im (a plain count, one number), before a connected read whose parts
     * need that many (a part w wide has ≥ w px); always true with args.pre false.
     * @param {ColorOptions} c @param {Box} roi @param {number} n @param {Image} im
     */
    function enough(c, roi, n, im) {
        return !preOn || countAtLeast(c, roi, n, im);
    }

    /**
     * At least n px of colour c in roi of im, counted in `parts` bands of rows (exact: the counts add up; one big read
     * of 20–40 ms held ttc up, rounds 162–164; the reads tick between). Stops once n is reached.
     * @param {ColorOptions} c @param {Box} roi @param {number} n @param {Image} im
     */
    function countAtLeast(c, roi, n, im, parts = 2) {
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

    /**
     * 起幕布's edges (EDGE over EDGE_ROI, parts ≥ 300 px), read in EDGE_STRIPS strips side by side, overlapping by
     * EDGE_OVERLAP px, a part touching a strip's inner side dropped (it may go on in the next one). An edge (≤ 30 wide)
     * lies whole in some strip off its inner sides, and a part off them is the whole part: the same edges as one read
     * (rounds 162–164: one read 51 ms, the most blamed for ttc gaps; the reads tick between).
     * @param {Image} im
     */
    function edgeParts(im) {
        const [x0, y0, W, H] = EDGE_ROI;
        const sw = Math.ceil(W / EDGE_STRIPS);
        /** @type {Match[]} */ const out = [];
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
        redWaiting = true;
        const dodged = watchFor(RED_DELAY);
        redWaiting = false;
        if (dodged) return true; // a 金光 meanwhile: dodged instead
        parryTap("红光");
        lastParry = Date.now();
        parries++;
        lastCheck = Date.now();
        lastAt = "a 卸势";
        return true;
    }

    /**
     * The 独夫 checks besides 金光, at most one a look (round 2: with both on every look, a look took 150–267 ms):
     * 红刺 / 红光 every RED_EVERY, else 起幕布 (curtainDue). (The red stab's read no longer goes with another one on
     * the same look: each comes a turn later at most, ~35 ms.)
     */
    function extra() {
        const now = Date.now();
        // a 蓄力 held or its slash coming (a big red arc of our own): only 金光 may cut it (teacher); 起幕布 still
        if (charging || now < slashUntil) return curtainOn && curtainDue(now) ? curtain() : false;
        if (pullOn && now - redBurstAt >= redEvery) {
            redBurstAt = now;
            return redBurst();
        }
        if (redOn && now - redAt >= redEvery) return red();
        if (curtainOn && curtainDue(now)) return curtain();
        return false;
    }

    /** 起幕布 to be looked for: every curtainEvery ms, every look while a sighting waits for its confirmation. */
    function curtainDue(now = Date.now()) {
        const pending = curtainDodge ? curtainSeen.length > 0 && now - curtainSeen[curtainSeen.length - 1] <= CURTAIN_CONFIRM_MS : curtainSeenN > 0;
        return now - curtainAt >= (pending ? 0 : curtainEvery);
    }

    /** Wait ms looking for 金光 only (dodging it); true if it did. */
    function watchFor(ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            img = nextShot();
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
        const im = img; // (a read may tick: all on the same frame)
        // the edges first: in 113 frames of the first fight, the dark parts in 77% of them
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
        if (!curtainDue(t)) return false;
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
            img = nextShot();
            const now = Date.now();
            gap(now);
            deadCheck();
            if (sweepDodge()) continue;
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
    /** @param {{lag?: number}} [o] lag: joystick → tap (none by default) */
    function dodge(times = 2, again = DODGE_AGAIN_MS, dir = "back", why = "", o = {}) {
        const lag = o.lag ?? 0;
        const flareDodging = why.startsWith("金光");
        inDodge = true;
        letGo(); // a held 蓄力
        touch.down(STICK, 0);
        touch.move(dir === "left" ? LEFT : dir === "right" ? RIGHT : dir === "forward" ? FORWARD : BACKWARD, 0);
        if (lag) sleep(lag);
        const smart = smartDodge && why.startsWith("金光");
        // flare2 (args.flare2): the second 金光 dodge goes whatever happened (the grab lunges at +15–20, after the first
        // one is over; the hit that would make smartDodge go again is seen too late, ~+25–30)
        const firstSmart = flare2 && why.startsWith("金光") ? 2 : 1;
        let h0 = smart ? hp() : null;
        let t0 = Date.now();
        /** The dodge tap. */
        const dodgeTap = () => {
            dodgePressAt = Date.now();
            touch.down(DODGE, 2);
            sleep(50);
            touch.up(2);
        };
        for (let i = 0; i < times; i++) {
            if (i >= firstSmart && smart) {
                // one that worked needs no more (teacher): again only when hit since, and stamina left
                let hitSince = false;
                while (Date.now() - t0 < SMART_DODGE_MS) {
                    img = nextShot();
                    guardWait();
                    const h = hp();
                    if (h0 != null && h != null && h < h0 - 0.025) {
                        hitSince = true;
                        break;
                    }
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
            dodgeTap();
            mark("dodge", `${dir} ${i + 1}/${times}${why ? " " + why : ""}`);
            if (!flareDodging) flareInDodge();
        }
        touch.up(0);
        inDodge = false;
        lastDodge = Date.now();
        lastCheck = lastDodge; // the dodging is not a gap
        lastHit = 0; // dodged back, out of reach: walk in again at once
        img = shot();
        heal();
        lastAt = "a dodge";
        dodges++;
    }

    /**
     * In a dodge that is not a 金光's: 金光 on a new frame (a new screenshot) is noted, with its kind
     * from that frame alone (flareClass), for flash() to dodge right after this one (flarePending).
     */
    function flareInDodge() {
        if (!dodgeOn || flarePending) return;
        img = nextShot();
        const im0 = img;
        if (!seeFlash()) return;
        const fk = flareModel ? flareKind(im0, 0) : null;
        flarePending = { tf: im0.time - (im0.age_ms ?? 0), age: im0.age_ms ?? 0, seenAt: Date.now(), fk };
        mark("flare", `seen in a dodge${fk ? ` (${fk.kind})` : ""}`);
    }

    /**
     * 金光 on the current screenshot: dodge, then strike nothing for a while. Out of a 警戒 (below) a dodge comes late:
     * every live one was hit (pressed 3–10 frames after the flash, the blows land from +12; one during a held 蓄力
     * did not come out; 卸势 first only cost 2–3 frames more).
     */
    function flash() {
        const now = Date.now();
        gap(now);
        if (!dodgeOn) return false;
        const pend = flarePending && now - flarePending.seenAt <= FLARE_PENDING_MS ? flarePending : null;
        flarePending = null;
        if (!pend && now - lastFlareDodge < FLASH_MS) return false;
        const im0 = img; // the frame seeFlash() looks at
        if (!pend && !seeFlash()) return false;
        const seenAt = pend ? pend.seenAt : Date.now();
        flaring = true;
        log(pend ? "金光 seen in a dodge: dodge" : "金光: dodge");
        // 独夫: its blows land +16–26 frames after the flare; our dodges showing at +6–8 were all hit (5 of 5), the
        // ones at +12–13 were not (2 of 2): a moment later, and closer together
        // defend: the delay cycles too (flareDelays; changing every 3 so each meets each way), to learn which works
        const fd = defendOn ? flareDelays[Math.floor(flashes / 3) % flareDelays.length] : flareDelay;
        const fk = pend ? pend.fk : flareModel ? flareKind(im0, seenAt + Math.max(0, fd - 8)) : null;
        if (fk) flareKinds[fk.kind] = (flareKinds[fk.kind] ?? 0) + 1;
        const pct = (/** @type {number[] | null} */ p) => (p ? p.map((x) => Math.round(x * 100)).join("/") : "?");
        const tf = pend ? pend.tf : im0.time - (im0.age_ms ?? 0); // the flare frame's capture
        const age = Math.round(pend ? pend.age : im0.age_ms ?? 0);
        const inDodgeNote = pend ? ", seen in a dodge" : "";
        if (fk && (fk.kind === "grab" || fk.kind === "slam")) {
            const grab = fk.kind === "grab";
            const n = grab ? flareGrabs++ : flareSlams++;
            // grab: left / right in turn; slam: back, left, back, right
            const dir = grab ? (n % 2 ? "right" : "left") : n % 2 ? (Math.floor(n / 2) % 2 ? "right" : "left") : "back";
            const at = tf + ((grab ? flareGrabAt : flareSlamAt) * 1000) / 30 - flareLagMs;
            sleep(Math.max(0, at - Date.now()));
            const pressAt = Date.now();
            mark("flare", `${fk.kind} p ${pct(fk.p)} (${fk.n} frames), ${dir}, pressed +${pressAt - seenAt} ms after seen ` +
                `(+${pressAt - tf} from its frame, planned +${Math.round(at - tf)}, frame age ${age} ms)${inDodgeNote}`);
            flareDodgeAt = pressAt;
            dodge(1, FLARE_AGAIN_MS, dir, `金光 ${fk.kind} +${pressAt - seenAt}`);
        } else if (fk && fk.kind === "other") { // at its frame too (flareOtherAt), then the dodges as before
            const at = tf + (flareOtherAt * 1000) / 30 - flareLagMs;
            sleep(Math.max(0, at - Date.now()));
            flareDodgeAt = Date.now();
            const dir = nextDir();
            mark("flare", `other p ${pct(fk.p)} (${fk.n} frames), ${dir}, pressed +${flareDodgeAt - seenAt} ms after seen ` +
                `(+${flareDodgeAt - tf} from its frame, planned +${Math.round(at - tf)}, frame age ${age} ms)${inDodgeNote}`);
            dodge(FLASH_DODGES, dufu ? FLARE_AGAIN_MS : DODGE_AGAIN_MS, dir, `金光 other +${flareDodgeAt - seenAt}`);
        } else {
            if (dufu) sleep(Math.max(0, seenAt + fd - Date.now()));
            flareDodgeAt = Date.now();
            const dir = nextDir();
            if (fk) mark("flare", `${fk.kind} p ${pct(fk.p)} (${fk.n} frames), as before: ${dir}, pressed +${flareDodgeAt - seenAt} ms ` +
                `after seen (+${flareDodgeAt - tf} from its frame, frame age ${age} ms)${inDodgeNote}`);
            dodge(FLASH_DODGES, dufu ? FLARE_AGAIN_MS : DODGE_AGAIN_MS, dir, `金光 +${fd}`);
        }
        lastFlareDodge = Date.now(); // (as lastDodge was: FLASH_MS runs out in the rest below)
        const rest = Date.now() + DODGE_REST_MS;
        flashResting = true;
        while (Date.now() < rest) {
            img = nextShot();
            if (sweepDodge()) continue;
            execute();
            guardWait();
        }
        flashResting = false;
        flaring = false;
        // (a 2.5 s watch for the red stab after each 金光 was here: it looked for nothing else and struck nothing,
        // round 11: 金光 unwatched for 2.4 s; the stab is looked for on every look instead, redBurst())
        lastCheck = Date.now();
        lastAt = "a dodge";
        return true;
    }

    /**
     * flareClass: the 金光's kind, p [other, grab, slam] averaged over its frame im0 and up to FLARE_MORE_FRAMES newer
     * ones while there is time (until); kind "?" when none was ready (a frame n-2 / n-4 missing).
     * @param {Image} im0 @param {number} until
     */
    function flareKind(im0, until) {
        /** @type {number[][]} */ const ps = [];
        const run = (/** @type {Image} */ im) => {
            const t0 = Date.now();
            const r = infer(/** @type {string} */ (flareModel), { ...TTC_OPTS, image: im });
            profAdd("flare3", Date.now() - t0, r.ms.total);
            if (r.ready && r.probs) ps.push(r.probs);
        };
        run(im0);
        let last = im0.seq;
        for (let more = 0; more < FLARE_MORE_FRAMES && Date.now() < until;) {
            let im = img;
            if (im.seq <= last) {
                if (frameSeq() <= last) {
                    nap(3);
                    continue;
                }
                im = img = shot();
            }
            last = im.seq;
            run(im);
            more++;
        }
        if (!ps.length) return { kind: "?", p: null, n: 0 };
        const p = [0, 1, 2].map((k) => ps.reduce((a, q) => a + (q[k] ?? 0), 0) / ps.length);
        return { kind: p[1] >= flareGrabTh ? "grab" : p[2] >= FLARE_P ? "slam" : "other", p, n: ps.length };
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
        if (guarding || drinking || holding() || now < ownFxUntil || stillUntil === Infinity || now - lastDodge < 400) return false;
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
        if (!weak && weakEmpties >= 2) weakStart("");
        else if (weak && q > QI_EMPTY) {
            weak = false;
            execFree = true;
            const how = execShownAt ? `, 处决 showed ${now - execShownAt} ms ago${execTapAt ? `, tapped ${now - execTapAt} ms ago` : ", not tapped"}` : ", 处决 never showed";
            log(`衰弱 over after ${now - weakSince} ms${how}`);
            mark("weak", `end after ${now - weakSince} ms (真气 back${how})`);
        }
    }

    /** 衰弱 from now (真气 read empty, or 处决 seen first). @param {string} why */
    function weakStart(why) {
        weak = true;
        weakSince = Date.now();
        weaks++;
        execShownAt = execTapAt = execMiss = 0;
        planRan = false;
        execFree = !planOn;
        log(`衰弱${why ? ` (${why})` : ""}, all out`);
        mark("weak", `start${why ? ` (${why})` : ""}`);
    }

    /** 衰弱 for real: 真气 empty, and with the plan the 处决 button seen too (round 120: 真气 read 0, the boss striking). */
    function weakNow() {
        return weak && (!planOn || execShownAt > 0);
    }

    /**
     * Dead: end the fight here. 独夫: the grey screen (boss bar and health bar gone, looked at every DEAD_MS), or,
     * missed (round 6: both deaths went by while it was in a drink's loop, which looked for nothing but 金光; the grey
     * lasted 3.7 and 6 s), the restart itself: the boss bar back to full (≥ BOSS_FULL px) and our health full after
     * the bar had been down to ≤ BOSS_DOWN. Phase one cleared (the quest line's 阶段二, or the bar full again after
     * its last 10%): "cleared". 镇关吼 (not dufu): the same grey screen is its 重伤, with the instance's panel
     * (再次挑战 / 继续) on it, and nothing starts over by itself (2026-10-14: a death was read as "boss gone" and the
     * chest search ran over the panel, a tap restarting the arena) — the bar gone and the grey (or the panel) ends
     * it. Called from every loop.
     * @param {number | null | undefined} [b] the boss bar's red px if just read
     */
    function deadCheck(b) {
        const now = Date.now();
        if (now - deadAt < DEAD_MS) return;
        deadAt = now;
        if (dufu) {
            if (args.boss) {
                phase2N = phase2() ? phase2N + 1 : 0;
                if (phase2N >= 2) cleared("阶段二 in the quest line");
            }
            if (b === undefined) b = boss();
            if (b != null) {
                bossLow = Math.min(bossLow, b);
                bossLowReads = b <= CLEAR_LOW_PX ? bossLowReads + 1 : 0;
                if (bossLowReads >= CLEAR_LOW_READS) bossLast = true;
                bossFullReads = b >= BOSS_FULL ? bossFullReads + 1 : 0;
                const full = bossFullReads >= BOSS_FULL_READS;
                if (full && bossLast) cleared("the boss bar full again after its last 10%");
                if (full && bossLow <= BOSS_DOWN && (hp() ?? 0) >= 0.95) {
                    log("the arena started over (dead, not seen)");
                    throw new Over("dead");
                }
                deadSeen = 0;
                return;
            }
        } else {
            if (!args.boss) return; // the strongholds' 重伤 (疗伤) is looked at in look()
            if (b === undefined) b = boss();
            if (b != null) { // the bar shows: alive
                deadSeen = 0;
                return;
            }
        }
        // 重伤: the grey screen (both bars gone), or the instance's panel (再次挑战 / 继续)
        const dead = hp() == null && (countAtLeast(GREY, GREY_ROI, Math.round(0.85 * GREY_ROI[2] * GREY_ROI[3]), img)
            || match("result_again.png", { image: img, roi: [800, 640, 280, 80], threshold: 0.8 }).hit
            || match("result_continue.png", { image: img, roi: [900, 640, 180, 80], threshold: 0.8 }).hit);
        deadSeen = dead ? deadSeen + 1 : 0;
        if (deadSeen >= 2) throw new Over("dead");
    }

    /** The quest line reads 「…阶段二」 (its last character 二, not 一: CLEAR_*). */
    function phase2() {
        const im = img; // (a read may tick: all three on the same frame)
        const n = (/** @type {Box} */ roi) => {
            const h = color({ ...QUEST_WHITE, image: im, roi, count: 1 });
            return h.hit ? h.results[0]?.count ?? 0 : 0;
        };
        return n(PHASE2_TOP) >= 8 && n(PHASE2_BOTTOM) >= 10 && n(PHASE1_MID) <= 2;
    }

    /** @param {string} why */
    function cleared(why) {
        log(`phase one cleared: ${why}`);
        mark("cleared", why);
        throw new Over("cleared");
    }

    /**
     * escapeOn: a blow just landed (health down at once): dodge sideways (left and right in turn), twice, before the
     * rest of its combo comes (they came 8–40 frames apart). Not in 起幕布 or while drinking.
     */
    function escape() {
        const now = Date.now();
        if (!escapeOn || !lastHitTaken || lastHitTaken === escapedHit || now - lastHitTaken > 400) return false;
        escapedHit = lastHitTaken;
        if (guarding || drinking || holding() || now - lastEscape < ESCAPE_MS || now - lastDodge < 400) return false;
        lastEscape = now;
        escapes++;
        dodge(ESCAPE_DODGES, FLARE_AGAIN_MS, escapes % 2 ? "left" : "right", "hit");
        return true;
    }

    /** A 蓄力 held or its slash still coming: nothing but 金光 may cut it (teacher, round 34). */
    function holding() {
        return charging || Date.now() < slashUntil;
    }

    /**
     * defend()'s guarding now (卸势 after a hit and on ttc with ttcHold, okEscape, failEscape): always in defend; with
     * outside "defend" between windows and, with windowGuard, in them; never while a 蓄力 is held or its slash is still
     * coming (teacher, round 34: only 金光 may cut it), nor in 衰弱.
     */
    function guardNow() {
        if (defendOn) return true;
        if (!guardOn || charging || Date.now() < slashUntil || weakNow() || planning) return false;
        return !inWindow || windowGuard;
    }

    /** Tap 卸势 and watch the looks after it for whether it worked (parryOk). */
    function parryTap(why) {
        diamondAtTap = dufu && seen("parryOk"); // a diamond still up from an earlier one does not count as this one's
        parryPressAt = Date.now();
        repressDue = 0;
        if (miss) miss.pressed = true;
        parryTapAt = tap(PARRY); // (fastTap: when the finger will be up, as the blocking tap returned)
        qiAtTap = qi;
        if (okFreshQi && dufu) {
            qiTap = readQi(); // (a frame from before the press shows)
            okFreshDone = false;
        }
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
        // okFreshQi: seen to work, not fresh yet: fresh once 真气 is down a step since the tap
        if (okFreshQi && parryOkSeen && !okFreshDone && qiFresh(now)) {
            okFreshDone = true;
            mark("parry fresh", `${parryWhy}, 真气 ${qiFreshRead}, ${now - parryTapAt} ms after`);
            if (okFreshAct(now)) return true;
        }
        const diamond = seen("parryOk");
        // 陌刀: no diamond (teacher: only 横刀 shows 重击派生): the 真气 line down a step after it (good 卸势 took
        // 10–25 px in the practice recording; nothing else took any there)
        const qiStep = !diamond && qiAtTap > 0 && qi >= 0 && qiAtTap - qi >= QI_STEP && now - parryTapAt >= 200;
        if (!diamond && !qiStep && (parryOkSeen || !seen("counter"))) return false;
        if (!parryOkSeen) {
            parryOkSeen = now;
            parriesOk++;
            let how = diamond ? "" : qiStep ? ` (真气 ${qiAtTap}→${qi})` : " (反击 only)";
            let fresh = qiStep || (diamond && !diamondAtTap);
            if (!fresh && okFreshQi && qiFresh(now)) {
                fresh = true;
                how += ` (fresh by 真气 ${qiFreshRead})`;
            }
            okFreshDone = fresh;
            mark("parry ok", `${parryWhy}, ${now - parryTapAt} ms after${how}, 真气 ${qi}`);
            if (fresh && okFreshAct(now)) return true;
        }
        // (no 重击派生 in defend, nor between windows with outside "defend": no blows there)
        if (defendOn || (guardOn && !inWindow) || !diamond || guarding || drinking || holding() || now - lastDodge < 500) return false;
        tap(HEAVY);
        heavies++;
        mark("heavy", "重击派生");
        parryTapAt = 0;
        return true;
    }

    /**
     * okRepress: the second 卸势 when due, if ttc's latest p (fresh) is OK_REPRESS_P or more; past ttcHold and the
     * cooldowns; not with a sweep coming, in 衰弱, 起幕布, a drink or a 蓄力. True if pressed.
     */
    function okRepressCheck() {
        if (!repressDue) return false;
        const now = Date.now();
        if (now < repressDue) return false;
        const late = now - repressDue;
        repressDue = 0;
        const p = ttcLastP != null && now - ttcLastAt <= TTC_FRESH_MS ? ttcLastP : null;
        const pct = p == null ? "?" : Math.round(p * 100);
        const no = late > OK_REPRESS_LATE_MS ? `${late} ms late` : p == null || p < OK_REPRESS_P ? `p ${pct}` :
            !guardNow() || guarding || drinking || holding() || weakNow() ? "busy" : sweepNear(now) ? nearLabel : "";
        if (no) {
            mark("ok repress", `not pressed: ${no}`);
            return false;
        }
        stride(0);
        parryTap(`ok repress p ${pct} +${now - parryPressAt}`);
        parries++;
        represses++;
        return true;
    }

    /** A fresh good 卸势 (not one left from before): okRepress / okEscape when due; true if it acted. */
    function okFreshAct(now) {
        if (okRepress) { // (no okEscape with it)
            if (!parryWhy.startsWith("ok repress") && !parryWhy.startsWith("cancel")) repressDue = parryPressAt + okRepressMs;
            return false;
        }
        if (okEscape && guardNow() && !guarding && !drinking && !weakNow() && now - okEscapeAt > OK_ESCAPE_MS) {
            okEscapeAt = now;
            okEscapes++;
            dodge(1, FLARE_AGAIN_MS, okEscapeDir === "side" ? (okEscapes % 2 ? "left" : "right") : okEscapeDir, "卸开后闪开");
            return true;
        }
        return false;
    }

    /**
     * okFreshQi: 真气 now (read on this frame) a step below its read right after the tap (and not empty, covered or
     * a misread: a step of QI_STEP–80 px; good 卸势 took 10–25).
     */
    function qiFresh(now) {
        if (qiTap <= QI_EMPTY || now - parryTapAt < 100) return false;
        const q = readQi();
        const d = qiTap - q;
        if (q <= QI_EMPTY || d < QI_STEP || d > 80) return false;
        qiFreshRead = `${qiTap}→${q}`;
        return true;
    }

    /**
     * waitGuard: defendWindup() in a wait that does not look for blows (guarded as watch() would), parryOk() first
     * outside a dodge (failEscape goes by whether the last 卸势 was seen to work; in a dodge it is off anyway).
     */
    function guardWait() {
        if (!waitGuard || !ttcModel || !guardNow()) return false;
        if (!inDodge && parryOk()) return true;
        if (!inDodge && okRepressCheck()) return true;
        return defendWindup();
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
            img = nextShot();
            deadCheck();
            const red = countAtLeast(PULL_HSV, PULL_ROI, PULL_RED, img);
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
        if (!countAtLeast(PULL_HSV, PULL_ROI, PULL_RED, img)) return false;
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
            img = nextShot();
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
            img = nextShot();
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
            img = nextShot();
            if (sweepDodge() || skyGuard() || alert() || flash() || sweepDodge()) return true;
            ttcPoll(); // (before extra(): 起幕布 / 红光 reads take 40–60 ms)
            if (extra() || grabCheck()) return true;
            if (okRepressCheck()) continue;
            ttcTick();
            execute();
            if (!parryOk()) cue();
            // outside "defend": defend()'s 卸势 after a hit and on the cue (defend() takes hits in its own loop)
            if (!defendOn && guardNow() && hitParry()) continue;
            if (motionOn && guardNow()) defendMotion();
            else if (motionFight && motionCue()) return true;
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

    /**
     * plan: 处决 seen (ex) or not on this look. First seen: the plan's clock (and 衰弱, if 真气 was not read empty twice
     * yet, rounds 126–127); while held, marked when it goes / comes back and 真气 every second (how long it stays).
     * @param {boolean} ex @param {number} now
     */
    function execTrack(ex, now) {
        if (ex && !execShownAt && (weak || (qi >= 0 && qi <= EXEC_QI_MAX))) {
            if (!weak) weakStart(`处决 first, 真气 ${qi}`);
            execShownAt = now;
            mark("punish", `处决 shows ${now - weakSince} ms after 真气 empty`);
        }
        if (!weak || !execShownAt || execTapAt) return;
        if (!ex) {
            if (!execMiss++) execMissAt = now;
            if (execMiss === 3) mark("punish", `处决 gone at ${execMissAt - execShownAt} ms`);
        } else {
            if (execMiss >= 3) mark("punish", `处决 back at ${now - execShownAt} ms`);
            execMiss = 0;
        }
        if (!execFree && now - execQiMarkAt >= 1000) {
            execQiMarkAt = now;
            mark("punish", `处决 held ${now - execShownAt} ms, 真气 ${qi}`);
        }
    }

    /** 处决 (or a boss's last move, in the same diamond) on the current screenshot: tap it. */
    function execute() {
        const now = Date.now();
        if (now - lastExecute < EXECUTE_MS) return false;
        const ex = seen("execute");
        if (dufu && planOn) execTrack(ex, now);
        const k = ex ? "处决" : usedUp && seen("ultimate") ? "化解" : null;
        if (!k) return false;
        if (k === "处决" && execHold && weak) return false; // punish: later (EXEC_AFTER_MS)
        if (k === "处决" && weak && planOn && !execFree && now - execShownAt < execHoldMax) return false; // held for the plan
        log(k);
        touch.up(1); // a 蓄力 held meanwhile is let go
        charging = false;
        walk(walking);
        tap(EXECUTE);
        if (k === "处决" && weak && execShownAt) {
            execTapAt = now;
            mark("punish", `处决 tapped ${now - execShownAt} ms after it showed${execFree ? "" : " (held too long)"}`);
        }
        lastExecute = now;
        executions++;
        return true;
    }

    /** New screenshot; dodge, 处决, heal, keep the lock, walk in, and end the fight when it is over. */
    function look() {
        img = nextShot();
        if (sweepDodge() || skyGuard() || alert() || flash() || sweepDodge() || extra()) img = shot();
        ttcTick();
        execute();
        if (!parryOk()) cue();
        okRepressCheck();
        ttcPoll();
        const now = Date.now();
        if (now - downAt >= DOWN_MS) {
            downAt = now;
            if (match("down_heal.png", { image: img, roi: DOWN_ROI, threshold: 0.8 }).hit) throw new Over("down");
        }
        const locked = color({ ...GOLD, image: img, roi: LOCK_ROI, count: 150 }).hit;
        // a boss fight looks for less each time (the minimap only before the lock, the icons now and then), so 金光
        // is looked for more often
        // (in a boss fight the minimap's marks were read while not locked, but nothing there uses them: not read)
        const foes = args.boss ? 0 : timed("enemies", () => enemies(img).filter((e) => e.dist <= (args.within ?? Infinity)).length);
        if (foes || locked) lastFoe = now;
        // the icons (77 ms to read): in a boss fight only once its bar has been gone a while (the end)
        if (!args.boss || (bossSeen && now - bossSeen > BOSS_GONE_MS / 2 && now - calmAt >= HUD_MS)) {
            calm = timed("hud calm", () => hudCalm(img));
            calmAt = now;
        }
        const b = args.boss ? boss() : null;
        if (b != null && !(bossLast && b >= BOSS_FULL)) bossLeft = b; // (not phase two's full bar)
        deadCheck(b);
        if (b != null) bossSeen = now;
        if (b != null) usedUp = b === 0;
        qiCheck(b);
        if (dufu && now - qijieLookAt >= QIJIE_MS) { // (logged only: every QIJIE_MS, was every look)
            qijieLookAt = now;
            const q = seen("qijie");
            if (q !== qijieOn) {
                qijieOn = q;
                mark("qijie", q ? "气竭 banner on" : `气竭 banner off after ${Date.now() - qijieAt} ms`);
                if (q) qijieAt = Date.now();
            }
        }
        // 金光 again halfway through and at the end (rounds 141–155: 150–260 ms from one look's check to the next)
        if (flashDue()) img = shot();
        ttcPoll();
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
        if (flashDue()) img = shot();
        ttcPoll();
        ttcTick();
    }

    /**
     * ttc's decision (watch()'s: defendMotion when guarding, else motionCue) between the reads of a look / a watch turn:
     * a high p is acted on only while fresh (TTC_FRESH_MS), and rounds 174–176 had ~160 short episodes a run (1–3 reads,
     * median 35 ms) no decision point read in time, most begun in a look or behind a long read (金光, 起幕布, 红光)
     */
    function ttcPoll() {
        if (!ttcModel) return false;
        if (motionOn && guardNow()) return defendMotion();
        if (motionFight) motionCue();
        return false;
    }

    /** flash() when the last look for 金光 is FLASH_EVERY old. */
    function flashDue() {
        return sweepDodge() || (Date.now() - lastCheck >= FLASH_EVERY && flash());
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
            if (defendOn || guardOn) mark("hit", `${Math.round(lastHp * 100)}→${Math.round(h * 100)}%`);
            if (now - lastDodge > 1500 || defendOn || guardOn) hitAt = now;
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
            if (ownDrinks < maxDrinks && lows >= 1 && now - lastPotion > POTION_MS && now - drinkCountedAt > POTION_CD_MS) drink(h);
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
        // round 113: 8 counted, 3 after our taps; the other rises were real drinks with no tap of ours (at 8–27%
        // health, the potion button's cooldown sweep on: the game's own) and the phase-two refill (now "cleared")
        const ours = now - potionTapAt < DRINK_MS + DRINK_LATE_MS;
        if (ours) ownDrinks++;
        log(`potion drunk (${ownDrinks}/${maxDrinks} ours, ${drinks} in all, ${why}${ours ? "" : ", no tap of ours"})`);
        mark("drunk", `${ownDrinks}/${maxDrinks} ours, ${drinks} in all${ours ? "" : " no tap of ours"}`);
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
                potionTapAt = Date.now();
                mark("potion", `${Math.round(h0 * 100)}%`);
                taps++;
                potions++;
                last = Date.now();
            }
            img = nextShot();
            deadCheck();
            if (flash() || sweepDodge()) continue;
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
        if (!parryHitsOn || weak || !hitAt || now - hitAt > 500 || stillUntil === Infinity || holding()) return;
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
        if (seen("modao")) return "modao";
        if (seen("hengdao")) return "hengdao";
        // 横刀's 重击 button is another one in 衰弱 (rounds 126–129): by 突进's icon
        return seen("mdash") ? "modao" : seen("swirl") || seen("dash") || seen("strike") || seen("damage") ? "hengdao" : null;
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
        const im = img; // (a read may tick: both on the same frame)
        const hit = match(T.qishu[0], { image: im, roi: T.qishu[1], threshold: THRESHOLD });
        if (!hit.hit || !hit.box) return false;
        const [x, y, w, h] = hit.box;
        const cx = Math.round(x + w / 2), cy = Math.round(y + h / 2);
        return color({ ...ICON_WHITE, image: im, roi: [cx - 18, cy - 18, 36, 36], count: QISHU_LIT_PX }).hit;
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
        if (!grabDodgeAt || Date.now() < grabDodgeAt || holding()) return false;
        grabDodgeAt = 0;
        dodge(1, FLARE_AGAIN_MS, "left", "插地");
        return true;
    }

    /** No blow coming: ttc's latest p(ttcBins) below chargeSafeP, or a good 卸势 just now (the boss staggered). */
    function quiet() {
        if (parryOkSeen && Date.now() - parryOkSeen < CHARGE_AFTER_PARRY_MS) return true;
        return ttcLastP != null && Date.now() - ttcLastAt < 150 && ttcLastP < chargeSafeP;
    }

    /** @param {string} why @param {{force?: boolean, redFrom?: number, cancel?: boolean, noHitAbort?: boolean, quick?: boolean, maxMs?: number, followMs?: number, noRed?: boolean}} [o] noRed: no red looked for (held maxMs); quick: back once the slash is out; maxMs: let go by then; followMs: the slash wait */
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
        let hits = 0, hitSeen = hit0; // hits while holding
        /** @type {number[]} */ const pre = []; // boss bar reads over the hold (the last ones are the baseline)
        const hot = Date.now() - burstAt < HOT_MS;
        const ds0 = daoshi();
        touch.down(CHARGE, 1);
        mark("charge", `${why}, 刀势 ${ds0}${hot ? ", 热血" : ""}`);
        charging = true;
        walk(walking);
        const t0 = Date.now();
        let how = "time";
        for (;;) {
            const held = Date.now() - t0;
            const maxMs = o.maxMs ?? CHARGE_RED_MAX;
            if (held >= maxMs) break;
            if (watch(Math.min(60, maxMs - held))) {
                how = "cut short";
                break;
            }
            heal(); // reads the health: a hit shows in lastHitTaken (no potion while holding unless urgent)
            if (lastHitTaken !== hitSeen) {
                hits++;
                hitSeen = lastHitTaken;
            }
            if (args.boss) {
                const bv = boss();
                if (bv != null) pre.push(bv);
            }
            if (lastHitTaken !== hit0 && !o.noHitAbort) { // hit / knocked down: this one is lost
                how = "hit";
                break;
            }
            if (!o.noRed && Date.now() - t0 >= (o.redFrom ?? CHARGE_RED_FROM) &&
                countAtLeast(CHARGE_RED, CHARGE_RED_ROI, CHARGE_RED_PX, img)) {
                how = "red";
                break;
            }
        }
        const held = Date.now() - t0;
        if (how !== "cut short") letGo();
        mark("release", `${why} ${how} ${held} ms${lastHitTaken !== hit0 ? `, hit while holding ×${Math.max(hits, 1)}` : ""}, 刀势 ${ds0}→${daoshi()}${hot ? ", 热血" : ""}`);
        // the slash comes out ~0.5 s after letting go: nothing tapped meanwhile (dodges for 金光 still go)
        const follow = how === "hit" ? 200 : o.followMs ?? (o.cancel ? CANCEL_MS : CHARGE_FOLLOW_MS);
        slashUntil = Date.now() + follow;
        // what the slash took off the boss bar: baseline = median of the last 5 reads while holding (we strike nothing
        // then), after = 2nd lowest read 0.3–1.4 s after letting go (one stray low read does not count); the device's
        // single read 0.9 s after disagreed with the recording (round 40: 0 for a 16 px slash)
        const r0 = Date.now();
        /** @type {number[]} */ const post = [];
        while (Date.now() - r0 < (o.cancel || o.quick ? follow : Math.max(follow, 1400))) {
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
        while (Date.now() < end - 1000 && !weakNow() && !usedUp) {
            closeIn("蓄力");
            const force = !lost;
            const h0 = lastHitTaken;
            const hot = Date.now() - burstAt < HOT_MS; // a fixed hotHoldMs under 热血难凉, else to red
            chargeHold(`window ${++n} (${end - Date.now()} ms left${hot ? `, hold ${hotHoldMs}` : ""})`,
                hot ? { force, cancel: true, maxMs: hotHoldMs, noRed: true } : { force, redFrom: WINDOW_RED_FROM, cancel: true });
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
        if (weakNow() && !planRan) { // (真气 empty, no 处决 yet: guarded as usual, keep holds no window)
            weakPlan();
            return;
        }
        if (!weapon() || !seen("qishu")) {
            tap(LIGHT);
            watch(300);
            look();
        }
        const keep = qi >= 0 && qi <= RESERVE_QI;
        if (rounds === 0) {
            switchTo("modao");
            qishu();
            if (lungeOn) openLunge();
        }
        if (!keep && Date.now() - burstAt >= BURST_CD_MS) {
            mark("sched", `横刀 (爆发 cool, 真气 ${qi})`);
            // 奇术 (+20% for 12 s) first, in a quiet moment (outside "defend" holds 横刀: its button is there too, 0.83–0.9
            // and lit in 99% of round 109's 横刀 frames)
            if (windowOn && (weapon() === "modao" || guardOn)) qishu();
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
            else if (guardOn) guardOut();
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
        if (guarding || drinking || (punishOn && weak) || (guardOn && weakNow())) return false;
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
     * A tick due with no new frame on the stream yet (frame(), no screenshot) waits for the next chance. The time
     * between inferences goes to ttcHist; one of 70+ ms is blamed on the slowest timed call since the last tick and
     * where it ended (the stack), in ttcBlame.
     */
    function ttcTick(im = /** @type {Image | null} */ (null)) {
        if (!ttcModel || ttcBusy) return;
        const now = Date.now();
        if (!im) {
            if (now - ttcAt < TTC_TICK_MS) return;
            if (frameSeq() === ttcSeq) return; // nothing new on screen yet
            // its own screenshot becomes the one everything looks at: only the last 8 are kept, an older img held
            // across 8 ticks would be gone ("image N is gone")
            im = img = snap();
        }
        if (im.seq === ttcSeq) return;
        if (ttcSeq >= 0) {
            const k = Math.min(5, Math.max(0, im.seq - ttcSeq - 1));
            ttcSkips[k]++;
        } else {
            ttcSeq0 = im.seq;
            ttcT0 = now;
        }
        if (ttcAt) {
            const dt = now - ttcAt;
            histAdd(ttcHist, dt);
            if (dt > 70) {
                ttcGaps++;
                ttcUntracked += Math.max(0, dt - sinceSum);
                const where = whereNow();
                if (dt > GAP_MARK_MS) mark("ttc gap", `${dt} ms, slowest ${sinceTop || "-"} ${Math.max(0, sinceTopMs)} ms, at ${where}`);
                const key = `${sinceTop || "-"} | ${where}`;
                const e = (ttcBlame[key] ??= [0, 0, 0, 0]);
                e[0]++;
                e[1] += dt;
                e[2] = Math.max(e[2], dt);
                e[3] += Math.max(0, sinceTopMs);
            }
        }
        sinceSum = 0;
        sinceTopMs = -1;
        sinceTop = "";
        ttcSeq = im.seq;
        ttcAt = now;
        const t0 = Date.now();
        const r = infer(ttcModel, { ...TTC_OPTS, ...ttcInput, image: im });
        profAdd("infer", Date.now() - t0, r.ms.total);
        ttcLooks++;
        ttcMs += r.ms.total;
        if (!r.ready) {
            const fr = ttcInput.frames ?? TTC_OPTS.frames ?? [0];
            (r.frames ?? []).forEach((f, i) => {
                if (!f) ttcMissing[fr[i]] = (ttcMissing[fr[i]] ?? 0) + 1;
            });
        }
        if (sweepModel) sweepRead(im);
        if (r.ready && r.probs) {
            ttcReady++;
            const pr = r.probs;
            const p = ttcBins.reduce((a, b) => a + (pr[b] ?? 0), 0);
            if (dufu) missTrack(p, now);
            ttcLastP = p;
            ttcLastAt = Date.now();
            ttcProbs = pr;
            if (ttcP == null || p >= ttcP || Date.now() - ttcPAt > TTC_FRESH_MS) {
                if (ttcP != null && ttcP >= ttcTh && p < ttcP) { // a high p no decision point read in time
                    const st = stateNow();
                    missWhy(st === "-" ? "unread" : `unread: ${st}`, `${Date.now() - ttcPAt} ms`);
                }
                ttcP = p;
                ttcPAt = Date.now();
            }
            if (ttcFast) ttcFastDecide(p, im);
        }
    }

    /** ttc episodes (MISS_*): a read p at now. @param {number} p @param {number} now */
    function missTrack(p, now) {
        if (miss && (now - miss.last > MISS_GAP_MS || now - miss.t0 > MISS_MAX_MS)) missClose();
        if (p < ttcTh) return;
        if (!miss) miss = { t0: now, last: now, pMax: p, n: 0, why: {}, det: {}, state: stateNow(), where: whereNow(), pressed: false };
        miss.last = now;
        miss.n++;
        miss.pMax = Math.max(miss.pMax, p);
    }

    /** A decision point did not press for this reason while an episode is open. @param {string} why @param {string} [detail] */
    function missWhy(why, detail = "") {
        if (!miss) return;
        miss.why[why] = (miss.why[why] ?? 0) + 1;
        if (detail) miss.det[why] = detail;
    }

    /** The episode is over: marked "ttc miss" if no 卸势 went in it. */
    function missClose() {
        const m = miss;
        miss = null;
        if (!m || m.pressed) return;
        const ws = Object.entries(m.why).sort((a, b) => b[1] - a[1]);
        const main = ws.length ? ws[0][0] : m.state === "-" ? "unseen" : `unseen: ${m.state}`;
        missCounts[main] = (missCounts[main] ?? 0) + 1;
        const why = ws.length ? ws.map(([k, n]) => `${k}×${n}${m.det[k] ? ` (${m.det[k]})` : ""}`).join(", ") : "unseen";
        mark("ttc miss", `p ${Math.round(m.pMax * 100)}, ${m.n} reads, ${m.last - m.t0} ms: ${why}; state ${m.state}; at ${m.where}`);
    }

    /** What is going on (for "ttc miss"): the states that keep 卸势 back, "-" if none. */
    function stateNow() {
        const now = Date.now();
        const st = [];
        if (charging) st.push("蓄力");
        else if (now < slashUntil) st.push("刀光");
        if (stillUntil === Infinity) st.push("横刀一套");
        if (inWindow) st.push("window");
        if (planning) st.push("衰弱 plan");
        else if (weak) st.push(weakNow() ? "衰弱" : "真气空");
        if (guarding) st.push("起幕布");
        if (drinking) st.push("drink");
        if (inDodge) st.push("dodge");
        if (flashResting) st.push("金光 rest");
        if (hitParrying) st.push("hitParry wait");
        if (!guardNow()) st.push("not guardNow");
        return st.join(",") || "-";
    }

    /** sweepNet: a sweep coming (p(0–12) ≥ SWEEP_QUIET_P, fresh): no 卸势. */
    function sweepNear(now = Date.now()) {
        return !!sweepModel && !!sweepProbs && now - sweepAt <= SWEEP_FRESH_MS && sweepProbs[0] + sweepProbs[1] + sweepProbs[2] >= SWEEP_QUIET_P;
    }

    /** The sweep net's latest probs, % ("0-4/5-8/9-12/13-20/far"). */
    function sweepPct() {
        return sweepProbs ? sweepProbs.map((x) => Math.round(x * 100)).join("/") : "?";
    }

    /** sweepNet on im (from ttcTick): its probs; p(0–8) high sets the dodge (SWEEP_GAP_MS apart). @param {Image} im */
    function sweepRead(im) {
        const t0 = Date.now();
        const r = infer(/** @type {string} */ (sweepModel), { ...TTC_OPTS, image: im });
        profAdd("sweep net", Date.now() - t0, r.ms.total);
        if (!r.ready || !r.probs) return;
        const now = Date.now();
        sweepProbs = r.probs;
        sweepAt = now;
        if (!sweepDue && r.probs[0] + r.probs[1] >= SWEEP_DODGE_P && now - sweepDodgeAt >= SWEEP_GAP_MS) {
            sweepDue = now;
            sweepTriggers++;
        }
    }

    /**
     * sweepNet's dodge, at the first chance after its read (not in a dodge, 衰弱 or its plan; dropped when
     * SWEEP_LATE_MS late); true if it went.
     */
    function sweepDodge() {
        if (!sweepDue || inDodge) return false;
        const now = Date.now(), late = now - sweepDue;
        sweepDue = 0;
        if (weakNow() || planning) {
            mark("sweep", `${sweepPct()}: no dodge in 衰弱`);
            return false;
        }
        if (late > SWEEP_LATE_MS) {
            mark("sweep", `${sweepPct()}: dodge dropped, ${late} ms late`);
            return false;
        }
        sweepDodgeAt = curtainDodgeAt = now; // (curtainDodge's own not within CURTAIN_DODGE_GAP_MS of it)
        sweepDodges++;
        mark("sweep", `${sweepPct()}: dodge, the tap ${late + SWEEP_LAG_MS} ms after the read`);
        dodge(1, FLARE_AGAIN_MS, "back", `幕布 sweep ${sweepPct()}`, { lag: SWEEP_LAG_MS });
        return true;
    }

    /** A screenshot into img, through ttcTick() too (its earlier frames come from this run's screenshots). */
    function shot() {
        const im = snap();
        ttcTick(im);
        return im;
    }

    /**
     * shot() of a frame newer than img's: the loops look at each frame once (the stream has one every ~35 ms; a turn
     * on the same frame again only redid every read on the same pixels), waiting for it NEXT_MS at most (a still
     * screen has none). Ticks meanwhile are not needed: there is nothing new for ttc either.
     */
    function nextShot() {
        // (rounds 162–164: 9% of the time went in this wait, mostly for nothing: a tick inside the last turn had
        // taken the newest frame into img already, and the wait was for the one after it)
        const latest = frameSeq();
        if (latest > loopSeq) { // the newest frame: img's if that is it, else a screenshot of it
            const im = latest > img.seq ? shot() : img;
            loopSeq = Math.max(loopSeq, im.seq);
            return im;
        }
        const t0 = Date.now();
        while (frameSeq() <= loopSeq && Date.now() - t0 < NEXT_MS) {
            releaseDue();
            nap(3);
        }
        const im = shot();
        loopSeq = Math.max(loopSeq, im.seq);
        return im;
    }

    /** Where the code is now: the first three callers that are not the ticking / reading helpers, "name:line". */
    function whereNow() {
        const skip = ["whereNow", "ttcTick", "tick", "match", "color", "sleep", "shot", "nextShot", "snap", "timed", "frameSeq", "seen", "perFrame", "enough", "missTrack", "<anonymous>"];
        /** @type {string[]} */ const out = [];
        for (const l of (new Error().stack ?? "").split(String.fromCharCode(10))) {
            const m = /at (\S+) \((?:.*:(\d+):\d+|native)\)/.exec(l);
            if (!m || skip.includes(m[1])) continue;
            out.push(m[2] ? `${m[1]}:${m[2]}` : m[1]);
            if (out.length === 3) break;
        }
        return out.join(" < ");
    }

    /**
     * Stamina 0–1 from the gold arc left of the character (teacher, explore 0145: rows ~400–443 near x 351–358, gold H
     * ~23 S ~92 V ~215, fills from the bottom); null when not seen (full, or moved with the camera; not calibrated, only
     * used to skip extra 金光 dodges): the tallest thin gold piece in STAMINA_ROI over STAMINA_FULL_PX.
     */
    function stamina() {
        const r = color({ ...STAMINA_HSV, image: img, roi: STAMINA_ROI, count: 12, connected: true });
        const b = r.results.map((m) => m.box).filter((x) => x && x[3] >= 6 && x[2] <= 14 && x[3] >= 1.5 * x[2]).sort((p, q) => (q?.[3] ?? 0) - (p?.[3] ?? 0))[0];
        return b ? Math.min(1, b[3] / STAMINA_FULL_PX) : null;
    }

    /** p(windup) on this screenshot; null on the frame looked at last time. */
    function windupNow() {
        windupStaleMs = 0;
        if (img.seq === windupSeq) return null;
        windupSeq = img.seq;
        if (ttcModel) {
            ttcTick();
            const p = ttcP != null && Date.now() - ttcPAt <= TTC_FRESH_MS ? ttcP : null;
            windupStaleMs = p == null && ttcP != null && ttcP >= ttcTh ? Date.now() - ttcPAt : 0;
            ttcP = null;
            return p;
        }
        const r = reco("NeuralNetworkClassify", { model: yoloModel, labels: ["idle", "windup"] }, { image: img, roi: YOLO_ROI });
        return r.label === "windup" ? r.score ?? 0 : 1 - (r.score ?? 1);
    }

    /** defend with args.yolo: like defendMotion, the classifier saying a blow is coming instead of the scene moving. */
    function defendWindup() {
        const now = Date.now();
        const early = guarding ? "起幕布" : drinking ? "drinking" : (punishOn && weak) || (guardOn && weakNow()) ? "weak" : "";
        if (early) {
            missWhy(early);
            return false;
        }
        const p = windupNow();
        if (p == null && windupStaleMs) missWhy("stale", `${windupStaleMs} ms`);
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
        return windupAct(p, now, false) === "pressed";
    }

    /**
     * defendWindup's decision on p (≥ the threshold): failEscape, the blocks, ttcHold, the 卸势. fast (ttcFast, from
     * ttcTick): failEscape's case is left to defendWindup ("defer"), the 卸势 marked "ttc fast". Returns "pressed"
     * (a 卸势 or failEscape's dodge), "blocked" or "defer".
     * @param {number} p @param {number} now @param {boolean} fast
     */
    function windupAct(p, now, fast) {
        const dodgedAt = Math.max(lastDodge, dodgePressAt); // (in a dodge, waitGuard: its last press)
        if (failEscape && !inDodge && parryTapAt && !parryOkSeen && parryWhy.startsWith("ttc") && now - parryTapAt >= FAIL_ESCAPE_MS &&
            now - parryTapAt < FAIL_ESCAPE_MS + 300 && now - dodgedAt > 1000) {
            if (fast) return "defer";
            failEscapes++;
            parryTapAt = 0;
            missWhy("failEscape dodge");
            dodge(1, FLARE_AGAIN_MS, failEscapes % 2 ? "left" : "right", `卸势没卸住 (ttc ${Math.round(p * 100)})`);
            return "pressed";
        }
        // a 卸势 that has shown no sign of working (no diamond / 真气 step yet) may be followed by another after reparryMs
        const cool = reparryMs > 0 && !parryOkSeen ? reparryMs : MOTION_MS;
        const block = sweepNear(now) ? nearLabel : now - dodgedAt < DEFEND_QUIET_MS ? "after a dodge" : now - parryTapAt < cool ? "after a tap" :
            now - lastMotionParry < cool ? "after a ttc 卸势" : "";
        if (block) {
            ttcBlocked[block] = (ttcBlocked[block] ?? 0) + 1;
            const since = block === "after a dodge" ? now - dodgedAt : block === "after a tap" ? now - parryTapAt :
                block === "after a ttc 卸势" ? now - lastMotionParry : -1;
            missWhy(block, since >= 0 ? `${since} ms` : `sweep ${sweepPct()}`);
            if (ttcModel && p >= 0.7 && now - ttcBlockMarkAt > 500) {
                ttcBlockMarkAt = now;
                mark("ttc blocked", `${Math.round(p * 100)} ${block}`);
            }
            return "blocked";
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
                const pc = (/** @type {number} */ k) => Math.round(((ttcProbs ?? [])[k] ?? 0) * 100);
                missWhy("hold", `near ${pc(1)} far ${pc(2)} 18–25 ${pc(3)}, ${now - ttcHoldSince} ms`);
                return "blocked";
            }
            held = ` held ${now - ttcHoldSince}`;
        } else if (ttcHoldSince) held = ` held ${now - ttcHoldSince}`;
        ttcHoldSince = 0;
        lastMotionParry = now;
        stride(0);
        if (yoloDelay) sleep(yoloDelay);
        parryTap(`${ttcModel ? "ttc" : "windup"}${fast ? " fast" : ""} ${Math.round(p * 100)} +${yoloDelay}${held}`);
        parries++;
        motionParries++;
        if (fast) fastPresses++;
        return "pressed";
    }

    /**
     * ttcFast: the decision on this frame's p in ttcTick() when guarding as defendWindup would and nothing that must
     * not be cut is going on; the frame is then taken (defendWindup does not decide on it again) unless deferred.
     * @param {number} p @param {Image} im
     */
    function ttcFastDecide(p, im) {
        if (!ttcFast || ttcBusy || p < ttcTh || !motionOn || !guardNow()) return;
        if (inDodge || flaring || flashResting || drinking || guarding || tapDown || redWaiting || planning || hitParryTapping) return;
        if ((punishOn && weak) || (guardOn && weakNow())) return;
        ttcBusy = true;
        try {
            const r = windupAct(p, Date.now(), true);
            if (r !== "defer") {
                ttcP = null;
                windupSeq = im.seq;
            }
        } finally {
            ttcBusy = false;
        }
    }

    function motionCue() {
        const now = Date.now();
        if (!ttcModel && now - motionAt2 < MOTION_EVERY) return false;
        motionAt2 = now;
        // ttc in the fight (args.ttc without defend): its p instead of the scene moving, looked at on every turn
        const p = ttcModel ? windupNow() : null;
        if (p == null && windupStaleMs) missWhy("stale", `${windupStaleMs} ms`);
        const busy = charging ? "蓄力" : now < slashUntil ? "刀光" : weak ? "weak" : guarding ? "起幕布" : drinking ? "drinking" :
            stillUntil === Infinity ? "横刀一套" : usedUp ? "used up" : "";
        const pHigh = p != null && p >= ttcTh;
        if (busy) {
            if (pHigh) missWhy(`not guarding: ${busy}`);
            return false;
        }
        const quiet = now - lastDodge < MOTION_QUIET_MS ? `after a dodge` : now - parryTapAt < MOTION_QUIET_MS ? "after a tap" :
            now - lastMotionParry < MOTION_MS ? "after a ttc 卸势" : sweepNear(now) ? nearLabel : "";
        if (quiet) {
            if (pHigh) missWhy(quiet, quiet === "after a dodge" ? `${now - lastDodge} ms` : quiet === "after a tap" ? `${now - parryTapAt} ms` :
                quiet === "after a ttc 卸势" ? `${now - lastMotionParry} ms` : "");
            return false;
        }
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
     * 衰弱期 by plan, once a 衰弱, from when 处决 shows (execShownAt), 处决 held until min(execAfter, execHoldMax).
     * A 陌刀 蓄力 if switch + the shortest hold + slash fit: (横刀) switch, tapped once → 唤千军 → 燃此魂 (破阵) → 蓄力 (let
     * go early to fit); buffs that do not fit dropped from the front. Else, on 横刀, 爆发 / 伤害 / 突进 / 轻击. Strikes
     * until 处决, then 处决, then strikes until 真气 is back. Stops when 真气 comes back or 处决 is gone (3 looks); every
     * wait has a limit and every step is marked with its ms from 处决 showing.
     */
    function weakPlan() {
        planRan = true;
        planning = true;
        const t0 = execShownAt || Date.now();
        const at = () => `${Date.now() - t0} ms`;
        const left = () => execHoldMax - (Date.now() - t0); // to the last moment for 处决
        const ex0 = executions;
        let why = "";
        // after a look: why the plan stops now
        // (处决 not seen for a while does not stop it: covered by effects at times, 130)
        const stop = () => (why = !weak ? "真气 back" : executions > ex0 ? "处决 tapped (held too long)" : "");
        const step = (/** @type {number} */ ms) => {
            watch(ms);
            look();
            return stop();
        };
        // one strike: 横刀 伤害 / 突进 / (burst: 爆发) / 轻击, 陌刀 轻击
        const strike = (/** @type {boolean} */ burst) => {
            const h = weapon() !== "modao";
            if (h && seen("strike")) {
                tap(DASH);
                mark("skill", `伤害 (衰弱) at ${at()}`);
            } else if (h && seen("dash")) {
                tap(DASH);
                mark("skill", `突进 (衰弱) at ${at()}`);
            } else if (h && burst && seen("burst")) {
                tap(BUFF);
                burstAt = Date.now();
                ownFxUntil = Date.now() + HENGDAO_FX_MS;
                mark("skill", `爆发 (衰弱) at ${at()}`);
            } else tap(LIGHT);
            step(150);
        };
        stride(0);
        let w = weapon();
        for (let i = 0; i < 3 && !w && !stop(); i++) {
            step(60);
            w = weapon();
        }
        if (!w) mark("punish", `weapon not read at ${at()}: taken as 横刀`);
        const hd = w !== "modao";
        const sw = hd ? WEAK_SWITCH_MS : 0;
        const hot = Date.now() - burstAt < HOT_MS;
        const budget = left() - 150;
        const hold = hot ? hotHoldMs : WEAK_COLD_HOLD_MS; // a whole one only (141: 1491 ms cold took 0 px)
        const charge = budget >= sw + hold + WEAK_SLASH_MS;
        /** @type {Set<string>} */ const picks = new Set();
        if (charge) { // buffs from the back while the 蓄力 still fits
            let used = sw + hold + WEAK_SLASH_MS;
            for (const b of ["ranshi", "buff"]) {
                if (used + BUFF_COST_MS[b] > budget) continue;
                used += BUFF_COST_MS[b];
                picks.add(b);
            }
        }
        mark("punish", `plan at ${at()} (${w ?? "?"}, ${left()} ms to the last 处决): ${charge ? `蓄力 ${hold} ms${picks.size ? " after " + [...picks].join(" ") : ""}, then 处决` : `no time for a whole 蓄力 (${sw + hold + WEAK_SLASH_MS} ms): strikes to ${execAfter} ms`}`);
        let onModao = !hd;
        let charged = false;
        if (!why && charge && hd) { // one tap, its change waited for (129: 4 presses ate the whole 处决 time)
            const ts = Date.now();
            tap(SWITCH);
            mark("skill", `switch to modao (衰弱) at ${at()}`);
            while (!onModao && Date.now() - ts < PLAN_SWITCH_MS && !step(60)) onModao = weapon() === "modao";
            if (!onModao && !why) mark("punish", `switch: still ${weapon() ?? "?"} after ${Date.now() - ts} ms at ${at()}: strikes`);
        }
        if (!why && charge && onModao) {
            if (picks.has("buff") && seen("buff")) {
                tap(BUFF);
                mark("skill", `唤千军 (衰弱) at ${at()}`);
                step(BUFF_COST_MS.buff - 100);
            }
            if (!why && picks.has("ranshi") && dashLit()) {
                tap(DASH);
                mark("skill", `燃此魂 (衰弱) at ${at()}`);
                step(BUFF_COST_MS.ranshi - 100);
            }
            const hotNow = Date.now() - burstAt < HOT_MS;
            const need = (hotNow ? hotHoldMs : WEAK_COLD_HOLD_MS) + WEAK_SLASH_MS;
            if (!why && left() - 150 >= need) {
                const maxMs = hotNow ? hotHoldMs : Math.min(CHARGE_RED_MAX, left() - 150 - WEAK_SLASH_MS);
                chargeHold(`衰弱 at ${at()} (${hotNow ? "热血难凉" : "to red"}, ${maxMs} ms at most)`,
                    hotNow ? { force: true, quick: true, maxMs, noRed: true, followMs: WEAK_SLASH_MS }
                        : { force: true, redFrom: CHARGE_RED_FROM, quick: true, maxMs, followMs: WEAK_SLASH_MS });
                charged = true;
                stop();
            } else if (!why) mark("punish", `蓄力 dropped at ${at()} (${left()} ms left, ${need} needed)`);
        }
        // no whole 蓄力: strikes until execAfter (衰弱 lasts ~3.3 s past 处决, so a later one gives no less time)
        while (!why && !charged && Date.now() - t0 < Math.min(execAfter, execHoldMax) - 100) strike(!charge);
        execFree = true;
        if (!why) {
            mark("punish", `处决 free at ${at()}${charged ? " (蓄力 out)" : ""}`);
            // looked for while 真气 is empty (a covered one comes back, 130), striking between looks once it is late
            while (executions === ex0 && weak && Date.now() - t0 < PLAN_MAX_MS) {
                if (Date.now() - t0 < execHoldMax + 300) step(60);
                else strike(true);
            }
            if (executions === ex0) mark("punish", `处决 not tapped (${weak ? "never seen again" : "真气 back"}) at ${at()}`);
            why = executions > ex0 ? "处决 tapped" : weak ? "处决 not seen to tap" : "真气 back";
        }
        if (executions > ex0 && weak) { // 衰弱 goes on ~3.3 s after 处决 (141, 142): strike on, no 卸势
            const tx = Date.now();
            mark("punish", `after 处决 at ${at()}: its scene, then strikes`);
            watch(EXEC_SCENE_MS);
            look();
            let n = 0;
            while (weak && Date.now() - tx < POST_EXEC_MS) {
                strike(true);
                n++;
            }
            mark("punish", `after 处决: ${n} strikes, ${weak ? `still 衰弱 after ${Date.now() - tx} ms (limit)` : `真气 back ${Date.now() - tx} ms after 处决`}`);
        }
        planning = false;
        mark("punish", `plan end at ${at()}: ${why}`);
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

    // defend()'s loop state (guardTurn), kept across sched's guardOut() calls
    const gst = { hi: 0, bi: 0, nextBlind: 0, lastStep: 0, stepUntil: 0 };

    /** A hit just seen (within 400 ms): 卸势 after the next of hitDelays (none if a dodge came meanwhile); true if due. */
    function hitParry(now = Date.now()) {
        if (!hitAt || now - hitAt >= 400 || hitParrying || (guardOn && weakNow())) return false;
        const d = hitDelays[gst.hi++ % hitDelays.length];
        const at = hitAt;
        hitAt = 0;
        hitParrying = true;
        stride(0);
        if (!watch(d)) {
            hitParryTapping = true;
            if (sweepNear()) {
                sweepSkips++;
                mark("parry skipped", `hit +${d}: ${nearLabel} (sweep ${sweepPct()})`);
                missWhy(nearLabel, "after a hit");
            }
            else {
                parryTap(`hit +${d} (hit seen +${at - start})`);
                parries++;
            }
            hitParryTapping = false;
        }
        hitParrying = false;
        return true;
    }

    /** One turn of defend()'s loop after its look (no blows): 卸势 after a hit / on the cue / blind, steps in, a wait. */
    function guardTurn() {
        const now = Date.now();
        if (hitParry(now)) {
            gst.nextBlind = Date.now() + DEFEND_BLIND_MS[gst.bi++ % DEFEND_BLIND_MS.length];
            return;
        }
        if (motionOn && defendMotion()) return;
        if (blindOn && now >= gst.nextBlind) {
            const gapMs = DEFEND_BLIND_MS[gst.bi++ % DEFEND_BLIND_MS.length];
            stride(0);
            parryTap(`blind (next in ${gapMs})`);
            parries++;
            gst.nextBlind = now + gapMs;
        }
        // keep close: in after a dodge, and a step now and then when nothing hit for a while
        const hitLately = now - lastHitTaken < 1500;
        if (now - lastDodge > 300 && now - lastDodge < 300 + DEFEND_WALK_MS && !hitLately) {
            if (stick !== 1) mark("walk", "after a dodge");
            lastStepAt = now;
            stride(1);
        } else if (!hitLately && now - gst.lastStep > DEFEND_STEP_EVERY) {
            gst.lastStep = now;
            gst.stepUntil = now + DEFEND_STEP_MS;
            lastStepAt = gst.stepUntil;
            mark("walk", "step");
            stride(1);
        } else if (now > gst.stepUntil) stride(0);
        watch(motionOn ? 150 : 40);
    }

    function defend() {
        if (defendWeapon !== "any") switchTo(defendWeapon);
        gst.nextBlind = Date.now() + DEFEND_BLIND_MS[0];
        gst.lastStep = Date.now();
        log(`defend: practice, no blows (skill started at epoch ${start})`);
        for (;;) {
            look();
            if (punishOn && weakNow() && !(planOn && planRan)) {
                punish();
                continue;
            }
            guardTurn();
        }
    }

    /**
     * sched, outside "defend": defend()'s loop between windows on args.weapon, until 爆发 is cool (真气 not kept), 衰弱
     * or the bar used up; marked "guard" / "guard over".
     */
    function guardOut() {
        if (defendWeapon !== "any") switchTo(defendWeapon);
        const t0 = Date.now();
        gst.nextBlind = t0 + DEFEND_BLIND_MS[0];
        gst.lastStep = t0;
        mark("sched", `guard: 爆发 in ${Math.max(0, BURST_CD_MS - (t0 - burstAt))} ms`);
        for (;;) {
            look();
            if ((weakNow() && !planRan) || usedUp || (Date.now() - burstAt >= BURST_CD_MS && !(qi >= 0 && qi <= RESERVE_QI))) break;
            guardTurn();
        }
        stride(0);
        mark("sched", `guard over after ${Date.now() - t0} ms`);
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
        tickIn = () => 25;
        if (miss) missClose();
        letGo();
        releaseDue(true);
        fastTapOn = false;
    }
    const more = dufu ? `, ${parries} 卸势 (${cues} on a wind-up, ${parriesOk} ok, ${heavies} 重击派生), ${weaks} 衰弱, 真气 ${qi}, ${escapes} escapes, ${pulls} 红刺, ${closeIns} close-ins, ${curtains} 起幕布, ${lunges} 突进 in` : "";
    log(`fight over (${why}): ${rounds} rounds, ${potions} potions (${drinks} drunk), ${executions} 处决, ${dodges} dodges (${alerts} on guard), ${walks} walks in, ${turns} turns to an enemy behind${more}, 金光 looked for at most ${maxGap} ms apart`);
    if (schedOn && windowOn) log(`outside: ${outsideMode}, ${tangs} 冢上霜, ${tangHeavies} 拨雪寻春 after them, ${okEscapes} okEscape, ${failEscapes} failEscape`);
    if (ttcModel) log(`ttc: ${ttcReady}/${ttcLooks} looks ready, ${ttcLooks ? Math.round(ttcMs / ttcLooks * 10) / 10 : 0} ms each`);
    // the n largest by total ms (index 1), values rounded: prof [calls, wall ms, native ms, longest wall ms],
    // ttc.blame [gaps, ms, longest gap ms, ms in the slowest call]
    /** @param {Record<string, number[]>} o @param {number} n */
    const top = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1][1] - a[1][1]).slice(0, n).map(([k, v]) => [k, v.map((x) => Math.round(x))]));
    const ttcOut = ttcModel ? {
        blocked: ttcBlocked, looks: ttcLooks, ready: ttcReady, gaps: ttcGaps, ms: ttcLooks ? Math.round(ttcMs / ttcLooks * 10) / 10 : 0,
        readyPct: ttcLooks ? Math.round((ttcReady / ttcLooks) * 1000) / 10 : 0, interval: histOut(ttcHist),
        untracked: ttcUntracked, blame: top(ttcBlame, 25),
        // the stream's own pace and how many of its frames the inferences skipped (0 = none)
        skips: ttcSkips, streamFps: ttcSeq0 >= 0 ? Math.round(((ttcSeq - ttcSeq0) * 10000) / Math.max(1, ttcAt - ttcT0)) / 10 : 0,
        missing: ttcMissing,
        misses: missCounts, // episodes of p ≥ ttcTh with no 卸势, by main reason ("ttc miss" events)
    } : undefined;
    if (ttcOut) log(`ttc interval ${JSON.stringify(ttcOut.interval)}, ready ${ttcOut.readyPct}%`);
    if (flareModel) log(`金光 kinds: ${JSON.stringify(flareKinds)}`);
    const sweepOut = sweepModel ? { triggers: sweepTriggers, dodges: sweepDodges, quiet: (ttcBlocked[nearLabel] ?? 0) + sweepSkips } : undefined;
    if (ttcOut && ttcFast) Object.assign(ttcOut, { fastPresses });
    return { reason: why, ttc: ttcOut, sweep: sweepOut, flareKinds: flareModel ? flareKinds : undefined, represses, prof: top(prof, 40), profMs: Date.now() - start, flashGap: histOut(flashHist), rounds, potions, drinks, ownDrinks, executions, dodges, alerts, walks, turns, parries, curtains, lunges, parriesOk, heavies, cues, weaks, qi, escapes, pulls, closeIns, motionParries, okEscapes, failEscapes, bossLeft, maxGap, start, events };
}
