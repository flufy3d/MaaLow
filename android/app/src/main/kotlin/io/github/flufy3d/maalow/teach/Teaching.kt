package io.github.flufy3d.maalow.teach

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.store.PrettyJson
import io.github.flufy3d.maalow.store.optArray
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.readJsonObject
import io.github.flufy3d.maalow.store.writeAtomic
import io.github.flufy3d.maalow.store.writeJson
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale

/**
 * A teaching session, as in the PC TeachingServer: the teacher (web UI) takes screenshots on demand, draws numbered
 * annotations and talks; the AI (PC client) listens, drives the device and replies. Every AI action becomes a step
 * with before/after screenshots. Files match maalow.teaching: teaching/<task>.json (TeachingSession),
 * teaching/<task>.chat.jsonl and teaching/<task>/NNNN.png.
 */
class Teaching(private val app: App) {
    private val lock = Any() // session and chat state; device work goes through the engine's device lock
    private val changed = MutableStateFlow(0L)

    var workspace = ""
        private set
    var task = ""
        private set
    private var steps = ArrayList<JsonObject>()
    private var messages = ArrayList<JsonObject>()
    private var delivered = 0 // messages already handed to the AI
    private var pending: JsonObject? = null // teacher message whose annotations go on the next step
    private var listeners = 0
    private var last = "" // latest screenshot, workspace-relative
    private var counter = 0
    private var session = 0 // bumped whenever another session (or a cleared one) is opened: the web UI reloads its chat
    @Volatile private var used = 0L // last request from the teacher or the AI

    val active: Boolean get() = workspace.isNotEmpty()

    private fun dir(ws: String = workspace) = File(app.workspaces.existing(ws), "teaching")
    private fun shots() = File(dir(), task)

    private fun ensure() {
        used = System.currentTimeMillis()
        if (!active) start(app.defaultWorkspace() ?: error("no workspace"), DEFAULT_TASK)
    }

    private fun start(ws: String, name: String) = synchronized(lock) {
        checkName(name)
        val d = dir(ws)
        workspace = ws
        task = name
        steps = ArrayList(readJsonObject(File(d, "$name.json"))?.optArray("steps")?.map { it.jsonObject } ?: emptyList())
        counter = File(d, name).listFiles()?.mapNotNull { it.name.removeSuffix(".png").toIntOrNull() }?.maxOrNull() ?: 0
        val log = File(d, "$name.chat.jsonl")
        messages = ArrayList(
            if (log.isFile) log.readLines().filter { it.isNotBlank() }.map { PrettyJson.parseToJsonElement(it).jsonObject }
            else emptyList(),
        )
        delivered = messages.size // history was already handled
        pending = null
        last = steps.lastOrNull()?.optStr("after").orEmpty()
        session++
        changed.value++
    }

    private fun checkName(name: String) =
        require(name.isNotEmpty() && name.none { it in "/\\" || it.isISOControl() } && !name.startsWith(".")) { "bad task name: $name" }

    private fun save() {
        File(dir(), "$task.json").writeJson(buildJsonObject {
            put("task", task)
            put("steps", JsonArray(steps))
        })
    }

    /** Save the current frame as the next numbered screenshot. */
    private fun capture(): JsonObject {
        val (_, png) = app.engine.snapshotPng()
        val name = synchronized(lock) { "%04d".format(++counter) }
        val f = File(shots(), "$name.png")
        f.writeAtomic(png)
        last = f.relativeTo(app.workspaces.dir(workspace)).invariantSeparatorsPath
        changed.value++
        return buildJsonObject {
            put("workspace", workspace)
            put("screenshot", last)
            put("size", buildJsonArray { add(JsonPrimitive(app.engine.width)); add(JsonPrimitive(app.engine.height)) })
        }
    }

    fun state(): JsonObject = synchronized(lock) {
        ensure()
        val talk = messages.filter { it["auto"] == null }
        val waiting = talk.isNotEmpty() && talk.last().optStr("role") == "teacher" // teacher spoke, AI has not replied
        buildJsonObject {
            put("workspace", workspace)
            put("task", task)
            put("session", session)
            put("steps", steps.size)
            put("messages", messages.size)
            put("screenshot", last)
            put("waiting", waiting)
            put("ai", if (listeners > 0) "listening" else if (waiting) "busy" else "away")
        }
    }

