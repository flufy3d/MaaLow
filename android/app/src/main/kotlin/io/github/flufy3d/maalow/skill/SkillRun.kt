package io.github.flufy3d.maalow.skill

import android.util.Log
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.engine.Bridge
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.engine.Maa
import io.github.flufy3d.maalow.store.optBool
import io.github.flufy3d.maalow.store.optInt
import io.github.flufy3d.maalow.store.optLong
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.readJsonObject
import io.github.flufy3d.maalow.store.str
import io.github.flufy3d.maalow.store.writeAtomic
import io.github.flufy3d.maalow.store.writeJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.Closeable
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** A failed skill call: error {name, message, file, line, column, stack}; reason error | timeout | stopped. */
class SkillError(val error: JsonObject, val reason: String) : RuntimeException(error.optStr("message")) {
    /** "message (skills/x.js:12)" */
    fun describe(): String = listOfNotNull(
        error.optStr("message"),
        error.optStr("file")?.let { f -> "($f${error.optInt("line")?.let { ":$it" }.orEmpty()})" },
    ).joinToString(" ")
}

/**
 * One skill run: a QuickJS runtime and the Maa context the skill acts through (context 0: only loading, as when
 * listing), serving the script's host calls on the thread that runs it. Skills it calls (runSkill) share the runtime;
 * every call has its own deadline, and an outer deadline also bounds the calls inside it.
 */
