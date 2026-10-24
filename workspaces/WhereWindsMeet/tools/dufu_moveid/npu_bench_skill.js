// TEMPORARY (tools/dufu_moveid/npu_bench.py puts it here, runs it and deletes it): infer() speed of candidate models.
// Only infer(): no screenshot, no touch, no keys. Every input is fed as an `extra` tensor (constant 0.5 floats), so
// no image work is in the timing; ms.run is onnxruntime's Run (plus the JNI copy of the input), ms.total the whole
// call (with the base64 decode). Per model x config: the first call (opens the session: load time) and n timed calls
// after `warm` untimed ones. A session that fails to open or run is reported with onnxruntime's message.
//   maalow do skill npu_bench --args '{"models":[{"path":"npu_bench/x.onnx","inputs":[[1,3,192,192]]}],
//                                      "configs":[{"provider":"cpu","threads":1}],"n":200,"warm":20}'

/** @type {SkillMeta} */
export const meta = { description: "TEMPORARY: infer() speed of the npu_bench models (no input actions)", timeout: 1_800_000 };

const B64 = { 0: "", 1: "AAAAPw==", 2: "AAAAPwAAAD8=" }; // little-endian float32 0.5, one or two of them
const cache = {};

/** base64 of `count` float32 0.5 values. */
function halves(count) {
    if (!cache[count]) cache[count] = "AAAAPwAAAD8AAAA/".repeat(Math.floor(count / 3)) + B64[count % 3];
    return cache[count];
}

function pct(v, p) {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function stats(v) {
    if (!v.length) return null;
    const r = (x) => Math.round(x * 1000) / 1000;
    return { p50: r(pct(v, 0.5)), p95: r(pct(v, 0.95)), min: r(Math.min(...v)), max: r(Math.max(...v)),
             mean: r(v.reduce((a, b) => a + b, 0) / v.length), n: v.length };
}

/** @param {{models: {path: string, inputs: number[][]}[], configs: {provider: "cpu"|"nnapi"|"qnn", threads?: number}[], n?: number, warm?: number}} args */
export default function (args) {
    const n = args.n ?? 200, warm = args.warm ?? 20;
    const out = [];
    for (const m of args.models) {
        const extra = m.inputs.map((dim) => ({ dim, data_b64: halves(dim.reduce((a, b) => a * b, 1)) }));
        for (const c of args.configs) {
            const res = { model: m.path, provider: c.provider, threads: c.threads ?? 1 };
            out.push(res);
            if (remaining() < 60_000) {
                res.error = "skipped: skill time running out";
                continue;
            }
            const opts = { extra, provider: c.provider, threads: c.threads ?? 1 };
            try {
                const t0 = Date.now();
                const r = infer(m.path, opts);
                // provider: what it ran on (qnn falls back to cpu without the plugin; fallback says why)
                res.first = { wall_ms: Date.now() - t0, ms: r.ms, shape: r.shape, out: (r.output || []).slice(0, 8),
                              provider: r.provider, fallback: r.fallback };
                for (let i = 0; i < warm; i++) infer(m.path, opts);
                const run = [], total = [], wall = [];
                for (let i = 0; i < n; i++) {
                    const t = Date.now();
                    const x = infer(m.path, opts);
                    wall.push(Date.now() - t);
                    run.push(x.ms.run);
                    total.push(x.ms.total);
                }
                res.run = stats(run);
                res.total = stats(total);
                res.wall = stats(wall);
                res.raw_run = run;
            } catch (e) {
                res.error = String(e && e.message ? e.message : e);
            }
            log(`${m.path} ${c.provider}/${res.threads}: ${res.error ?? `run p50 ${res.run.p50} p95 ${res.run.p95}`}`);
        }
    }
    return out;
}
