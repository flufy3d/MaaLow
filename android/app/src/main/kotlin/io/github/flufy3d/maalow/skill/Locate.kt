package io.github.flufy3d.maalow.skill

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.engine.Maa
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.readJsonObject
import io.github.flufy3d.maalow.store.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File

/**
 * Skills' locate(): where a screen region (e.g. a minimap) is, matched in a reference image drawn at its scale
 * (native, locate_core.cpp). A reference is templates/<ref>.json (made offline, see scripts/map_locate.py):
 *
 *     {"levels": [{"zoom": "out", "image": "locate/x_out.png", "k": 2.3, "origin": [u, v], "off": [dx, dy]}, ...],
 *      "crop": {"center": [144, 70], "size": 110},
 *      "mask": {"circle": [9, 44], "wedge": {"r": 34, "half": 38},
 *               "drop": [{"h": [0, 8], "s": [45, 255], "v": [150, 255]}, ...], "grow": 5, "sat_max": 0},
 *      "regions": {"h": [10, 24], "s": [25, 85], "v": [100, 235], "mode": "flat", "gain": 1,
 *                  "open": 3, "min_px": 60, "close": 5, "edge": 5},
 *      "prep": {"kind": "dog", "pre": 1, "sigma": 4}}
 *
 * levels: one per zoom of what is matched (a minimap may zoom in inside some places): image (alpha: where the map is
 * known), k (position units per image px), origin (image px of the position origin), off (added to the result),
 * layer (optional: levels that only fit one state of the place, e.g. "live" / "taken" for a stronghold with and
 * without its orange zone; a call passing `layer` skips the levels of other layers, those without one are always
 * tried). Every level is tried and the best score wins. crop: the screen square of `size` px around `center` that is
 * matched; the point located is its middle. mask (all optional, left out: the whole square): circle keeps
 * inner < r <= outer from the middle; wedge leaves out r <= wedge.r within ±half degrees of the heading passed per
 * call (no heading: all of r <= wedge.r); drop leaves out pixels in these HSV ranges (OpenCV's, H 0-180), grown by
 * `grow` px; sat_max > 0 leaves out pixels more saturated than it, the regions' color excepted. regions (optional):
 * a see-through overlay of one HSV color, its area opened by `open`, dropped under `min_px`, closed by `close`
 * (kernel px); flat filters its inside apart from the rest (contrast times gain) and leaves out the `edge` px band
 * around it, mask leaves it all out, none ignores it. prep: the filter on both sides (kind raw | hp | dog | grad |
 * canny, pre, sigma). Images are decoded and preprocessed once, kept while their files stay the same.
 */
internal class Locator(private val app: App) {
    private class Level(val zoom: String, val layer: String?, val k: Double, val ox: Double, val oy: Double, val offX: Double, val offY: Double, val handle: Long)

    private class Loaded(val stamp: Long, val levels: List<Level>)

