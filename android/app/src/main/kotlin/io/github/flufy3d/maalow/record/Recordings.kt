package io.github.flufy3d.maalow.record

import android.media.MediaCodec
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.store.optArray
import io.github.flufy3d.maalow.store.optInt
import io.github.flufy3d.maalow.store.optLong
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.readJsonObject
import io.github.flufy3d.maalow.store.with
import io.github.flufy3d.maalow.store.writeJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.DataInputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

/**
 * Recordings of a workspace, recordings/<id>/:
 *
 *     video.mp4       H.264, fixed 30 fps: frame n is shown at n / 30 s
 *     meta.json       {id, name, note, workspace, state, started, fps, width, height, bitrate, frames, duration_ms, thumbs, ...}
 *     labels.json     {version, fps, width, height, frames: {"n": {rev, time_ms, note, annotations: [{kind, coords, label}]}}}
 *     thumbs/NNN.jpg  preview sheets (see [Thumbs])
 *
 * While recording, the encoder output goes to hidden files ([STREAM] + [INDEX] + [CSD]) that survive the app being
 * killed at any point; [finish] turns them into video.mp4, both on a normal stop and when recovering a recording
 * that was cut short.
 */
class Recordings(private val app: App) {
    private val labelLock = Any()

    fun root(ws: String): File = File(app.workspaces.existing(ws), DIR)

    fun dir(ws: String, id: String): File {
        require(ID.matches(id)) { "bad recording id: $id" }
        return File(root(ws), id)
    }

    fun existing(ws: String, id: String): File =
        dir(ws, id).also { if (!File(it, META).isFile) throw NoSuchElementException("没有这段录像：$ws/$id") }

    fun meta(ws: String, id: String): JsonObject = readJsonObject(File(existing(ws, id), META))!!

    fun video(ws: String, id: String): File = File(existing(ws, id), VIDEO).also {
        check(it.isFile) { "录像 $id 还没有保存完" }
    }

    /** Newest first; the one being recorded (or saved) carries its live state. */
    fun list(ws: String): List<JsonObject> {
        val live = app.recorder.live()
        return root(ws).listFiles()?.filter { File(it, META).isFile && ID.matches(it.name) }?.sortedByDescending { it.name }
            ?.mapNotNull { d ->
                val m = runCatching { readJsonObject(File(d, META)) }.getOrNull() ?: return@mapNotNull null
                if (live != null && live.optStr("workspace") == ws && live.optStr("id") == d.name) JsonObject(m + live) else m
            } ?: emptyList()
    }

    fun update(ws: String, id: String, name: String?, note: String?): JsonObject = synchronized(this) {
        val f = File(existing(ws, id), META)
        val m = readJsonObject(f)!!
        val next = m.with(*listOfNotNull(name?.let { "name" to JsonPrimitive(it.trim()) }, note?.let { "note" to JsonPrimitive(it) }).toTypedArray())
        f.writeJson(next)
        next
    }

    fun delete(ws: String, id: String): Boolean {
        val d = existing(ws, id)
        check(!app.recorder.owns(ws, id)) { "这段录像正在录制或保存，先结束录制" }
        app.frames.forget(File(d, VIDEO))
        return d.deleteRecursively()
    }

    // ---- labels

    fun labels(ws: String, id: String): JsonObject {
        val d = existing(ws, id)
        return readJsonObject(File(d, LABELS)) ?: emptyLabels(readJsonObject(File(d, META))!!)
    }

    private fun emptyLabels(meta: JsonObject) = buildJsonObject {
        put("version", 0)
        put("fps", meta.optInt("fps") ?: FPS)
        put("width", meta.optInt("width") ?: 0)
        put("height", meta.optInt("height") ?: 0)
        put("frames", JsonObject(emptyMap()))
    }

    /** Result of saving one frame's labels: ok, or a conflict carrying what is stored now. */
    class Saved(val ok: Boolean, val body: JsonObject)

