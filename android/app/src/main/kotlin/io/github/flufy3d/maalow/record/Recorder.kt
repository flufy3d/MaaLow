package io.github.flufy3d.maalow.record

import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.opengl.EGLSurface
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.store.writeJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Records the screen into a workspace recording (see [Recordings]): the privileged process opens a second mirror of
 * the display, into a SurfaceTexture here; a GL thread draws its latest image into the H.264 encoder's input surface
 * on a fixed 30 fps clock, so frame n is always the screen at n / 30 s after the first frame, whether the screen
 * changed or not (a mirror only delivers frames when the content changes). Frames missed because the thread was late
 * are emitted as repeats, so the frame count never drifts from wall time. Every [Recordings.THUMB_EVERY]-th frame is
 * also drawn small and read back for the preview sheets.
 *
 * Independent of the device lock: guards, tasks and skills keep running while recording. The capture path used for
 * recognition (bridge ImageReader) is untouched.
 */
class Recorder(private val app: App) {
    private val lock = Any()
    @Volatile private var session: Session? = null
    @Volatile private var saving: Saving? = null
    private val io = Executors.newSingleThreadExecutor { Thread(it, "maalow-record-io") }

    private class Saving(val ws: String, val id: String, val done: Deferred<JsonObject>)

    /** Recording or saving this recording right now. */
    fun owns(ws: String, id: String): Boolean =
        session?.let { it.ws == ws && it.id == id } == true || saving?.let { it.ws == ws && it.id == id } == true

    val recording: Boolean get() = session != null

