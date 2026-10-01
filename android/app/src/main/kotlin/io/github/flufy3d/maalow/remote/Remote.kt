package io.github.flufy3d.maalow.remote

import android.app.KeyguardManager
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.util.Xml
import android.view.Surface
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.store.optBool
import io.github.flufy3d.maalow.store.optInt
import io.github.flufy3d.maalow.store.optStr
import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.xmlpull.v1.XmlPullParser
import java.io.StringReader
import java.nio.ByteBuffer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

/**
 * Remote view and control from the web UI's remote stage, over the WebSocket /api/v1/remote. Not a teaching mode:
 * nothing of it goes into the chat or is recorded.
 *
 * Viewing: the privileged process mirrors the display straight into a hardware H.264 encoder's input surface (no GL in
 * between), at the recognition frame size, 30 fps at most; the Annex-B output goes to every connected page, which
 * decodes it with WebCodecs. A mirror only delivers frames when the screen changes, so a still screen costs next to
 * nothing. It runs only while some page shows the stage; its mirror is the one extra besides recognition's, so the
 * remote view and recording exclude each other ([App.claimMirror]). A page that falls behind gets no more frames until
 * the next key frame, and the bit rate goes down (1–10 Mbps, back up while the network keeps up): never a queue.
 *
 * Control: one page at a time. Taking it stops what runs (as the teacher's stop does) and takes the device lock as
 * [OWNER]; meanwhile AI actions are refused ("teacher has control"), guards do not get the lock and schedules skip.
 * Its touches go straight to the privileged process's injector as contacts [CONTACT_BASE] and up, not through Maa.
 * Released by the page, the tablet's notification, the connection closing, two missed heartbeats' worth of silence
 * ([HEARTBEAT_MS]) or [IDLE_MS] without input; every release lifts the remote touches still down.
 *
 * The lock screen's password pad is a secure window, black in any mirror; while it may be up, the pages get its controls
 * from the accessibility tree instead ([readLayout]) and draw them where they are, so it can be tapped blind.
 */
class Remote(private val app: App) {
    private val clients = CopyOnWriteArrayList<Client>() // changed under [frames]
    private val frames = Any() // frame delivery, the key frame cache and joining pages
    private val streamLock = Any()
    @Volatile private var stream: Stream? = null
    @Volatile private var blocked: String? = null // why there is no picture
    private var watcher: Job? = null
    private var look: List<Any?> = emptyList() // what the pages were last told about the device
    @Volatile private var layout: JsonObject = emptyLayout() // {t: "layout", nodes, typed}: the password pad, for the pages
    private var layoutJob: Job? = null
    private val dumping = Mutex()

    private val ctl = Mutex()
    @Volatile private var controller: Client? = null
    @Volatile private var lastInput = 0L
    private val input = Executors.newSingleThreadExecutor { Thread(it, "maalow-remote-input") }.asCoroutineDispatcher()
    private val down = HashSet<Int>() // remote contacts held down; input thread only

    data class Status(val viewers: Int, val controlled: Boolean)

    private val statusFlow = MutableStateFlow(Status(0, false))

    /** Viewers and control, for the app's notification. */
    val status: StateFlow<Status> = statusFlow

    /** A page has control of the device. */
    val controlling: Boolean get() = controller != null

    /** For /status. */
    fun json(): JsonObject = buildJsonObject {
        put("viewers", clients.size)
        put("controlled", controlling)
        put("streaming", stream != null)
        stream?.let { put("bitrate", it.bitrate) }
    }

    // ---- a connected page