    /**
     * Save one frame's labels. rev is the revision the client edited (0: a frame it saw without labels); a different
     * stored revision means another page changed the frame meanwhile, and nothing is written unless force. Empty note
     * and annotations remove the frame.
     */
    fun putFrame(ws: String, id: String, n: Int, rev: Long, note: String, annotations: JsonArray, force: Boolean): Saved =
        synchronized(labelLock) {
            val d = existing(ws, id)
            val meta = readJsonObject(File(d, META))!!
            val frames = meta.optInt("frames") ?: 0
            require(n >= 0 && (frames == 0 || n < frames)) { "帧号超出范围：$n（共 $frames 帧）" }
            val all = readJsonObject(File(d, LABELS)) ?: emptyLabels(meta)
            val map = all["frames"]!!.jsonObject.toMutableMap()
            val cur = map[n.toString()]?.jsonObject
            val curRev = cur?.optLong("rev") ?: 0
            val version = all.optLong("version") ?: 0
            if (curRev != rev && !force) {
                return Saved(false, buildJsonObject {
                    put("error", "第 $n 帧已被另一个页面修改")
                    put("version", version)
                    put("frame", n)
                    put("current", cur ?: JsonObject(emptyMap()))
                })
            }
            val marks = normalize(annotations)
            val entry = if (note.isBlank() && marks.isEmpty()) null else buildJsonObject {
                put("rev", curRev + 1)
                put("time_ms", timeMs(n, meta.optInt("fps") ?: FPS))
                put("note", note)
                put("annotations", marks)
                put("updated", System.currentTimeMillis())
            }
            if (entry == null) map.remove(n.toString()) else map[n.toString()] = entry
            val sorted = map.entries.sortedBy { it.key.toInt() }.associate { it.key to it.value }
            File(d, LABELS).writeJson(all.with("version" to JsonPrimitive(version + 1), "frames" to JsonObject(sorted)))
            Saved(true, buildJsonObject {
                put("version", version + 1)
                put("frame", n)
                put("current", entry ?: JsonObject(emptyMap()))
            })
        }

    /** Annotations in the shape live teaching uses: {kind, coords (ints), label}. */
    private fun normalize(raw: JsonArray): JsonArray = buildJsonArray {
        raw.forEach { e ->
            val a = e.jsonObject
            val kind = a.optStr("kind").orEmpty()
            require(kind in KINDS) { "unknown annotation kind: $kind" }
            val coords = a.optArray("coords")?.map { it.jsonPrimitive.content.toDouble().roundToInt() }.orEmpty()
            require(coords.size == if (kind == "click") 2 else 4) { "bad coords for $kind: $coords" }
            add(buildJsonObject {
                put("kind", kind)
                put("coords", JsonArray(coords.map { JsonPrimitive(it) }))
                put("label", a.optStr("label").orEmpty())
            })
        }
    }

    // ---- finishing and recovery

    /**
     * Turn the raw encoder output of a recording into video.mp4, fill in missing thumbnails, complete meta.json and
     * drop the raw files. thumbs: tiles already written (null: count the full sheets on disk).
     */
    suspend fun finish(dir: File, stoppedBy: String, thumbs: Int?): JsonObject {
        val metaFile = File(dir, META)
        val meta = readJsonObject(metaFile) ?: error("no meta.json in $dir")
        val samples = readIndex(dir)
        if (samples.isEmpty()) {
            dir.deleteRecursively()
            error("录像没有任何帧，已丢弃")
        }
        val fps = meta.optInt("fps") ?: FPS
        val width = meta.optInt("width")!!
        val height = meta.optInt("height")!!
        val video = File(dir, VIDEO)
        remux(dir, samples, width, height, fps, video)
        val frames = (samples.last().pts * fps / 1_000_000.0).roundToInt() + 1
        val layout = meta["thumbs"]?.jsonObject
        val every = layout?.optInt("every") ?: THUMB_EVERY
        val tw = layout?.optInt("width") ?: Thumbs.WIDTH
        val th = layout?.optInt("height") ?: (Thumbs.WIDTH * height / width)
        val want = Thumbs.tilesFor(frames, every)
        val thumbDir = File(dir, THUMBS)
        var have = thumbs ?: ((thumbDir.listFiles()?.count { it.name.endsWith(".jpg") } ?: 0) * Thumbs.PER_SHEET)
        have = have.coerceAtMost(want)
        if (have < want) {
            try {
                app.frames.fillThumbs(video, Thumbs(thumbDir, every, tw, th, null).apply { resume(have) }, want)
                have = want
            } catch (e: Exception) {
                Log.w(TAG, "thumbnails of ${dir.name} incomplete", e)
            }
        }
        val done = meta.with(
            "state" to JsonPrimitive("ready"),
            "frames" to JsonPrimitive(frames),
            "duration_ms" to JsonPrimitive(timeMs(frames, fps)),
            "size" to JsonPrimitive(video.length()),
            "stopped_by" to JsonPrimitive(stoppedBy),
            "thumbs" to Thumbs.layout(every, tw, th, have),
        )
        metaFile.writeJson(done)
        listOf(STREAM, INDEX, CSD).forEach { File(dir, it).delete() }
        Log.i(TAG, "saved ${dir.name}: $frames frames, ${video.length()} bytes ($stoppedBy)")
        return done
    }