    fun shot(): JsonObject {
        ensure()
        return capture()
    }

    suspend fun act(action: JsonObject, say: String, waitMs: Long): JsonObject {
        ensure()
        val type = action.optStr("type")
        val full = if (type in setOf("start_app", "stop_app") && action["package"] == null) {
            JsonObject(action + ("package" to JsonPrimitive(app.workspaces.packageOf(workspace))))
        } else action
        return app.engine.exclusive("teach:$workspace/$task") {
            val before = last.ifEmpty { capture().optStr("screenshot")!! }
            val ok = app.engine.act(full)
            if (type != "wait") delay(waitMs) // a wait action already waited
            val after = capture()
            synchronized(lock) {
                val note = pending
                pending = null
                steps.add(buildJsonObject {
                    put("screenshot", before)
                    put("instruction", say.ifEmpty { note?.optStr("text").orEmpty() })
                    put("annotations", annotations(note?.optArray("annotations")))
                    put("action", full)
                    put("result", "")
                    put("after", after.optStr("screenshot"))
                })
                save()
                JsonObject(mapOf("ok" to JsonPrimitive(ok), "step" to JsonPrimitive(steps.size)) + after)
            }
        }
    }

    /** Annotation list in the maalow.teaching.Annotation shape, coordinates rounded to ints. */
    private fun annotations(raw: JsonArray?): JsonArray = buildJsonArray {
        raw?.forEach { e ->
            val a = e.jsonObject
            add(buildJsonObject {
                put("kind", a.optStr("kind"))
                put("coords", buildJsonArray { a.optArray("coords")?.forEach { add(JsonPrimitive(Math.round(it.jsonPrimitive.content.toDouble()))) } })
                put("label", a.optStr("label").orEmpty())
            })
        }
    }

    suspend fun run(node: String, once: Boolean): JsonObject {
        ensure()
        return app.engine.exclusive("teach:$workspace/$task") {
            val r = app.engine.run(workspace, node, once)
            JsonObject(mapOf("node" to JsonPrimitive(node)) + r + capture())
        }
    }

    /**
     * Save the session and switch to another task (an existing one continues where it left off). Both chats get a
     * system line marking the switch; by="teacher" (the web UI) also hands the new one to the AI on its next listen.
     */
    fun task(name: String, ws: String?, by: String = "ai"): JsonObject {
        synchronized(lock) {
            checkName(name)
            val target = ws ?: workspace.ifEmpty { app.defaultWorkspace() ?: error("no workspace") }
            dir(target) // an unknown workspace fails here, before anything is written
            if (active && target == workspace && name == task) return state()
            val (prevWs, prev, prevSteps) = Triple(workspace, task, steps.size)
            val wasActive = active
            val who = who(by)
            val ending = name == DEFAULT_TASK && prev != DEFAULT_TASK && target == prevWs
            if (wasActive) {
                if (steps.isNotEmpty()) save()
                system(if (ending) "$who 结束了任务 $prev，共 $prevSteps 步" else "$who 切换到任务 $name", by)
            }
            start(target, name)
            system(
                when {
                    !wasActive -> "$who 开始任务 $name"
                    ending -> "$who 结束了任务 $prev（$prevSteps 步），回到草稿"
                    else -> "$who 开始任务 $name（上一个：${if (prevWs != target) "$prevWs/" else ""}$prev，$prevSteps 步）" +
                        if (steps.isNotEmpty()) "，接着已有的 ${steps.size} 步" else ""
                },
                by,
            )
        }
        return state()
    }

