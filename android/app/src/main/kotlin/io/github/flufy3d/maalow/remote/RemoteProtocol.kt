package io.github.flufy3d.maalow.remote

import android.util.Xml
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.xmlpull.v1.XmlPullParser
import java.io.StringReader
import java.nio.ByteBuffer
import kotlin.math.roundToInt

/** Wire formats of the remote stage: the WebSocket video packets and the keyguard pad layout. */

private const val HEADER = 10

private val BOUNDS = Regex("""\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]""")

internal fun layoutOf(nodes: List<JsonObject>, typed: Int) = buildJsonObject {
    put("t", "layout")
    put("nodes", buildJsonArray { nodes.forEach { add(it) } })
    put("typed", typed)
}

/**
 * The controls under the keyguard's security container in a uiautomator dump, mapped like the mirror (aspect
 * fit of the lw x lh display into w x h): {x, y, w, h, id, label, kind}, kind "tap" (keys and buttons, labelled
 * by their content description or the first text inside), "text" (messages) or "field" (the password field).
 */
internal fun padNodes(xml: String, lw: Int, lh: Int, w: Int, h: Int): List<JsonObject> {
    val scale = minOf(w.toFloat() / lw, h.toFloat() / lh)
    val ox = (w - lw * scale) / 2
    val oy = (h - lh * scale) / 2
    fun node(kind: String, id: String, label: String, b: List<Int>) = buildJsonObject {
        put("x", (b[0] * scale + ox).roundToInt())
        put("y", (b[1] * scale + oy).roundToInt())
        put("w", ((b[2] - b[0]) * scale).roundToInt())
        put("h", ((b[3] - b[1]) * scale).roundToInt())
        put("id", id)
        put("label", label)
        put("kind", kind)
    }
    class Open(val inside: Boolean, val tap: Boolean, val id: String, var label: String, val box: List<Int>?)
    val open = ArrayList<Open>()
    val nodes = ArrayList<JsonObject>()
    val p = Xml.newPullParser().apply { setInput(StringReader(xml)) }
    while (true) {
        when (p.next()) {
            XmlPullParser.END_DOCUMENT -> break
            XmlPullParser.START_TAG -> if (p.name == "node") {
                val a = { k: String -> p.getAttributeValue(null, k).orEmpty() }
                val inside = open.lastOrNull()?.inside == true || a("resource-id").endsWith(":id/keyguard_security_container")
                val box = BOUNDS.find(a("bounds"))?.groupValues?.drop(1)?.map(String::toInt)
                val tap = inside && box != null && a("clickable") == "true"
                val text = a("content-desc").ifEmpty { a("text") }.trim()
                val field = a("password") == "true"
                val id = a("resource-id").substringAfterLast('/')
                val owner = open.lastOrNull { it.tap }
                if (owner != null) {
                    if (owner.label.isEmpty()) owner.label = text
                } else if (inside && !tap && box != null && (text.isNotEmpty() || field)) {
                    nodes.add(node(if (field) "field" else "text", id, text, box))
                }
                open.add(Open(inside, tap, id, text, box))
            }
            XmlPullParser.END_TAG -> if (p.name == "node") {
                val o = open.removeAt(open.size - 1)
                if (o.tap && o.box != null) nodes.add(node("tap", o.id, o.label, o.box))
            }
        }
    }
    return nodes
}

/** [type 1 = video][flags: 1 = key frame][timestamp µs, 8 bytes big-endian] + Annex-B data. */
internal fun packet(data: ByteArray, key: Boolean, ptsUs: Long): ByteArray =
    ByteBuffer.allocate(HEADER + data.size).put(1).put(if (key) 1 else 0).putLong(ptsUs).put(data).array()

/** The WebCodecs codec string ("avc1.PPCCLL") from the SPS in Annex-B codec config data. */
internal fun avcCodec(csd: ByteArray): String {
    for (i in 0 until csd.size - 6) {
        val start = csd[i].toInt() == 0 && csd[i + 1].toInt() == 0 && csd[i + 2].toInt() == 1
        if (start && csd[i + 3].toInt() and 0x1f == 7) {
            return "avc1.%02x%02x%02x".format(csd[i + 4].toInt() and 0xff, csd[i + 5].toInt() and 0xff, csd[i + 6].toInt() and 0xff)
        }
    }
    return "avc1.42e01f"
}
