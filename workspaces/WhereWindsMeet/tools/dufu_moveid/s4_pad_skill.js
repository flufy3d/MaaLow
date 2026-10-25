// TEMPORARY (tools/dufu_moveid/s4_pad.py copies it to skills/dufu2_pair.js, runs it and deletes it): the dufu2 student
// pipeline on the current screen, read-only. Calls ONLY screenshot(), saveImage() and infer(): no touch, no keys, no
// clicks, no node runs. Per frame: screenshot -> glob(screen) / crop(big) / crop(small) (each appends its feature to
// a ring) -> head on the three rings (s4_common docstring, model/dufu2/dufu2.json).
//   mode "pair": n frames; each frame's screenshot saved as captures/dufu2_pair/<run>_<i>.png, the device's
//                preprocessed views (infer input: true) returned base64, features and head logits returned
//   mode "time": n frames after `warm`; per frame the screenshot wall time and every call's ms (prep / run / total)
// args: {mode, n, warm?, run?, models: {glob, crop, head}, provider?, threads?, hist?: number[4]}

/** @type {SkillMeta} */
export const meta = { description: "TEMPORARY: dufu2 student on-device parity / timing (read-only, no input actions)", timeout: 1_800_000 };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** @param {number[]} b bytes */
function b64(b) {
    const out = [];
    for (let i = 0; i < b.length; i += 3) {
        const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
        out.push(B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "="));
    }
    return out.join("");
}

const BIG = [290, 55, 530, 530], SMALL = [425, 190, 260, 260];

/** @param {any} args */
export default function (args) {
    const n = args.n ?? 20, warm = args.warm ?? 0, mode = args.mode ?? "pair";
    const M = args.models;
    const common = { color: "bgr", resize: "area", threads: args.threads ?? 1, provider: args.provider ?? "cpu" };
    const hist = args.hist ?? [2, 2, 2, 0];
    const want = mode === "pair";
    const frames = [];
    for (let i = 0; i < warm + n; i++) {
        const t0 = Date.now();
        const img = screenshot();
        const tShot = Date.now() - t0;
        const reset = i === 0;
        const g = infer(M.glob, { ...common, image: img, roi: [0, 0, img.width, img.height], size: [384, 240], input: want,
                                  history: [{ name: "glob", aux: hist, reset }] });
        const b = infer(M.crop, { ...common, image: img, roi: BIG, size: 192, input: want, history: [{ name: "big", aux: [0], reset }] });
        const s = infer(M.crop, { ...common, image: img, roi: SMALL, size: 192, input: want, history: [{ name: "small", aux: [0], reset }] });
        const h = infer(M.head, { threads: common.threads, provider: common.provider, post: "none",
                                  extra: [{ name: "glob", dim: [1, 30, 132], ring: true }, { name: "big", dim: [1, 30, 97], ring: true },
                                          { name: "small", dim: [1, 30, 97], ring: true }] });
        const tAll = Date.now() - t0;
        if (i < warm) continue;
        /** @type {any} */
        const f = { i: i - warm, seq: img.seq, time: img.time, w: img.width, h: img.height, shot_wall: tShot, wall: tAll,
                    ms: { glob: g.ms, big: b.ms, small: s.ms, head: h.ms },
                    provider: [g, b, s, h].map((x) => /** @type {any} */ (x).provider ?? null),
                    fallback: [g, b, s, h].map((x) => /** @type {any} */ (x).fallback ?? null), ring: h.ring };
        if (want) {
            const name = `captures/dufu2_pair/${args.run ?? "r"}_${String(i - warm).padStart(3, "0")}.png`;
            f.png = saveImage(img, name);
            f.input = { glob: b64(g.input[0]), big: b64(b.input[0]), small: b64(s.input[0]) };
            f.feat = { glob: g.output, big: b.output, small: s.output };
            f.logits = h.output;
        }
        frames.push(f);
        if (remaining() < 30_000) break;
    }
    return { mode, n: frames.length, models: M, provider: common.provider, threads: common.threads, frames };
}