    /**
     * Rename the current task, files and the screenshot paths inside them. From the scratch task this is "save the
     * draft as a task": the work moves over and explore starts empty next time.
     */
    suspend fun rename(name: String, by: String): JsonObject = device("rename") {
        synchronized(lock) {
            ensure()
            checkName(name)
            val d = dir()
            val (from, to) = task to name
            require(from != to) { "same name: $name" }
            require(listOf("$to.json", "$to.chat.jsonl", to).none { File(d, it).exists() }) { "task exists: $to" }
            if (steps.isNotEmpty()) save()
            val (a, b) = "teaching/$from/" to "teaching/$to/"
            readJsonObject(File(d, "$from.json"))?.let { File(d, "$to.json").writeJson(retarget(it, a, b)) }
            File(d, "$from.chat.jsonl").takeIf { it.isFile }?.let { f ->
                File(d, "$to.chat.jsonl").writeText(
                    f.readLines().filter { it.isNotBlank() }.joinToString("") { retarget(PrettyJson.parseToJsonElement(it), a, b).toString() + "\n" },
                )
            }
            File(d, from).takeIf { it.isDirectory }?.let { check(it.renameTo(File(d, to))) { "cannot move $from/" } }
            File(d, "$from.json").delete()
            File(d, "$from.chat.jsonl").delete()
            start(workspace, to)
            system("${who(by)} ${if (from == DEFAULT_TASK) "把草稿另存为任务 $to" else "把任务 $from 改名为 $to"}（${steps.size} 步）", by)
        }
        state()
    }

    /** Delete the current task: its chat, steps and screenshots. The scratch task is emptied; any other returns to it. */
    suspend fun delete(by: String): JsonObject = device("delete") {
        synchronized(lock) {
            ensure()
            val (gone, n) = task to steps.size
            val d = dir()
            File(d, "$gone.json").delete()
            File(d, "$gone.chat.jsonl").delete()
            File(d, gone).deleteRecursively()
            start(workspace, DEFAULT_TASK)
            system(if (gone == DEFAULT_TASK) "${who(by)} 清空了草稿（$n 步）" else "${who(by)} 删除了任务 $gone（$n 步），回到草稿", by)
        }
        state()
    }

    /** File work that must not race a step writing screenshots; waits a little for a guard check to finish. */
    private suspend fun <T : Any> device(what: String, block: () -> T): T =
        withTimeoutOrNull(5000) { app.engine.exclusive("teach:$what") { block() } } ?: error("设备正忙（${app.engine.busy}），稍后再试")

    private fun who(by: String) = if (by == "teacher") "老师" else "MaaLow"

    private fun retarget(e: JsonElement, from: String, to: String): JsonElement = when (e) {
        is JsonObject -> JsonObject(e.mapValues { retarget(it.value, from, to) })
        is JsonArray -> JsonArray(e.map { retarget(it, from, to) })
        is JsonPrimitive -> if (e.isString && e.content.startsWith(from)) JsonPrimitive(to + e.content.removePrefix(from)) else e
        else -> e
    }

    /** Tasks of a workspace: the scratch task first, then the most recently used. name, steps, mtime (ms). */
    fun tasks(ws: String?): JsonArray {
        val w = ws ?: synchronized(lock) { ensure(); workspace }
        val files = dir(w).listFiles().orEmpty()
        val names = files.mapNotNull { f ->
            when {
                f.name.endsWith(".chat.jsonl") -> f.name.removeSuffix(".chat.jsonl")
                f.name.endsWith(".json") -> f.name.removeSuffix(".json")
                else -> null
            }
        }.toMutableSet()
        names += DEFAULT_TASK // the scratch task is always there, even before it has files
        synchronized(lock) { if (w == workspace) names += task }
        return buildJsonArray {
            names.map { n ->
                val json = File(dir(w), "$n.json")
                val chat = File(dir(w), "$n.chat.jsonl")
                val steps = synchronized(lock) { if (w == workspace && n == task) steps.size else null }
                    ?: readJsonObject(json)?.optArray("steps")?.size ?: 0
                Triple(n, steps, maxOf(json.lastModified(), chat.lastModified()))
            }.sortedWith(compareBy<Triple<String, Int, Long>> { it.first != DEFAULT_TASK }.thenByDescending { it.third }).forEach { (n, s, t) ->
                add(buildJsonObject { put("name", n); put("steps", s); put("mtime", t) })
            }
        }
    }

    /** The workspace's files were replaced underneath (import): reopen the session from disk. */
    fun reload(ws: String) = synchronized(lock) {
        if (workspace == ws) start(ws, task)
    }

    // ---- chat between the human teacher and the AI

