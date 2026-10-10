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
import { calm as hudCalm } from "./lib/hud.js";
import { angleDiff, cameraHeading, enemies } from "./lib/minimap.js";
import { turn } from "./move.js";

/** @type {SkillMeta} */
export const meta = { description: "fight the enemies around with the 陌刀 / 横刀 rotation, healing below half health", timeout: 600_000 };

/** @type {Point} */ const LIGHT = [945, 592]; // 轻击 (横刀: 轻蓄力)
/** @type {Point} */ const CHARGE = [1020, 478]; // 陌刀 蓄力 (横刀: 重击)
/** @type {Point} */ const PARRY = [952, 495]; // 卸势
/** @type {Point} */ const QISHU = [881, 525]; // 奇术
/** @type {Point} */ const DASH = [833, 593]; // 突进 (横刀: turns into 伤害 after 爆发)
/** @type {Point} */ const BUFF = [825, 668]; // 陌刀 增益 (横刀: 爆发)
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
    // a boss's last move: 化解 in the same diamond (镇关吼 frames 3479–3501, ≥ 0.95; none in the stronghold runs)
    ultimate: ["combat/ultimate.png", [815, 391, 75, 75]],
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

const ROUND_MS = 20_000; // 陌刀 part of a round, from switching back
const CHARGE_MS = 3000;
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

function tap(p, ms = 50) {
    touch.down(p, 1);
    sleep(ms);
    touch.up(1);
}

class Over extends Error {}

/** The character's health 0–1 on this screenshot, or null when the bar cannot be read. @param {Image} image */
export function health(image) {
    const hit = color({ ...HP_GREY, image, roi: HP_ROI, count: 5, connected: true });
    if (!hit.hit) return null;
    const boxes = hit.results.map((m) => m.box);
    if (Math.min(...boxes.map(([x]) => x)) > HP_LEFT + 8) return null;
    const right = Math.max(...boxes.map(([x, , w]) => x + w));
    if (right - HP_LEFT < 4) return null; // only the left end: covered (a red screen read as 0% four times, run 10)
    return Math.max(0, Math.min(1, (right - HP_LEFT) / (HP_FULL - HP_LEFT)));
}

/**
 * @param {{hp?: number, idleMs?: number, calmMs?: number, ms?: number, within?: number, probe?: boolean,
 *   dodge?: boolean, boss?: boolean}} [args]  probe: only report what is seen; dodge: false leaves 金光 alone;
 *   boss: a boss fight (over when its bar is gone and the icons are back)
 */
