package io.github.flufy3d.maalow.server

import android.graphics.Bitmap
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.record.Recordings
import io.github.flufy3d.maalow.record.Thumbs
import io.github.flufy3d.maalow.store.optArray
import io.github.flufy3d.maalow.store.optBool
import io.github.flufy3d.maalow.store.optInt
import io.github.flufy3d.maalow.store.optLong
import io.github.flufy3d.maalow.store.optStr
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondFile
import io.ktor.server.routing.Route
import io.ktor.server.routing.RoutingCall
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Screen recordings for replay teaching (workspace recordings/<id>/, see Recordings):
 *
 *     POST   /api/v1/record/start {workspace?, name?, note?, bitrate?}   start recording (one at a time, 3 min max)
 *     POST   /api/v1/record/stop                     stop; returns the saved recording's meta
 *     GET    /api/v1/record                          {recording, id, frames, elapsed_ms, remaining_ms, limit_ms, saving?}
 *     GET    /api/v1/recordings?workspace=W          newest first
 *     GET    /api/v1/recordings/{ws}/{id}            meta
 *     PATCH  /api/v1/recordings/{ws}/{id} {name?, note?}
 *     DELETE /api/v1/recordings/{ws}/{id}
 *     GET    /api/v1/recordings/{ws}/{id}/frame?n=N&fmt=jpg|png&q=90    exact frame N (X-Frame, X-Time-Ms, X-Decode-Ms)
 *     GET    /api/v1/recordings/{ws}/{id}/thumbs/{k}  preview sheet k (JPEG; layout in meta.thumbs)
 *     GET    /api/v1/recordings/{ws}/{id}/thumb?n=N   the preview tile nearest frame N
 *     GET    /api/v1/recordings/{ws}/{id}/video.mp4   the video (range requests)
 *     GET    /api/v1/recordings/{ws}/{id}/labels      labels.json
 *     PUT    /api/v1/recordings/{ws}/{id}/labels/{n} {rev, note, annotations, force?}
 *            save frame n's labels; 409 {error, current} if another page changed the frame since revision rev
 */
fun Route.recordRoutes(app: App) {
    val rec = app.recordings
    fun workspaceOf(w: String?): String = w ?: app.defaultWorkspace() ?: error("no workspace")

    post("/api/v1/record/start") {
        val b = call.body()
        val ws = workspaceOf(b.optStr("workspace"))
        call.respondJson(app.recorder.start(ws, b.optStr("name"), b.optStr("note"), b.optInt("bitrate")))
    }

    post("/api/v1/record/stop") { call.respondJson(app.recorder.stop()) }

    get("/api/v1/record") { call.respondJson(app.recorder.state()) }

    get("/api/v1/recordings") {
        val ws = workspaceOf(call.query("workspace"))
        call.respondJson(withContext(Dispatchers.IO) { rec.list(ws) })
    }

    get("/api/v1/recordings/{ws}/{id}") { call.respondJson(rec.meta(call.ws(), call.id())) }

    patch("/api/v1/recordings/{ws}/{id}") {
        val b = call.body()
        call.respondJson(rec.update(call.ws(), call.id(), b.optStr("name"), b.optStr("note")))
    }

    delete("/api/v1/recordings/{ws}/{id}") {
        val ok = withContext(Dispatchers.IO) { rec.delete(call.ws(), call.id()) }
        call.respondJson(buildJsonObject { put("deleted", ok) }, if (ok) HttpStatusCode.OK else HttpStatusCode.NotFound)
    }

    get("/api/v1/recordings/{ws}/{id}/frame") {
        val n = call.query("n")?.toInt() ?: throw IllegalArgumentException("missing n")
        val png = call.query("fmt") == "png"
        val q = (call.query("q")?.toInt() ?: 90).coerceIn(1, 100)
        val f = app.frames.frame(rec.video(call.ws(), call.id()), n, png, q)
        call.response.header("X-Frame", f.n.toString())
        call.response.header("X-Frames", f.frames.toString())
        call.response.header("X-Time-Ms", Recordings.timeMs(f.n).toString())
        call.response.header("X-Decode-Ms", "%.1f".format(f.decodeMs))
        call.response.header("X-Encode-Ms", "%.1f".format(f.encodeMs))
        call.response.header("X-Cached", f.cached.toString())
        call.response.header("Cache-Control", "private, max-age=3600")
        call.respondBytes(f.bytes, if (png) ContentType.Image.PNG else ContentType.Image.JPEG)
    }

    get("/api/v1/recordings/{ws}/{id}/thumbs/{k}") {
        val k = call.parameters["k"]!!.removeSuffix(".jpg").toInt()
        val f = File(rec.existing(call.ws(), call.id()), "${Recordings.THUMBS}/%03d.jpg".format(k))
        if (!f.isFile) throw NoSuchElementException("no thumbnail sheet $k")
        call.respondFile(f)
    }

    get("/api/v1/recordings/{ws}/{id}/thumb") {
        val n = call.query("n")?.toInt() ?: throw IllegalArgumentException("missing n")
        val meta = rec.meta(call.ws(), call.id())
        val t = meta["thumbs"]!!.jsonObject
        val every = t.optInt("every")!!
        val w = t.optInt("width")!!
        val h = t.optInt("height")!!
        val count = t.optInt("count") ?: 0
        require(count > 0) { "no thumbnails" }
        val i = Math.round(n.toDouble() / every).toInt().coerceIn(0, count - 1)
        val sheet = File(rec.existing(call.ws(), call.id()), "${Recordings.THUMBS}/%03d.jpg".format(i / Thumbs.PER_SHEET))
        val slot = i % Thumbs.PER_SHEET
        val bytes = withContext(Dispatchers.IO) {
            val d = BitmapRegionDecoder.newInstance(sheet.path)!!
            try {
                val x = (slot % Thumbs.COLS) * w
                val y = (slot / Thumbs.COLS) * h
                val bmp = d.decodeRegion(Rect(x, y, x + w, y + h), null)
                ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it); bmp.recycle() }.toByteArray()
            } finally {
                d.recycle()
            }
        }
        call.response.header("X-Frame", (i * every).toString())
        call.respondBytes(bytes, ContentType.Image.JPEG)
    }

    get("/api/v1/recordings/{ws}/{id}/video.mp4") { call.respondFile(rec.video(call.ws(), call.id())) }

    get("/api/v1/recordings/{ws}/{id}/labels") {
        call.respondJson(withContext(Dispatchers.IO) { rec.labels(call.ws(), call.id()) })
    }

    put("/api/v1/recordings/{ws}/{id}/labels/{n}") {
        val b = call.body()
        val n = call.parameters["n"]!!.toInt()
        val saved = withContext(Dispatchers.IO) {
            rec.putFrame(
                call.ws(), call.id(), n, b.optLong("rev") ?: 0, b.optStr("note").orEmpty(),
                b.optArray("annotations") ?: JsonArray(emptyList()), b.optBool("force") == true,
            )
        }
        call.respondJson(saved.body, if (saved.ok) HttpStatusCode.OK else HttpStatusCode.Conflict)
    }
}

private fun RoutingCall.ws(): String = parameters["ws"]!!

private fun RoutingCall.id(): String = parameters["id"]!!
