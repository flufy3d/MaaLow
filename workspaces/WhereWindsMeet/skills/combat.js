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
import { calm as hudCalm } from "./lib/hud.js";
import { enemies } from "./lib/minimap.js";

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
};
const THRESHOLD = 0.7;

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
const STRIKE_MS = 4000; // 爆发 playing until 伤害 is ready
const PARRY_AFTER = 2000; // 奇术 recovery cut by 卸势 after this
const POTION_MS = 3000; // between potion taps
const LOCK_MS = 2000; // between lock taps when enemies are around but nothing is locked
const EXECUTE_MS = 300; // between 处决 taps while it still shows

function tap(p, ms = 50) {
    touch.down(p, 1);
    sleep(ms);
    touch.up(1);
}

class Over extends Error {}


/**
 * @param {{hp?: number, idleMs?: number, calmMs?: number, ms?: number, within?: number, probe?: boolean}} [args]  probe: only report what is seen
 */
export default function (args = {}) {
    const hpMin = args.hp ?? 0.5;
    const idleMs = args.idleMs ?? 4000;
    const until = Date.now() + (args.ms ?? 300_000);
    let lastFoe = Date.now();
    let fought = false; // the top right icons have been hidden
    let calmSince = 0; // since when they are back
    let lastPotion = 0;
    let lastLock = 0;
    let lastExecute = 0;
    let lows = 0;
    let rounds = 0;
    let potions = 0;
    let executions = 0;
    let img = screenshot();

    const seen = (k) => match(T[k][0], { image: img, roi: T[k][1], threshold: THRESHOLD }).hit;

    /** Health 0–1, or null when the bar cannot be read. */
    function hp() {
        const hit = color({ ...HP_GREY, image: img, roi: HP_ROI, count: 5, connected: true });
        if (!hit.hit) return null;
        const boxes = hit.results.map((m) => m.box);
        if (Math.min(...boxes.map(([x]) => x)) > HP_LEFT + 8) return null;
        const right = Math.max(...boxes.map(([x, , w]) => x + w));
        return Math.max(0, Math.min(1, (right - HP_LEFT) / (HP_FULL - HP_LEFT)));
    }

    /** 处决 on the current screenshot: tap it. */
    function execute() {
        const now = Date.now();
        if (now - lastExecute < EXECUTE_MS || !seen("execute")) return false;
        log("处决");
        tap(EXECUTE);
        lastExecute = now;
        executions++;
        return true;
    }

    /** New screenshot; 处决, heal, keep the lock, and end the fight when it is over. */
    function look() {
        img = screenshot();
        execute();
        const now = Date.now();
        const locked = color({ ...GOLD, image: img, roi: LOCK_ROI, count: 150 }).hit;
        const foes = enemies(img).filter((e) => e.dist <= (args.within ?? Infinity)).length;
        if (foes || locked) lastFoe = now;
        if (now - lastFoe > idleMs) throw new Over("no enemies");
        const calm = hudCalm(img);
        if (!calm) {
            fought = true;
            calmSince = 0;
        } else if (fought) {
            calmSince ||= now;
            if (now - calmSince > (args.calmMs ?? 1500)) throw new Over("out of combat");
        }
        if (now > until) throw new Over("time");
        if (foes && !locked && now - lastLock > LOCK_MS) {
            tap(LOCK);
            lastLock = now;
        }
        const h = hp();
        if (h != null) lows = h < hpMin ? lows + 1 : 0;
        if (lows >= 2 && now - lastPotion > POTION_MS) {
            log(`health ${Math.round(h * 100)}%: potion`);
            tap(POTION);
            lastPotion = now;
            potions++;
        }
    }

    /** Press p until done() (on a fresh screenshot) says it came out. */
    function press(p, done, name, tries = 4, wait = 300) {
        for (let i = 0; i < tries; i++) {
            tap(p);
            sleep(wait);
            look();
            if (done()) return true;
        }
        log(`${name}: no change after ${tries} presses`);
        return false;
    }

    function weapon() {
        return seen("modao") ? "modao" : seen("hengdao") ? "hengdao" : null;
    }

    function switchTo(w) {
        if (weapon() === w) return true;
        return press(SWITCH, () => weapon() === w, `switch to ${w}`, 4, 600);
    }

    /** 奇术 if lit, then 卸势 once its recovery has run for a while. */
    function qishu() {
        if (!seen("qishu")) return false;
        if (!press(QISHU, () => !seen("qishu"), "奇术", 3)) return false;
        sleep(PARRY_AFTER - 300);
        tap(PARRY);
        look();
        return true;
    }

    function round() {
        if (!weapon() || !seen("qishu")) {
            tap(LIGHT); // out of a fight only 轻击 shows; it brings back the other buttons
            sleep(300);
            look();
        }
        switchTo("modao");
        qishu();
        if (seen("buff")) press(BUFF, () => !seen("buff"), "增益");

        if (switchTo("hengdao")) {
            if (seen("dash")) press(DASH, () => !seen("dash"), "突进");
            if (seen("burst")) press(BUFF, () => seen("damage") || seen("strike"), "爆发");
            if (waitFor(() => { look(); return seen("strike"); }, { timeout: STRIKE_MS })) press(DASH, () => !seen("strike"), "伤害");
            else log("伤害: never ready");
        }

        switchTo("modao");
        const t0 = Date.now();
        for (let i = 0; i < CHARGES; i++) {
            touch.down(CHARGE, 1);
            sleep(CHARGE_MS);
            touch.up(1);
            sleep(100);
            look();
        }
        while (Date.now() - t0 < ROUND_MS) {
            tap(LIGHT);
            sleep(200);
            look();
            if (weapon() === "modao") qishu();
        }
        rounds++;
    }

    if (args.probe) {
        const out = { weapon: weapon(), hp: hp(), foes: enemies(img).length };
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
        touch.up(1);
    }
    log(`fight over (${why}): ${rounds} rounds, ${potions} potions, ${executions} 处决`);
    return { reason: why, rounds, potions, executions };
}