    fun start(ws: String, name: String?, note: String?, bitrate: Int?): JsonObject = synchronized(lock) {
        check(session == null) { "已经在录制（同时只能录一段）" }
        check(app.engine.state == Engine.State.RUNNING) { "引擎没有运行，无法录制" }
        val root = app.recordings.root(ws)
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date())
        val id = generateSequence(1) { it + 1 }.map { if (it == 1) stamp else "$stamp-$it" }.first { !File(root, it).exists() }
        val s = Session(
            ws, id, File(root, id), name?.trim()?.takeIf { it.isNotEmpty() } ?: "录像 ${id.substring(9, 11)}:${id.substring(11, 13)}",
            note.orEmpty(), bitrate ?: app.settings().recordBitrate,
        )
        try {
            s.begin()
        } catch (e: Throwable) {
            s.halt()
            s.dir.deleteRecursively()
            throw e
        }
        session = s
        app.events.post("recording") {
            put("workspace", ws)
            put("recording", id)
            put("state", "recording")
        }
        state()
    }

    /** Stop recording; the returned job finishes saving (video.mp4, thumbnails, meta). null if not recording. */
    fun stopAsync(reason: String): Deferred<JsonObject>? = synchronized(lock) {
        val s = session ?: return saving?.done
        session = null
        s.halt()
        val done = CompletableDeferred<JsonObject>()
        saving = Saving(s.ws, s.id, done)
        app.scope.launch(Dispatchers.IO) {
            try {
                io.submit { }.get() // thumbnail sheets queued by the session are written
                val meta = app.recordings.finish(s.dir, reason, s.thumbCount)
                app.events.post("recording") {
                    put("workspace", s.ws)
                    put("recording", s.id)
                    put("state", "saved")
                    put("frames", meta["frames"]!!)
                    put("stopped_by", reason)
                }
                done.complete(meta)
            } catch (e: Throwable) {
                Log.e(TAG, "saving ${s.id} failed", e)
                done.completeExceptionally(e)
            } finally {
                synchronized(lock) { if (saving?.done === done) saving = null }
            }
        }
        done
    }

    suspend fun stop(reason: String = "user"): JsonObject = (stopAsync(reason) ?: error("没有在录制")).await()

    /** Live fields merged into the recording's meta while it records or saves. */
    fun live(): JsonObject? {
        session?.let { s ->
            return buildJsonObject {
                put("workspace", s.ws)
                put("id", s.id)
                put("state", "recording")
                put("frames", s.frames)
                put("duration_ms", Recordings.timeMs(s.frames))
            }
        }
        return saving?.let { s ->
            buildJsonObject {
                put("workspace", s.ws)
                put("id", s.id)
                put("state", "saving")
            }
        }
    }

    /** For /status and the web UI. */
    fun state(): JsonObject = buildJsonObject {
        val s = session
        put("recording", s != null)
        put("limit_ms", LIMIT_FRAMES * 1000L / Recordings.FPS)
        if (s != null) {
            put("workspace", s.ws)
            put("id", s.id)
            put("name", s.name)
            put("frames", s.frames)
            put("elapsed_ms", Recordings.timeMs(s.frames))
            put("remaining_ms", Recordings.timeMs(LIMIT_FRAMES - s.frames))
            put("bitrate", s.bitrate)
        }
        saving?.let {
            put("saving", buildJsonObject {
                put("workspace", it.ws)
                put("id", it.id)
            })
        }
    }

    private inner class Session(val ws: String, val id: String, val dir: File, val name: String, val note: String, val bitrate: Int) {
        val width = app.engine.width
        val height = app.engine.height
        private val thumbW = Thumbs.WIDTH
        private val thumbH = Thumbs.WIDTH * height / width
        private val thumbs = Thumbs(File(dir, Recordings.THUMBS), Recordings.THUMB_EVERY, thumbW, thumbH, io)
        @Volatile var frames = 0 // drawn into the encoder
            private set
        @Volatile var thumbCount = 0
            private set

        private var codec: MediaCodec? = null
        private var input: Surface? = null
        private val glThread = HandlerThread("maalow-record").apply { start() }
        private val gh = Handler(glThread.looper)
        private var gl: Gl? = null
        private var target: EGLSurface? = null
        private lateinit var quad: ExternalQuad
        private var texture: SurfaceTexture? = null
        private var mirrorSurface: Surface? = null
        private lateinit var fbo: Fbo
        private lateinit var tile: Bitmap
        private lateinit var pixels: ByteBuffer
        private var pending = 0 // mirror frames not yet latched (GL thread)
        private var created = 0L
        private var t0 = 0L // time of frame 0, System.nanoTime
        @Volatile private var halted = false
        private var mirrorId = -1

        private var stream: FileOutputStream? = null
        private var index: FileOutputStream? = null
        private var streamPos = 0L
        private val record = ByteBuffer.allocate(Recordings.INDEX_RECORD).order(ByteOrder.LITTLE_ENDIAN)
        private var drain: Thread? = null

        fun begin() {
            dir.mkdirs()
            File(dir, Recordings.META).writeJson(buildJsonObject {
                put("id", id)
                put("name", name)
                put("note", note)
                put("workspace", ws)
                put("state", "recording")
                put("started", System.currentTimeMillis())
                put("started_at", SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(Date()))
                put("fps", Recordings.FPS)
                put("width", width)
                put("height", height)
                put("bitrate", bitrate)
                put("gop_s", GOP_S)
                put("thumbs", Thumbs.layout(Recordings.THUMB_EVERY, thumbW, thumbH, 0))
            })
            stream = FileOutputStream(File(dir, Recordings.STREAM))
            index = FileOutputStream(File(dir, Recordings.INDEX))

            val format = MediaFormat.createVideoFormat(MIME, width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, Recordings.FPS)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, GOP_S)
                setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0) // decode order = display order: sample i is frame i
                setInteger(MediaFormat.KEY_PRIORITY, 0)
            }
            val c = MediaCodec.createEncoderByType(MIME)
            codec = c
            c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            input = c.createInputSurface()
            c.start()
            drain = Thread({ drainLoop(c) }, "maalow-record-out").apply { start() }

            onGl {
                val g = Gl()
                gl = g
                target = g.windowSurface(input!!).also { g.makeCurrent(it) }
                quad = ExternalQuad()
                texture = SurfaceTexture(quad.texture).apply {
                    setDefaultBufferSize(width, height)
                    setOnFrameAvailableListener({ pending++ }, gh)
                }
                mirrorSurface = Surface(texture)
                fbo = Fbo(thumbW, thumbH)
                tile = Bitmap.createBitmap(thumbW, thumbH, Bitmap.Config.ARGB_8888)
                pixels = ByteBuffer.allocateDirect(thumbW * thumbH * 4).order(ByteOrder.nativeOrder())
            }
            mirrorId = app.engine.privileged().mirror(mirrorSurface, width, height, "maalow-record")
            check(mirrorId > 0) { "录制镜像创建失败" }
            created = System.nanoTime()
            gh.post(::tick)
            Log.i(TAG, "recording $ws/$id ${width}x$height @${Recordings.FPS} ${bitrate / 1000} kbps")
        }

        private fun onGl(block: () -> Unit) {
            var error: Throwable? = null
            val done = CountDownLatch(1)
            gh.post {
                try {
                    block()
                } catch (e: Throwable) {
                    error = e
                } finally {
                    done.countDown()
                }
            }
            check(done.await(5, TimeUnit.SECONDS)) { "record GL thread stuck" }
            error?.let { throw it }
        }

        /** GL thread: latch the newest mirror image, emit every frame that is due by now, schedule the next one. */
        private fun tick() {
            if (halted) return
            try {
                val now = System.nanoTime()
                val st = texture!!
                if (pending > 0) {
                    repeat(pending) { st.updateTexImage() }
                    pending = 0
                    if (t0 == 0L) t0 = now // the clock starts with the first real image
                }
                if (t0 == 0L) {
                    if (now - created < FIRST_FRAME_WAIT_NS) {
                        gh.postDelayed(::tick, 4)
                        return
                    }
                    t0 = now // nothing on screen changed yet: start anyway (the first frames stay black)
                }
                val due = minOf(LIMIT_FRAMES, ((now - t0) / FRAME_NS).toInt() + 1)
                while (frames < due) {
                    quad.draw(st, width, height)
                    gl!!.swap(target!!, frames * 1_000_000_000L / Recordings.FPS)
                    if (frames % Recordings.THUMB_EVERY == 0) thumb(st)
                    frames++
                }
                if (frames >= LIMIT_FRAMES) {
                    Log.i(TAG, "recording $id reached the limit")
                    app.scope.launch { stopAsync("limit") } // not on this thread: stopping waits for it
                    return
                }
                val wait = (t0 + frames * FRAME_NS - System.nanoTime()) / 1_000_000
                gh.postDelayed(::tick, wait.coerceAtLeast(0))
            } catch (e: Throwable) {
                Log.e(TAG, "recording $id failed", e)
                app.scope.launch { stopAsync("error") }
            }
        }

        private fun thumb(st: SurfaceTexture) {
            fbo.bind()
            quad.draw(st, thumbW, thumbH, flip = true)
            readPixels(thumbW, thumbH, pixels)
            fbo.unbind()
            tile.copyPixelsFromBuffer(pixels)
            thumbs.add(tile)
            thumbCount = thumbs.count
        }

        /** Encoder output -> stream + index files, written straight through so a killed app loses at most a frame. */
        private fun drainLoop(c: MediaCodec) {
            val info = MediaCodec.BufferInfo()
            try {
                while (true) {
                    val i = c.dequeueOutputBuffer(info, 100_000)
                    if (i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        writeCsd(c.outputFormat)
                    } else if (i >= 0) {
                        val buf = c.getOutputBuffer(i)!!
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
                            buf.position(info.offset).limit(info.offset + info.size)
                            val ch = stream!!.channel
                            while (buf.hasRemaining()) ch.write(buf)
                            record.clear()
                            record.putLong(streamPos).putInt(info.size)
                                .putInt(if (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0) 1 else 0)
                                .putLong(info.presentationTimeUs)
                            index!!.write(record.array())
                            streamPos += info.size
                        }
                        c.releaseOutputBuffer(i, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                    }
                }
            } catch (e: Exception) {
                if (!halted) Log.e(TAG, "encoder output of $id failed", e)
            }
        }

        private fun writeCsd(format: MediaFormat) {
            DataOutputStream(FileOutputStream(File(dir, Recordings.CSD))).use { out ->
                for (key in listOf("csd-0", "csd-1")) {
                    val b = format.getByteBuffer(key)!!.duplicate()
                    out.writeInt(b.remaining())
                    val bytes = ByteArray(b.remaining())
                    b.get(bytes)
                    out.write(bytes)
                }
            }
        }

        /** Stop producing frames and release everything but the files. */
        fun halt() {
            halted = true
            runCatching {
                val done = CountDownLatch(1)
                gh.postAtFrontOfQueue { gh.removeCallbacksAndMessages(null); done.countDown() }
                done.await(2, TimeUnit.SECONDS)
            }
            if (mirrorId > 0) runCatching { app.engine.privilegedOrNull()?.release(mirrorId) }
            mirrorId = -1
            codec?.let { c ->
                runCatching { c.signalEndOfInputStream() }
                drain?.join(3000)
                runCatching { c.stop() }
                runCatching { c.release() }
            }
            codec = null
            runCatching {
                onGl {
                    mirrorSurface?.release()
                    texture?.release()
                    gl?.let { g ->
                        target?.let { g.release(it) }
                        g.close()
                    }
                    gl = null
                }
            }
            glThread.quitSafely()
            input?.release()
            thumbs.flush()
            thumbCount = thumbs.count
            runCatching { stream?.close() }
            runCatching { index?.close() }
            Log.i(TAG, "recording $id halted at $frames frames")
        }
    }

    companion object {
        const val TAG = "MaaLowRecord"
        const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
        const val GOP_S = 1
        const val LIMIT_FRAMES = 3 * 60 * Recordings.FPS
        const val FRAME_NS = 1_000_000_000L / Recordings.FPS
        const val FIRST_FRAME_WAIT_NS = 1_500_000_000L
    }
}
