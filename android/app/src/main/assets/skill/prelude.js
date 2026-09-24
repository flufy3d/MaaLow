// MaaLow skill API (declared in maalow.d.ts), built on the one native call __host(op, json) -> json that the app
// serves (SkillRun.dispatch). Evaluated as a global script in every skill runtime before the skill module loads.
(() => {
    const host = globalThis.__host;
    delete globalThis.__host;

    const call = (op, args) => {
        const out = host(op, args === undefined ? undefined : JSON.stringify(args));
        return out === undefined ? undefined : JSON.parse(out);
    };

    const isBox = (a) => Array.isArray(a) && a.length === 4;

    /** A point from (x, y), [x, y], a box (its center), {x, y}, or a hit / match (its box's center). */
    const point = (t, y) => {
        if (typeof t === "number") return [t, y];
        if (Array.isArray(t)) {
            if (t.length === 2) return t;
            if (isBox(t)) return [Math.round(t[0] + t[2] / 2), Math.round(t[1] + t[3] / 2)];
        } else if (t && typeof t === "object") {
            if (typeof t.x === "number") return [t.x, t.y];
            if ("box" in t) {
                if (t.hit === false || !t.box) throw new Error("target was not hit");
                return point(t.box);
            }
        }
        throw new TypeError(`not a point, box or hit: ${JSON.stringify(t)}`);
    };

    const recoOpts = (o = {}) => ({ image: o.image ? o.image.id : undefined, detail: o.detail });
    const withRoi = (param, o = {}) => (o.roi ? { ...param, roi: o.roi } : param);

    const reco = (type, param = {}, o = {}) => call("reco", { type, param: withRoi(param, o), ...recoOpts(o) });
    const recognize = (node, o = {}) =>
        call("recognize", { node, roi: o.roi, override: o.override, ...recoOpts(o) });

    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

    const api = {
        screenshot: () => call("screenshot"),
        frame: () => call("frame"),
        recognize,
        reco,
        match: (template, o = {}) =>
            reco("TemplateMatch", { template, ...pick(o, ["threshold", "green_mask", "method", "order_by"]) }, o),
        color: (o) => reco("ColorMatch", pick(o, ["lower", "upper", "count", "connected", "method", "order_by"]), o),
        ocr: (o = {}) => reco("OCR", pick(o, ["expected", "threshold", "only_rec", "order_by"]), o),
        detect: (o) => reco("NeuralNetworkDetect", pick(o, ["model", "expected", "labels", "threshold", "order_by"]), o),

        waitFor(target, o = {}) {
            const end = Date.now() + (o.timeout ?? 10000);
            const interval = o.interval ?? 100;
            for (;;) {
                let v;
                if (typeof target === "function") {
                    v = target();
                } else {
                    call("screenshot");
                    v = recognize(target, o);
                    if (!v.hit) v = null;
                }
                if (v) return v;
                if (Date.now() >= end) return null;
                call("sleep", { ms: Math.min(interval, Math.max(0, end - Date.now())) });
            }
        },

        saveImage: (image, path) => call("save_image", { image: image.id, path }),

        click(t, y) {
            const [px, py] = point(t, y);
            call("click", { x: px, y: py });
        },
        longPress(t, ms = 800) {
            const [x, y] = point(t);
            call("long_press", { x, y, ms });
        },
        swipe(from, to, ms = 300) {
            const [x1, y1] = point(from);
            const [x2, y2] = point(to);
            call("swipe", { x1, y1, x2, y2, ms });
        },
        touch: Object.freeze({
            down(t, contact = 0) {
                const [x, y] = point(t);
                call("touch", { op: "down", contact, x, y });
            },
            move(t, contact = 0) {
                const [x, y] = point(t);
                call("touch", { op: "move", contact, x, y });
            },
            up(contact = 0) {
                call("touch", { op: "up", contact });
            },
        }),
        key: (code) => call("key", { code }),
        keyDown: (code) => call("key", { code, op: "down" }),
        keyUp: (code) => call("key", { code, op: "up" }),
        inputText: (text) => call("input_text", { text: String(text) }),
        back: () => call("key", { code: 4 }),
        home: () => call("key", { code: 3 }),
        startApp: (pkg) => call("start_app", { package: pkg }),
        stopApp: (pkg) => call("stop_app", { package: pkg }),

        sleep: (ms) => call("sleep", { ms }),
        remaining: () => call("remaining"),

        log: (...values) =>
            call("log", {
                message: values
                    .map((v) => (typeof v === "string" ? v : v instanceof Error ? `${v.name}: ${v.message}` : JSON.stringify(v)))
                    .join(" "),
            }),
        event: (name, data) => call("event", { name, data }),
        memory: Object.freeze({
            get(key, fallback) {
                const v = call("memory_get", { key });
                return v === undefined || v === null ? fallback : v;
            },
            set: (key, value) => call("memory_set", { key, value: value ?? null }),
            delete: (key) => call("memory_set", { key }),
            all: () => call("memory_all"),
        }),

        runNode: (node, o = {}) => call("run_node", { node, once: o.once, override: o.override }),
        runSkill: (name, args) => call("run_skill", { name, args: args ?? {} }),
    };

    for (const [k, v] of Object.entries(api)) {
        Object.defineProperty(globalThis, k, { value: v, enumerable: false, writable: false, configurable: false });
    }
    // console.log for code written out of habit
    globalThis.console = Object.freeze({ log: api.log, info: api.log, warn: api.log, error: api.log });
})();