internal class SkillRun(
    private val app: App,
    private val skills: Skills,
    val workspace: String,
    private val context: Long,
    private val trigger: String,
) : Js.Host, Closeable {
    private val h = Js.create(this, skills.prelude, PRELUDE_NAME)
    private val controller = if (context != 0L) Maa.contextController(context) else 0L
    private val images = LinkedHashMap<Int, Long>() // id -> MaaImageBuffer we own, oldest first
    private val borrowed = HashMap<Int, Long>() // the image a custom recognition was given
    private var nextImage = 1
    private var latest = 0
    private val logs = ArrayDeque<String>()
    private val frames = ArrayList<Frame>()
    private val signal = Object() // wakes pauses on stop / timeout
    @Volatile private var stopped = false
    @Volatile private var inNode = false
    private var closed = false

    /** "workspace/skill" of the outermost call, for /status. */
    @Volatile var label = workspace
        private set

    private inner class Frame(val skill: String, val timeoutMs: Long, parent: Frame?) {
        val deadline: Long = minOf(System.nanoTime() + timeoutMs * 1_000_000, parent?.deadline ?: Long.MAX_VALUE)
        @Volatile var expired = false
        private val timer: ScheduledFuture<*> =
            skills.timer.schedule(Runnable { expire() }, (deadline - System.nanoTime()).coerceAtLeast(0), TimeUnit.NANOSECONDS)

        private fun expire() {
            expired = true
            wake()
        }

        fun cancel() = timer.cancel(false)
    }

    /** End the run: the script gets an uncatchable error at its next step or host call. */
    fun stop() {
        stopped = true
        wake()
    }

    private fun wake() {
        synchronized(this) { if (!closed) Js.interrupt(h, true) }
        synchronized(signal) { signal.notifyAll() }
        if (inNode) app.engine.stopTask() // a nested pipeline task only ends through the tasker
    }

    override fun close() {
        frames.toList().forEach { it.cancel() }
        synchronized(this) {
            closed = true
            Js.destroy(h)
        }
        images.values.forEach { Maa.imageDestroy(it) }
        images.clear()
    }

    // ---- calls

    /** A top-level call, as a result object for the API and the event log. */
    fun top(name: String, export: String, args: JsonElement, ctx: JsonObject, timeoutMs: Long?, image: Long = 0L): JsonObject {
        label = "$workspace/$name"
        if (image != 0L) borrowed[0] = image
        val t0 = System.nanoTime()
        val result = runCatching { invoke(name, export, args, ctx, timeoutMs) }
        val ms = (System.nanoTime() - t0) / 1e6
        val out = buildJsonObject {
            put("workspace", workspace)
            put("skill", name)
            put("trigger", trigger)
            val e = result.exceptionOrNull()
            put("ok", e == null)
            if (e == null) {
                put("value", result.getOrThrow())
            } else {
                val err = e as? SkillError ?: SkillError(buildJsonObject { put("message", "${e.javaClass.simpleName}: ${e.message}") }, "error")
                put("reason", err.reason)
                put("error", err.error)
            }
            put("ms", Math.round(ms * 10) / 10.0)
            put("logs", JsonArray(logs.map { JsonPrimitive(it) }))
        }
        // Recognitions get polled (every pipeline round, every guard tick): only their failures go to the log.
        if (context != 0L && (trigger != "recognition" || result.isFailure)) {
            app.events.post("skill") {
                out.forEach { (k, v) -> if (k != "logs" && (k != "value" || v.toString().length <= MAX_EVENT_VALUE)) put(k, v) }
            }
        }
        return out
    }

    /** Export names and meta of a skill, loading it the way a run would (context 0: device calls fail). */
    fun describe(name: String): JsonObject {
        val exports = withFrame(name, LOAD_TIMEOUT_MS) { js(module(name), "*", JsonNull, JsonNull).first }
        val meta = withFrame(name, LOAD_TIMEOUT_MS) { js(module(name), "meta", JsonNull, JsonNull).first }
        return buildJsonObject {
            put("exports", exports)
            put("meta", meta as? JsonObject ?: JsonObject(emptyMap()))
        }
    }

    private fun invoke(name: String, export: String, args: JsonElement, ctx: JsonObject, timeoutMs: Long?): JsonElement {
        val module = module(name)
        // Loading runs the module's top-level code once and reports syntax errors; meta says how long a call may take.
        val meta = withFrame(name, LOAD_TIMEOUT_MS) { js(module, "meta", JsonNull, JsonNull).first } as? JsonObject
        val timeout = timeoutMs ?: meta?.optLong("timeout") ?: DEFAULT_TIMEOUT_MS
        val full = JsonObject(ctx + mapOf("workspace" to JsonPrimitive(workspace), "skill" to JsonPrimitive(name), "trigger" to JsonPrimitive(trigger)))
        return withFrame(name, timeout) {
            val (value, missing) = js(module, export, args, full)
            if (missing) {
                throw SkillError(buildJsonObject {
                    put("name", "TypeError")
                    put("message", "skill $name has no ${if (export == "default") "default" else "\"$export\""} export")
                    put("file", module)
                }, "error")
            }
            value
        }
    }

    private fun module(name: String): String {
        if (!Skills.NAME.matches(name) || !app.workspaces.file(workspace, "${Skills.DIR}/$name.js").isFile) {
            throw NoSuchElementException("no skill $name in $workspace")
        }
        return "${Skills.DIR}/$name.js"
    }

    private fun <T> withFrame(name: String, timeoutMs: Long, block: () -> T): T {
        val f = Frame(name, timeoutMs, frames.lastOrNull())
        frames.add(f)
        try {
            return block()
        } finally {
            f.cancel()
            frames.remove(f)
            // This call's own deadline passed (maybe just as it returned): the caller, if any, goes on.
            if (f.expired && !stopped && frames.none { it.expired }) synchronized(this) { Js.interrupt(h, false) }
        }
    }

    /** Call into the script; returns (value, missing) or throws SkillError. */
    private fun js(module: String, export: String, args: JsonElement, ctx: JsonElement): Pair<JsonElement, Boolean> {
        val env = Json.parseToJsonElement(
            Js.call(h, module, export, args.toString().toByteArray(), ctx.toString().toByteArray()).decodeToString(),
        ).jsonObject
        if (env.optBool("ok") == true) return (env["value"] ?: JsonNull) to (env.optBool("missing") == true)
        val err = env["error"]!!.jsonObject
        val interrupted = err.optBool("interrupted") == true
        val reason = when {
            stopped -> "stopped"
            interrupted && frames.any { it.expired } -> "timeout"
            else -> "error"
        }
        throw SkillError(located(err, reason), reason)
    }

    /** The script error plus the first skills/ file and line in its stack. */
    private fun located(err: JsonObject, reason: String): JsonObject {
        val stack = err.optStr("stack").orEmpty()
        val m = LOCATION.find(stack)
        val message = when (reason) {
            "stopped" -> "stopped"
            "timeout" -> frames.lastOrNull { it.expired }?.let { "${it.skill} timed out after ${it.timeoutMs} ms" } ?: "timed out"
            else -> err.optStr("message").orEmpty()
        }
        return buildJsonObject {
            put("name", if (reason == "error") err["name"] ?: JsonPrimitive("Error") else JsonPrimitive(reason))
            put("message", message)
            if (m != null) {
                put("file", m.groupValues[1])
                put("line", m.groupValues[2].toInt())
                m.groupValues[3].toIntOrNull()?.let { put("column", it) }
            }
            put("stack", stack)
        }
    }

    // ---- host

    override fun module(name: ByteArray): ByteArray {
        val n = name.decodeToString()
        require(n.startsWith("${Skills.DIR}/") && n.endsWith(".js")) { "cannot import \"$n\": import relative .js files under skills/" }
        val f = app.workspaces.file(workspace, n)
        if (!f.isFile) throw NoSuchElementException("no module $n")
        return f.readBytes()
    }

    override fun call(op: String, args: ByteArray?): ByteArray? {
        alive()
        val a = args?.let { Json.parseToJsonElement(it.decodeToString()) as? JsonObject } ?: JsonObject(emptyMap())
        val out = try {
            dispatch(op, a)
        } catch (e: Js.Stop) {
            throw e
        } catch (e: Exception) {
            if (stopped || frames.any { it.expired }) throw Js.Stop(if (stopped) "stopped" else "timeout")
            throw RuntimeException(e.message ?: e.javaClass.simpleName)
        }
        return out?.toString()?.toByteArray()
    }

    private fun alive() {
        if (stopped) throw Js.Stop("stopped")
        if (frames.any { it.expired }) throw Js.Stop("timeout")
    }

    private fun device(): Long {
        check(controller != 0L) { "device calls only work while the skill runs, not at module top level" }
        return controller
    }

    private fun done(ok: Boolean, what: String): JsonElement? {
        check(ok) { "$what failed" }
        return null
    }

    private fun dispatch(op: String, a: JsonObject): JsonElement? {
        fun i(k: String, d: Int = 0) = a.optInt(k) ?: d
        return when (op) {
            "screenshot" -> screenshot()
            "recognize" -> {
                val node = node(a)
                val ov = (a["override"] as? JsonObject).orEmpty() + (a["roi"]?.let { mapOf("roi" to it) } ?: emptyMap())
                val override = buildJsonObject { put(node, JsonObject(ov)) }
                timed(a) { Maa.contextRecognize(context(), node, override.toString(), image(a)) }
            }
            "reco" -> timed(a) { Maa.contextRecognizeDirect(context(), a.str("type"), (a["param"] ?: JsonObject(emptyMap())).toString(), image(a)) }
            "click" -> done(Maa.controllerClick(device(), i("x"), i("y")), "click")
            "long_press" -> {
                val c = device()
                done(Maa.controllerTouch(c, 0, 0, i("x"), i("y")), "touch down")
                try {
                    pause(a.optLong("ms") ?: 800)
                } finally {
                    Maa.controllerTouch(c, 2, 0, i("x"), i("y"))
                }
                null
            }
            "swipe" -> done(Maa.controllerSwipe(device(), i("x1"), i("y1"), i("x2"), i("y2"), i("ms", 300)), "swipe")
            "touch" -> {
                val type = when (a.optStr("op")) {
                    "down" -> 0
                    "move" -> 1
                    "up" -> 2
                    else -> throw IllegalArgumentException("touch op must be down, move or up")
                }
                done(Maa.controllerTouch(device(), type, i("contact"), i("x"), i("y")), "touch ${a.optStr("op")}")
            }
            "key" -> when (a.optStr("op")) {
                "down" -> done(Maa.controllerKeyState(device(), 0, i("code")), "key down")
                "up" -> done(Maa.controllerKeyState(device(), 1, i("code")), "key up")
                else -> done(Maa.controllerKey(device(), i("code")), "key")
            }
            "input_text" -> done(Maa.controllerInputText(device(), a.str("text")), "input text")
            "start_app" -> done(Maa.controllerStartApp(device(), packageOf(a)), "start app")
            "stop_app" -> done(Maa.controllerStopApp(device(), packageOf(a)), "stop app")
            "sleep" -> pause(a.optLong("ms") ?: 0).let { null }
            "remaining" -> JsonPrimitive(frames.lastOrNull()?.let { maxOf(0, (it.deadline - System.nanoTime()) / 1_000_000) } ?: 0)
            "frame" -> frameStats()
            "log" -> log(a.optStr("message").orEmpty()).let { null }
            "event" -> {
                app.events.post("skill_event") {
                    put("workspace", workspace)
                    put("skill", frames.lastOrNull()?.skill)
                    put("name", a.str("name"))
                    put("data", a["data"] ?: JsonNull)
                }
                null
            }
            "memory_get" -> memory()[a.str("key")]
            "memory_set" -> {
                val key = a.str("key")
                synchronized(skills.memoryLock) {
                    val m = memory()
                    memoryFile().writeJson(JsonObject(if (a["value"] == null) m - key else m + (key to a["value"]!!)))
                }
                null
            }
            "memory_all" -> memory()
            "run_node" -> {
                val node = node(a)
                val override = buildJsonObject {
                    put(node, buildJsonObject {
                        (a["override"] as? JsonObject)?.forEach { (k, v) -> put(k, v) }
                        if (a.optBool("once") == true) put("timeout", 0)
                    })
                }
                inNode = true
                try {
                    Engine.summarize(Maa.contextRunTask(context(), node, override.toString()))
                } finally {
                    inNode = false
                }
            }
            "run_skill" -> runSkill(a.str("name"), a["args"] ?: JsonNull)
            "save_image" -> {
                val path = a.str("path")
                require(path.endsWith(".png")) { "save_image: path must end in .png" }
                val f = app.workspaces.file(workspace, path)
                f.writeAtomic(Maa.imageEncoded(image(a)))
                JsonPrimitive(path)
            }
            else -> throw IllegalArgumentException("unknown host op: $op")
        }
    }

    private fun node(a: JsonObject): String {
        val node = a.str("node")
        require(Maa.contextNodeData(context(), node) != null) { "no pipeline node \"$node\" in $workspace" }
        return node
    }

    private fun context(): Long {
        check(context != 0L) { "recognition only works while the skill runs, not at module top level" }
        return context
    }

    private fun packageOf(a: JsonObject) =
        a.optStr("package")?.takeIf { it.isNotEmpty() } ?: app.workspaces.packageOf(workspace).ifEmpty { error("no package given and none in workspace.json") }

    private fun runSkill(name: String, args: JsonElement): JsonElement {
        val caller = frames.last().skill
        try {
            return invoke(name, "default", args, buildJsonObject { put("caller", caller) }, null)
        } catch (e: SkillError) {
            // A failure or only the inner call's own timeout: the caller goes on and can catch this.
            if (stopped || frames.any { it.expired }) throw Js.Stop(if (stopped) "stopped" else "timeout")
            throw RuntimeException("skill $name: ${e.describe()}")
        }
    }

    /** Sleep, waking early for stop or timeout. */
    private fun pause(ms: Long) {
        val end = System.nanoTime() + ms * 1_000_000
        synchronized(signal) {
            while (true) {
                alive()
                val left = (end - System.nanoTime()) / 1_000_000
                if (left <= 0) return
                signal.wait(minOf(left, 1000))
            }
        }
    }

    private fun log(msg: String) {
        Log.i(TAG, "[$label] $msg")
        logs.addLast(msg)
        if (logs.size > MAX_LOGS) logs.removeFirst()
    }

    // ---- images

    private fun screenshot(): JsonObject {
        val img = Maa.imageCreate()
        if (!Maa.controllerScreencapInto(device(), img)) {
            Maa.imageDestroy(img)
            error("screenshot failed")
        }
        val id = nextImage++
        images[id] = img
        latest = id
        while (images.size > KEEP_IMAGES) {
            val (old, ptr) = images.entries.first()
            images.remove(old)
            Maa.imageDestroy(ptr)
        }
        return JsonObject(frameStats() + mapOf("id" to JsonPrimitive(id)))
    }

    private fun frameStats(): JsonObject {
        val s = Bridge.stats()
        return buildJsonObject {
            put("width", app.engine.width)
            put("height", app.engine.height)
            put("seq", s.seq)
            put("age_ms", Math.round(s.ageMs * 10) / 10.0)
            put("time", System.currentTimeMillis())
        }
    }

    /** The image a call names (id), else the latest screenshot (the recognition input), else a new screenshot. */
    private fun image(a: JsonObject): Long {
        val id = (a["image"] as? JsonObject)?.get("id")?.jsonPrimitive?.longOrNull?.toInt() ?: a.optInt("image")
        if (id != null) {
            return images[id] ?: borrowed[id] ?: throw IllegalArgumentException("image $id is gone (only the last $KEEP_IMAGES screenshots are kept)")
        }
        images[latest]?.let { return it }
        borrowed[0]?.let { return it }
        screenshot()
        return images[latest]!!
    }

    /** Run a recognition; its raw detail becomes a Hit: {hit, box, score?, text?, label?, algorithm, results, ms, detail?}. */
    private fun timed(a: JsonObject, reco: () -> String): JsonObject {
        val t0 = System.nanoTime()
        val r = Json.parseToJsonElement(reco()).jsonObject
        val ms = (System.nanoTime() - t0) / 1e6
        val detail = r["detail"] as? JsonObject
        val best = detail?.get("best") as? JsonObject
        return buildJsonObject {
            put("hit", r["hit"]!!)
            put("box", r["box"] ?: JsonNull)
            for (k in listOf("score", "text", "label")) best?.get(k)?.let { put(k, it) }
            put("algorithm", r["algorithm"] ?: JsonPrimitive(""))
            put("results", buildJsonArray {
                (detail?.get("filtered") as? JsonArray)?.take(MAX_RESULTS)?.forEach { m ->
                    (m as? JsonObject)?.let { add(JsonObject(it.filterKeys { k -> k in RESULT_KEYS })) }
                }
            })
            put("ms", Math.round(ms * 100) / 100.0)
            if (a.optBool("detail") == true) put("detail", r["detail"] ?: JsonNull)
        }
    }

    // ---- memory: memory/memory.json, the same key-value file as maalow.memory.MemoryStore

    private fun memoryFile() = app.workspaces.file(workspace, "memory/memory.json")

    private fun memory(): JsonObject = readJsonObject(memoryFile()) ?: JsonObject(emptyMap())

    companion object {
        const val TAG = "MaaLowSkill"
        const val PRELUDE_NAME = "maalow/prelude.js"
        const val DEFAULT_TIMEOUT_MS = 60_000L
        const val LOAD_TIMEOUT_MS = 5_000L
        const val KEEP_IMAGES = 8
        const val MAX_LOGS = 200
        const val MAX_RESULTS = 50
        const val MAX_EVENT_VALUE = 2000
        val RESULT_KEYS = setOf("box", "score", "text", "label", "cls_index", "count")
        /** "(skills/a.js:12:5)" or "at skills/a.js:12" in a QuickJS stack. */
        val LOCATION = Regex("""(skills/[^\s():]+\.js):(\d+)(?::(\d+))?""")
    }
}
