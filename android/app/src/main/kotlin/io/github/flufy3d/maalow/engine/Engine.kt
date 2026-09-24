package io.github.flufy3d.maalow.engine

import android.content.Context
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import android.util.Log
import io.github.flufy3d.maalow.IPrivileged
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * Owns the capture/input pipeline and MaaFramework instances. Device operations run one at a time on the
 * engine thread; frame snapshots do not touch that thread.
 */
class Engine(private val context: Context) {
    private val thread = Executors.newSingleThreadExecutor { Thread(it, "maalow-engine") }.asCoroutineDispatcher()

    enum class State { STOPPED, STARTING, RUNNING, ERROR }

    @Volatile var state = State.STOPPED
        private set
    @Volatile var error: String? = null
        private set
    var width = 0
        private set
    var height = 0
        private set

    val workspaces = File(context.getExternalFilesDir(null), "workspaces").apply { mkdirs() }
    private val nativeLibDir = context.applicationInfo.nativeLibraryDir

    private var priv: IPrivileged? = null
    private var mirrorId = -1
    private var controller = 0L
    private var loaded: Loaded? = null

    private class Loaded(val name: String, val stamp: Long, val resource: Long, val tasker: Long)

    suspend fun <T> onEngine(block: () -> T): T = withContext(thread) { block() }

    suspend fun start() {
        if (state == State.RUNNING || state == State.STARTING) return
        state = State.STARTING
        error = null
        try {
            val s = ShizukuLink.bind { onPrivilegedDied() }
            onEngine { setUp(s) }
            state = State.RUNNING
        } catch (e: Throwable) {
            Log.e(TAG, "engine start failed", e)
            error = "${e.javaClass.simpleName}: ${e.message}"
            onEngine { tearDown() }
            state = State.ERROR
        }
    }

    suspend fun stop() {
        onEngine { tearDown() }
        ShizukuLink.unbind()
        state = State.STOPPED
    }

    private fun onPrivilegedDied() {
        Log.w(TAG, "privileged service died")
        error = "Shizuku 服务已断开"
        state = State.ERROR
    }

    private fun setUp(s: IPrivileged) {
        priv = s
        val (lw, lh) = s.displayInfo()
        val long = maxOf(lw, lh)
        val short = minOf(lw, lh)
        height = SHORT_SIDE
        width = (SHORT_SIDE.toDouble() * long / short).roundToInt()

        val surface = Bridge.nativeCreate(width, height) ?: error("AImageReader creation failed")
        mirrorId = s.mirror(surface, width, height, "maalow-capture")
        check(mirrorId > 0) { "display mirror failed" }

        val a = java.io.FileDescriptor()
        val b = java.io.FileDescriptor()
        Os.socketpair(OsConstants.AF_UNIX, OsConstants.SOCK_SEQPACKET, 0, a, b)
        Bridge.nativeSetInputFd(ParcelFileDescriptor.dup(a).detachFd())
        ParcelFileDescriptor.dup(b).use { s.attachInput(it, width, height) }
        Os.close(a)
        Os.close(b)

        Maa.setLogDir(File(context.getExternalFilesDir(null), "maa-log").apply { mkdirs() }.absolutePath)
        val config = buildJsonObject {
            put("library_path", "$nativeLibDir/lib${Bridge.LIBRARY}.so")
            put("screen_resolution", buildJsonObject { put("width", width); put("height", height) })
        }
        controller = Maa.controllerCreateNative(config.toString())
        check(controller != 0L) { "MaaAndroidNativeControllerCreate failed" }
        Maa.controllerUseRawSize(controller)
        check(Maa.controllerConnect(controller)) { "controller connect failed" }
        Log.i(TAG, "engine up: ${width}x$height, maa ${Maa.version()}")
    }

    private fun tearDown() {
        loaded?.let { Maa.taskerDestroy(it.tasker); Maa.resourceDestroy(it.resource) }
        loaded = null
        if (controller != 0L) Maa.controllerDestroy(controller)
        controller = 0L
        if (mirrorId > 0) runCatching { priv?.release(mirrorId) }
        mirrorId = -1
        Bridge.nativeDestroy()
        priv = null
    }

    fun privileged(): IPrivileged = priv ?: error("engine not running")

    private fun requireRunning() = check(state == State.RUNNING && controller != 0L) { "engine not running" }

    // ---- frames

    /** JPEG of the latest frame; returns (seq, bytes). Does not wait for the engine thread. */
    fun snapshotJpeg(quality: Int = 85): Pair<Long, ByteArray> {
        requireRunning()
        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val seq = Bridge.nativeSnapshot(bmp, 2000)
        check(seq > 0) { "no frame available" }
        val out = ByteArrayOutputStream(256 * 1024)
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        bmp.recycle()
        return seq to out.toByteArray()
    }

    fun snapshotPng(): Pair<Long, ByteArray> {
        requireRunning()
        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val seq = Bridge.nativeSnapshot(bmp, 2000)
        check(seq > 0) { "no frame available" }
        val out = ByteArrayOutputStream(1024 * 1024)
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        return seq to out.toByteArray()
    }

    // ---- actions (engine thread)

