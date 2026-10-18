package io.github.flufy3d.maalow.skill

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.engine.Maa
import io.github.flufy3d.maalow.store.optBool
import io.github.flufy3d.maalow.store.optInt
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.str
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import java.io.File
import kotlin.math.roundToInt

/**
 * Skills' infer(): any ONNX model under the workspace's model/ run on a screenshot region, through the onnxruntime
 * MaaFramework ships (nn_jni.cpp). Sessions are kept per model file (and options) and reopened when the file
 * changes, so a synced model takes effect on the next call.
 *
 * Input: the region `roi` resized to `size` (area / linear / nearest), as gray / rgb / bgr, scaled to 0..1 and
 * normalized per channel ((v / 255 - mean) / std; uint8 models get the bytes), laid out nchw / nhwc. Several frames
 * (`frames`: offsets from the frame looked at, in capture stream frames or in units of `frame_ms`) are stacked as
 * channels in the order given; earlier frames come from the run's history: the preprocessed regions of its own
 * screenshots (each preprocessed once, kept small and bounded: [History]). Models with more inputs after the image
 * take them from `extra` (float32, one per input, in order; `data`, packed little-endian float32 `data_b64`, or a
 * feature ring). A model with no image input (its input count equals the extra count) skips the screenshot work
 * entirely; `history` appends a call's first output + aux to a per-run ring ([RING] steps), which a `ring: true`
 * extra tensor assembles as [1, RING, step] (front-padded with the oldest), its len / sum returned under `ring`.
 *
 * Output: the raw tensors, and per `post`: softmax / sigmoid of a vector (index / score / label of its largest),
 * or yolo: YOLOv8 / YOLO11 detection ([1, 4 + classes, n] or transposed) decoded, thresholded and NMS'd, boxes in
 * screen coordinates.
 */
internal class Nn(private val app: App) {
    class Tensor(val name: String, val type: Int, val shape: List<Long>)

    class Model(val stamp: Long, val handle: Long, val inputs: List<Tensor>, val outputs: List<Tensor>, val names: Map<Int, String>) {
        fun info(): JsonObject = buildJsonObject {
            fun list(ts: List<Tensor>) = buildJsonArray {
                ts.forEach { t ->
                    add(buildJsonObject {
                        put("name", t.name)
                        put("type", TYPES[t.type] ?: "type ${t.type}")
                        put("shape", buildJsonArray { t.shape.forEach { add(JsonPrimitive(it)) } })
                    })
                }
            }
            put("inputs", list(inputs))
            put("outputs", list(outputs))
            if (names.isNotEmpty()) put("labels", buildJsonObject { names.forEach { (k, v) -> put("$k", v) } })
        }
    }

    private class Out(val shape: IntArray, val data: FloatArray)

    /** The model's other inputs, encoded for Maa.nnRunExtra (@see extraInputs), and a ring assembly's stats. */
    private class Extras(val flat: FloatArray, val ring: JsonObject?)

