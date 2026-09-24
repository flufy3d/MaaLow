package io.github.flufy3d.maalow.record

import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.opengl.EGLSurface
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/**
 * Exact frames of a recording by frame number: MediaExtractor + a hardware decoder rendering into a SurfaceTexture,
 * drawn into a pbuffer and read back. One decoder (for the recording last asked about) stays open on its own thread,
 * so stepping is cheap:
 *
 *  - forward: the decoder simply continues;
 *  - backward: the decoder restarts at the key frame before the target and every frame up to the target is kept in a
 *    small cache, so the following backward steps are cache hits until the start of that GOP;
 *  - a jump: seek to the key frame before the target and decode up to it, reading back only the target.
 *
 * After each step the next frame in the same direction is prefetched and encoded in the format just asked for, so a
 * steady step costs little more than the transfer.
 */
class Frames {
    private val exec = Executors.newSingleThreadScheduledExecutor { Thread(it, "maalow-decode") }
    private val thread = exec.asCoroutineDispatcher()
    private val callbacks = HandlerThread("maalow-decode-st").apply { start() }
    private var gl: Gl? = null
    private var dec: Decoder? = null
    private val cache = object : LinkedHashMap<Int, ByteBuffer>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, ByteBuffer>): Boolean =
            (size > CACHE_FRAMES).also { if (it) pool.add(eldest.value) }
    }
    private val pool = ArrayList<ByteBuffer>()
    private data class Key(val n: Int, val png: Boolean, val quality: Int)
    private val encoded = object : LinkedHashMap<Key, ByteArray>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Key, ByteArray>) = size > ENCODED_FRAMES
    }
    private var last = -1 // last frame asked for
    private var used = 0L

    /** An encoded frame. cached: served without decoding. */
    class Frame(val n: Int, val frames: Int, val bytes: ByteArray, val decodeMs: Double, val encodeMs: Double, val cached: Boolean)

    suspend fun frame(video: File, n: Int, png: Boolean, quality: Int): Frame = withContext(thread) {
        val d = open(video)
        require(n in 0 until d.frames) { "帧号超出范围：$n（共 ${d.frames} 帧）" }
        val dir = if (last < 0 || n == last) 0 else if (n > last) 1 else -1
        last = n
        val key = Key(n, png, quality)
        val t0 = System.nanoTime()
        val ready = encoded[key]
        val hit = ready != null || n in cache
        if (ready == null && n !in cache) decodeInto(d, n, if (dir < 0) maxOf(d.keyFrameOf(n), n - CACHE_FRAMES + 2) else n)
        val t1 = System.nanoTime()
        val bytes = ready ?: encode(cache[n]!!, d.width, d.height, png, quality).also { encoded[key] = it }
        val t2 = System.nanoTime()
        val next = n + dir
        if (dir != 0 && next in 0 until d.frames) exec.execute { prefetch(video, next, dir, png, quality) }
        Frame(n, d.frames, bytes, (t1 - t0) / 1e6, (t2 - t1) / 1e6, hit)
    }

    /** Decode the tiles of a recording's preview sheets from `thumbs.count` up to `until` (recovery). */
    internal suspend fun fillThumbs(video: File, thumbs: Thumbs, until: Int) = withContext(thread) {
        val d = open(video)
        val tile = Bitmap.createBitmap(d.width, d.height, Bitmap.Config.ARGB_8888)
        while (thumbs.count < until) {
            val n = minOf(thumbs.count * thumbs.every, d.frames - 1)
            val buf = cache[n] ?: run { decodeInto(d, n, n); cache[n]!! }
            buf.rewind()
            tile.copyPixelsFromBuffer(buf)
            val small = Bitmap.createScaledBitmap(tile, thumbs.width, thumbs.height, true)
            thumbs.add(small)
            small.recycle()
        }
        thumbs.flush()
        tile.recycle()
        last = -1
    }

    /** Drop the decoder of a video about to be deleted. */
    fun forget(video: File) {
        exec.submit {
            if (dec?.file == video) close()
        }.get(5, TimeUnit.SECONDS)
    }

    /** Decode and encode the frame after the one just served, unless the client already went elsewhere. */
    private fun prefetch(video: File, n: Int, dir: Int, png: Boolean, quality: Int) {
        val d = dec ?: return
        val key = Key(n, png, quality)
        if (d.file != video || n != last + dir || key in encoded) return
        runCatching {
            if (n !in cache) decodeInto(d, n, if (dir < 0) maxOf(d.keyFrameOf(n), n - CACHE_FRAMES + 2) else n)
            encoded[key] = encode(cache[n]!!, d.width, d.height, png, quality)
        }.onFailure { Log.w(TAG, "prefetch $n failed", it) }
    }

    private fun decodeInto(d: Decoder, n: Int, keepFrom: Int) {
        d.decode(n, keepFrom) { i, pixels ->
            val b = cache.remove(i) ?: pool.removeLastOrNull() ?: ByteBuffer.allocateDirect(d.width * d.height * 4).order(ByteOrder.nativeOrder())
            b.clear()
            b.put(pixels)
            b.flip()
            cache[i] = b
        }
    }

    private fun encode(buf: ByteBuffer, w: Int, h: Int, png: Boolean, quality: Int): ByteArray {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        buf.rewind()
        bmp.copyPixelsFromBuffer(buf)
        val out = ByteArrayOutputStream(if (png) 1 shl 20 else 256 * 1024)
        bmp.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, quality, out)
        bmp.recycle()
        return out.toByteArray()
    }

    private fun open(video: File): Decoder {
        used = System.nanoTime()
        dec?.let { if (it.file == video && it.stamp == video.lastModified()) return it }
        close()
        check(video.isFile) { "no video: $video" }
        val g = gl ?: Gl().also { gl = it }
        val d = Decoder(video, g, Handler(callbacks.looper))
        dec = d
        exec.schedule(::closeIfIdle, IDLE_MS, TimeUnit.MILLISECONDS)
        return d
    }

    private fun closeIfIdle() {
        if (dec == null) return
        if (System.nanoTime() - used >= IDLE_MS * 1_000_000) close()
        else exec.schedule(::closeIfIdle, IDLE_MS, TimeUnit.MILLISECONDS)
    }

    private fun close() {
        dec?.close()
        dec = null
        cache.values.forEach { pool.add(it) }
        cache.clear()
        pool.clear()
        encoded.clear()
        last = -1
    }

    /** Decoder state for one video; decoder thread only. */
    private class Decoder(val file: File, private val gl: Gl, handler: Handler) : Closeable {
        val stamp = file.lastModified()
        private val extractor = MediaExtractor().apply { setDataSource(file.path) }
        private val codec: MediaCodec
        val width: Int
        val height: Int
        private val pts: LongArray // per sample (decode order = display order: the recorder never makes B-frames)
        private val sync: BooleanArray
        private val sampleOfFrame: IntArray
        val frames: Int
        private val pbuffer: EGLSurface
        private val quad: ExternalQuad
        private val texture: SurfaceTexture
        private val surface: Surface
        private val pixels: ByteBuffer
        private val lock = Object()
        private var available = false
        private var next = 0 // next sample to queue
        private var lastOut = -1 // last sample the decoder put out
        private var eos = false
        private val info = MediaCodec.BufferInfo()

        init {
            val track = (0 until extractor.trackCount).first {
                extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)!!.startsWith("video/")
            }
            extractor.selectTrack(track)
            val format = extractor.getTrackFormat(track)
            width = format.getInteger(MediaFormat.KEY_WIDTH)
            height = format.getInteger(MediaFormat.KEY_HEIGHT)
            val p = ArrayList<Long>(6000)
            val s = ArrayList<Boolean>(6000)
            while (extractor.sampleTime >= 0) {
                p.add(extractor.sampleTime)
                s.add(extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0)
                extractor.advance()
            }
            check(p.isNotEmpty()) { "empty video: $file" }
            pts = p.toLongArray()
            sync = s.toBooleanArray()
            val fps = if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) format.getInteger(MediaFormat.KEY_FRAME_RATE) else Recordings.FPS
            val frameOf = IntArray(pts.size) { ((pts[it] - pts[0]) * fps / 1_000_000.0).roundToInt() }
            frames = frameOf.last() + 1
            // frame -> sample; a frame the encoder skipped shows the sample before it
            sampleOfFrame = IntArray(frames)
            var j = 0
            for (f in 0 until frames) {
                while (j + 1 < pts.size && frameOf[j + 1] <= f) j++
                sampleOfFrame[f] = j
            }
            extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)

            pbuffer = gl.pbuffer(width, height)
            gl.makeCurrent(pbuffer)
            quad = ExternalQuad()
            texture = SurfaceTexture(quad.texture)
            texture.setOnFrameAvailableListener({
                synchronized(lock) {
                    available = true
                    lock.notifyAll()
                }
            }, handler)
            surface = Surface(texture)
            pixels = ByteBuffer.allocateDirect(width * height * 4).order(ByteOrder.nativeOrder())
            format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
            codec.configure(format, surface, null, 0)
            codec.start()
        }

        fun keyFrameOf(frame: Int): Int {
            var s = sampleOfFrame[frame]
            while (s > 0 && !sync[s]) s--
            return frameOfSample(s)
        }

        /**
         * Decode up to `frame`, handing the pixels (RGBA, rows top first) of every frame in keepFrom..frame to sink.
         */
        fun decode(frame: Int, keepFrom: Int, sink: (Int, ByteBuffer) -> Unit) {
            gl.makeCurrent(pbuffer)
            val target = sampleOfFrame[frame]
            val keepSample = sampleOfFrame[keepFrom]
            var key = target
            while (key > 0 && !sync[key]) key--
            // restart at the key frame when going back (or to what was already put out), when the target lies behind
            // a key frame not queued yet (cheaper than decoding up to it), or to re-read frames to keep
            if (target <= lastOut || key > next || keepSample <= lastOut) {
                val from = minOf(key, keepSample.let { var k = it; while (k > 0 && !sync[k]) k--; k })
                codec.flush()
                extractor.seekTo(pts[from], MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                next = from
                lastOut = from - 1
                eos = false
            }
            val deadline = System.nanoTime() + 5_000_000_000L
            while (true) {
                if (!eos) {
                    val ii = codec.dequeueInputBuffer(0)
                    if (ii >= 0) {
                        if (next < pts.size) {
                            val n = extractor.readSampleData(codec.getInputBuffer(ii)!!, 0)
                            codec.queueInputBuffer(ii, 0, n, extractor.sampleTime, 0)
                            extractor.advance()
                            next++
                        } else {
                            codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            eos = true
                        }
                    }
                }
                val oi = codec.dequeueOutputBuffer(info, 2_000)
                if (oi >= 0) {
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0 && info.size == 0) {
                        codec.releaseOutputBuffer(oi, false)
                        error("decoder ended before frame $frame")
                    }
                    val s = sampleAt(info.presentationTimeUs)
                    lastOut = s
                    val keep = s in keepSample..target
                    codec.releaseOutputBuffer(oi, keep)
                    if (keep) {
                        awaitImage()
                        texture.updateTexImage()
                        quad.draw(texture, width, height, flip = true)
                        readPixels(width, height, pixels)
                        // every frame showing this sample (normally just one)
                        for (f in maxOf(keepFrom, frameOfSample(s))..frame) {
                            if (sampleOfFrame[f] != s) break
                            pixels.rewind()
                            sink(f, pixels)
                        }
                    }
                    if (s >= target) return
                }
                check(System.nanoTime() < deadline) { "decoding frame $frame timed out" }
            }
        }

        private fun frameOfSample(s: Int): Int {
            // sampleOfFrame is non-decreasing: binary search for the first frame showing sample s
            var lo = 0
            var hi = frames - 1
            while (lo < hi) {
                val mid = (lo + hi) / 2
                if (sampleOfFrame[mid] < s) lo = mid + 1 else hi = mid
            }
            return lo
        }

        private fun sampleAt(us: Long): Int {
            val i = pts.binarySearch(us)
            if (i >= 0) return i
            val ins = -i - 1
            return when {
                ins <= 0 -> 0
                ins >= pts.size -> pts.size - 1
                us - pts[ins - 1] <= pts[ins] - us -> ins - 1
                else -> ins
            }
        }

        private fun awaitImage() {
            synchronized(lock) {
                val end = System.nanoTime() + 1_000_000_000L
                while (!available) {
                    val left = (end - System.nanoTime()) / 1_000_000
                    check(left > 0) { "decoded frame did not arrive" }
                    lock.wait(left)
                }
                available = false
            }
        }

        override fun close() {
            runCatching { codec.stop() }
            runCatching { codec.release() }
            extractor.release()
            surface.release()
            texture.release()
            quad.release()
            gl.release(pbuffer)
        }
    }

    companion object {
        const val TAG = "MaaLowFrames"
        /** Decoded frames kept (RGBA, 3 MB each at 1080x720): a GOP (30) and some. */
        const val CACHE_FRAMES = 40
        /** Encoded frames kept (served and prefetched ones). */
        const val ENCODED_FRAMES = 16
        const val IDLE_MS = 120_000L
    }
}
