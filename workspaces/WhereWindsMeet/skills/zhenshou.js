// 镇守挑战 (boss challenges), from the teacher's recording 镇守挑战-镇关吼 (20261009-225813) and messages 16–31:
//   menu → 江湖行 → 挑战 → the 镇守挑战 tab → the boss's card (scrolled to, like the stronghold cards) → 传送;
//   the fight is combat.js in boss mode (金光 dodged, walking in when the blows hit air, the last move's 化解 tapped);
//   won, a chest mark shows on screen: walk at it (turning the camera on it) until 获取奖励 is offered, tap it,
//   确认领取 with the panel on 领取三份 (teacher: yes), then 再次挑战 (teacher: quickest; whether it refills the
//   potions is to be seen) or 继续 and the exit icon back to the world.
// Potions only come back at a teleport stone (teacher, frame 4811), not by leaving: before the first teleport the
// character goes home to the 不羡仙 stone (teacher, explore message 42: big map → 切换区域 → 清河 → 隐月 → the stone
// → 传送) to heal and fill up. Being revived (疗伤) in the arena fills them up too (2026-10-10).
import { health } from "./combat.js";
import { calm } from "./lib/hud.js";
import { turn } from "./move.js";
import { lines, toCard } from "./stronghold.js";

/** @type {SkillMeta} */
export const meta = { description: "镇守挑战: teleport to a boss, fight it, take the chest (领取三份), again", timeout: 3_600_000 };

/** Bosses: the card's title template. */
const BOSSES = { 镇关吼: "zhenshou_card_zhenguanhou.png" };

/** @type {Box} */ const TAB_ROI = [50, 20, 90, 30]; // 镇守挑战, the first tab: gold when open
const TAB_GOLD = { lower: [180, 130, 60], upper: [255, 215, 160] };
/** @type {Point} */ const TAB = [93, 40];
/** @type {Box} */ const BOUNTY_ROI = [130, 640, 180, 80]; // 发布悬赏, bottom of the challenge pages
/** @type {Box} */ const GO_ROI = [800, 640, 270, 80]; // the boss map's 传送
/** @type {Point} */ const STICK = [175, 569];
/** @type {Point} */ const FORWARD = [175, 486];
/** @type {Box} */ const MARK_ROI = [100, 100, 880, 500]; // the chest mark on screen (a white chest, 26米 under it)
/** @type {Box} */ const OFFER_ROI = [690, 360, 130, 220]; // the interaction list (route.js LIST_ROI)
/** @type {Box} */ const REWARD_ROI = [790, 470, 280, 190]; // 镇守奖励: 领取三份, (剩余避战符, 扫荡次数,) 消耗心力
/** @type {Box} */ const EXIT_ROI = [660, 0, 70, 50];
const LESS_X = 815; // 镇守奖励: the ◀ left of 领取三份 (fewer shares)
const MORE_X = 1040; // and the ▶ right of it
/** @type {Point} */ const PANEL_CLOSE = [1035, 38];
/** @type {Box} */ const PANEL_TITLE_ROI = [790, 10, 160, 45];
/** @type {Box} */ const AGAIN_ROI = [818, 665, 100, 30]; // 再次挑战: white when it can be taken, gray (V ~57) when not
const LIT = { lower: [0, 0, 150], upper: [180, 60, 255], method: 40 };
const AIM_F = 600; // screen px from the middle to the joystick angle: atan(dx / AIM_F) (~90° across the screen)
const STICK_R = 83; // joystick radius (move.js)
const EDGE_PX = 250; // the chest this far off the middle: turn to it before walking
const FAST_M = 10; // the mark's 米: full speed beyond this, half below
const SLOW_M = 4; // and short pushes below this (the mark hides at ~3)
const METERS_MS = 800; // the 米 label read this often (OCR ~240 ms)
const NUDGE_MS = 150;
const TURN_STEP = 50; // px dragged per turn toward it (slow drags turn less than fast ones)
const SETTLE_MS = 400;
const PILLAR = { lower: [8, 40, 200], upper: [35, 255, 255], method: 40 }; // HSV: the chest's gold light
/** @type {Box} */ const PILLAR_ROI = [200, 150, 680, 450];
const CHEST_MS = 60_000;
/** @type {Point} */ const MINIMAP = [140, 65];
/** @type {Point} */ const REGIONS = [63, 633]; // big map: 切换区域
/** @type {Box} */ const REGION_ROI = [800, 70, 260, 570];
const REGION_PIC_X = 980; // a region's picture, right of its name: a tap there opens it
/** @type {Box} */ const MAP_ROI = [0, 60, 770, 580];
const STONE = { lower: [190, 160, 110], upper: [245, 225, 190] }; // RGB: the beige of a stone icon (the map is gray)
/** @type {Box} */ const POTION_NUM_ROI = [688, 680, 28, 20];
const AGAIN_POTIONS = 3; // 再次挑战 neither heals nor fills the potions (teacher, message 80): only with this many
const AGAIN_HP = 0.7; // and this much health left, else home first
const FULL_POTIONS = 6;
const STONE_STEP_MS = 400;
/** @type {Box} */ const PICK_ROI = [570, 360, 210, 160]; // icons on top of each other: a list to pick from
/** @type {Box} */ const PANEL_ROI = [790, 10, 200, 70]; // the picked mark's name and kind (地标·传送), top right

