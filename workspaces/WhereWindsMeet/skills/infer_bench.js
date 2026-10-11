// Timing and check of infer() (ONNX through the app's onnxruntime), recognition only, no clicks. Default model: the
// 独夫 frames-to-contact net (MobileNetV3-small, 96x96, gray frames n-4, n-2, n as 3 channels, data/tmp/dufu_moves/cnn.py).
//   maalow do skill infer_bench --args '{"threads": [1, 2]}'
// check: also saves the screenshots of one ready call to captures/infer_check/<seq>.png and returns its input bytes
// and output, for an offline onnxruntime run on the same input (data/tmp/infer_check.py).
import { stats } from "./lib/stats.js";

/** @type {SkillMeta} */
export const meta = { description: "time infer() per thread count (no clicks)", timeout: 300_000 };

/** @type {InferOptions} */
// model/dufu/ttc.onnx normalizes inside (no mean / std; data/tmp/dufu_yolo/train_ttc.py)
const TTC = { roi: [240, 30, 600, 600], size: 96, color: "gray", frames: [-4, -2, 0], frame_ms: 1000 / 30, post: "softmax" };

/** @param {{model?: string, rounds?: number, threads?: number[], frame_ms?: number, check?: boolean, opts?: InferOptions}} args */
export default function (args) {
    const model = args.model ?? "dufu/ttc.onnx";
    const rounds = args.rounds ?? 100;
    const base = { ...TTC, ...(args.opts ?? {}), ...(args.frame_ms ? { frame_ms: args.frame_ms } : {}) };
    /** @type {Record<string, any>} */
    const out = { info: modelInfo(model) };
    for (const threads of args.threads ?? [1, 2]) {
        const o = { ...base, threads };
        const t0 = Date.now();
        let img = screenshot();
        const first = infer(model, { ...o, image: img });
        const firstMs = Date.now() - t0;
        // screenshot + infer each round, as a skill polling would
        const loop = [], run = [], prep = [], gaps = [];
        let ready = 0;
        const s0 = img;
        for (let i = 0; i < rounds; i++) {
            const w = Date.now();
            img = screenshot();
            const r = infer(model, { ...o, image: img });
            loop.push(Date.now() - w);
            prep.push(r.ms.prep);
            if (r.ready) {
                ready++;
                run.push(r.ms.run ?? 0);
                gaps.push(r.frames.map((f) => f?.ms).join("/"));
            }
        }
        const fps = ((img.seq - s0.seq) * 1000) / Math.max(1, img.time - s0.time);
        // the same frames again: onnxruntime alone (plus the call)
        const same = [], wall = [];
        for (let i = 0; i < rounds; i++) {
            const w = Date.now();
            const r = infer(model, { ...o, image: img });
            wall.push(Date.now() - w);
            if (r.ready) same.push(r.ms.run ?? 0);
        }
        out[`threads_${threads}`] = {
            first_ms: firstMs, first_ready: first.ready, ready: `${ready}/${rounds}`, stream_fps: Math.round(fps * 10) / 10,
            shot_infer: stats(loop), prep: stats(prep), run: stats(run), run_same: stats(same), call_same: stats(wall),
            frame_ms_sample: gaps.slice(0, 8),
        };
        log(`threads ${threads}`, JSON.stringify(out[`threads_${threads}`]));
    }
    if (args.check ?? true) {
        // until a call is ready whose frames are all among the run's last 8 screenshots (the ones still kept)
        /** @type {Image[]} */
        const last = [];
        const kept = (/** @type {Inference} */ r) => r.ready && r.frames.every((f) => f && last.some((i) => i.seq === f.seq));
        let r = null;
        for (let i = 0; i < 50 && !(r && kept(r)); i++) {
            const img = screenshot();
            last.push(img);
            if (last.length > 8) last.shift();
            r = infer(model, { ...base, image: img, input: true });
        }
        const shots = new Map(last.map((i) => [i.seq, i]));
        if (r && kept(r)) {
            const files = r.frames.map((f) => (f && shots.has(f.seq) ? saveImage(/** @type {Image} */ (shots.get(f.seq)), `captures/infer_check/${f.seq}.png`) : null));
            out.check = { files, frames: r.frames, output: r.output, probs: r.probs, index: r.index, input: r.input, opts: base };
        } else {
            out.check = { ready: false };
        }
    }
    return out;
}
