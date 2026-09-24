// Close whatever popups cover the game (shop, reward, item tip, idle slideshow) until the screen stays clear.
// One screenshot is checked against all popup nodes at once; a hit runs that node once, so it clicks exactly as the
// pipeline defines (its target and post_delay). Used standalone, before tasks, or from a pipeline node:
//   "ClearPopups": {"action": "Custom", "custom_action": "clear_popups", "custom_action_param": {"clear_frames": 3}}

/** @type {SkillMeta} */
export const meta = { description: "close popups until the screen stays clear", timeout: 60_000 };

const POPUPS = ["CloseRewardPopup", "CloseItemTip", "CloseShopPopup", "DismissIdleSlideshow"];

/** @param {{nodes?: string[], clear_frames?: number, interval?: number}} args */
export default function (args) {
    const nodes = args.nodes ?? POPUPS;
    const need = args.clear_frames ?? 3; // clear screenshots in a row to call it done
    const closed = [];
    let clear = 0;
    while (clear < need) {
        const image = screenshot();
        const hit = nodes.find((n) => recognize(n, { image }).hit);
        if (!hit) {
            clear++;
            sleep(args.interval ?? 300);
            continue;
        }
        clear = 0;
        const r = runNode(hit, { once: true });
        log(`${hit}: ${r.hit ? "closed" : "missed"}`);
        if (r.hit) closed.push(hit);
        if (closed.length > 20) throw new Error(`popups keep coming: ${closed.slice(-5).join(", ")}`);
    }
    if (closed.length) event("popups_closed", { closed });
    return { closed };
}