function tapBox(b) {
    click(Math.round(b[0] + b[2] / 2), Math.round(b[1] + b[3] / 2));
}

/** Tap the template once it shows (within ms); false if it never did. */
function tapWhen(template, roi, ms) {
    const hit = waitFor(() => {
        const h = match(template, { image: screenshot(), roi, threshold: 0.8 });
        return h.hit ? h : null;
    }, { timeout: ms, interval: 200 });
    if (!hit) return false;
    tapBox(hit.box);
    return true;
}

/** From the world, the menu, 江湖行 or a challenge page to the boss's 传送; then wait for the arena. */
function teleport(card) {
    for (let i = 0; i < 20; i++) {
        const image = screenshot();
        const go = match("teleport_button.png", { image, roi: GO_ROI, threshold: 0.8 });
        if (go.hit) {
            log("传送");
            tapBox(go.box);
            landed("传送");
            return;
        }
        if (match("challenge_bounty_button.png", { image, roi: BOUNTY_ROI, threshold: 0.8 }).hit) {
            if (!color({ ...TAB_GOLD, image, roi: TAB_ROI, count: 60 }).hit) {
                log("镇守挑战 tab");
                click(TAB[0], TAB[1]);
                sleep(1500);
                continue;
            }
            toCard(card);
            sleep(3000);
            continue;
        }
        if (recognize("Teleport_Challenge", { image }).hit) runNode("Teleport_Challenge", { once: true, override: { next: [] } });
        else if (recognize("Teleport_Jianghu", { image }).hit) runNode("Teleport_Jianghu", { once: true, override: { next: [] } });
        else if (recognize("Teleport_OpenMenu", { image }).hit) runNode("Teleport_OpenMenu", { once: true, override: { next: [] } });
        else {
            runSkill("clear_popups", {});
            sleep(1000);
        }
    }
    throw new Error("镇守挑战: never got to 传送");
}

/** Tap a line of OCR text in roi that includes `text`; false if none. */
function tapText(text, roi, ms = 3000) {
    const hit = waitFor(() => {
        const r = ocr({ image: screenshot(), roi }).results.find((m) => (m.text ?? "").includes(text));
        return r ?? null;
    }, { timeout: ms, interval: 400 });
    if (!hit) return false;
    tapBox(hit.box);
    return true;
}

/** Back to the world screen, waiting out the loading after a teleport. */
function landed(what) {
    sleep(3000);
    if (!waitFor("Teleport_OpenMenu", { timeout: 60_000, interval: 500 })) throw new Error(`${what}: not back 60 s after the teleport`);
    sleep(2000);
}

/** Open the big map (centered on the character) from the world screen. */
function openMap() {
    click(MINIMAP[0], MINIMAP[1]);
    if (!waitFor(() => match("map_filter_button.png", { image: screenshot(), roi: [20, 640, 150, 80], threshold: 0.8 }).hit, { timeout: 5000 }))
        throw new Error("big map did not open");
    sleep(800);
}

