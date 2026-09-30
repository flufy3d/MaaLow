// Two-finger pinch on the map: fingers move apart from `center` to zoom in (out: true pinches them together).
// Contacts 0 and 1 go down `from` px either side of the center (vertically) and slide to `to` px in `steps` moves.
//   {times: 3}                         zoom in three pinches' worth at the screen middle
//   {center: [450, 380], out: true}    zoom out there

/** @type {SkillMeta} */
export const meta = { description: "pinch to zoom the map in / out", timeout: 30_000 };

/** @param {{center?: Point, from?: number, to?: number, out?: boolean, times?: number, steps?: number, ms?: number}} args */
export default function (args) {
    const [cx, cy] = args.center ?? [400, 380];
    let a = args.from ?? 30;
    let b = args.to ?? 250;
    if (args.out) [a, b] = [b, a];
    const steps = args.steps ?? 12;
    const ms = args.ms ?? 300;
    for (let t = 0; t < (args.times ?? 1); t++) {
        touch.down([cx, cy - a], 0);
        touch.down([cx, cy + a], 1);
        for (let i = 1; i <= steps; i++) {
            const d = Math.round(a + ((b - a) * i) / steps);
            sleep(ms / steps);
            touch.move([cx, cy - d], 0);
            touch.move([cx, cy + d], 1);
        }
        sleep(50);
        touch.up(0);
        touch.up(1);
        sleep(300);
    }
}
