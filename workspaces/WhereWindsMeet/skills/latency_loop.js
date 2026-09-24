// Latency of the screenshot → recognize → click loop, on the world screen: open the menu (top-right button),
// wait until the menu panel shows, close it, wait until the world is back; repeat.
//
// Per iteration it times the loop body (screenshot + recognition + click, what a combat loop pays per decision) and,
// per click, the reaction: from sending the click until a screenshot shows the new state (adds the game's own UI
// animation and the display → capture path).
import { stats } from "./lib/stats.js";

/** @type {SkillMeta} */
export const meta = { description: "measure screenshot → recognize → click latency (menu open/close)", timeout: 300_000 };

const WORLD = "SignIn_InWorld"; // world menu button (template, green mask)
const MENU = "SignIn_CloseMenu"; // menu panel ("单人模式")
/** @type {Point} */
const MENU_CLOSE = [1042, 36]; // the « at the panel's top right, as in SignIn_CloseMenu

/** @param {{rounds?: number, settle?: number}} args */
export default function (args) {
    const rounds = args.rounds ?? 20;
    const loop = []; // ms: screenshot + recognize + click
    const shot = []; // ms: screenshot alone
    const reco = []; // ms: recognition alone
    const tap = []; // ms: click alone (Maa's touch down, hold, up)
    const age = []; // ms: how old the frame was when taken
    const react = []; // ms: click → first screenshot recognizing the new state
    const polls = []; // screenshots until the new state showed

    // Poll until `node` is recognized; returns [ms since t0, polls], or null after 5 s.
    const until = (node, t0) => {
        for (let n = 1; ; n++) {
            const s0 = Date.now();
            const img = screenshot();
            shot.push(Date.now() - s0);
            age.push(img.age_ms);
            const r = recognize(node);
            reco.push(r.ms);
            if (r.hit) return [Date.now() - t0, n];
            if (Date.now() - t0 > 5000) return null;
        }
    };

    if (!recognize(WORLD, { image: screenshot() }).hit) throw new Error("start on the world screen (menu button not found)");
    for (let i = 0; i < rounds; i++) {
        for (const [from, to] of [[WORLD, MENU], [MENU, WORLD]]) {
            const t0 = Date.now();
            screenshot();
            const r = recognize(from);
            if (!r.hit) throw new Error(`expected ${from} (round ${i})`);
            const c0 = Date.now();
            click(from === WORLD ? r : MENU_CLOSE);
            const t1 = Date.now();
            tap.push(t1 - c0);
            loop.push(t1 - t0);
            const got = until(to, t1);
            if (!got) throw new Error(`${to} did not show within 5 s (round ${i})`);
            react.push(got[0]);
            polls.push(got[1]);
            sleep(args.settle ?? 600); // let the panel animation finish before the next click (not timed)
        }
    }
    const out = {
        rounds,
        loop_ms: stats(loop),
        screenshot_ms: stats(shot),
        recognize_ms: stats(reco),
        click_ms: stats(tap),
        frame_age_ms: stats(age),
        reaction_ms: stats(react),
        polls: stats(polls),
    };
    log(JSON.stringify(out));
    memory.set("latency_loop", { ...out, time: Date.now() });
    return out;
}