/** Stones on the big map: beige upright blobs (the icon's body), [x, y], away from the left panels. */
function stones() {
    const hit = color({ ...STONE, image: screenshot(), roi: MAP_ROI, count: 95, connected: true });
    return hit.results
        .filter(({ box: [x, y, w, h], count }) => w >= 10 && w <= 16 && h >= 12 && h <= 19 && (count ?? 0) <= 170 && !(x < 260 && y > 460))
        .map(({ box: [x, y, w, h] }) => /** @type {Point} */ ([x + w / 2, y + h / 2]));
}

/**
 * To a stone to heal and fill the potions (they only come back by a stone, teacher; not at an inn or a house): big
 * map → 切换区域 → 清河 → 隐月山, then the stone nearest the map's middle (teacher, message 92: any stone will do), the
 * nearest few tapped in turn until the panel says 传送 → 传送. 清河 opens on a tap on its picture, not its name
 * (explore 0015). The map keeps its zoom, so which stone that is can change; any is fine.
 */
function home() {
    runSkill("clear_popups", {});
    if (!waitFor("Teleport_OpenMenu", { timeout: 5000 })) throw new Error("home: not on the world screen");
    openMap();
    click(REGIONS[0], REGIONS[1]);
    sleep(1200);
    const qinghe = waitFor(() => ocr({ image: screenshot(), roi: REGION_ROI }).results.find((m) => (m.text ?? "").includes("清河")) ?? null, { timeout: 3000, interval: 400 });
    if (!qinghe?.box) throw new Error("home: no 清河 in 切换区域");
    click(REGION_PIC_X, Math.round(qinghe.box[1] + qinghe.box[3] / 2));
    sleep(1200);
    if (!tapText("隐月", REGION_ROI)) throw new Error("home: no 隐月山 under 清河");
    sleep(1500);
    swipe([400, 650], [400, 640], 200); // closes the region list, the map stays (explore 0019)
    sleep(800);
    let left = stones().sort((a, b) => Math.hypot(a[0] - 540, a[1] - 360) - Math.hypot(b[0] - 540, b[1] - 360)).slice(0, 4);
    while (left.length) {
        const [x, y] = /** @type {Point} */ (left.shift());
        click(Math.round(x), Math.round(y));
        sleep(1200);
        const name = ocrText(PANEL_ROI);
        if (name.includes("传送") && tapWhen("teleport_button.png", GO_ROI, 2000)) {
            log(`home: stone ${name}`);
            landed("home");
            return refill();
        }
        log(`home: mark at ${Math.round(x)},${Math.round(y)} is "${name}"`);
        left = left.map(([a, b]) => /** @type {Point} */ ([a + 540 - x, b + 360 - y]));
    }
    throw new Error("home: no stone near 隐月山");
}

/**
 * Landed by a stone, it lies a couple of steps ahead (the camera faces it): walk at it until health and potions are
 * back (瓷窑, 2026-10-10: 5 potions and 81% on landing, 6 and 100% after a step).
 */
function refill() {
    for (let i = 0; i < 4; i++) {
        step(STONE_STEP_MS);
        const ok = waitFor(() => {
            const hp = health(screenshot());
            return hp != null && hp >= 0.99 && (potionsLeft() ?? 0) >= FULL_POTIONS;
        }, { timeout: 1500, interval: 300 });
        if (ok) {
            log("home: healed, potions full");
            return "full";
        }
    }
    log(`home: not healed by the stone (health ${health(screenshot())}, ${potionsLeft()} potions)`);
    return "not full";
}

/** All the text OCR reads in roi of this screenshot, joined. */
function ocrIn(image, roi) {
    return lines(ocr({ image, roi }).results).join("");
}

/** All the text OCR reads in roi, joined. */
function ocrText(roi) {
    return lines(ocr({ image: screenshot(), roi }).results).join("");
}

/** Potions left: the number under the bottle, or null. */
function potionsLeft() {
    const t = ocrText(POTION_NUM_ROI).replace(/[^0-9]/g, "");
    return t ? Number(t) : null;
}

/** 获取奖励 in the interaction list on this screenshot. */
const offered = (image) => match("interact_reward.png", { image, roi: OFFER_ROI, threshold: 0.8 });