    private val cache = object : LinkedHashMap<String, Model>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Model>): Boolean {
            if (size <= KEEP) return false
            Maa.nnDestroy(eldest.value.handle)
            return true
        }
    }

    /** A screenshot of the run: its Maa image, capture stream frame number and capture time (monotonic ns). */
    class Shot(val id: Int, val image: Long, val seq: Long, val ns: Long)

    /**
     * Preprocessed regions of a run's screenshots, per preprocessing: the earlier frames of multi-frame inputs. Up to
     * [HISTORY] frames and [HISTORY_BYTES] per preprocessing, [SPECS] preprocessings; plain JVM arrays, gone with
     * the run. Its rings are the other way round (infer()'s `history` option): the run's last [RING] feature vectors
     * with their aux columns, for a head model that takes no image.
     */
    class History {
        /** id: the run's image id (0: an image it did not take). */
        class Entry(val id: Int, val seq: Long, val ns: Long, val px: ByteArray)

        val specs = object : LinkedHashMap<String, ArrayDeque<Entry>>(4, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ArrayDeque<Entry>>) = size > SPECS
        }

        /** One appended step: a call's first output vector (the backbone's features) and its aux columns. */
        class Ring {
            class Entry(val f: FloatArray, val aux: FloatArray)

            val entries = ArrayDeque<Entry>()
            var step = 0 // f.size + aux.size of the entries
        }

        /** infer()'s feature rings, per name, oldest first (@see Ring). */
        val rings = HashMap<String, Ring>()

        fun add(spec: String, e: Entry) {
            val q = specs.getOrPut(spec) { ArrayDeque() }
            if (q.any { it.seq == e.seq || (e.id != 0 && it.id == e.id) }) return
            // kept in frame order: a screenshot preprocessed late (from the run's last ones) goes in its place
            val at = q.indexOfFirst { it.seq > e.seq }.let { if (it < 0) q.size else it }
            q.add(at, e)
            while (q.size > HISTORY || (q.size > 1 && q.sumOf { it.px.size.toLong() } > HISTORY_BYTES)) q.removeFirst()
        }
    }

    @Synchronized
    fun model(ws: String, name: String, opts: IntArray): Model {
        val path = if (name.endsWith(".onnx")) name else "$name.onnx"
        val f = app.workspaces.file(ws, "model/$path")
        require(f.isFile) { "infer: no model model/$path" }
        // with the weights beside it (a torch export's external data, <name>.onnx.data) when there is such a file
        val stamp = listOf(f, File(f.path + ".data")).filter { it.isFile }.fold(17L) { h, x -> (h * 31 + x.lastModified()) * 31 + x.length() }
        val key = "$ws/$path ${opts.joinToString(",")}"
        cache[key]?.let { if (it.stamp == stamp) return it }
        cache.remove(key)?.let { Maa.nnDestroy(it.handle) }
        val h = Maa.nnCreate(f.absolutePath, opts)
        val info = Json.parseToJsonElement(Maa.nnInfo(h)).jsonObject
        fun tensors(k: String) = info[k]!!.jsonArray.map { e ->
            val o = e.jsonObject
            Tensor(o.str("name"), o.optInt("type") ?: 0, o["shape"]!!.jsonArray.map { it.jsonPrimitive.longOrNull ?: -1 })
        }
        // YOLO exports: "{0: 'person', 1: 'bicycle'}"
        val names = NAMES.findAll(info.optStr("names").orEmpty()).associate { it.groupValues[1].toInt() to it.groupValues[2] }
        return Model(stamp, h, tensors("inputs"), tensors("outputs"), names).also { cache[key] = it }
    }

    @Synchronized
    private fun run(m: Model, frames: Array<ByteArray>, params: FloatArray, extras: FloatArray? = null): List<Out> {
        val r = if (extras == null) Maa.nnRun(m.handle, frames, params) else Maa.nnRunExtra(m.handle, frames, params, extras)
        val n = r[0].toInt()
        var at = 1
        val shapes = List(n) {
            val rank = r[at++].toInt()
            IntArray(rank) { r[at++].toInt() }
        }
        return shapes.map { s ->
            val count = s.fold(1) { a, d -> a * d }
            Out(s, r.copyOfRange(at, at + count)).also { at += count }
        }
    }

    /** {model, ...InferOptions} on `cur` (the image looked at); `kept`: the run's other screenshots, for history. */
    @Synchronized // the session stays open through the call
    fun infer(ws: String, a: JsonObject, cur: Shot, kept: List<Shot>, history: History, width: Int, height: Int): JsonElement {
        val t0 = System.nanoTime()
        val opts = intArrayOf(
            a.optInt("threads") ?: 1,
            if (a.optBool("spin") == true) 1 else 0,
            when (a.optStr("provider") ?: "cpu") {
                "cpu" -> 0
                "nnapi" -> 1
                else -> throw IllegalArgumentException("infer: provider must be cpu or nnapi")
            },
        )
        val m = model(ws, a.str("model"), opts)
        // A model with no image input (a head driven by `extra` alone) takes all its inputs as extras and no
        // screenshot work: extra tensor count == the model's input count. One fewer: the usual image + extras.
        val extraEl = a["extra"]
        val extraArr = extraEl as? JsonArray
        val noImage = extraArr != null && extraArr.isNotEmpty() && extraArr.size == m.inputs.size
        val ex = if (extraEl == null || extraEl is JsonNull) null else extraInputs(m, extraEl, noImage, history)
        if (noImage) {
            require((a.optStr("post") ?: "none") != "yolo") { "infer: yolo needs an image input" }
            val prepMs = (System.nanoTime() - t0) / 1e6
            val t1 = System.nanoTime()
            val outs = run(m, emptyArray(), FloatArray(0), ex!!.flat)
            val runMs = (System.nanoTime() - t1) / 1e6
            appendHistory(history, a["history"], outs)
            return response(m, a, outs, buildJsonArray { }, emptyList(), prepMs, runMs, t0, ex.ring, 0, 0, listOf(0, 0, 0, 0))
        }
        val extras = ex?.flat
        val input = m.inputs.firstOrNull() ?: error("infer: the model has no input")
        val offsets = (a["frames"] as? JsonArray)?.map { it.jsonPrimitive.doubleOrNull ?: error("infer: frames must be numbers") } ?: listOf(0.0)
        require(offsets.isNotEmpty()) { "infer: frames is empty" }
        val color = COLORS[a.optStr("color") ?: "rgb"] ?: throw IllegalArgumentException("infer: color must be gray, rgb or bgr")
        val interp = INTERPS[a.optStr("resize") ?: "area"] ?: throw IllegalArgumentException("infer: resize must be area, linear or nearest")
        val cpf = if (color == 0) 1 else 3
        val c = offsets.size * cpf
        val dims = input.shape
        require(dims.size == 4 || dims.size == 3) { "infer: the model's input must be 3- or 4-dimensional, not ${dims}" }
        val d = if (dims.size == 4) dims.drop(1) else dims // [C, H, W] or [H, W, C]
        val nhwc = when (a.optStr("layout")) {
            "nchw" -> false
            "nhwc" -> true
            null -> d[2] == c.toLong() && d[0] != c.toLong()
            else -> throw IllegalArgumentException("infer: layout must be nchw or nhwc")
        }
        val (mh, mw) = if (nhwc) d[0] to d[1] else d[1] to d[2]
        val modelC = if (nhwc) d[2] else d[0]
        require(modelC <= 0 || modelC == c.toLong()) {
            "infer: the model takes $modelC channels, the input has $c (${offsets.size} frame(s) × $cpf)"
        }
        val (ow, oh) = when (val s = a["size"]) {
            null, JsonNull -> {
                require(mw > 0 && mh > 0) { "infer: the model's input size is not fixed: give size" }
                mw.toInt() to mh.toInt()
            }
            is JsonArray -> s[0].jsonPrimitive.intOrNull!! to s[1].jsonPrimitive.intOrNull!!
            else -> s.jsonPrimitive.intOrNull!!.let { it to it }
        }
        val roi = (a["roi"] as? JsonArray)?.map { it.jsonPrimitive.doubleOrNull?.roundToInt() ?: 0 } ?: listOf(0, 0, width, height)
        require(roi.size == 4) { "infer: roi must be [x, y, w, h]" }
        val prep = intArrayOf(roi[0], roi[1], roi[2], roi[3], ow, oh, color, interp)
        val spec = prep.joinToString(",")
        fun prepped(s: Shot) = Maa.nnPrep(s.image, prep) ?: throw IllegalArgumentException("infer: roi $roi is not inside the image")

        // frames: the one looked at, earlier ones from the history (filled from the run's last screenshots)
        val frameMs = (a["frame_ms"] as? JsonPrimitive)?.doubleOrNull
        val tolerance = (a["tolerance"] as? JsonPrimitive)?.doubleOrNull ?: 1.0
        val curPx = prepped(cur)
        val multi = offsets.any { it != 0.0 }
        fun units(seq: Long, ns: Long) = if (frameMs != null) (ns - cur.ns) / 1e6 / frameMs else (seq - cur.seq).toDouble()
        val used = ArrayList<History.Entry?>()
        if (multi) {
            val lo = offsets.min() - tolerance
            val hi = offsets.max() + tolerance
            history.add(spec, History.Entry(cur.id, cur.seq, cur.ns, curPx))
            for (s in kept) {
                val u = units(s.seq, s.ns)
                if (s.id != cur.id && u >= lo && u <= hi && history.specs[spec]!!.none { it.seq == s.seq || it.id == s.id }) {
                    history.add(spec, History.Entry(s.id, s.seq, s.ns, prepped(s)))
                }
            }
        }
        val pool = history.specs[spec].orEmpty()
        for (o in offsets) {
            if (o == 0.0) {
                used += History.Entry(cur.id, cur.seq, cur.ns, curPx)
                continue
            }
            if (frameMs != null) {
                // what was on screen then: the last frame captured by that time, known when the run also has the
                // frame right after it (the stream only has a frame when the screen changed)
                val at = cur.ns + (o * frameMs * 1e6).toLong()
                val i = pool.indexOfLast { it.ns <= at }
                val next = pool.getOrNull(i + 1)
                if (i >= 0 && next != null && next.seq == pool[i].seq + 1 && next.ns > at) {
                    used += pool[i]
                    continue
                }
            }
            val best = pool.filter { it.seq != cur.seq }.minByOrNull { abs(units(it.seq, it.ns) - o) }
            used += best?.takeIf { abs(units(it.seq, it.ns) - o) <= tolerance }
        }
        val prepMs = (System.nanoTime() - t0) / 1e6
        val framesJson = buildJsonArray {
            used.forEach { e ->
                add(if (e == null) JsonNull else buildJsonObject {
                    put("seq", e.seq)
                    put("ms", Math.round((e.ns - cur.ns) / 1e5) / 10.0)
                })
            }
        }
        if (used.any { it == null }) {
            return buildJsonObject {
                put("ready", false)
                put("frames", framesJson)
                put("ms", buildJsonObject { put("prep", round2(prepMs)); put("total", round2(prepMs)) })
            }
        }

        val mean = perChannel(a["mean"], cpf, c, 0.0, "mean")
        val std = perChannel(a["std"], cpf, c, 1.0, "std")
        val params = FloatArray(4 + 2 * c)
        params[0] = ow.toFloat(); params[1] = oh.toFloat(); params[2] = cpf.toFloat(); params[3] = if (nhwc) 1f else 0f
        for (i in 0 until c) {
            params[4 + 2 * i] = mean[i].toFloat()
            params[5 + 2 * i] = std[i].toFloat()
        }
        val t1 = System.nanoTime()
        val outs = run(m, used.map { it!!.px }.toTypedArray(), params, extras)
        val runMs = (System.nanoTime() - t1) / 1e6
        appendHistory(history, a["history"], outs)
        return response(m, a, outs, framesJson, used, prepMs, runMs, t0, ex?.ring, ow, oh, roi)
    }

    /** The ready response of an infer() call: the outputs, `post` of the first one, the frames used and the timings. */
    private fun response(m: Model, a: JsonObject, outs: List<Out>, framesJson: JsonArray, used: List<History.Entry?>,
                         prepMs: Double, runMs: Double, t0: Long, ring: JsonObject?, ow: Int, oh: Int, roi: List<Int>): JsonObject {
        val raw = a.optBool("raw") == true
        val first = outs.first()
        val labels = (a["labels"] as? JsonArray)?.map { it.jsonPrimitive.content }
        fun label(i: Int) = labels?.getOrNull(i) ?: m.names[i]
        return buildJsonObject {
            put("ready", true)
            put("shape", shapeJson(first.shape))
            if (raw || first.data.size <= MAX_OUTPUT) put("output", floats(first.data))
            if (raw) put("outputs", buildJsonArray {
                outs.forEachIndexed { i, o ->
                    add(buildJsonObject {
                        put("name", m.outputs.getOrNull(i)?.name ?: "$i")
                        put("shape", shapeJson(o.shape))
                        put("data", floats(o.data))
                    })
                }
            })
            when (val post = a.optStr("post") ?: "none") {
                "none", "softmax", "sigmoid" -> if (first.shape.count { it > 1 } <= 1) {
                    val v = first.data
                    val p = when (post) {
                        "softmax" -> softmax(v)
                        "sigmoid" -> FloatArray(v.size) { (1 / (1 + exp(-v[it].toDouble()))).toFloat() }
                        else -> null
                    }
                    p?.let { put("probs", floats(it)) }
                    val s = p ?: v
                    val idx = s.indices.maxByOrNull { s[it] } ?: -1
                    put("index", idx)
                    if (idx >= 0) put("score", round4(s[idx]))
                    label(idx)?.let { put("label", it) }
                } else require(post == "none") { "infer: $post needs a vector output (one row), not ${first.shape.toList()}" }
                "yolo" -> {
                    val dets = yolo(first, a, ow, oh, roi, ::label)
                    put("hit", dets.isNotEmpty())
                    put("box", dets.firstOrNull()?.get("box") ?: JsonNull)
                    dets.firstOrNull()?.let { b -> b["score"]?.let { put("score", it) }; b["label"]?.let { put("label", it) } }
                    put("detections", JsonArray(dets))
                }
                else -> throw IllegalArgumentException("infer: post must be none, softmax, sigmoid or yolo")
            }
            put("frames", framesJson)
            // the preprocessed frames (HWC bytes each), to check against an offline pipeline
            if (a.optBool("input") == true) put("input", buildJsonArray {
                used.forEach { e -> add(buildJsonArray { e!!.px.forEach { add(JsonPrimitive(it.toInt() and 0xff)) } }) }
            })
            ring?.let { put("ring", it) } // a ring assembly's device-side numbers (@see extraInputs), for the caller's check
            put("ms", buildJsonObject {
                put("prep", round2(prepMs))
                put("run", round2(runMs))
                put("total", round2((System.nanoTime() - t0) / 1e6))
            })
        }
    }

    /** YOLOv8 / YOLO11 head [1, 4 + k, n] (or [1, n, 4 + k]): cx, cy, w, h in input px, then class scores. */
    private fun yolo(o: Out, a: JsonObject, ow: Int, oh: Int, roi: List<Int>, label: (Int) -> String?): List<JsonObject> {
        require(o.shape.size == 3 && o.shape[0] == 1) { "infer: yolo needs a [1, 4 + classes, n] output, not ${o.shape.toList()}" }
        val transposed = o.shape[2] < o.shape[1] // [1, n, 4 + k]
        val n = if (transposed) o.shape[1] else o.shape[2]
        val f = if (transposed) o.shape[2] else o.shape[1]
        val k = f - 4
        require(k >= 1) { "infer: yolo output has no class scores" }
        fun at(i: Int, j: Int) = if (transposed) o.data[i * f + j] else o.data[j * n + i]
        val th = (a["threshold"] as? JsonPrimitive)?.doubleOrNull ?: 0.25
        val iou = (a["iou"] as? JsonPrimitive)?.doubleOrNull ?: 0.45
        val maxDet = a.optInt("max_det") ?: 100
        val sx = roi[2].toDouble() / ow
        val sy = roi[3].toDouble() / oh
        class Det(val x: Double, val y: Double, val w: Double, val h: Double, val score: Float, val cls: Int)
        val cand = ArrayList<Det>()
        for (i in 0 until n) {
            var best = 0
            for (j in 1 until k) if (at(i, 4 + j) > at(i, 4 + best)) best = j
            val s = at(i, 4 + best)
            if (s < th) continue
            val w = at(i, 2) * sx
            val h = at(i, 3) * sy
            cand += Det(roi[0] + at(i, 0) * sx - w / 2, roi[1] + at(i, 1) * sy - h / 2, w, h, s, best)
        }
        cand.sortByDescending { it.score }
        val keep = ArrayList<Det>()
        for (d in cand) {
            if (keep.size >= maxDet) break
            if (keep.none { it.cls == d.cls && iouOf(it.x, it.y, it.w, it.h, d.x, d.y, d.w, d.h) > iou }) keep += d
        }
        return keep.map { d ->
            buildJsonObject {
                put("box", buildJsonArray { listOf(d.x, d.y, d.w, d.h).forEach { add(JsonPrimitive(it.roundToInt())) } })
                put("score", round4(d.score))
                put("cls_index", d.cls)
                label(d.cls)?.let { put("label", it) }
            }
        }
    }

    companion object {
        const val KEEP = 4 // sessions kept open
        const val HISTORY = 32 // frames per preprocessing
        const val HISTORY_BYTES = 8L shl 20
        const val SPECS = 4
        const val MAX_OUTPUT = 4096 // first output values returned without raw
        const val MAX_EXTRA = 4 // tensors beyond the image a model may take (InferOptions.extra)
        const val RING = 30 // entries of a feature ring (InferOptions.history / extra with ring)
        val COLORS = mapOf("gray" to 0, "rgb" to 1, "bgr" to 2)
        val INTERPS = mapOf("area" to 0, "linear" to 1, "nearest" to 2)
        val TYPES = mapOf(1 to "float32", 2 to "uint8", 3 to "int8", 6 to "int32", 7 to "int64", 10 to "float16")
        private val NAMES = Regex("""(\d+)\s*:\s*['"]([^'"]*)['"]""")

        /** A number, one per channel of a frame (repeated for every frame), or one per stacked channel. */
        private fun perChannel(e: JsonElement?, cpf: Int, c: Int, d: Double, what: String): DoubleArray {
            val v = when (e) {
                null, JsonNull -> listOf(d)
                is JsonArray -> e.map { it.jsonPrimitive.doubleOrNull ?: error("infer: $what must be numbers") }
                else -> listOf(e.jsonPrimitive.doubleOrNull ?: error("infer: $what must be a number"))
            }
            require(v.size == 1 || v.size == cpf || v.size == c) { "infer: $what takes 1, $cpf or $c values" }
            return DoubleArray(c) { v[if (v.size == c) it else it % v.size] }
        }

        /**
         * `extra`: the model's inputs after the image (or all of them, for a model with no image input: [noImage]), one
         * tensor each in that order (up to [MAX_EXTRA]), as the flat float encoding of Maa.nnRunExtra: [n, then per
         * tensor: rank, dims..., count, data...]. Each input must be float32 with the given dims, and the given `name`
         * (if any) must be its name; the model's batch dimension (1 or dynamic) takes 1.
         *
         * A tensor's values come from `data` (a JSON float array) or `data_b64` (standard base64, padding included, of
         * the little-endian packed float32 bytes, dim product * 4 of them), or - with `ring: true` - from the run's
         * feature ring of that `name` ([History.Ring]): the last [RING] (feature, aux) entries, oldest first, front-
         * padded with the oldest when short, as [1, RING, step]; `dim` must say exactly that shape. [Extras.ring] is
         * that assembly's len / sum (the RING * step floats, double, oldest first) for the caller to check its own.
         */
        private fun extraInputs(m: Model, e: JsonElement?, noImage: Boolean, history: History): Extras {
            val arr = e as? JsonArray ?: throw IllegalArgumentException("infer: extra must be an array of tensors")
            require(arr.isNotEmpty()) { "infer: extra is empty" }
            require(arr.size <= MAX_EXTRA) { "infer: extra takes at most $MAX_EXTRA tensors, not ${arr.size}" }
            require(arr.size == m.inputs.size - (if (noImage) 0 else 1)) {
                "infer: extra has ${arr.size} tensor(s), the model takes ${m.inputs.size - 1} besides the image (all of them with no image)"
            }
            var ring: JsonObject? = null
            val dims = ArrayList<List<Int>>(arr.size)
            val data = ArrayList<FloatArray>(arr.size)
            arr.forEachIndexed { i, el ->
                val o = el as? JsonObject ?: throw IllegalArgumentException("infer: extra[$i] must be {name?, dim, data}")
                val input = m.inputs[i + (if (noImage) 0 else 1)]
                o.optStr("name")?.let { require(it == input.name) { "infer: extra[$i] is named '$it', not '${input.name}'" } }
                require(input.type == 1) { "infer: input ${input.name} must be float32, not ${TYPES[input.type] ?: "type ${input.type}"}" }
                val d = ((o["dim"] as? JsonArray) ?: throw IllegalArgumentException("infer: extra[$i].dim is missing"))
                    .map { it.jsonPrimitive.intOrNull ?: throw IllegalArgumentException("infer: extra[$i].dim must be integers") }
                require(d.size == input.shape.size && d.withIndex().all { (k, v) ->
                    v >= 1 && (v.toLong() == input.shape[k] || (k == 0 && v == 1 && input.shape[k] <= 1))
                }) { "infer: input ${input.name} takes ${input.shape}, extra[$i] is $d" }
                if (o.optBool("ring") == true) {
                    val name = o.optStr("name") ?: throw IllegalArgumentException("infer: extra[$i] with ring must name it")
                    val r = history.rings[name]
                    require(r != null && r.entries.isNotEmpty()) { "ring: empty ('$name' has no entries yet)" }
                    require(d == listOf(1, RING, r.step)) { "infer: ring '$name' assembles [1, $RING, ${r.step}], extra[$i] is $d" }
                    val v = FloatArray(RING * r.step)
                    var at = 0
                    val pad = RING - r.entries.size
                    for (k in 0 until RING) {
                        val en = if (k < pad) r.entries.first() else r.entries[k - pad]
                        en.f.forEach { v[at++] = it }
                        en.aux.forEach { v[at++] = it }
                    }
                    dims += d
                    data += v
                    if (ring == null) {
                        var sum = 0.0
                        for (x in v) sum += x.toDouble()
                        ring = buildJsonObject { put("len", r.entries.size); put("sum", sum) }
                    }
                } else {
                    val count = d.fold(1L) { a, x -> a * x }
                    val b64 = o.optStr("data_b64")
                    val v: FloatArray = if (b64 != null) {
                        require(o["data"] == null) { "infer: extra[$i] has both data and data_b64" }
                        val bytes = try {
                            java.util.Base64.getDecoder().decode(b64)
                        } catch (x: IllegalArgumentException) {
                            throw IllegalArgumentException("infer: extra[$i].data_b64 is not base64")
                        }
                        require(bytes.size.toLong() == count * 4) {
                            "infer: extra[$i].data_b64 has ${bytes.size} bytes, its dim $d takes ${count * 4}"
                        }
                        val f = java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
                        FloatArray(count.toInt()) { f.get(it) }
                    } else {
                        val dd = (o["data"] as? JsonArray) ?: throw IllegalArgumentException("infer: extra[$i].data is missing")
                        val f = dd.map { it.jsonPrimitive.doubleOrNull?.toFloat() ?: throw IllegalArgumentException("infer: extra[$i].data must be numbers") }
                        require(f.size.toLong() == count) { "infer: extra[$i] has ${f.size} values, its dim $d takes $count" }
                        f.toFloatArray()
                    }
                    dims += d
                    data += v
                }
            }
            val flat = FloatArray(1 + dims.indices.sumOf { 1 + dims[it].size + 1 + data[it].size })
            var at = 0
            flat[at++] = arr.size.toFloat()
            for (i in dims.indices) {
                flat[at++] = dims[i].size.toFloat()
                dims[i].forEach { flat[at++] = it.toFloat() }
                flat[at++] = data[i].size.toFloat()
                data[i].forEach { flat[at++] = it }
            }
            return Extras(flat, ring)
        }

        /**
         * infer()'s `history` option, after a successful call: its first output (a vector: [N] or [1, N]) and each
         * entry's `aux` are appended to the run's ring `name` ([History.Ring], the last [RING] entries; `reset: true`
         * clears it first), to be assembled into an extra tensor later (@see extraInputs).
         */
        private fun appendHistory(history: History, e: JsonElement?, outs: List<Out>) {
            val arr = (e as? JsonArray) ?: return
            require(arr.isNotEmpty()) { "infer: history is empty" }
            val first = outs.firstOrNull() ?: error("infer: the model has no output")
            // a vector: [N], or a [1, N] batch of one (the backbones export [1, 192])
            require(first.shape.size == 1 || (first.shape.size == 2 && first.shape[0] == 1)) {
                "infer: history takes a vector first output ([N] or [1, N]), not ${first.shape.toList()}"
            }
            require(first.data.isNotEmpty()) { "infer: history takes a non-empty first output" }
            arr.forEachIndexed { i, el ->
                val o = el as? JsonObject ?: throw IllegalArgumentException("infer: history[$i] must be {name, aux}")
                val name = o.str("name")
                require(name.isNotEmpty()) { "infer: history[$i].name is empty" }
                val aux = ((o["aux"] as? JsonArray) ?: throw IllegalArgumentException("infer: history[$i].aux is missing"))
                    .map { it.jsonPrimitive.doubleOrNull?.toFloat() ?: throw IllegalArgumentException("infer: history[$i].aux must be numbers") }
                    .toFloatArray()
                require(aux.isNotEmpty()) { "infer: history[$i].aux is empty" }
                val r = history.rings.getOrPut(name) { History.Ring() }
                if (o.optBool("reset") == true) r.entries.clear()
                val step = first.data.size + aux.size
                require(r.entries.isEmpty() || r.step == step) {
                    "infer: ring '$name' holds $r.step-wide steps, this call's output + aux is $step"
                }
                r.step = step
                r.entries.addLast(History.Ring.Entry(first.data, aux))
                while (r.entries.size > RING) r.entries.removeFirst()
            }
        }

        private fun softmax(v: FloatArray): FloatArray {
            val mx = v.maxOrNull() ?: 0f
            val e = DoubleArray(v.size) { exp((v[it] - mx).toDouble()) }
            val s = e.sum()
            return FloatArray(v.size) { (e[it] / s).toFloat() }
        }

        private fun iouOf(ax: Double, ay: Double, aw: Double, ah: Double, bx: Double, by: Double, bw: Double, bh: Double): Double {
            val iw = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
            val ih = max(0.0, min(ay + ah, by + bh) - max(ay, by))
            val inter = iw * ih
            return inter / (aw * ah + bw * bh - inter + 1e-9)
        }

        private fun shapeJson(s: IntArray) = buildJsonArray { s.forEach { add(JsonPrimitive(it)) } }

        private fun floats(v: FloatArray) = buildJsonArray { v.forEach { add(JsonPrimitive(it)) } }

        private fun round2(v: Double) = Math.round(v * 100) / 100.0
        private fun round4(v: Float) = Math.round(v * 10000.0) / 10000.0
    }
}
