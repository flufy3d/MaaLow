// On-device latency of the unified 独夫 path: backbone (96x96 color crop -> 192-d) then the causal GRU head
// ([1,30,207] via infer's `extra`), one backbone + one head per screenshot, as the dufu.js scheduler will run them.
// Read-only (no clicks). Also saves one screenshot + the backbone feature + head output for an offline check
// (data/tmp/dufu_ml/unified/verify_device.py).
//   maalow do skill unified_bench --args '{"secs": 45}'
import { stats } from "./lib/stats.js";

/** @type {SkillMeta} */
export const meta = { description: "unified backbone + GRU head on-device latency (no clicks)", timeout: 180_000 };

const T = 30;
const F = 192;
const A = 15;
const D = F + A;
/** @type {InferOptions} */
const BACK = { roi: [120, 30, 840, 530], size: 96, resize: "area", color: "rgb", mean: 0, std: 1, frames: [0], post: "none" };

/** @param {{secs?: number, verify?: boolean}} args */
export default function (args) {
    const secs = args.secs ?? 45;
    const verify = args.verify ?? true;
    /** @type {{f: number[], aux: number[]}[]} */
    const ring = [];
    const back = [], head = [], loop = [], bprep = [], brun = [], hprep = [], hrun = [];
    let ready = 0, hready = 0, shots = 0;
    /** @type {Record<string, any> | null} */
    let v = null;
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000) {
        const w = Date.now();
        const im = screenshot();
        shots++;
        const b = infer("dufu/unified_back.onnx", { ...BACK, image: im });
        back.push(Date.now() - w);
        if (b.ready) {
            ready++;
            bprep.push(b.ms.prep);
            brun.push(b.ms.run ?? 0);
            const aux = new Array(A).fill(0);
            aux[0] = 1;
            ring.push({ f: b.output, aux });
            while (ring.length > T) ring.shift();
            const seq = [];
            for (let i = 0; i < T; i++) {
                const r = ring[Math.max(0, i - (T - ring.length))];
                for (const x of r.f) seq.push(x);
                for (const x of r.aux) seq.push(x);
            }
            const h0 = Date.now();
            const h = infer("dufu/unified_head.onnx", { ...BACK, image: im, extra: [{ name: "seq", dim: [1, T, D], data: seq }] });
            head.push(Date.now() - h0);
            if (h.ready) {
                hready++;
                hprep.push(h.ms.prep);
                hrun.push(h.ms.run ?? 0);
                if (verify && !v && ring.length === T) {
                    v = { file: saveImage(im, `captures/unified_bench/${im.seq}.png`), seq: im.seq, feat: b.output, out: h.output };
                }
            }
        }
        loop.push(Date.now() - w);
    }
    const out = {
        looks: shots, ready, hready, secs,
        back: stats(back), head: stats(head), loop: stats(loop),
        bprep: stats(bprep), brun: stats(brun), hprep: stats(hprep), hrun: stats(hrun),
        verify: v,
    };
    log("unified_bench", JSON.stringify({ looks: shots, ready, hready, back: out.back, head: out.head, loop: out.loop }));
    return out;
}
