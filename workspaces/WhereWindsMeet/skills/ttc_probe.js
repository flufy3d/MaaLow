// The 独夫 frames-to-contact net (model/dufu/ttc.onnx, as combat.js's ttc) on every screenshot of a loop that also
// spends `busy` ms per turn (other looks); reports how often it was ready, its time, and p(k 5–17). No clicks.
import { stats } from "./lib/stats.js";

/** @type {SkillMeta} */
export const meta = { description: "ttc infer readiness / time in a loop (no clicks)", timeout: 300_000 };

const OPTS = { roi: [240, 30, 600, 600], size: 96, color: "gray", frames: [-4, -2, 0], frame_ms: 1000 / 30, post: "softmax" };

/** @param {{busy?: number[], ms?: number, tick?: number}} args tick: also infer on a screenshot of its own every this many ms of the busy part (as combat.js ttcTick) */
export default function (args) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const busy of args.busy ?? [0, 30, 60, 100]) {
        const end = Date.now() + (args.ms ?? 8000);
        const total = [], turn = [], p = [];
        let n = 0, ready = 0;
        while (Date.now() < end) {
            const t0 = Date.now();
            const img = screenshot();
            if (busy) {
                // stand-in for the other looks of a turn: template / colour checks on this screenshot
                const until = Date.now() + busy;
                let nextTick = Date.now() + (args.tick ?? Infinity);
                while (Date.now() < until) {
                    color({ lower: [200, 200, 200], upper: [255, 255, 255], image: img, roi: [0, 0, 1080, 720], count: 1 });
                    if (Date.now() >= nextTick) {
                        infer("dufu/ttc.onnx", { ...OPTS, image: screenshot() });
                        nextTick = Date.now() + (args.tick ?? Infinity);
                    }
                }
            }
            const r = infer("dufu/ttc.onnx", { ...OPTS, image: img });
            n++;
            total.push(r.ms.total);
            if (r.ready && r.probs) {
                ready++;
                p.push(Math.round((r.probs[1] + r.probs[2]) * 100));
            }
            turn.push(Date.now() - t0);
        }
        out[`busy ${busy}`] = { looks: n, ready, infer_ms: stats(total), turn_ms: stats(turn), p_5_17: stats(p) };
    }
    return out;
}
