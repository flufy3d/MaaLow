package io.github.flufy3d.maalow.teach

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.store.PrettyJson
import io.github.flufy3d.maalow.store.optArray
import io.github.flufy3d.maalow.store.optInt
import io.github.flufy3d.maalow.store.optLong
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
 * A teaching session: the teacher (web UI) and the AI (PC client) talk in messages that carry text and attachments
 * (a screenshot with its annotations, or a recording with an optional focus on some frames). The AI listens, drives
 * the device and replies. Every AI action becomes a step with before/after screenshots. Files match maalow.teaching:
 * teaching/<task>.json (TeachingSession), teaching/<task>.chat.jsonl, teaching/<task>/NNNN.png, and the teacher's
 * unsent attachments in teaching/<task>.tray.json.
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
    private var pending: JsonObject? = null // {text, annotations} of the teacher message, for the next step
    private var tray = ArrayList<JsonObject>() // the teacher's unsent attachments, each with an id
    private var trayRev = 0
    private var stopped = false // the teacher pressed stop: AI actions are refused until it says something
    private var listeners = 0
    private var lastPoll = 0L // when the last listen returned: the CLI polls again right away
    private var last = "" // latest screenshot, workspace-relative
    private var counter = 0
    private var session = 0 // bumped whenever another session (or a cleared one) is opened: the web UI reloads its chat
    @Volatile private var used = 0L // last request from the teacher or the AI
    @Volatile private var aiSeen = 0L // last request from the AI (the PC client), and what it was
    @Volatile private var aiDid = ""

    /** Thrown by AI actions while the teacher has stopped it; the API answers {"error": "stopped by teacher"}. */
    class Stopped : IllegalStateException(STOPPED)

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
            if (log.isFile) log.readLines().filter { it.isNotBlank() }.map { upgrade(PrettyJson.parseToJsonElement(it).jsonObject) }
            else emptyList(),
        )
        delivered = messages.size // history was already handled
        pending = null
        stopped = false
        tray = ArrayList(readJsonObject(File(d, "$name.tray.json"))?.optArray("items")?.map { it.jsonObject } ?: emptyList())
        trayRev++
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

    /** The teacher spoke and the AI has not replied yet (nor was the wait skipped). */
    private fun waiting(): Boolean {
        val asked = messages.indexOfLast { it.optStr("role") == "teacher" }
        return asked >= 0 && messages.indexOfLast { (it.optStr("role") == "ai" && it["auto"] == null) || it["unlock"] != null } < asked
    }

    fun state(): JsonObject = synchronized(lock) {
        ensure()
        val talk = talk()
        val waiting = waiting()
        val busy = app.engine.busy
        buildJsonObject {
            put("workspace", workspace)
            put("task", task)
            put("session", session)
            put("steps", steps.size)
            put("messages", messages.size)
            put("talk", talk.size)
            put("screenshot", last)
            put("waiting", waiting)
            val online = listeners > 0 || System.currentTimeMillis() - lastPoll < POLL_GAP_MS
            put("ai", if (online) "listening" else if (waiting) "busy" else "away")
            put("stopped", stopped)
            // who has the device, for the top bar (arbitration comes with remote control)
            put("control", when {
                stopped -> "stopped"
                waiting -> "ai"
                busy != null && !busy.startsWith("guard:") -> "task"
                else -> "idle"
            })
            if (aiSeen > 0) {
                put("ai_idle_ms", System.currentTimeMillis() - aiSeen)
                put("ai_did", aiDid)
            }
            put("tray_rev", trayRev)
        }
    }

    /** A request from the AI: it is alive and working (the web UI tells slow from stuck by this). */
    fun aiActive(what: String) {
        aiSeen = System.currentTimeMillis()
        aiDid = what
    }

    /** AI actions (act, run, skill) call this first. */
    fun checkNotStopped() {
        if (stopped) throw Stopped()
    }

    fun shot(): JsonObject {
        ensure()
        return capture()
    }

    suspend fun act(action: JsonObject, say: String, waitMs: Long): JsonObject {
        ensure()
        checkNotStopped()
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

    /** Annotation list in the maalow.teaching.Annotation shape, coordinates rounded to ints ("box" is taken as rect). */
    private fun annotations(raw: JsonArray?): JsonArray = buildJsonArray {
        raw?.forEach { e ->
            val a = e.jsonObject
            val kind = a.optStr("kind").let { if (it == "box") "rect" else it }
            require(kind in KINDS) { "unknown annotation kind: $kind (${KINDS.joinToString()})" }
            add(buildJsonObject {
                put("kind", kind)
                put("coords", buildJsonArray { a.optArray("coords")?.forEach { add(JsonPrimitive(Math.round(it.jsonPrimitive.content.toDouble()))) } })
                put("label", a.optStr("label").orEmpty())
            })
        }
    }

    suspend fun run(node: String, once: Boolean): JsonObject {
        ensure()
        checkNotStopped()
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
            if (target != app.settings().workspace) app.updateSettings { it.copy(workspace = target) } // one current workspace
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
            require(listOf("$to.json", "$to.chat.jsonl", "$to.tray.json", to).none { File(d, it).exists() }) { "task exists: $to" }
            if (steps.isNotEmpty()) save()
            val (a, b) = "teaching/$from/" to "teaching/$to/"
            readJsonObject(File(d, "$from.json"))?.let { File(d, "$to.json").writeJson(retarget(it, a, b)) }
            File(d, "$from.chat.jsonl").takeIf { it.isFile }?.let { f ->
                File(d, "$to.chat.jsonl").writeText(
                    f.readLines().filter { it.isNotBlank() }.joinToString("") { retarget(PrettyJson.parseToJsonElement(it), a, b).toString() + "\n" },
                )
            }
            readJsonObject(File(d, "$from.tray.json"))?.let { File(d, "$to.tray.json").writeJson(retarget(it, a, b)) }
            File(d, from).takeIf { it.isDirectory }?.let { check(it.renameTo(File(d, to))) { "cannot move $from/" } }
            File(d, "$from.json").delete()
            File(d, "$from.chat.jsonl").delete()
            File(d, "$from.tray.json").delete()
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
            File(d, "$gone.tray.json").delete()
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
    private fun talk() = messages.filter { it["auto"] == null }

    private data class TaskInfo(val name: String, val steps: Int, val talk: Int, val mtime: Long)

    fun tasks(ws: String?): JsonArray {
        val w = ws ?: synchronized(lock) { ensure(); workspace }
        val files = dir(w).listFiles().orEmpty()
        val names = files.mapNotNull { f ->
            when {
                f.name.endsWith(".chat.jsonl") -> f.name.removeSuffix(".chat.jsonl")
                f.name.endsWith(".tray.json") -> null
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
                val open = synchronized(lock) { if (w == workspace && n == task) steps.size to talk().size else null }
                val steps = open?.first ?: readJsonObject(json)?.optArray("steps")?.size ?: 0
                // chat lines without "auto" (system lines, rule notices) are what the teacher and AI said
                val talk = open?.second ?: chat.takeIf { it.isFile }?.useLines { ls -> ls.count { it.isNotBlank() && "\"auto\":true" !in it } } ?: 0
                TaskInfo(n, steps, talk, maxOf(json.lastModified(), chat.lastModified()))
            }.sortedWith(compareBy<TaskInfo> { it.name != DEFAULT_TASK }.thenByDescending { it.mtime }).forEach { t ->
                add(buildJsonObject { put("name", t.name); put("steps", t.steps); put("talk", t.talk); put("mtime", t.mtime) })
            }
        }
    }

    /** The workspace's files were replaced underneath (import): reopen the session from disk. */
    fun reload(ws: String) = synchronized(lock) {
        if (workspace == ws) start(ws, task)
    }

    /** The workspace was renamed (to) or deleted (null): follow it, or close the session. */
    fun moved(from: String, to: String?) = synchronized(lock) {
        if (workspace != from) return@synchronized
        if (to != null) start(to, task)
        else {
            workspace = ""
            task = ""
            session++
            changed.value++
        }
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

    /**
     * Messages from before attachments kept one screenshot's annotations on the message itself: read them as one shot
     * attachment (note: the annotated image the old web UI drew). The file on disk stays as it is.
     */
    private fun upgrade(m: JsonObject): JsonObject {
        if (m["attachments"] != null || m.optStr("role") != "teacher") return m
        val marks = m.optArray("annotations") ?: JsonArray(emptyList())
        val note = m.optStr("note").orEmpty()
        val shot = m.optStr("screenshot").orEmpty().ifEmpty { note } // some old ones kept only the drawing
        val list = if (shot.isNotEmpty() && (marks.isNotEmpty() || note.isNotEmpty())) listOf(shotAttachment(shot, marks, note)) else emptyList()
        return JsonObject(m - setOf("annotations", "note", "screenshot", "view") + ("attachments" to JsonArray(list)))
    }

    private fun shotAttachment(file: String, annotations: JsonArray, note: String = "") = buildJsonObject {
        put("type", "shot")
        put("file", file)
        put("annotations", annotations)
        if (note.isNotEmpty()) put("note", note)
    }

    /** Workspace-relative path of a screenshot named in an attachment: as given, under teaching/, or in this task. */
    private fun shotPath(name: String): String {
        val ws = app.workspaces.dir(workspace)
        return listOf(name, "teaching/$name", "teaching/$task/$name")
            .firstOrNull { ".." !in it && File(ws, it).isFile } ?: throw IllegalArgumentException("没有这张截图：$name")
    }

    /**
     * Check an attachment and bring it to its stored shape. shot {file, annotations}: file "now" (the AI only) takes a
     * fresh screenshot. recording {rec, focus?: {from, to}}: a saved recording of this workspace, focus within its frames.
     */
    private fun attachment(e: JsonElement, now: Boolean): JsonObject {
        val a = e as? JsonObject ?: throw IllegalArgumentException("attachment is not an object: $e")
        return when (a.optStr("type")) {
            "shot" -> {
                val name = (a["file"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw IllegalArgumentException("shot needs file")
                val marks = annotations(a.optArray("annotations")) // checked before a screenshot is taken for nothing
                val file = if (name == "now" && now) capture().optStr("screenshot")!! else shotPath(name)
                shotAttachment(file, marks, a.optStr("note").orEmpty())
            }
            "recording" -> {
                val rec = a.optStr("rec") ?: throw IllegalArgumentException("recording needs rec")
                app.recordings.video(workspace, rec) // exists and is saved
                val frames = app.recordings.meta(workspace, rec).optInt("frames") ?: 0
                buildJsonObject {
                    put("type", "recording")
                    put("rec", rec)
                    (a["focus"] as? JsonObject)?.let { f ->
                        val from = f.optInt("from") ?: throw IllegalArgumentException("focus needs from")
                        val to = f.optInt("to") ?: from
                        require(from in 0..to && to < frames) { "focus $from–$to 不在录像里（0–${frames - 1}）" }
                        put("focus", buildJsonObject { put("from", from); put("to", to) })
                    }
                }
            }
            else -> throw IllegalArgumentException("unknown attachment type: ${a.optStr("type")}")
        }
    }

    private fun attachments(raw: JsonArray?, now: Boolean): List<JsonObject> = raw.orEmpty().map { attachment(it, now) }

    /** The old POST /teach body: annotations drawn on one screenshot; image: that drawing as a PNG data URL. */
    fun legacyAttachments(annotations: JsonArray, image: String, screenshot: String?): JsonArray {
        ensure()
        var note = ""
        if (image.startsWith(PNG_URL)) {
            val n = (shots().listFiles()?.count { it.name.startsWith("note-") } ?: 0) + 1
            val f = File(shots(), "note-%04d.png".format(n))
            f.writeAtomic(Base64.getDecoder().decode(image.substring(PNG_URL.length)))
            note = f.relativeTo(app.workspaces.dir(workspace)).invariantSeparatorsPath
        }
        val file = (screenshot?.takeIf { it.isNotEmpty() } ?: last).ifEmpty { note }
        if (file.isEmpty() || (annotations.isEmpty() && note.isEmpty())) return JsonArray(emptyList())
        return JsonArray(listOf(shotAttachment(file, annotations, note)))
    }

    /** A teacher message. Attachments from the tray (they carry its item id) leave it: a sent message is final. */
    fun teach(text: String, raw: JsonArray?): JsonObject {
        ensure()
        val list = attachments(raw, now = false)
        require(text.isNotBlank() || list.isNotEmpty()) { "消息不能既没有文字也没有附件" }
        val sent = raw.orEmpty().mapNotNull { (it as JsonObject).optLong("id") }.toSet()
        return synchronized(lock) {
            if (tray.removeAll { it.optLong("id") in sent }) saveTray()
            post(mapOf("role" to JsonPrimitive("teacher"), "text" to JsonPrimitive(text), "attachments" to JsonArray(list)))
        }
    }

    /** Task boundaries and the like. auto, so it neither locks the composer nor counts as a reply (unlock: it ends the wait). */
    private fun system(text: String, by: String, unlock: Boolean = false) = post(
        mapOf("role" to JsonPrimitive("system"), "text" to JsonPrimitive(text), "by" to JsonPrimitive(by), "auto" to JsonPrimitive(true)) +
            (if (unlock) mapOf("unlock" to JsonPrimitive(true)) else emptyMap()),
    )

    /**
     * AI reply, with attachments like the teacher's. It answers the teacher: the composer unlocks and a stop is over.
     * (Guard notices are marked auto: they do not count as answering.)
     */
    fun say(text: String, raw: JsonArray? = null): JsonObject {
        ensure()
        val list = attachments(raw, now = true)
        require(text.isNotBlank() || list.isNotEmpty()) { "消息不能既没有文字也没有附件" }
        return synchronized(lock) {
            stopped = false
            post(mapOf("role" to JsonPrimitive("ai"), "text" to JsonPrimitive(text), "attachments" to JsonArray(list)))
        }
    }

    /**
     * The teacher stops the AI while waiting for its reply. The AI is not listening then, so the app ends what runs now
     * and refuses its further actions (reads still work) until it explains itself with say.
     */
    fun stop(): JsonObject {
        synchronized(lock) {
            ensure()
            check(waiting()) { "没有在等 MaaLow 回复" }
            if (!stopped) system("老师叫停了", "teacher")
            stopped = true
        }
        app.skills.stop()
        app.engine.stopTask()
        return state()
    }

    /** The teacher gives up waiting (the AI seems stuck): unlock the composer, and tell the AI when it is back. */
    fun unlock(): JsonObject {
        synchronized(lock) {
            ensure()
            check(waiting()) { "没有在等 MaaLow 回复" }
            stopped = false
            system("老师跳过了等待", "teacher", unlock = true)
        }
        return state()
    }

    // ---- the tray: attachments the teacher is getting ready to send, kept per task so a reload or another page sees them

    fun tray(): JsonObject = synchronized(lock) {
        ensure()
        buildJsonObject { put("rev", trayRev); put("items", JsonArray(tray)) }
    }

    private fun saveTray() {
        trayRev++
        val f = File(dir(), "$task.tray.json")
        if (tray.isEmpty()) f.delete() else f.writeJson(buildJsonObject { put("items", JsonArray(tray)) })
        changed.value++
    }

    /** Put an attachment in the tray (shot with file "now": take the screenshot); returns the item, id included. */
    fun trayAdd(raw: JsonObject): JsonObject {
        ensure()
        val a = attachment(raw, now = true)
        return synchronized(lock) {
            val id = maxOf(System.currentTimeMillis(), (tray.maxOfOrNull { it.optLong("id") ?: 0 } ?: 0) + 1)
            val item = JsonObject(mapOf("id" to JsonPrimitive(id)) + a)
            tray.add(item)
            saveTray()
            item
        }
    }

    /** Change a tray item: a shot's annotations, a recording's focus (null: none). */
    fun trayEdit(id: Long, change: JsonObject): JsonObject {
        ensure()
        val i = synchronized(lock) { tray.indexOfFirst { it.optLong("id") == id } }
        if (i < 0) throw NoSuchElementException("托盘里没有这一项：$id")
        val old = tray[i]
        val a = attachment(JsonObject(old + change.filterKeys { it == "annotations" || it == "focus" }), now = false)
        return synchronized(lock) {
            val item = JsonObject(mapOf("id" to JsonPrimitive(id)) + a)
            val j = tray.indexOfFirst { it.optLong("id") == id }
            if (j < 0) throw NoSuchElementException("托盘里没有这一项：$id")
            tray[j] = item
            saveTray()
            item
        }
    }

    /** Take items out of the tray (all when ids is null); their screenshots go too unless something else uses them. */
    fun trayRemove(ids: Set<Long>?): JsonObject {
        synchronized(lock) {
            ensure()
            val gone = tray.filter { ids == null || it.optLong("id") in ids }
            if (gone.isEmpty()) return tray()
            tray.removeAll(gone.toSet())
            saveTray()
            gone.mapNotNull { if (it.optStr("type") == "shot") it.optStr("file") else null }.filterNot { used(it) }.forEach { f ->
                app.workspaces.file(workspace, f).delete()
                if (last == f) last = steps.lastOrNull()?.optStr("after").orEmpty()
            }
        }
        return tray()
    }

    /** A screenshot some message, step or tray item refers to. */
    private fun used(file: String): Boolean =
        messages.any { m -> m.optArray("attachments").orEmpty().any { (it as JsonObject).optStr("file") == file || it.optStr("note") == file } } ||
            steps.any { it.optStr("screenshot") == file || it.optStr("after") == file } ||
            tray.any { it.optStr("file") == file }

    /** Chat messages with since < id < before, at most the last [limit] of them. */
    fun since(n: Int, before: Int? = null, limit: Int? = null): List<JsonObject> = synchronized(lock) {
        ensure()
        val from = n.coerceIn(0, messages.size) // ids start at 1: id k is messages[k - 1]
        val to = ((before ?: Int.MAX_VALUE) - 1).coerceIn(from, messages.size)
        val range = messages.subList(from, to)
        (if (limit != null) range.takeLast(limit) else range).toList()
    }

    /** Wait for teacher messages not yet delivered to the AI. */
    /**
     * Short polls (at most [POLL_MAX_MS]): a listener that went away without closing its connection would otherwise
     * keep the web UI showing the AI online until its long timeout ran out.
     */
    suspend fun listen(timeoutMs: Long): List<JsonObject> {
        synchronized(lock) {
            ensure()
            listeners++
        }
        try {
            val end = System.currentTimeMillis() + timeoutMs.coerceAtMost(POLL_MAX_MS)
            var first = true
            while (true) {
                val seen = changed.value
                synchronized(lock) {
                    // teacher messages, and what the teacher did in the web UI (task switches, stop, skipping the wait)
                    val new = messages.drop(delivered).filter {
                        it.optStr("role") == "teacher" || (it.optStr("role") == "system" && it.optStr("by") == "teacher")
                    }
                    if (new.isNotEmpty()) {
                        delivered = messages.size
                        new.lastOrNull { it.optStr("role") == "teacher" }?.let { said ->
                            val shot = said.optArray("attachments").orEmpty().map { it.jsonObject }
                                .lastOrNull { it.optStr("type") == "shot" && it.optArray("annotations")?.isNotEmpty() == true }
                            pending = shot?.let { buildJsonObject { put("text", said.optStr("text").orEmpty()); put("annotations", it["annotations"]!!) } }
                        }
                        return new
                    }
                    // back to listening without answering what it was given (it forgot to say): unlock the teacher
                    if (first && waiting()) {
                        stopped = false
                        system("MaaLow 没有回复就回去等消息了，已自动解锁", "app", unlock = true)
                        delivered = messages.size
                    }
                    first = false
                }
                val left = end - System.currentTimeMillis()
                if (left <= 0) return emptyList()
                withTimeoutOrNull(left) { changed.first { it > seen } }
            }
        } finally {
            synchronized(lock) { listeners--; lastPoll = System.currentTimeMillis() }
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
        const val STOPPED = "stopped by teacher"
        val KINDS = setOf("rect", "circle", "arrow", "click", "region")
        const val DEFAULT_TASK = "explore" // the scratch task: where teaching starts and ending a task returns to
        const val NOTICE_WINDOW_MS = 30 * 60_000L
        const val POLL_MAX_MS = 25_000L
        const val POLL_GAP_MS = 5_000L // still online this long after a poll returned
    }
}
