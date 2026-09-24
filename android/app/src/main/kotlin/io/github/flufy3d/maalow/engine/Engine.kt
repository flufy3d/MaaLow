package io.github.flufy3d.maalow.engine

import android.content.Context
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import android.util.Log
import io.github.flufy3d.maalow.IPrivileged
import io.github.flufy3d.maalow.skill.Skills
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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
 * Owns the capture/input pipeline and MaaFramework instances. Maa calls run one at a time on the engine thread;
 * frame snapshots do not touch that thread. Skills are the exception: they run inside a task, on the tasker's
 * thread while the engine thread waits for that task, and call Maa through their context directly. Multi-step
 * device work (a task, a skill, a teaching step, a guard check) holds the device lock so steps from different
 * sources do not interleave.
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
    @Volatile private var loaded: Loaded? = null

    /** Serves the skills registered as custom actions / recognitions. */
    var custom: Maa.Custom? = null

    private class Loaded(val name: String, val stamp: Long, val resource: Long, val tasker: Long) {
        var skills: Set<String> = emptySet() // registered as custom actions / recognitions
    }

    /** Workspace whose resources are loaded: the one a running custom action (skill) belongs to. */
    val loadedWorkspace: String? get() = loaded?.name

    suspend fun <T> onEngine(block: () -> T): T = withContext(thread) { block() }

    private val device = Mutex()

    /** Who holds the device lock, e.g. "task:WhereWindsMeet/DailySignIn"; null when idle. */
    @Volatile var busy: String? = null
        private set

    suspend fun <T> exclusive(owner: String, block: suspend () -> T): T = device.withLock {
        busy = owner
        try {
            block()
        } finally {
            busy = null
        }
    }

    /** Like [exclusive], but returns null at once if the device is busy. */
    suspend fun <T> tryExclusive(owner: String, block: suspend () -> T): T? {
        if (!device.tryLock()) return null
        busy = owner
        try {
            return block()
        } finally {
            busy = null
            device.unlock()
        }
    }

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

        Maa.custom = custom
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

    suspend fun restart() {
        stop()
        start()
    }

    fun privileged(): IPrivileged = priv ?: error("engine not running")

    /** Shell command in the privileged process; returns (exit code, output). */
    suspend fun shell(cmd: String): Pair<Int, String> = withContext(Dispatchers.IO) {
        val out = privileged().exec(cmd)
        val nl = out.indexOf('\n').let { if (it < 0) out.length else it }
        (out.substring(0, nl).removePrefix("exit=").toIntOrNull() ?: -1) to out.substring(minOf(nl + 1, out.length))
    }

    /** Package of the resumed (focused) activity, or null. */
    suspend fun foreground(): String? {
        val (_, out) = shell("dumpsys activity activities | grep -m1 topResumedActivity")
        return Regex("""u\d+ ([\w.]+)/""").find(out)?.groupValues?.get(1)
    }

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

    /** Changes whenever a pipeline, template or model file is added, removed, resized or touched. */
    private fun stampOf(ws: File): Long =
        listOf("pipeline", "templates", "model").flatMap { File(ws, it).walkTopDown().filter { f -> f.isFile }.toList() }
            .sortedBy { it.path }
            .fold(17L) { h, f -> ((h * 31 + f.path.hashCode()) * 31 + f.length()) * 31 + f.lastModified() }

    /**
     * Resource + tasker for a workspace, reloaded when its pipeline or templates change. Skills (skills/<name>.js) are
     * registered on the resource under their names; their code is read fresh on every run.
     */
    private fun load(name: String): Loaded = loadResource(name).also { l ->
        val names = Skills.names(File(workspaces, name)).toSet()
        if (names != l.skills) {
            (l.skills - names).forEach { Maa.resourceUnregisterCustom(l.resource, it) }
            (names - l.skills).forEach { check(Maa.resourceRegisterCustom(l.resource, it)) { "cannot register skill $it" } }
            l.skills = names
        }
    }

    private fun loadResource(name: String): Loaded {
        val ws = File(workspaces, name)
        check(File(ws, "workspace.json").isFile) { "no workspace: $name" }
        val stamp = stampOf(ws)
        loaded?.let { if (it.name == name && it.stamp == stamp) return it }
        val res = Maa.resourceCreate()
        val ocr = File(ws, "model/ocr") // optional PaddleOCR model (det.onnx, rec.onnx, keys.txt)
        val ok = Maa.resourceLoad(res, 1, File(ws, "pipeline").absolutePath) &&
            Maa.resourceLoad(res, 2, File(ws, "templates").absolutePath) &&
            (!ocr.isDirectory || Maa.resourceLoad(res, 3, ocr.absolutePath))
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

    /** Run a pipeline node on the device. once: check the current screen only; stop: don't follow next. */
    suspend fun run(workspace: String, node: String, once: Boolean, stop: Boolean = false): JsonObject = onEngine {
        requireRunning()
        val l = load(workspace)
        summarize(Maa.taskerRun(l.tasker, node, override(node, once, stop)))
    }

    /**
     * Run a skill on the device as a one-node task whose action is the skill ([SKILL_NODE]), so it gets a Maa
     * context just like a skill a pipeline node calls. Blocks the engine thread until the skill returns.
     */
    suspend fun runSkill(workspace: String, name: String, args: JsonElement): JsonObject = onEngine {
        requireRunning()
        val l = load(workspace)
        check(name in l.skills) { "no skill $name in $workspace" }
        val node = buildJsonObject {
            put(SKILL_NODE, buildJsonObject {
                put("recognition", "DirectHit")
                put("action", "Custom")
                put("custom_action", name)
                put("custom_action_param", args)
                put("pre_delay", 0)
                put("post_delay", 0)
            })
        }
        summarize(Maa.taskerRun(l.tasker, SKILL_NODE, node.toString()))
    }

    /** Ask a running task to stop; it ends at the next node boundary. */
    fun stopTask() {
        loaded?.let { Maa.taskerStop(it.tasker) }
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
        /** Entry of the one-node task a standalone skill run is. */
        const val SKILL_NODE = "MaaLow.Skill"

        /** {hit, status, nodes: [names]} from a task detail; hit: it succeeded and its last node completed. */
        fun summarize(detail: String): JsonObject {
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
    }
}
