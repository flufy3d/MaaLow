// Timing of NeuralNetworkClassify / NeuralNetworkDetect (ONNX under model/classify/, model/detect/): per model, the
// first call (loads the model) and `rounds` more on one screenshot, plus screenshot + recognition on fresh frames.
// Recognition only, no clicks. 2026-10-10 (game in front): dufu/windup.onnx (MobileNetV3-L, 224x160) ~28 ms;
// YOLO11n detect 320x320 34–75 ms, 416x416 49–76 ms (it varies with the game's load / heat).
import { stats } from "./lib/stats.js";

/** @type {SkillMeta} */
export const meta = { description: "time NeuralNetworkClassify / Detect per model (no clicks)", timeout: 300_000 };

/** @param {{models?: string[], classify?: string[], roi?: Box, rounds?: number, threshold?: number}} args */
export default function (args) {
    const models = args.models ?? [];
    const rounds = args.rounds ?? 50;
    const out = {};
    // classify models (model/classify/): NeuralNetworkClassify on args.roi
    const cls = (model, image) => reco("NeuralNetworkClassify", { model, labels: ["idle", "windup"] }, { image, roi: args.roi ?? [120, 40, 840, 620] });
    for (const model of args.classify ?? ["dufu/windup.onnx"]) {
        const img = screenshot();
        const t0 = Date.now();
        const first = cls(model, img);
        const firstMs = Date.now() - t0;
        const same = [];
        for (let i = 0; i < rounds; i++) same.push(cls(model, img).ms);
        const loop = [];
        for (let i = 0; i < rounds; i++) {
            const w = Date.now();
            cls(model, screenshot());
            loop.push(Date.now() - w);
        }
        out[model] = { first_ms: firstMs, label: first.label, score: first.score, classify: stats(same), shot_classify: stats(loop) };
        log(model, JSON.stringify(out[model]));
    }
    for (const model of models) {
        const img = screenshot();
        const t0 = Date.now();
        const first = detect({ model, image: img, threshold: args.threshold ?? 0.3 });
        const firstMs = Date.now() - t0;
        const same = [];
        const wall = [];
        for (let i = 0; i < rounds; i++) {
            const w = Date.now();
            same.push(detect({ model, image: img, threshold: args.threshold ?? 0.3 }).ms);
            wall.push(Date.now() - w);
        }
        const loop = []; // screenshot + detect
        for (let i = 0; i < rounds; i++) {
            const w = Date.now();
            const s = screenshot();
            detect({ model, image: s, threshold: args.threshold ?? 0.3 });
            loop.push(Date.now() - w);
        }
        out[model] = { first_ms: firstMs, first_hit: first.hit, first_n: first.results.length, label: first.label,
            detect: stats(same), detect_wall: stats(wall), shot_detect: stats(loop) };
        log(model, JSON.stringify(out[model]));
    }
    return out;
}