    private val cache = object : LinkedHashMap<String, Loaded>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Loaded>): Boolean {
            if (size <= KEEP) return false
            eldest.value.levels.forEach { Maa.locateRefDestroy(it.handle) }
            return true
        }
    }

    /**
     * {ref, image?, prior?: [x, y], radius?, wedge? (cam: its old name), zoom?, layer?, crop?, mask?, regions?, prep?}
     * -> {x, y, score, second, zoom, layer?, k, used, ms, levels: {zoom: score}}, or null when no level could be matched. crop, mask,
     * regions and prep are laid over the reference's, key by key.
     */
    @Synchronized
    fun locate(ws: String, a: JsonObject, image: Long): JsonElement {
        val t0 = System.nanoTime()
        val name = a.str("ref").let { if (it.endsWith(".json")) it else "$it.json" }
        val json = app.workspaces.file(ws, "templates/$name")
        require(json.isFile) { "locate: no reference templates/$name" }
        val meta = readJsonObject(json) ?: error("locate: templates/$name is not a JSON object")
        val cfg = JsonObject(SECTIONS.associateWith { JsonObject((meta[it] as? JsonObject).orEmpty() + (a[it] as? JsonObject).orEmpty()) })
        val params = paramsOf(cfg)
        val center = (cfg.getValue("crop").jsonObject["center"] as? JsonArray)?.map { it.jsonPrimitive.doubleOrNull ?: 0.0 }
        require(center != null && center.size == 2) { "locate: templates/$name needs crop.center [x, y]" }
        val ref = load(ws, name, json, meta, params)
        val prior = (a["prior"] as? JsonArray)?.map { it.jsonPrimitive.doubleOrNull ?: error("locate: prior must be [x, y]") }
        require(prior == null || prior.size == 2) { "locate: prior must be [x, y]" }
        val radius = num(a, "radius") ?: DEFAULT_RADIUS
        val wedge = num(a, "wedge") ?: num(a, "cam") ?: Double.NaN
        val only = a.optStr("zoom")
        val layer = a.optStr("layer")
        var best: FloatArray? = null
        var bestLevel: Level? = null
        val scores = LinkedHashMap<String, Float>()
        for (lv in ref.levels) {
            if (only != null && lv.zoom != only) continue
            if (layer != null && lv.layer != null && lv.layer != layer) continue
            val pu = if (prior != null) lv.ox + (prior[0] - lv.offX) / lv.k else 0.0
            val pv = if (prior != null) lv.oy + (prior[1] - lv.offY) / lv.k else 0.0
            val r = if (prior != null) radius / lv.k else -1.0
            val args = floatArrayOf(center[0].toFloat(), center[1].toFloat(), wedge.toFloat(), pu.toFloat(), pv.toFloat(), r.toFloat()) + params
            val out = Maa.locateRun(image, lv.handle, args) ?: continue
            scores[lv.zoom] = out[2]
            if (best == null || out[2] > best[2]) {
                best = out
                bestLevel = lv
            }
        }
        val ms = (System.nanoTime() - t0) / 1e6
        val b = best ?: return JsonNull
        val lv = bestLevel!!
        return buildJsonObject {
            put("x", round2((b[0] - lv.ox) * lv.k + lv.offX))
            put("y", round2((b[1] - lv.oy) * lv.k + lv.offY))
            put("score", round3(b[2].toDouble()))
            put("second", round3(b[3].toDouble()))
            put("zoom", lv.zoom)
            lv.layer?.let { put("layer", it) }
            put("k", lv.k)
            put("used", b[4].toInt())
            put("ms", Math.round(ms * 10) / 10.0)
            put("levels", buildJsonObject { scores.forEach { (z, s) -> put(z, round3(s.toDouble())) } })
        }
    }

    private fun load(ws: String, name: String, json: File, meta: JsonObject, params: FloatArray): Loaded {
        val levels = meta["levels"]?.jsonArray ?: error("locate: templates/$name has no levels")
        val files = levels.map { app.workspaces.file(ws, "templates/" + it.jsonObject.str("image")) }
        val stamp = (files + json).maxOf { it.lastModified() }
        val key = "$ws/$name ${params.joinToString(",")}"
        cache[key]?.let { if (it.stamp == stamp) return it }
        cache.remove(key)?.levels?.forEach { Maa.locateRefDestroy(it.handle) }
        val loaded = levels.mapIndexed { i, e ->
            val o = e.jsonObject
            val origin = o["origin"]!!.jsonArray.map { it.jsonPrimitive.doubleOrNull ?: 0.0 }
            val off = (o["off"] as? JsonArray)?.map { it.jsonPrimitive.doubleOrNull ?: 0.0 } ?: listOf(0.0, 0.0)
            Level(o.optStr("zoom") ?: "$i", o.optStr("layer"), num(o, "k") ?: 1.0, origin[0], origin[1], off[0], off[1], reference(files[i], params))
        }
        return Loaded(stamp, loaded).also { cache[key] = it }
    }

    private fun reference(f: File, params: FloatArray): Long {
        require(f.isFile) { "locate: no image ${f.name}" }
        val bmp = BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPremultiplied = false
        }) ?: error("locate: cannot decode ${f.name}")
        try {
            val px = IntArray(bmp.width * bmp.height)
            bmp.getPixels(px, 0, bmp.width, 0, 0, bmp.width, bmp.height)
            val h = Maa.locateRefCreate(px, bmp.width, bmp.height, params)
            check(h != 0L) { "locate: bad reference ${f.name}" }
            return h
        } finally {
            bmp.recycle()
        }
    }

    companion object {
        const val KEEP = 6 // references kept preprocessed
        const val DEFAULT_RADIUS = 30.0 // position units around the prior
        private const val MAX_DROP = 8 // LOC_MAX_DROP in locate_core.h
        private val SECTIONS = listOf("crop", "mask", "regions", "prep")
        private val KINDS = mapOf("raw" to 0, "hp" to 1, "dog" to 2, "grad" to 3, "canny" to 4)
        private val MODES = mapOf("flat" to 0, "mask" to 1, "none" to 2)
        private val NO_RANGE = floatArrayOf(1f, 1f, 1f, 0f, 0f, 0f) // lo > hi: matches nothing

        private fun num(o: JsonObject, k: String): Double? = (o[k] as? JsonPrimitive)?.doubleOrNull

        private fun pair(o: JsonObject, k: String, what: String): List<Double>? {
            val a = (o[k] as? JsonArray)?.map { it.jsonPrimitive.doubleOrNull } ?: return null
            require(a.size == 2 && a.all { it != null }) { "locate: $what must be [a, b]" }
            return a.map { it!! }
        }

        /** An HSV range {h: [lo, hi], s: [lo, hi], v: [lo, hi]} (a channel left out: all of it) as [lo h s v, hi h s v]. */
        private fun rangeOf(o: JsonObject, what: String): FloatArray {
            val ch = listOf("h", "s", "v").map { pair(o, it, "$what.$it") ?: listOf(0.0, 255.0) }
            return FloatArray(6) { (if (it < 3) ch[it][0] else ch[it - 3][1]).toFloat() }
        }

        /**
         * {crop, mask, regions, prep} as locate_jni.cpp takes them: [kind, pre, sigma, size, rIn, rOut, wedgeR,
         * wedgeHalf, grow, satMax, regionMode, region lo h s v, hi h s v, regionGain, regionOpen, regionMin,
         * regionClose, regionEdge, nDrop, then the drop ranges]. What is left out does nothing.
         */
        fun paramsOf(cfg: JsonObject): FloatArray {
            val empty = JsonObject(emptyMap())
            val crop = cfg["crop"] as? JsonObject ?: empty
            val mask = cfg["mask"] as? JsonObject ?: empty
            val regions = (cfg["regions"] as? JsonObject)?.takeIf { it.isNotEmpty() }
            val prep = cfg["prep"] as? JsonObject ?: empty
            val kind = prep.optStr("kind") ?: "dog"
            val size = num(crop, "size") ?: error("locate: the reference needs crop.size")
            require(size >= 3) { "locate: crop.size must be at least 3" }
            val circle = pair(mask, "circle", "mask.circle") ?: listOf(-1.0, -1.0)
            val wedge = mask["wedge"] as? JsonObject
            val drop = (mask["drop"] as? JsonArray)?.map { rangeOf(it.jsonObject, "mask.drop") }.orEmpty()
            require(drop.size <= MAX_DROP) { "locate: mask.drop takes at most $MAX_DROP ranges" }
            val mode = if (regions == null) "none" else regions.optStr("mode") ?: "flat"
            val head = floatArrayOf(
                (KINDS[kind] ?: error("locate: prep kind must be one of ${KINDS.keys}")).toFloat(),
                (num(prep, "pre") ?: 1.0).toFloat(),
                (num(prep, "sigma") ?: 4.0).toFloat(),
                size.toFloat(),
                circle[0].toFloat(),
                circle[1].toFloat(),
                (wedge?.let { num(it, "r") } ?: -1.0).toFloat(),
                (wedge?.let { num(it, "half") } ?: 0.0).toFloat(),
                (num(mask, "grow") ?: 0.0).toFloat(),
                (num(mask, "sat_max") ?: 0.0).toFloat(),
                (MODES[mode] ?: error("locate: regions mode must be one of ${MODES.keys}")).toFloat(),
            )
            val region = regions?.let { rangeOf(it, "regions") } ?: NO_RANGE
            val tail = floatArrayOf(
                (regions?.let { num(it, "gain") } ?: 1.0).toFloat(),
                (regions?.let { num(it, "open") } ?: 0.0).toFloat(),
                (regions?.let { num(it, "min_px") } ?: 0.0).toFloat(),
                (regions?.let { num(it, "close") } ?: 0.0).toFloat(),
                (regions?.let { num(it, "edge") } ?: 0.0).toFloat(),
                drop.size.toFloat(),
            )
            return drop.fold(head + region + tail) { acc, r -> acc + r }
        }

        private fun round2(v: Double) = Math.round(v * 100) / 100.0
        private fun round3(v: Double) = Math.round(v * 1000) / 1000.0
    }
}