    /** Recordings left unfinished by a killed app or a crash: finish them now. */
    suspend fun recoverAll() {
        for (ws in app.workspaces.list()) {
            val dirs = File(app.workspaces.dir(ws), DIR).listFiles() ?: continue
            for (d in dirs) {
                if (!File(d, STREAM).isFile || app.recorder.owns(ws, d.name)) continue
                try {
                    finish(d, "recovered", null)
                    app.events.post("recording") {
                        put("workspace", ws)
                        put("recording", d.name)
                        put("state", "recovered")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "cannot recover $ws/${d.name}", e)
                }
            }
        }
    }

    internal class Sample(val offset: Long, val size: Int, val key: Boolean, val pts: Long)

    /** Index records whose data made it into the stream file; a record cut short at the end is dropped. */
    private fun readIndex(dir: File): List<Sample> {
        val idx = File(dir, INDEX)
        val stream = File(dir, STREAM)
        if (!idx.isFile || !stream.isFile) return emptyList()
        val len = stream.length()
        val out = ArrayList<Sample>()
        DataInputStream(idx.inputStream().buffered()).use { input ->
            val rec = ByteArray(INDEX_RECORD)
            repeat((idx.length() / INDEX_RECORD).toInt()) {
                input.readFully(rec)
                val b = ByteBuffer.wrap(rec).order(ByteOrder.LITTLE_ENDIAN)
                val s = Sample(b.long, b.int, b.int and 1 != 0, b.long)
                if (s.offset + s.size > len) return@use
                out.add(s)
            }
        }
        // decoding has to start at a key frame
        val first = out.indexOfFirst { it.key }
        return if (first < 0) emptyList() else out.subList(first, out.size)
    }

    private fun remux(dir: File, samples: List<Sample>, width: Int, height: Int, fps: Int, video: File) {
        val format = MediaFormat.createVideoFormat(Recorder.MIME, width, height).apply {
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            DataInputStream(File(dir, CSD).inputStream()).use { input ->
                for (key in listOf("csd-0", "csd-1")) {
                    val bytes = ByteArray(input.readInt()).also { input.readFully(it) }
                    setByteBuffer(key, ByteBuffer.wrap(bytes))
                }
            }
        }
        val tmp = File(dir, ".$VIDEO.tmp")
        val mux = MediaMuxer(tmp.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        try {
            val track = mux.addTrack(format)
            mux.start()
            val info = MediaCodec.BufferInfo()
            var buf = ByteBuffer.allocateDirect(1 shl 20)
            RandomAccessFile(File(dir, STREAM), "r").channel.use { ch ->
                for (s in samples) {
                    if (buf.capacity() < s.size) buf = ByteBuffer.allocateDirect(s.size * 2)
                    buf.clear().limit(s.size)
                    var pos = s.offset
                    while (buf.hasRemaining()) {
                        val n = ch.read(buf, pos)
                        check(n > 0) { "short read in ${dir.name}" }
                        pos += n
                    }
                    buf.flip()
                    info.set(0, s.size, s.pts, if (s.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                    mux.writeSampleData(track, buf, info)
                }
            }
            mux.stop()
        } finally {
            mux.release()
        }
        check(tmp.renameTo(video) || (video.delete() && tmp.renameTo(video))) { "cannot write $video" }
    }

    companion object {
        const val TAG = "MaaLowRecord"
        const val DIR = "recordings"
        const val META = "meta.json"
        const val LABELS = "labels.json"
        const val VIDEO = "video.mp4"
        const val THUMBS = "thumbs"
        const val STREAM = ".stream.h264"
        const val INDEX = ".frames.idx"
        const val CSD = ".csd"
        /** Index record, little endian: int64 offset, int32 size, int32 flags (1: key frame), int64 pts (us). */
        const val INDEX_RECORD = 24
        const val FPS = 30
        const val THUMB_EVERY = 5
        val ID = Regex("^[0-9]{8}-[0-9]{6}(-[0-9]+)?$")
        val KINDS = setOf("click", "rect", "circle", "arrow", "region")

        fun timeMs(frame: Int, fps: Int = FPS): Long = Math.round(frame * 1000.0 / fps)
    }
}