    private fun post(msg: Map<String, JsonElement>): JsonObject = synchronized(lock) {
        val m = JsonObject(
            mapOf(
                "id" to JsonPrimitive(messages.size + 1),
                "time" to JsonPrimitive(SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(Date())),
            ) + msg,
        )
        messages.add(m)
        File(dir(), "$task.chat.jsonl").appendText(m.toString() + "\n")
        changed.value++
        m
    }

    /** A teacher message. image: the annotated screenshot as a PNG data URL; screenshot: the frame it was drawn on. */
    fun teach(text: String, annotations: JsonArray, image: String, screenshot: String?): JsonObject {
        ensure()
        var note = ""
        if (image.startsWith(PNG_URL)) {
            val n = (shots().listFiles()?.count { it.name.startsWith("note-") } ?: 0) + 1
            val f = File(shots(), "note-%04d.png".format(n))
            f.writeAtomic(Base64.getDecoder().decode(image.substring(PNG_URL.length)))
            note = f.relativeTo(app.workspaces.dir(workspace)).invariantSeparatorsPath
        }
        return post(
            mapOf(
                "role" to JsonPrimitive("teacher"),
                "text" to JsonPrimitive(text),
                "annotations" to annotations,
                "screenshot" to JsonPrimitive(screenshot?.takeIf { it.isNotEmpty() } ?: last),
                "note" to JsonPrimitive(note),
            ),
        )
    }

    /** Task boundary line. auto, so it neither locks the composer nor counts as a reply. */
    private fun system(text: String, by: String) =
        post(mapOf("role" to JsonPrimitive("system"), "text" to JsonPrimitive(text), "by" to JsonPrimitive(by), "auto" to JsonPrimitive(true)))

    /** AI reply. (Guard notices are marked auto: they do not count as answering the teacher.) */
    fun say(text: String): JsonObject {
        ensure()
        return post(mapOf("role" to JsonPrimitive("ai"), "text" to JsonPrimitive(text)))
    }

    /** Chat messages with since < id < before, at most the last [limit] of them. */
    fun since(n: Int, before: Int? = null, limit: Int? = null): List<JsonObject> = synchronized(lock) {
        ensure()
        val from = n.coerceIn(0, messages.size) // ids start at 1: id k is messages[k - 1]
        val to = ((before ?: Int.MAX_VALUE) - 1).coerceIn(from, messages.size)
        val range = messages.subList(from, to)
        (if (limit != null) range.takeLast(limit) else range).toList()
    }

    /** Wait for teacher messages not yet delivered to the AI. */
    suspend fun listen(timeoutMs: Long): List<JsonObject> {
        synchronized(lock) {
            ensure()
            listeners++
        }
        try {
            val end = System.currentTimeMillis() + timeoutMs
            while (true) {
                val seen = changed.value
                synchronized(lock) {
                    // teacher messages, and task switches the teacher made in the web UI
                    val new = messages.drop(delivered).filter {
                        it.optStr("role") == "teacher" || (it.optStr("role") == "system" && it.optStr("by") == "teacher")
                    }
                    if (new.isNotEmpty()) {
                        delivered = messages.size
                        val said = new.lastOrNull { it.optStr("role") == "teacher" }
                        if (said?.optArray("annotations")?.isNotEmpty() == true) pending = said
                        return new
                    }
                }
                val left = end - System.currentTimeMillis()
                if (left <= 0) return emptyList()
                withTimeoutOrNull(left) { changed.first { it > seen } }
            }
        } finally {
            synchronized(lock) { listeners-- }
        }
    }

    /**
     * A guard fired: tell the teacher, if someone is teaching right now. Guards run all day in the background, so
     * idle sessions get no notices (and no screenshots, which would pile up in the workspace).
     */
    fun onGuard(ws: String, node: String) {
        if (!active || ws != workspace || System.currentTimeMillis() - used > NOTICE_WINDOW_MS) return
        post(mapOf("role" to JsonPrimitive("ai"), "text" to JsonPrimitive("[自动] 规则 $node 已触发"), "auto" to JsonPrimitive(true)))
    }

    companion object {
        const val PNG_URL = "data:image/png;base64,"
        const val DEFAULT_TASK = "explore" // the scratch task: where teaching starts and ending a task returns to
        const val NOTICE_WINDOW_MS = 30 * 60_000L
    }
}