export default function (args = {}) {
    const hpMin = args.hp ?? 0.5;
    const idleMs = args.idleMs ?? 4000;
    const dodgeOn = args.dodge ?? true;
    const start = Date.now();
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
        }
        walking = on;
        stride(on ? 1 : charging && Date.now() >= stillUntil ? CREEP : 0);
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
            if (args.boss && ms > GAP_LOG_MS) log(`no look for 金光 in ${ms} ms: ${lastAt} → ${at}`);
        }
        lastCheck = now;
        lastAt = at;
    }

    /** A 金光 line on the current screenshot (boss fights: as wide as 2.5 times as high, 1–3 frames sooner). */
    function seeFlash() {
        const hit = color({ ...FLASH, image: img, roi: FLASH_ROI, count: 150, connected: true });
        const ratio = args.boss ? 2.5 : 3.5;
        return hit.hit && hit.results.some(({ box: [, , w, h], count }) => w >= 230 && w >= ratio * h && (count ?? 0) >= 0.15 * w * h);
    }

    /**
     * Dodge now, backwards (the joystick pulled back with it), and again every DODGE_AGAIN_MS: a ground attack lands
     * 4–5 blows from 12 to ~38 frames after its 金光 (research on the five 镇关吼 recordings, 2026-10-10); two dodges
     * left the blows at +34 and +44 to land (run 6), so after a 金光 FLASH_DODGES of them.
     */
    function dodge(times = 2) {
        letGo(); // a held 蓄力
        touch.down(STICK, 0);
        touch.move(BACKWARD, 0);
        for (let i = 0; i < times; i++) {
            if (i) sleep(DODGE_AGAIN_MS);
            touch.down(DODGE, 2);
            sleep(50);
            touch.up(2);
        }
        touch.up(0);
        lastDodge = Date.now();
        lastCheck = lastDodge; // the dodging is not a gap
        lastHit = 0; // dodged back, out of reach: walk in again at once
        img = screenshot();
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
        dodge(FLASH_DODGES);
        const rest = Date.now() + DODGE_REST_MS;
        while (Date.now() < rest) {
            img = screenshot();
            execute();
        }
        lastCheck = Date.now();
        lastAt = "a dodge";
        return true;
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
        if (!dodgeOn || !args.boss || usedUp) return false;
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
            img = screenshot();
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
        if (!dodgeOn || !args.boss || !burst()) return false;
        const t0 = Date.now();
        log("金光 tell (orange burst): on guard");
        letGo();
        alerts++;
        let end = t0 + ALERT_MS;
        let flashed = false;
        let early = false;
        while (Date.now() < end) {
            img = screenshot();
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
            img = screenshot();
            if (skyGuard() || alert() || flash()) return true;
            execute();
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
        img = screenshot();
    }

    /** 处决 (or a boss's last move, in the same diamond) on the current screenshot: tap it. */
    function execute() {
        const now = Date.now();
        if (now - lastExecute < EXECUTE_MS) return false;
        const k = seen("execute") ? "处决" : usedUp && seen("ultimate") ? "化解" : null;
        if (!k) return false;
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
        img = screenshot();
        if (skyGuard() || alert() || flash()) img = screenshot();
        execute();
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
        if (b != null) bossSeen = now;
        if (b != null) usedUp = b === 0;
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
        walk((locked || (args.boss && !bossSeen)) && now - lastHit > (args.boss ? BOSS_WHIFF_MS : WHIFF_MS));
        heal();
    }

    /**
     * Below hpMin, the potion. A boss fight takes it on one low reading (a covered bar reads as none, not 0%) and
     * looks during the dodging too: a blow takes 40–75% at once, two readings and only between blows had it drink at
     * 29% (teacher, 2026-10-10: 喝血不及时).
     */
    function heal() {
        const h = hp();
        if (h == null) return; // covered: no reading, no potion (a stale low one had it drink at "0%")
        lows = h < hpMin ? lows + 1 : 0;
        const now = Date.now();
        if (lows >= (args.boss ? 1 : 2) && now - lastPotion > POTION_MS) {
            log(`health ${Math.round(h * 100)}%: potion`);
            tap(POTION);
            lastPotion = now;
            potions++;
        }
    }

    /** Press p until done() (on a fresh screenshot) says it came out. */
    function press(p, done, name, tries = 4, wait = 300) {
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
        if (!press(QISHU, () => !qishuLit(), "奇术", 3)) return false;
        if (!watch(PARRY_AFTER - 300)) tap(PARRY);
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

    function round() {
        if (usedUp) return hold();
        if (!weapon() || !seen("qishu")) {
            tap(LIGHT); // out of a fight only 轻击 shows; it brings back the other buttons
            watch(300);
            look();
        }
        switchTo("modao");
        qishu();
        if (seen("buff")) press(BUFF, () => !seen("buff"), "增益");

        // 横刀 (teacher, again 2026-10-10): 突进, 爆发, 突进 again, then the 突进 button turns into 伤害 (same place: a
        // swirl, then the arrow), 伤害, and back to 陌刀. 爆发 counts as out once its own button goes (cooldown).
        if (switchTo("hengdao")) {
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
                    n++;
                    watch(BURST_TAP_MS);
                    look();
                    if (!seen("burst") && gone("burst")) {
                        burst = true;
                        break;
                    }
                }
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

        switchTo("modao");
        const t0 = Date.now();
        for (let i = 0; i < CHARGES && !usedUp; i++) {
            touch.down(CHARGE, 1);
            charging = true;
            walk(walking); // creep forward while charging
            if (!watch(CHARGE_MS)) letGo(); // (a dodge has let go already)
            watch(100);
            look();
        }
        while (Date.now() - t0 < ROUND_MS && !usedUp) {
            tap(LIGHT);
            watch(200);
            look();
            if (weapon() === "modao") qishu();
        }
        rounds++;
    }

    if (args.probe) {
        const fl = color({ ...FLASH, image: img, roi: FLASH_ROI, count: 150, connected: true });
        const out = { weapon: weapon(), hp: hp(), foes: enemies(img).length, boss: args.boss ? boss() : null, bars: bars(),
            flash: fl.results.map(({ box, count }) => [...box, count]),
            orange: color({ ...BURST, image: img, roi: FLASH_ROI, count: 1, connected: false }).results.map(({ box, count }) => [...box, count]) };
        for (const k of Object.keys(T)) out[k] = Math.round((match(T[k][0], { image: img, roi: T[k][1], threshold: -1 }).score ?? 0) * 100) / 100;
        return out;
    }

    let why = "";
    try {
        look();
        for (;;) round();
    } catch (e) {
        if (!(e instanceof Over)) throw e;
        why = e.message;
    } finally {
        letGo();
    }
    log(`fight over (${why}): ${rounds} rounds, ${potions} potions, ${executions} 处决, ${dodges} dodges (${alerts} on guard), ${walks} walks in, ${turns} turns to an enemy behind, 金光 looked for at most ${maxGap} ms apart`);
    return { reason: why, rounds, potions, executions, dodges, alerts, walks, turns, maxGap };
}
