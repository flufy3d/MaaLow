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
    @Volatile private var used = 0L // last request from the teacher or the AI

    val active: Boolean get() = workspace.isNotEmpty()

    private fun dir(ws: String = workspace) = File(app.workspaces.existing(ws), "teaching")
    private fun shots() = File(dir(), task)

    private fun ensure() {
        used = System.currentTimeMillis()
        if (!active) start(app.defaultWorkspace() ?: error("no workspace"), "explore")
    }

    private fun start(ws: String, name: String) = synchronized(lock) {
        require(name.isNotEmpty() && !name.contains('/') && !name.startsWith(".")) { "bad task name: $name" }
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
        changed.value++
    }

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
            put("steps", steps.size)
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

    fun task(name: String, ws: String?): JsonObject {
        synchronized(lock) {
            if (active && steps.isNotEmpty()) save()
            start(ws ?: workspace.ifEmpty { app.defaultWorkspace() ?: error("no workspace") }, name)
        }
        return state()
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

    /** AI reply. (Guard notices are marked auto: they do not count as answering the teacher.) */
    fun say(text: String): JsonObject {
        ensure()
        return post(mapOf("role" to JsonPrimitive("ai"), "text" to JsonPrimitive(text)))
    }

    fun since(n: Int): List<JsonObject> = synchronized(lock) {
        ensure()
        messages.drop(n)
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
                    val new = messages.drop(delivered).filter { it.optStr("role") == "teacher" }
                    if (new.isNotEmpty()) {
                        delivered = messages.size
                        if (new.last().optArray("annotations")?.isNotEmpty() == true) pending = new.last()
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
        const val NOTICE_WINDOW_MS = 30 * 60_000L
    }
}
