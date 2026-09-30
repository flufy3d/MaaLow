// The icons at the top right of the world screen (activities, books, ...) hide during a fight. Five of them are
// template matched (templates/hud/1–5.png) and the best one counts: over a bright background one alone can drop to
// ~0.55, but the best of five stays ≥ ~0.75 out of a fight and ≤ ~0.5 in one.

/** @type {Box} */
const HUD_ROI = [660, 0, 310, 60];
const HUD = ["hud/1.png", "hud/2.png", "hud/3.png", "hud/4.png", "hud/5.png"];

/** Out of a fight: the top right icons show. */
export function calm(image) {
    return match(HUD, { image, roi: HUD_ROI, threshold: 0.65 }).hit;
}