/** Walk forward for up to ms, stopping at once when 获取奖励 is offered; true then. */
function step(ms) {
    touch.down(STICK, 0);
    touch.move(FORWARD, 0);
    try {
        return !!waitFor(() => offered(screenshot()).hit, { timeout: ms, interval: 60 });
    } finally {
        touch.up(0);
    }
}

/** The chest's gold pillar (close by the mark hides): x of the tallest warm bright upright blob, or null. */
function pillar(image) {
    const hit = color({ ...PILLAR, image, roi: PILLAR_ROI, count: 300, connected: true });
    const up = hit.results.filter(({ box: [, , w, h] }) => h >= 2 * w && h >= 80);
    if (!up.length) return null;
    const b = up.reduce((a, c) => (c.box[3] > a.box[3] ? c : a)).box;
    return b[0] + b[2] / 2;
}

/** Where the chest is on screen: the mark's x (far), else the gold pillar's (close by the mark hides). */
function chestX(image) {
    const mark = match("zhenshou_chest_mark.png", { image, roi: MARK_ROI, threshold: 0.85 });
    if (mark.hit && mark.box) return { x: mark.box[0] + mark.box[2] / 2, near: false, box: mark.box };
    const x = pillar(image);
    return x == null ? null : { x, near: true, box: null };
}

/**
 * Won: walk to the chest and tap 获取奖励 the moment it is offered, then wait for the reward panel. Far, the chest
 * mark (26米) shows where it is; close, the mark hides and the chest's gold pillar does. The joystick is pushed toward
 * where the chest is on screen and re-aimed every look while walking (half way once close: slower), so the camera
 * is never turned to it (teacher, 2026-10-10: turning to aim overshot every time, a dozen tries before going).
 * Only with the chest out of sight does the camera turn to look for it.
 */
function chest() {
    const end = Date.now() + CHEST_MS;
    let looks = 0;
    let held = false;
    let nearSeen = 0; // the pillar (close) last seen
    let meters = Infinity; // the mark's distance label, read now and then
    let metersAt = 0;
    const go = (/** @type {number} */ x, /** @type {number} */ speed) => {
        const a = Math.atan2(x - 540, AIM_F);
        const r = STICK_R * speed;
        const p = /** @type {Point} */ ([Math.round(STICK[0] + r * Math.sin(a)), Math.round(STICK[1] - r * Math.cos(a))]);
        if (!held) touch.down(STICK, 0);
        touch.move(p, 0);
        held = true;
    };
    const stop = () => {
        if (held) touch.up(0);
        held = false;
    };
    try {
        while (Date.now() < end) {
            const image = screenshot();
            let offer = offered(image);
            if (offer.hit) {
                stop();
                sleep(SETTLE_MS); // standing still, then tap if still offered
                offer = offered(screenshot());
                if (!offer.hit) continue;
                log("获取奖励");
                tapBox(offer.box);
                if (waitFor(() => panel(), { timeout: 4000, interval: 400 })) return true;
                log("获取奖励: no panel, again");
                continue;
            }
            const at = chestX(image);
            if (at && Math.abs(at.x - 540) > EDGE_PX) {
                // far off to a side, or behind: the mark sits at the screen's edge with an arrow (68米 the wrong way,
                // 2026-10-10); turn to it first, slowly, a bit at a time
                stop();
                looks = 0;
                const drag = Math.sign(at.x - 540) * TURN_STEP;
                turn(drag, TURN_STEP * 10);
                sleep(400);
                continue;
            }
            if (at && at.box && Date.now() - metersAt > METERS_MS) {
                const [mx, my, mw, mh] = at.box;
                const t = ocrIn(image, [Math.max(0, mx - 30), my + mh, mw + 60, 26]).match(/(\d+)\s*米/);
                if (t) meters = Number(t[1]);
                metersAt = Date.now();
            }
            if (at && !at.near && meters > SLOW_M) { // far: walk, faster the farther
                looks = 0;
                go(at.x, meters > FAST_M ? 1 : 0.5);
                sleep(60);
                continue;
            }
            if (at) {
                // close (the mark a few 米 off, or hidden and the pillar shows): a short push, then stand and look
                // for the offer (teacher, 2026-10-10: it ran past without slowing down, then wandered off)
                looks = 0;
                if (at.near) nearSeen = Date.now();
                go(at.x, 0.4);
                sleep(NUDGE_MS);
                stop();
                sleep(250);
                continue;
            }
            stop();
            if (Date.now() - nearSeen < 2000) { // lost it close by: gone past, back a little
                log("chest lost close by: stepping back");
                touch.down(STICK, 0);
                touch.move([STICK[0], STICK[1] + STICK_R * 0.4], 0);
                sleep(NUDGE_MS);
                touch.up(0);
                nearSeen = 0;
                sleep(250);
                continue;
            }
            if (looks >= 6) throw new Error("chest: not in sight all round");
            log("chest out of sight: turning to look");
            turn(100); // ~60°
            looks++;
            sleep(400);
        }
    } finally {
        stop();
    }
    return false;
}

