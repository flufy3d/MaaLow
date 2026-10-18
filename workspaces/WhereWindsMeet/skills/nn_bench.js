// onnxruntime CPU vs NNAPI (and thread count / spin) for the 独夫 pair, one run. Each config: its own fresh
// screenshot, compared against a CPU t1 call on that same screenshot (backbone features / head output), then a
// paced loop of screenshot -> backbone -> head on live frames. The head is always fed one fixed 30x207 seq (it
// ignores its image input). Read-only (no clicks). The `wall - prep - run` column is the JS<->app JSON bridge.
//   maalow do skill nn_bench --args '{"secs":12}'
// ring: the no-image head pipeline (dufu.js seqRing): the backbone appends its feature + aux to the run's ring and the
// head is called without an image on that ring. Measures the new head (with bridge) vs the old image + data head on
// the same screenshot / seq, checks the two outputs against each other (max|d| <= 1e-5) and times a paced loop.
//   maalow do skill nn_bench --args '{"secs":10,"backModel":"dufu/unified_back9.onnx","headModel":"dufu/unified_head9s.onnx","headModelOld":"dufu/unified_head9.onnx","ring":true}'
import { stats } from "./lib/stats.js";

/** @type {SkillMeta} */
export const meta = { description: "CPU/NNAPI x threads A/B for the dufu backbone+head (no clicks)", timeout: 600_000 };

const T = 30, F = 192, A = 15, D = F + A;
/** @type {InferOptions} */
const BACK = { roi: [120, 30, 840, 530], size: 96, resize: "area", color: "rgb", mean: 0, std: 1, frames: [0], post: "none" };

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function diff(a, b) {
    let max = 0, sum = 0;
    const k = Math.min(a.length, b.length);
    for (let i = 0; i < k; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; sum += d; }
    const r = (/** @type {number} */ x) => Math.round(x * 1e5) / 1e5;
    return { n: k, lenA: a.length, lenB: b.length, max: r(max), mean: r(k ? sum / k : 0) };
}

/** Standard base64 (padding included) of the little-endian packed float32 bytes, for `extra.data_b64`. @param {number[]} v */
function b64of(v) {
    const buf = new Uint8Array(v.length * 4);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i], true);
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < buf.length; i += 3) {
        const b0 = buf[i], b1 = i + 1 < buf.length ? buf[i + 1] : 0, b2 = i + 2 < buf.length ? buf[i + 2] : 0;
        out += A[b0 >> 2] + A[((b0 & 3) << 4) | (b1 >> 4)] + (i + 1 < buf.length ? A[((b1 & 15) << 2) | (b2 >> 6)] : "=")
            + (i + 2 < buf.length ? A[b2 & 63] : "=");
    }
    return out;
}