    private inner class Client(val session: DefaultWebSocketServerSession) {
        val queue = Channel<Frame>(Channel.UNLIMITED)
        val queued = AtomicLong() // bytes handed to the queue and not yet to the socket
        @Volatile var waitKey = false // behind: nothing until the next key frame
        @Volatile var seen = SystemClock.elapsedRealtime()

        fun send(f: Frame) {
            queued.addAndGet(f.data.size.toLong())
            queue.trySend(f)
        }

        fun json(o: JsonObject) = send(Frame.Text(o.toString()))

        fun error(msg: String) = json(buildJsonObject { put("t", "error"); put("message", msg) })

        fun notice(msg: String) = json(buildJsonObject { put("t", "notice"); put("message", msg) })

        /** One video frame; false when this page is behind (it then waits for a key frame). */
        fun video(packet: ByteArray, key: Boolean): Boolean {
            val limit = maxOf(MIN_BACKLOG, (stream?.bitrate ?: DEFAULT_BITRATE) / 16L) // half a second
            if (queued.get() > limit) {
                waitKey = true
                return false
            }
            if (waitKey && !key) return true
            waitKey = false
            send(Frame.Binary(true, packet))
            return true
        }
    }

    /** The WebSocket of one page, from its hello to its close. */
    suspend fun serve(s: DefaultWebSocketServerSession) {
        val hello = withTimeoutOrNull(HELLO_MS) { s.incoming.receiveCatching().getOrNull() } as? Frame.Text
        val h = hello?.let { runCatching { Json.parseToJsonElement(it.readText()).jsonObject }.getOrNull() }
        if (h?.optStr("t") != "hello" || h.optStr("token") != app.token) {
            s.close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "bad hello"))
            return
        }
        val c = Client(s)
        val sender = s.launch {
            for (f in c.queue) {
                s.outgoing.send(f)
                c.queued.addAndGet(-f.data.size.toLong())
            }
        }
        join(c)
        try {
            for (f in s.incoming) {
                if (f !is Frame.Text) continue
                c.seen = SystemClock.elapsedRealtime()
                try {
                    handle(c, Json.parseToJsonElement(f.readText()).jsonObject)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    c.error(e.message ?: e.javaClass.simpleName)
                }
            }
        } finally {
            withContext(NonCancellable) { leave(c) }
            sender.cancel()
        }
    }

    private suspend fun handle(c: Client, m: JsonObject) {
        when (m.optStr("t")) {
            "ping" -> c.json(buildJsonObject { put("t", "pong"); m["ts"]?.let { put("ts", it) } })
            "take" -> take(c, m.optBool("force") == true)
            "release" -> release(c, null)
            "touch" -> touch(c, m)
            "key" -> key(c, m.optStr("code").orEmpty())
            "keyframe" -> { // the page's decoder failed: start it again from a key frame
                c.waitKey = true
                stream?.requestKey()
            }
        }
    }

    private fun join(c: Client) {
        synchronized(frames) {
            clients.add(c)
            stream?.let { s -> s.config?.let { c.json(it); s.replay(c) } }
            if (layout != emptyLayout()) c.json(layout)
        }
        stream?.requestKey()
        synchronized(this) { if (watcher == null) watcher = app.scope.launch { watch() } }
        ensureStream()
        publish()
        broadcastState()
    }

    private suspend fun leave(c: Client) {
        val gone = synchronized(frames) { clients.remove(c) }
        if (!gone) return
        c.queue.close()
        release(c, null)
        if (clients.isEmpty()) stopStream()
        publish()
        broadcastState()
    }

    // ---- the picture

    private fun ensureStream() {
        synchronized(streamLock) {
            if (stream != null || clients.isEmpty()) return
            if (app.engine.state != Engine.State.RUNNING) return setBlocked("引擎没有运行")
            try {
                app.claimMirror("remote")
            } catch (e: IllegalStateException) {
                return setBlocked(e.message)
            }
            var s: Stream? = null
            try {
                s = Stream(app.engine.width, app.engine.height, app.engine.privileged().displayInfo()[2])
                s.begin()
            } catch (e: Throwable) {
                Log.e(TAG, "remote stream failed", e)
                s?.halt()
                app.releaseMirror("remote")
                return setBlocked("远程画面开不了：${e.message}")
            }
            stream = s
        }
        setBlocked(null)
    }

    private fun stopStream() {
        synchronized(streamLock) {
            stream?.halt()
            stream = null
            app.releaseMirror("remote")
        }
    }

    private fun setBlocked(why: String?) {
        if (why == blocked) return
        blocked = why
        broadcastState()
    }

    /** The engine (or the privileged process) went away: drop the picture and control; the watcher brings it back. */
    fun engineGone() {
        app.scope.launch {
            stopStream()
            release(null, "引擎断开了，已释放控制权")
        }
    }

    /** Delivers one encoder output frame to every page (drain thread). */
    private fun deliver(s: Stream, packet: ByteArray, key: Boolean) {
        var behind = false
        synchronized(frames) {
            s.cache(packet, key)
            for (c in clients) if (!c.video(packet, key)) behind = true
        }
        s.sent++
        if (behind) s.congested()
    }

    private fun broadcast(f: Frame.Text) {
        synchronized(frames) { clients.forEach { it.send(f) } }
    }

    /** The display mirrored into a hardware encoder; its output goes to [deliver]. */
    private inner class Stream(val width: Int, val height: Int, val rotation: Int) {
        @Volatile var bitrate = DEFAULT_BITRATE
            private set
        @Volatile var config: JsonObject? = null // {t: "config", width, height, codec}, once the encoder said
            private set
        @Volatile var sent = 0L
        private val codec = MediaCodec.createEncoderByType(MIME)
        private var surface: Surface? = null
        private var mirror = -1
        private var drain: Thread? = null
        @Volatile private var halted = false
        private var csd = ByteArray(0) // SPS + PPS, put in front of every key frame
        private val gop = ArrayList<ByteArray>() // since the last key frame, for pages joining a still screen
        private var gopBytes = 0L
        private var lastDown = 0L
        private var lastCongestion = 0L
        private var lastRaise = 0L
        private var sentAtRaise = 0L

        fun begin() {
            val format = MediaFormat.createVideoFormat(MIME, width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
                setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, FPS.toFloat()) // the display may run at 120 Hz
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, GOP_S) // long: new pages ask for a key frame
                setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, REPEAT_US) // so a still screen can still send one
                setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                setInteger(MediaFormat.KEY_PRIORITY, 0) // realtime
                setInteger(MediaFormat.KEY_LATENCY, 1)
            }
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val input = codec.createInputSurface()
            surface = input
            codec.start()
            drain = Thread(::drainLoop, "maalow-remote-out").apply { start() }
            mirror = app.engine.privileged().mirror(input, width, height, "maalow-remote")
            check(mirror > 0) { "镜像创建失败" }
            Log.i(TAG, "remote stream ${width}x$height @$FPS ${bitrate / 1000} kbps, rotation $rotation")
        }

        private fun drainLoop() {
            val info = MediaCodec.BufferInfo()
            try {
                while (!halted) {
                    val i = codec.dequeueOutputBuffer(info, 100_000)
                    if (i < 0) continue
                    val buf = codec.getOutputBuffer(i)!!
                    val bytes = ByteArray(info.size)
                    buf.position(info.offset)
                    buf.get(bytes)
                    codec.releaseOutputBuffer(i, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        csd = bytes
                        val cfg = buildJsonObject {
                            put("t", "config")
                            put("width", width)
                            put("height", height)
                            put("codec", avcCodec(bytes))
                        }
                        config = cfg
                        broadcast(Frame.Text(cfg.toString()))
                        continue
                    }
                    if (bytes.isEmpty()) continue
                    val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                    deliver(this, packet(if (key) csd + bytes else bytes, key, info.presentationTimeUs), key)
                }
            } catch (e: Exception) {
                if (!halted) Log.e(TAG, "remote encoder output failed", e)
            }
        }

        /** Keep the frames since the last key frame (under [frames]), as long as they stay small. */
        fun cache(packet: ByteArray, key: Boolean) {
            if (key) {
                gop.clear()
                gopBytes = 0
            } else if (gop.isEmpty()) return
            gopBytes += packet.size
            if (gopBytes > GOP_CACHE_MAX) gop.clear() else gop.add(packet)
        }

        /** A page joined (under [frames]): what it needs to show the screen now. */
        fun replay(c: Client) = gop.forEach { c.send(Frame.Binary(true, it)) }

        fun requestKey() = params { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }

        /** A page fell behind: less data from now on, and a key frame for it to start again from. */
        fun congested() {
            val now = SystemClock.elapsedRealtime()
            lastCongestion = now
            if (now - lastDown < 1000) return
            lastDown = now
            setBitrate(maxOf(MIN_BITRATE, (bitrate * 0.7).roundToInt()))
            requestKey()
        }

        /** Every tick: the network kept up for a while and frames flowed, so try a little more. */
        fun adapt(now: Long) {
            if (bitrate >= MAX_BITRATE || now - lastCongestion < RAISE_AFTER_MS || now - lastRaise < RAISE_AFTER_MS) return
            if (sent - sentAtRaise < FPS * 2) return
            lastRaise = now
            sentAtRaise = sent
            setBitrate(minOf(MAX_BITRATE, bitrate + BITRATE_STEP))
        }

        private fun setBitrate(b: Int) {
            if (b == bitrate) return
            bitrate = b
            params { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, b) }
        }

        private fun params(fill: Bundle.() -> Unit) {
            if (halted) return
            runCatching { codec.setParameters(Bundle().apply(fill)) }
        }

        fun halt() {
            halted = true
            if (mirror > 0) runCatching { app.engine.privilegedOrNull()?.release(mirror) }
            mirror = -1
            drain?.join(1000)
            runCatching { codec.stop() }
            runCatching { codec.release() }
            surface?.release()
            Log.i(TAG, "remote stream stopped after $sent frames")
        }
    }

    // ---- control

    private suspend fun take(c: Client, force: Boolean) {
        ctl.withLock {
            val cur = controller
            if (cur === c) return
            check(app.engine.state == Engine.State.RUNNING) { "引擎没有运行" }
            if (cur != null) {
                check(force) { "另一个网页正在操控" }
                controller = c
                lastInput = SystemClock.elapsedRealtime()
                liftAll()
                cur.notice("另一个网页抢过了控制权，你现在只能观看")
            } else {
                app.teaching.interrupt()
                check(app.engine.hold(OWNER, TAKE_WAIT_MS)) { "拿不到设备锁：${app.engine.busy ?: "设备忙"} 还没结束" }
                controller = c
                lastInput = SystemClock.elapsedRealtime()
            }
        }
        app.events.post("remote") { put("control", "teacher") }
        publish()
        broadcastState()
    }

    /** Give control back (c: only if it is the one holding it; null: whoever does), telling it why. */
    private suspend fun release(c: Client?, why: String?) {
        ctl.withLock {
            val cur = controller ?: return
            if (c != null && cur !== c) return
            controller = null
            liftAll()
            app.engine.unhold(OWNER)
            why?.let { cur.notice(it) }
        }
        app.events.post("remote") { put("control", "released") }
        publish()
        broadcastState()
    }

    /** The tablet's notification: take control back from the web page. */
    fun reclaim() {
        app.scope.launch { release(null, "平板上收回了控制权") }
    }

    private suspend fun touch(c: Client, m: JsonObject) {
        if (controller !== c) return // viewing: input is dropped
        lastInput = SystemClock.elapsedRealtime()
        val action = when (m.optStr("a")) {
            "down" -> 0
            "move" -> 1
            "up" -> 2
            else -> return
        }
        val contact = CONTACT_BASE + (m.optInt("id") ?: 0).coerceIn(0, MAX_TOUCHES - 1)
        val x = num(m, "x")
        val y = num(m, "y")
        withContext(input) {
            if (action != 2 && controller !== c) return@withContext // released meanwhile: its touches were lifted
            if (action == 0) down.add(contact) else if (action == 2 && !down.remove(contact)) return@withContext
            runCatching { app.engine.privilegedOrNull()?.remoteTouch(action, contact, x, y, app.engine.width, app.engine.height) }
            padTouch(action, contact, x, y)
        }
    }

    private suspend fun key(c: Client, code: String) {
        if (controller !== c) return
        val k = KEYS[code] ?: throw IllegalArgumentException("unknown key: $code")
        lastInput = SystemClock.elapsedRealtime()
        withContext(input) { runCatching { app.engine.privilegedOrNull()?.remoteKey(k) } }
    }

    private suspend fun liftAll() = withContext(input) {
        val p = app.engine.privilegedOrNull()
        for (contact in down) runCatching { p?.remoteTouch(2, contact, 0, 0, app.engine.width, app.engine.height) }
        down.clear()
    }

    private fun num(m: JsonObject, k: String): Int =
        (m[k] as? JsonPrimitive)?.content?.toDoubleOrNull()?.roundToInt() ?: throw IllegalArgumentException("touch needs $k")

    // ---- the password pad: drawn from its controls, since the picture of it is black

    private val pad = Any() // the fields below
    private var padNodes: List<JsonObject> = emptyList() // as last read
    private var typed = 0 // digits tapped from the pages since the field was last seen empty: the pad does not show them
    private var lastPadTap = 0L
    private val padDown = HashMap<Int, Pair<JsonObject, Long>>() // contact -> the control it went down on, and when

    /**
     * Every tick: while the screen is on and locked with a password, read the pad's controls. Once it is not (unlocked,
     * off), the pages drop the pad at once; the dump under way is thrown away when it returns (its job is cancelled).
     */
    private fun ensureLayout(on: Boolean, locked: Boolean) {
        synchronized(this) {
            if (on && locked && app.engine.state == Engine.State.RUNNING) {
                if (layoutJob?.isActive != true) layoutJob = app.scope.launch { readLayout() }
                return
            }
            layoutJob?.cancel()
            layoutJob = null
        }
        clearPad()
    }

    private suspend fun readLayout() {
        val me = currentCoroutineContext()[Job]
        try {
            while (clients.isNotEmpty() && screen().let { (on, locked) -> on && locked }) {
                val started = SystemClock.elapsedRealtime()
                runCatching { padLayout() }.getOrNull()?.let { setPad(it, started) } // a failed dump keeps what the pages have
                delay(LAYOUT_MS)
            }
        } finally { // cancelled, its dump may end seconds later (it cannot be stopped): by then a newer job may show a pad
            if (synchronized(this) { (layoutJob === me).also { if (it) layoutJob = null } }) clearPad()
        }
    }

    /**
     * One uiautomator dump (about 2 s, longer while the screen turns off or on): the pad's controls in frame coordinates,
     * none when it is not up; null if it failed. One at a time: a cancelled job's dump still running holds up the next.
     */
    private suspend fun padLayout(): List<JsonObject>? {
        val (_, out) = dumping.withLock { app.engine.shell("timeout 8 uiautomator dump /dev/stdout") }
        val start = out.indexOf("<hierarchy")
        val end = out.lastIndexOf("</hierarchy>")
        if (start < 0 || end < start) return null
        val (lw, lh) = app.engine.privileged().displayInfo()
        return padNodes(out.substring(start, end + "</hierarchy>".length), lw, lh, app.engine.width, app.engine.height)
    }

    /**
     * A new read of the pad. Not guessed ahead from the last one: the pad sits left, middle or right depending on where
     * the swipe up began. One begun a while after the last tap can also tell the field is empty: no pad, or cancel
     * instead of delete. A read finishing just after the unlock is dropped (checked under the lock [clearPad] runs under).
     */
    private fun setPad(nodes: List<JsonObject>, started: Long) {
        synchronized(pad) {
            if (nodes.isNotEmpty() && !screen().let { (on, locked) -> on && locked }) return
            padNodes = nodes
            val settled = started > lastPadTap + PAD_SETTLE_MS // the pad had time to take the last tap in
            if (settled && (nodes.isEmpty() || nodes.any { it.optStr("id") == "cancel_button" })) typed = 0
            show()
        }
    }

    /** Unlocked, off, or no page left: no pad. */
    private fun clearPad() {
        synchronized(pad) {
            padNodes = emptyList()
            typed = 0
            show()
        }
    }

    /** Under [pad]. */
    private fun show() {
        if (padNodes.isEmpty()) padDown.clear()
        sendPad()
    }

    /** A remote touch (input thread) on the pad: digits and deletes counted as the pad will, on the way up like a click. */
    private fun padTouch(action: Int, contact: Int, x: Int, y: Int) {
        synchronized(pad) {
            if (padNodes.isEmpty() || action == 1) return
            val now = SystemClock.elapsedRealtime()
            lastPadTap = now
            if (action == 0) {
                padNodes.firstOrNull { it.optStr("kind") == "tap" && x in it.span("x", "w") && y in it.span("y", "h") }
                    ?.let { padDown[contact] = it to now }
                return
            }
            val (n, at) = padDown.remove(contact) ?: return
            val id = n.optStr("id").orEmpty()
            typed = when {
                DIGIT_KEY.matches(id) -> typed + 1
                id == "delete_button" -> if (now - at >= LONG_PRESS_MS) 0 else maxOf(0, typed - 1)
                id == "key_enter" -> 0
                else -> return
            }
            sendPad()
        }
    }

    private fun JsonObject.span(at: String, len: String): IntRange = (optInt(at) ?: 0).let { it until it + (optInt(len) ?: 0) }

    /** Under [pad]. */
    private fun sendPad() {
        val l = layoutOf(padNodes, typed)
        if (l == layout) return
        layout = l
        broadcast(Frame.Text(l.toString()))
    }

    // ---- state for the pages and the notification

    private fun publish() {
        statusFlow.value = Status(clients.size, controlling)
    }

    private fun screen(): Pair<Boolean, Boolean> {
        val km = app.getSystemService(KeyguardManager::class.java)
        return app.getSystemService(PowerManager::class.java).isInteractive to (km.isKeyguardLocked && km.isDeviceSecure)
    }

    private fun stateFor(c: Client, on: Boolean, locked: Boolean) = buildJsonObject {
        put("t", "state")
        val cur = controller
        put("control", if (cur == null) "none" else if (cur === c) "me" else "other")
        put("can_take", cur == null && app.engine.state == Engine.State.RUNNING)
        put("viewers", clients.size)
        put("screen_on", on)
        put("locked", locked)
        put("engine", app.engine.state.name.lowercase())
        app.engine.busy?.let { put("busy", it) }
        blocked?.let { put("blocked", it) }
        stream?.let { put("bitrate", it.bitrate) }
        put("idle_release_ms", IDLE_MS)
    }

    private fun broadcastState() {
        val (on, locked) = screen()
        look = listOf(on, locked, app.engine.state, app.engine.busy)
        synchronized(frames) { clients.forEach { it.json(stateFor(it, on, locked)) } }
    }

    /** While pages are connected: heartbeats, idle control, the picture (start, rebuild on rotation, bit rate). */
    private suspend fun watch() {
        while (true) {
            delay(TICK_MS)
            synchronized(this) {
                if (clients.isEmpty()) {
                    watcher = null
                    return
                }
            }
            try {
                tick()
            } catch (e: Exception) {
                Log.w(TAG, "remote watcher", e)
            }
        }
    }

    private suspend fun tick() {
        val now = SystemClock.elapsedRealtime()
        for (c in clients) if (now - c.seen > HEARTBEAT_MS) { // network gone, lid closed: as if it had closed
            leave(c)
            c.session.cancel()
        }
        controller?.let { if (now - lastInput > IDLE_MS) release(it, "${IDLE_MS / 60_000} 分钟没有操作，已释放控制权（画面继续看）") }
        val s = stream
        if (s == null) ensureStream()
        else {
            val rotation = runCatching { app.engine.privileged().displayInfo()[2] }.getOrNull()
            if (rotation != null && rotation != s.rotation) {
                stopStream()
                ensureStream()
            } else s.adapt(now)
        }
        val (on, locked) = screen()
        if (listOf(on, locked, app.engine.state, app.engine.busy) != look) broadcastState()
        ensureLayout(on, locked)
    }

    companion object {
        const val TAG = "MaaLowRemote"
        const val OWNER = "remote:teacher"
        const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
        const val FPS = 30
        const val GOP_S = 10
        const val REPEAT_US = 100_000L
        const val DEFAULT_BITRATE = 6_000_000
        const val MIN_BITRATE = 1_000_000
        const val MAX_BITRATE = 10_000_000
        const val BITRATE_STEP = 500_000
        const val RAISE_AFTER_MS = 5_000L
        const val MIN_BACKLOG = 128 * 1024L
        const val GOP_CACHE_MAX = 3L * 1024 * 1024
        const val CONTACT_BASE = 100
        const val MAX_TOUCHES = 10
        const val HELLO_MS = 5_000L
        const val TICK_MS = 500L
        const val HEARTBEAT_MS = 6_000L
        const val IDLE_MS = 2 * 60_000L
        const val TAKE_WAIT_MS = 3_000L
        const val HEADER = 10
        const val LAYOUT_MS = 300L
        const val LONG_PRESS_MS = 500L
        const val PAD_SETTLE_MS = 500L
        val DIGIT_KEY = Regex("key\\d")

        /** Key names from the page -> Android key codes. */
        val KEYS = mapOf("back" to 4, "home" to 3, "recents" to 187, "wakeup" to 224)

        private val BOUNDS = Regex("""\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]""")

        fun emptyLayout() = layoutOf(emptyList(), 0)

        private fun layoutOf(nodes: List<JsonObject>, typed: Int) = buildJsonObject {
            put("t", "layout")
            put("nodes", buildJsonArray { nodes.forEach { add(it) } })
            put("typed", typed)
        }

        /**
         * The controls under the keyguard's security container in a uiautomator dump, mapped like the mirror (aspect
         * fit of the lw x lh display into w x h): {x, y, w, h, id, label, kind}, kind "tap" (keys and buttons, labelled
         * by their content description or the first text inside), "text" (messages) or "field" (the password field).
         */
        fun padNodes(xml: String, lw: Int, lh: Int, w: Int, h: Int): List<JsonObject> {
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
        fun packet(data: ByteArray, key: Boolean, ptsUs: Long): ByteArray =
            ByteBuffer.allocate(HEADER + data.size).put(1).put(if (key) 1 else 0).putLong(ptsUs).put(data).array()

        /** The WebCodecs codec string ("avc1.PPCCLL") from the SPS in Annex-B codec config data. */
        fun avcCodec(csd: ByteArray): String {
            for (i in 0 until csd.size - 6) {
                val start = csd[i].toInt() == 0 && csd[i + 1].toInt() == 0 && csd[i + 2].toInt() == 1
                if (start && csd[i + 3].toInt() and 0x1f == 7) {
                    return "avc1.%02x%02x%02x".format(csd[i + 4].toInt() and 0xff, csd[i + 5].toInt() and 0xff, csd[i + 6].toInt() and 0xff)
                }
            }
            return "avc1.42e01f"
        }
    }
}