/**
 * The 镇守奖励 panel's lines, or null when it is not open. With 避战符 left it has two more lines (剩余避战符, 扫荡次数)
 * and 领取三份 sits higher (run 4: the panel was there but not read, and the next tap on 获取奖励 closed it).
 */
function panel() {
    const image = screenshot();
    if (!ocrIn(image, PANEL_TITLE_ROI).includes("镇守奖励")) return null;
    return lines(ocr({ image, roi: REWARD_ROI }).results);
}

/** The 镇守奖励 panel: 确认领取 on 领取三份 (teacher), else left open for a person. */
function reward() {
    let read = waitFor(() => panel(), { timeout: 5000, interval: 500 });
    if (!read) return "no reward panel";
    log(`reward panel: ${read.join(" / ")}`);
    // the panel keeps the share last taken (双份 after a 心力-short one, 2026-10-10): ▶ back up to 三份
    for (let i = 0; i < 2 && !read.some((l) => l.includes("三份")); i++) {
        const line = ocr({ image: screenshot(), roi: REWARD_ROI }).results.find((m) => (m.text ?? "").includes("领取"));
        if (!line?.box) break;
        click(MORE_X, Math.round(line.box[1] + line.box[3] / 2));
        sleep(800);
        read = panel() ?? read;
        log(`up to 三份: ${read.join(" / ")}`);
    }
    if (!read.some((l) => l.includes("三份"))) return `reward panel not on 领取三份 (${read.join(" / ")}): left open`;
    // 心力 short of 三份 (60): 双份 (40) or 单份 (20) with what is left, the teacher's "刷完" (2026-10-10, 56 left:
    // 双份); the ◀ left of the 领取 line steps down; none affordable: left for a person, and no more fights
    for (let i = 0; i < 2 && short(read); i++) {
        const line = ocr({ image: screenshot(), roi: REWARD_ROI }).results.find((m) => (m.text ?? "").includes("领取"));
        if (!line?.box) break;
        click(LESS_X, Math.round(line.box[1] + line.box[3] / 2));
        sleep(800);
        read = panel() ?? read;
        log(`心力 short: ${read.join(" / ")}`);
    }
    if (short(read)) return "out of 心力";
    if (!tapWhen("reward_confirm.png", [800, 640, 280, 80], 3000)) return "no 确认领取";
    return "taken";
}

/** The panel's 消耗心力 have/need says there is not enough. @param {string[]} read */
function short(read) {
    const m = read.join("").match(/心力\D*(\d+)\s*\/\s*(\d+)/);
    return !!m && Number(m[1]) < Number(m[2]);
}

/**
 * @param {{boss?: string, times?: number, again?: boolean, hp?: number, home?: boolean, here?: boolean, chest?: boolean, probe?: boolean, homeOnly?: boolean}} args
 *   boss: the card (镇关吼); times: fights in a row (default 1); again: 再次挑战 between them (default true), else out
 *   and in by teleport (home first); hp: potion below; home: false skips going home first; here: already in the arena;
 *   chest: (with here) the first fight is won already, go for its chest; probe: only report potions and health
 */