/** @param {{secs?: number, backModel?: string, headModel?: string, headModelOld?: string, ring?: boolean, skipBack?: boolean, skipHead?: boolean, configs?: {label: string, provider: "cpu"|"nnapi", threads: number, spin?: boolean}[]}} args */
export default function (args) {
    const secs = args.secs ?? 12;
    const skipBack = args.skipBack === true;
    const skipHead = args.skipHead === true;
    const backModel = args.backModel ?? "dufu/unified_back.onnx";
    const headModel = args.headModel ?? "dufu/unified_head.onnx";
    const configs = args.configs ?? [
        { label: "cpu t1", provider: "cpu", threads: 1 },
        { label: "cpu t2", provider: "cpu", threads: 2 },
        { label: "cpu t4", provider: "cpu", threads: 4 },
        { label: "cpu t2 spin", provider: "cpu", threads: 2, spin: true },
        { label: "nnapi t1", provider: "nnapi", threads: 1 },
        { label: "nnapi t2", provider: "nnapi", threads: 2 },
    ];
    /** @type {Record<string, any>} */
    const out = { pair: `${backModel} + ${headModel}`, secs, configs: {} };

    // ring: the no-image head pipeline (@see the header). ①/② the new image-less head vs the old image + data head on
    // the same screenshot and seq, ③ their outputs against each other, ④ a paced loop for the main loop. Read-only.
    if (args.ring === true) {
        const headOld = args.headModelOld ?? "dufu/unified_head9.onnx";
        /** @type {Record<string, any>} */
        const r = { backModel, headModel, headOld };
        const img = screenshot();
        const firstBack = infer(backModel, { ...BACK, image: img });
        if (!firstBack.ready || !firstBack.output) return { error: "the backbone is not ready on the first screenshot" };
        const feat = firstBack.output;
        /** @type {number[]} */
        const aux = new Array(A).fill(0);
        aux[0] = 1;
        /** @type {number[]} */
        const seq = [];
        for (let i = 0; i < T; i++) {
            for (const x of feat) seq.push(x);
            for (const a of aux) seq.push(a);
        }
        // ② the old pipeline's head (image + JSON data seq) on this screenshot / seq
        /** @type {number[]} */
        const oldMs = [];
        /** @type {number[] | null} */
        let outOld = null;
        for (let i = 0; i < 20; i++) {
            const t = Date.now();
            const h = infer(headOld, { ...BACK, image: img, extra: [{ name: "seq", dim: [1, T, D], data: seq }] });
            oldMs.push(Date.now() - t);
            if (!outOld && h.ready && h.output) outOld = h.output;
        }
        r.headOld = stats(oldMs);
        // ②b the same call with the seq as packed little-endian float32 base64 (`data_b64`): same output expected
        const hb = infer(headOld, { ...BACK, image: img, extra: [{ name: "seq", dim: [1, T, D], data_b64: b64of(seq) }] });
        let b64max = NaN;
        if (outOld && hb.ready && hb.output) {
            b64max = outOld.length === hb.output.length ? 0 : Infinity;
            const k = Math.min(outOld.length, hb.output.length);
            for (let i = 0; i < k; i++) b64max = Math.max(b64max, Math.abs(outOld[i] - hb.output[i]));
        }
        r.b64Same = { len: hb.output ? hb.output.length : 0, max: b64max, pass: b64max <= 1e-5 };
        // ③ the ring path: 30 backbone calls fill the ring with those 30 steps, one image-less head call reads it
        for (let i = 0; i < T; i++) {
            const b = infer(backModel, { ...BACK, image: img, history: [{ name: "seq", aux, reset: i === 0 }] });
            if (!b.ready || !b.output) return { error: "the backbone is not ready while filling the ring" };
        }
        const hn = infer(headModel, { post: "none", extra: [{ name: "seq", dim: [1, T, D], ring: true }] });
        const outNew = hn.ready ? hn.output ?? null : null;
        let maxd = NaN;
        if (outOld && outNew) {
            maxd = outOld.length === outNew.length ? 0 : Infinity;
            const k = Math.min(outOld.length, outNew.length);
            for (let i = 0; i < k; i++) maxd = Math.max(maxd, Math.abs(outOld[i] - outNew[i]));
        }
        r.same = { n: Math.min(outOld?.length ?? 0, outNew?.length ?? 0), lenOld: outOld?.length ?? 0, lenNew: outNew?.length ?? 0,
            max: maxd, pass: maxd <= 1e-5, ring: hn.ring ?? null };
        // ④ the paced loop: screenshot -> backbone (appends to the ring) -> image-less head. The aux varies per frame
        // (distinct entries + front padding); the device's ring len / sum are checked against ours (@see dufu.js).
        /** @type {number[]} */
        const back = [], head = [], loop = [], hrun = [], hbridge = [];
        /** @type {{f: number[], aux: number[]}[]} */
        const own = [];
        let ringBad = 0;
        const t2 = Date.now();
        let n = 0;
        while (Date.now() - t2 < secs * 1000) {
            const w = Date.now();
            const im = screenshot();
            /** @type {number[]} */
            const a2 = new Array(A).fill(0);
            a2[0] = 1 + (n % 7) / 3; // varies: exercises the float32 aux conversion and the padding
            const b = infer(backModel, { ...BACK, image: im, history: [{ name: "seq", aux: a2, reset: n === 0 }] });
            back.push(Date.now() - w);
            if (b.ready && b.output) { own.push({ f: b.output, aux: a2 }); if (own.length > T) own.shift(); }
            const hw = Date.now();
            const h = infer(headModel, { post: "none", extra: [{ name: "seq", dim: [1, T, D], ring: true }] });
            const hwAll = Date.now() - hw;
            head.push(hwAll);
            if (h.ready) {
                hrun.push(h.ms.run ?? 0); hbridge.push(hwAll - h.ms.prep - (h.ms.run ?? 0));
                const pad = T - own.length;
                let sum = 0;
                for (let i = 0; i < T; i++) {
                    const e = i < pad ? own[0] : own[i - pad];
                    for (const x of e.f) sum += Math.fround(x);
                    for (const x of e.aux) sum += Math.fround(x);
                }
                if (!h.ring || h.ring.len !== own.length || !(Math.abs(h.ring.sum - sum) <= 1e-6 + 1e-9 * Math.abs(sum))) ringBad++;
            }
            loop.push(Date.now() - w);
            n++;
        }
        r.frames = n;
        r.headNew = stats(head); // ① the new head, with the JS<->app bridge
        r.headNewRun = stats(hrun); r.headNewBridge = stats(hbridge);
        r.back = stats(back); r.loop = stats(loop);
        r.ringBad = ringBad; // the live ring's len / sum vs ours (0 expected)
        out.ring = r;
        log("nn_bench ring", JSON.stringify({ headOld: r.headOld, headNew: r.headNew, headNewRun: r.headNewRun, headNewBridge: r.headNewBridge,
            back: r.back, loop: r.loop, same: r.same, b64Same: r.b64Same, ringBad, frames: n }));
        return out;
    }

    // one fixed seq for the head (its image input is unused); built from a CPU t1 backbone call
    const first = screenshot();
    const firstBack = infer(backModel, { ...BACK, image: first });
    if (!firstBack.ready || !firstBack.output) return { error: "the backbone is not ready on the first screenshot" };
    const seq = [];
    for (let i = 0; i < T; i++) {
        for (const x of firstBack.output) seq.push(x);
        for (let a = 0; a < A; a++) seq.push(a === 0 ? 1 : 0);
    }
    const extra = [{ name: "seq", dim: [1, T, D], data: seq }];

    // what the JS->app bridge costs just to serialize one infer() call (the prelude does JSON.stringify(args))
    {
        const t = Date.now();
        const N = 20;
        for (let i = 0; i < N; i++) JSON.stringify({ ...BACK, extra });
        out.stringifyMs = Math.round(((Date.now() - t) / N) * 100) / 100;
        const t2 = Date.now();
        for (let i = 0; i < N; i++) JSON.stringify({ ...BACK, image: 1, extra });
        out.stringifyWithImageMs = Math.round(((Date.now() - t2) / N) * 100) / 100;
    }

    for (const c of configs) {
        /** @type {Record<string, any>} */
        const r = { label: c.label, provider: c.provider, threads: c.threads, spin: c.spin ?? false };
        const o = { ...BACK, provider: c.provider, threads: c.threads, ...(c.spin ? { spin: true } : {}) };
        try {
            // the same screenshot through the config and through CPU t1, back to back
            const img = screenshot();
            const baseB = skipBack ? null : infer(backModel, { ...BACK, image: img });
            const t0 = Date.now();
            const b0 = skipBack ? null : infer(backModel, { ...o, image: img });
            r.firstBackMs = Date.now() - t0;
            const baseH = skipHead ? null : infer(headModel, { ...BACK, image: img, extra });
            const t1 = Date.now();
            const h0 = skipHead ? null : infer(headModel, { ...o, image: img, extra });
            r.firstHeadMs = Date.now() - t1;
            r.backSame = b0 && b0.ready && b0.output ? diff(b0.output, baseB?.output ?? []) : { error: "not ready" };
            r.headSame = h0 && h0.ready && h0.output ? diff(h0.output, baseH?.output ?? []) : { error: "not ready" };
        } catch (e) {
            r.error = String(e);
            out.configs[c.label] = r;
            log("nn_bench", JSON.stringify({ label: c.label, error: r.error }));
            continue;
        }
        const back = [], head = [], loop = [], brun = [], bprep = [], hrun = [], hprep = [], hgap = [];
        const t2 = Date.now();
        let n = 0;
        while (Date.now() - t2 < secs * 1000) {
            const w = Date.now();
            const im = screenshot();
            const b = skipBack ? null : infer(backModel, { ...o, image: im });
            back.push(Date.now() - w);
            if (b && b.ready) { bprep.push(b.ms.prep); brun.push(b.ms.run ?? 0); }
            const hw = Date.now();
            const h = skipHead ? null : infer(headModel, { ...o, image: im, extra });
            const hwAll = Date.now() - hw;
            head.push(hwAll);
            if (h && h.ready) {
                hprep.push(h.ms.prep); hrun.push(h.ms.run ?? 0);
                hgap.push(hwAll - h.ms.prep - (h.ms.run ?? 0));
            }
            loop.push(Date.now() - w);
            n++;
        }
        r.frames = n;
        r.back = stats(back); r.head = stats(head); r.loop = stats(loop);
        r.backRun = stats(brun); r.headRun = stats(hrun);
        r.backPrep = stats(bprep); r.headPrep = stats(hprep); r.headBridge = stats(hgap);
        out.configs[c.label] = r;
        log("nn_bench", JSON.stringify({ label: c.label, back: r.back, head: r.head, loop: r.loop, backRun: r.backRun, headRun: r.headRun, headBridge: r.headBridge, backSame: r.backSame, headSame: r.headSame, firstBackMs: r.firstBackMs, firstHeadMs: r.firstHeadMs, frames: n }));
    }
    return out;
}
