// Device check of infer()'s extra inputs (the second input of a head model): model/extra_check/toy.onnx takes image
// [1,3,8,8] and vec [1,4], out = concat(image.mean(), vec * 2) [1,5] (data/tmp/dufu_ml/unified/toy_extra.py). PC
// reference, fixed input image i/191 (mean 0.5) and vec [1,2,3,4]: expected [0.5, 2, 4, 6, 8]. On the device the image
// is a screenshot, so out[0] is checked against the mean of the preprocessed pixels (r.input, what the model got) and
// only out[1..4] against the PC numbers; what this primarily checks is that `extra` reaches the model.
//   maalow do skill infer_extra_check
/** @type {SkillMeta} */
export const meta = { description: "check infer() extra inputs on the toy model (no clicks)", timeout: 60_000 };

const VEC = [1, 2, 3, 4];
// toy_extra.py fixed-input reference: [0.5, 2, 4, 6, 8]
const EXPECT_VEC = [2, 4, 6, 8];

export default function () {
    const img = screenshot();
    const r = infer("extra_check/toy.onnx", {
        image: img,
        roi: [0, 0, 8, 8],
        size: 8,
        input: true,
        extra: [{ name: "vec", dim: [1, 4], data: VEC }],
    });
    if (!r.ready) return { pass: false, ready: false, frames: r.frames };
    const px = r.input[0];
    const expect = [px.reduce((a, v) => a + v, 0) / (255 * px.length), ...EXPECT_VEC];
    const got = r.output;
    const diff = got.map((v, i) => Math.abs(v - expect[i]));
    const pass = diff.every((d) => d < 1e-4);
    log(pass ? "extra inputs ok" : "extra inputs mismatch", JSON.stringify({ got, expect, diff }));
    return { pass, got, expect, diff, info: modelInfo("extra_check/toy.onnx") };
}