export default function (args = {}) {
    const boss = args.boss ?? "镇关吼";
    const card = BOSSES[boss];
    if (!card) throw new Error(`no card template for ${boss}`);
    const times = args.times ?? 1;
    if (args.probe) return { potions: potionsLeft(), health: health(screenshot()), stones: stones() };
    if (args.homeOnly) return home();
    const report = [];
    if (!args.here) {
        if (args.home !== false) home();
        teleport(card);
    }
    for (let i = 1; i <= times; i++) {
        const t0 = Date.now();
        const fight = args.chest && i === 1 ? { reason: "boss gone" } : runSkill("combat", { boss: true, hp: args.hp ?? 0.7, ms: 900_000 });
        log(`fight ${i}: ${JSON.stringify(fight)}`);
        if (fight?.reason !== "boss gone") throw new Error(`fight ${i} not won: ${fight?.reason}`);
        const hp = health(screenshot());
        const potions = potionsLeft();
        log(`after fight ${i}: health ${hp == null ? "?" : Math.round(hp * 100) + "%"}, ${potions ?? "?"} potions`);
        if (!chest()) throw new Error(`fight ${i}: no 获取奖励 within ${CHEST_MS / 1000} s`);
        const got = reward();
        log(`chest ${i}: ${got}`);
        report.push({ fight: i, s: Math.round((Date.now() - t0) / 1000), ...fight, hp, potions, reward: got });
        if (got === "out of 心力") {
            click(PANEL_CLOSE[0], PANEL_CLOSE[1]); // the chest stays; out of the arena
            sleep(1500);
            if (tapWhen("zhenshou_exit.png", EXIT_ROI, 5000)) landed("退出");
            break;
        }
        if (got !== "taken") break;
        const more = i < times;
        const fit = (hp ?? 0) >= AGAIN_HP && (potions ?? 0) >= AGAIN_POTIONS;
        // the result page (再次挑战 / 继续) comes after a plain 领取三份; with 扫荡 taken too it went straight back to
        // the arena (run 4)
        // the result page can take a few seconds, the arena (its exit icon) showing meanwhile (run 7)
        const resultPage = () => match("result_continue.png", { image: screenshot(), roi: [900, 640, 180, 80], threshold: 0.8 }).hit;
        const page = waitFor(resultPage, { timeout: 60_000, interval: 300 }) ? "result" // with 扫荡: >8 s (run 9), >25 s with 3
            : waitFor(() => match("zhenshou_exit.png", { image: screenshot(), roi: EXIT_ROI, threshold: 0.8 }).hit, { timeout: 7000, interval: 300 }) ? "arena" : null;
        if (!page) throw new Error("neither the result page nor the arena after 领取");
        // with 扫荡 there is a result page for each: 再次挑战 is gray on all but the last, 继续 turns the page
        // (2026-10-10: a tap on the gray one did nothing)
        const want = more && args.again !== false && (fit || args.home === false);
        let again = false;
        for (let n = 0; n < 8 && waitFor(resultPage, { timeout: n ? 8000 : 1000, interval: 300 }); n++) {
            const image = screenshot();
            const btn = match("result_again.png", { image, roi: [800, 640, 280, 80], threshold: 0.8 });
            const lit = btn.hit && color({ ...LIT, image, roi: AGAIN_ROI, count: 600 }).hit;
            if (want && lit && btn.box) {
                tapBox(btn.box);
                log("再次挑战");
                again = true;
                break;
            }
            if (!tapWhen("result_continue.png", [900, 640, 180, 80], 3000)) throw new Error("no 继续");
            log(lit ? "继续" : "继续 (next result page)");
            sleep(2000);
        }
        if (again) {
            landed("再次挑战");
            continue;
        }
        sleep(1500);
        runSkill("clear_popups", {});
        if (!tapWhen("zhenshou_exit.png", EXIT_ROI, 5000)) throw new Error("no exit icon");
        log("退出");
        sleep(3000);
        if (!waitFor(() => { const im = screenshot(); return recognize("Teleport_OpenMenu", { image: im }).hit && calm(im); }, { timeout: 60_000, interval: 500 }))
            throw new Error("not back in the world 60 s after 退出");
        if (more) {
            if (args.home !== false) home();
            teleport(card);
        }
    }
    return report;
}
