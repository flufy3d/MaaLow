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
 * Skills' locate(): where the character is, from the minimap disc matched in a reference drawn at the minimap's
 * scale (native, locate_core.cpp). A reference is templates/<ref>.json, made by scripts/minimap_locate.py export:
 *
 *     {"levels": [{"zoom": "out", "image": "locate/x_out.png", "k": 2.3, "origin": [u, v], "off": [dx, dy]}, ...],
 *      "prep": {"kind": "dog", "pre": 1, "sigma": 4}}
 *
 * one level per minimap zoom (it zooms in inside some places): image (alpha: where the map is known), k (position
 * units per image px), origin (image px of the position origin), off (added to the result). Every level is tried
 * and the best score wins. Images are decoded and preprocessed once, kept while their files stay the same.
 */
internal class Locator(private val app: App) {
    private class Level(val zoom: String, val k: Double, val ox: Double, val oy: Double, val offX: Double, val offY: Double, val handle: Long)

    private class Loaded(val stamp: Long, val prep: FloatArray, val levels: List<Level>)

    private val cache = object : LinkedHashMap<String, Loaded>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Loaded>): Boolean {
            if (size <= KEEP) return false
            eldest.value.levels.forEach { Maa.locateRefDestroy(it.handle) }
            return true
        }
    }

    /**
     * {ref, image?, prior?: [x, y], radius?, cam?, zoom?, center?: [x, y], prep?} -> {x, y, score, second, zoom, used,
     * ms, levels: {zoom: score}}, or null when no level could be matched.
     */
    @Synchronized
    fun locate(ws: String, a: JsonObject, image: Long): JsonElement {
        val t0 = System.nanoTime()
        val name = a.str("ref").let { if (it.endsWith(".json")) it else "$it.json" }
        val ref = load(ws, name, a["prep"] as? JsonObject)
        val prior = (a["prior"] as? JsonArray)?.map { it.jsonPrimitive.doubleOrNull ?: error("locate: prior must be [x, y]") }
        require(prior == null || prior.size == 2) { "locate: prior must be [x, y]" }
        val radius = num(a, "radius") ?: DEFAULT_RADIUS
        val cam = num(a, "cam") ?: Double.NaN
        val only = a.optStr("zoom")
        val center = (a["center"] as? JsonArray)?.map { it.jsonPrimitive.doubleOrNull ?: 0.0 } ?: listOf(MINIMAP[0], MINIMAP[1])
        var best: FloatArray? = null
        var bestLevel: Level? = null
        val scores = LinkedHashMap<String, Float>()
        for (lv in ref.levels) {
            if (only != null && lv.zoom != only) continue
            val pu = if (prior != null) lv.ox + (prior[0] - lv.offX) / lv.k else 0.0
            val pv = if (prior != null) lv.oy + (prior[1] - lv.offY) / lv.k else 0.0
            val r = if (prior != null) radius / lv.k else -1.0
            val args = floatArrayOf(center[0].toFloat(), center[1].toFloat(), cam.toFloat(), pu.toFloat(), pv.toFloat(), r.toFloat()) + ref.prep
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
            put("used", b[4].toInt())
            put("ms", Math.round(ms * 10) / 10.0)
            put("levels", buildJsonObject { scores.forEach { (z, s) -> put(z, round3(s.toDouble())) } })
        }
    }

    private fun load(ws: String, name: String, override: JsonObject?): Loaded {
        val json = app.workspaces.file(ws, "templates/$name")
        require(json.isFile) { "locate: no reference templates/$name" }
        val meta = readJsonObject(json) ?: error("locate: templates/$name is not a JSON object")
        val levels = meta["levels"]?.jsonArray ?: error("locate: templates/$name has no levels")
        val files = levels.map { app.workspaces.file(ws, "templates/" + it.jsonObject.str("image")) }
        val stamp = (files + json).maxOf { it.lastModified() }
        val prep = prepOf(JsonObject((meta["prep"] as? JsonObject).orEmpty() + override.orEmpty()))
        val key = "$ws/$name ${prep.joinToString(",")}"
        cache[key]?.let { if (it.stamp == stamp) return it }
        cache.remove(key)?.levels?.forEach { Maa.locateRefDestroy(it.handle) }
        val loaded = levels.mapIndexed { i, e ->
            val o = e.jsonObject
            val origin = o["origin"]!!.jsonArray.map { it.jsonPrimitive.doubleOrNull ?: 0.0 }
            val off = (o["off"] as? JsonArray)?.map { it.jsonPrimitive.doubleOrNull ?: 0.0 } ?: listOf(0.0, 0.0)
            Level(o.optStr("zoom") ?: "$i", num(o, "k") ?: 1.0, origin[0], origin[1], off[0], off[1], reference(files[i], prep))
        }
        return Loaded(stamp, prep, loaded).also { cache[key] = it }
    }

    private fun reference(f: File, prep: FloatArray): Long {
        require(f.isFile) { "locate: no image ${f.name}" }
        val bmp = BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPremultiplied = false
        }) ?: error("locate: cannot decode ${f.name}")
        try {
            val px = IntArray(bmp.width * bmp.height)
            bmp.getPixels(px, 0, bmp.width, 0, 0, bmp.width, bmp.height)
            val h = Maa.locateRefCreate(px, bmp.width, bmp.height, prep)
            check(h != 0L) { "locate: bad reference ${f.name}" }
            return h
        } finally {
            bmp.recycle()
        }
    }

    companion object {
        const val KEEP = 6 // references kept preprocessed
        const val DEFAULT_RADIUS = 30.0 // position units around the prior
        val MINIMAP = doubleArrayOf(144.0, 70.0)
        private val KINDS = mapOf("raw" to 0, "hp" to 1, "dog" to 2, "grad" to 3, "canny" to 4)
        private val ZONES = mapOf("flat" to 0, "mask" to 1, "none" to 2)

        private fun num(o: JsonObject, k: String): Double? = (o[k] as? JsonPrimitive)?.doubleOrNull

        /** [kind, pre, sigma, rUse, rArrow, fanR, fanHalf, satMax, zone, zoneGain], defaults as scripts/minimap_locate.py Prep. */
        fun prepOf(p: JsonObject): FloatArray {
            val kind = p.optStr("kind") ?: "dog"
            val zone = p.optStr("zone") ?: "flat"
            return floatArrayOf(
                (KINDS[kind] ?: error("locate: prep kind must be one of ${KINDS.keys}")).toFloat(),
                (num(p, "pre") ?: 1.0).toFloat(),
                (num(p, "sigma") ?: 4.0).toFloat(),
                (num(p, "r_use") ?: 44.0).toFloat(),
                (num(p, "r_arrow") ?: 9.0).toFloat(),
                (num(p, "fan_r") ?: 34.0).toFloat(),
                (num(p, "fan_half") ?: 38.0).toFloat(),
                (num(p, "sat_max") ?: 0.0).toFloat(),
                (ZONES[zone] ?: error("locate: prep zone must be one of ${ZONES.keys}")).toFloat(),
                (num(p, "zone_gain") ?: 1.0).toFloat(),
            )
        }

        private fun round2(v: Double) = Math.round(v * 100) / 100.0
        private fun round3(v: Double) = Math.round(v * 1000) / 1000.0
    }
}