    suspend fun act(action: JsonObject): Boolean = onEngine {
        requireRunning()
        fun i(k: String, d: Int = 0) = action[k]?.jsonPrimitive?.int ?: d
        val c = controller
        when (val type = action["type"]?.jsonPrimitive?.content) {
            "click" -> Maa.controllerClick(c, i("x"), i("y"))
            "long_press" -> Maa.controllerTouch(c, 0, 0, i("x"), i("y")).also { Thread.sleep(i("ms", 800).toLong()) } &&
                Maa.controllerTouch(c, 2, 0, i("x"), i("y"))
            "swipe" -> Maa.controllerSwipe(c, i("x1"), i("y1"), i("x2"), i("y2"), i("duration", 300))
            "touch" -> Maa.controllerTouch(c, when (action["op"]?.jsonPrimitive?.content) {
                "down" -> 0; "move" -> 1; else -> 2
            }, i("contact"), i("x"), i("y"))
            "key" -> Maa.controllerKey(c, i("code"))
            "back" -> Maa.controllerKey(c, 4)
            "home" -> Maa.controllerKey(c, 3)
            "wake" -> Maa.controllerKey(c, 224)
            "text" -> Maa.controllerInputText(c, action["text"]!!.jsonPrimitive.content)
            "start_app" -> Maa.controllerStartApp(c, action["package"]!!.jsonPrimitive.content)
            "stop_app" -> Maa.controllerStopApp(c, action["package"]!!.jsonPrimitive.content)
            "wait" -> true.also { Thread.sleep(i("ms", 1000).toLong()) }
            else -> error("unknown action type: $type")
        }
    }

    // ---- pipeline (engine thread)

    private fun stampOf(ws: File): Long =
        listOf("pipeline", "templates").flatMap { File(ws, it).walkTopDown().filter { f -> f.isFile }.toList() }
            .maxOfOrNull { it.lastModified() } ?: 0

    /** Resource + tasker for a workspace, reloaded when its pipeline or templates change. */
    private fun load(name: String): Loaded {
        val ws = File(workspaces, name)
        check(File(ws, "workspace.json").isFile) { "no workspace: $name" }
        val stamp = stampOf(ws)
        loaded?.let { if (it.name == name && it.stamp == stamp) return it }
        val res = Maa.resourceCreate()
        val ok = Maa.resourceLoad(res, 1, File(ws, "pipeline").absolutePath) &&
            Maa.resourceLoad(res, 2, File(ws, "templates").absolutePath)
        if (!ok) {
            Maa.resourceDestroy(res)
            error("failed to load resources of $name")
        }
        val tasker = Maa.taskerCreate()
        check(Maa.taskerBind(tasker, res, controller)) { "failed to bind tasker" }
        loaded?.let { Maa.taskerDestroy(it.tasker); Maa.resourceDestroy(it.resource) }
        return Loaded(name, stamp, res, tasker).also { loaded = it }
    }

    private fun override(node: String, once: Boolean, stop: Boolean) = buildJsonObject {
        put(node, buildJsonObject {
            if (once) put("timeout", 0)
            if (stop) put("next", buildJsonArray { })
        })
    }.toString()

    private fun summarize(detail: String): JsonObject {
        val d = Json.parseToJsonElement(detail).jsonObject
        val nodes = d["nodes"]!!.jsonArray
        val hit = d["status"]!!.jsonPrimitive.int == Maa.STATUS_SUCCEEDED && nodes.isNotEmpty() &&
            nodes.last().jsonObject["completed"]!!.jsonPrimitive.boolean
        return buildJsonObject {
            put("hit", hit)
            put("status", d["status"]!!)
            put("nodes", buildJsonArray { nodes.forEach { add(it.jsonObject["name"]!!) } })
        }
    }

    /** Run a pipeline node on the device. once: check the current screen only; stop: don't follow next. */
    suspend fun run(workspace: String, node: String, once: Boolean, stop: Boolean = false): JsonObject = onEngine {
        requireRunning()
        val l = load(workspace)
        summarize(Maa.taskerRun(l.tasker, node, override(node, once, stop)))
    }

    /** Would this node fire on the given image? Runs offline against an image controller; touches no device. */
    suspend fun check(workspace: String, node: String, image: File): JsonObject = onEngine {
        val l = load(workspace)
        val ic = Maa.imageControllerCreate(image.absolutePath)
        check(ic != 0L) { "cannot read ${image.name}" }
        try {
            val ctrl = Maa.imageControllerGet(ic)
            Maa.controllerUseRawSize(ctrl)
            check(Maa.controllerConnect(ctrl)) { "image controller connect failed" }
            val tasker = Maa.taskerCreate()
            try {
                check(Maa.taskerBind(tasker, l.resource, ctrl)) { "failed to bind tasker" }
                summarize(Maa.taskerRun(tasker, node, override(node, once = true, stop = true)))
            } finally {
                Maa.taskerDestroy(tasker)
            }
        } finally {
            Maa.imageControllerDestroy(ic)
        }
    }

    /** Timing of n Maa screencaps through the bridge, in ms. */
    suspend fun bench(n: Int): JsonObject = onEngine {
        requireRunning()
        val times = (1..n).map {
            val t0 = System.nanoTime()
            check(Maa.controllerScreencap(controller)) { "screencap failed" }
            (System.nanoTime() - t0) / 1e6
        }.sorted()
        buildJsonObject {
            put("n", n)
            put("min_ms", times.first())
            put("median_ms", times[times.size / 2])
            put("max_ms", times.last())
        }
    }

    companion object {
        const val TAG = "MaaLowEngine"
        const val SHORT_SIDE = 720
    }
}
