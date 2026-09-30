package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.store.optArray
import io.github.flufy3d.maalow.store.optBool
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.str
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Teaching session, same names as the PC teaching server:
 *
 *     GET  /api/v1/state                     current workspace, task, step count, last screenshot, AI presence
 *     GET  /api/v1/messages?since=N&before=M&limit=L   chat messages with N < id < M, the last L of them
 *     GET  /api/v1/listen?timeout=S          block until new teacher messages arrive
 *     POST /api/v1/teach {text, attachments}   teacher message; attachments from the tray carry their id and leave it
 *                                            (the old body {text, annotations, image, screenshot} still works)
 *     POST /api/v1/say   {text, attachments?}   AI reply; a shot with file "now" takes a fresh screenshot
 *     POST /api/v1/teach/stop                teacher stops the AI: what runs ends, AI actions are refused until it says
 *     POST /api/v1/teach/unlock              teacher skips waiting for the reply
 *     POST /api/v1/shot  {tray?}             save a fresh screenshot (tray: true, into the teacher's tray)
 *     GET  /api/v1/tray                      the teacher's unsent attachments: {rev, items: [{id, type, ...}]}
 *     POST /api/v1/tray  {attachment}        add one (a recording, or a shot with file "now")
 *     PUT  /api/v1/tray/{id} {annotations | focus}   change one
 *     DELETE /api/v1/tray/{id}, /api/v1/tray remove one, or all; their unsent screenshots are deleted
 *     GET  /api/v1/tasks?workspace=W         tasks in teaching/, explore then most recent: [{name, steps, mtime}]
 *     POST /api/v1/task  {name, workspace?, by?}   save the session and switch to another task ("explore" ends it);
 *                                            by=teacher (web UI) tells the AI through listen
 *     POST /api/v1/task/rename {name, by?}   rename the current task (from explore: save the draft as a task)
 *     POST /api/v1/task/delete {by?}         delete the current task's chat, steps and screenshots (explore: clear it)
 *
 * act and run are in ApiServer (they also serve non-teaching callers).
 */
fun Route.teachRoutes(app: App) {
    val t = app.teaching

    get("/api/v1/state") { call.respondJson(t.state()) }

    get("/api/v1/messages") {
        call.respondJson(t.since(call.query("since")?.toInt() ?: 0, call.query("before")?.toInt(), call.query("limit")?.toInt()))
    }

    get("/api/v1/listen") {
        val seconds = (call.query("timeout")?.toDouble() ?: 600.0).coerceIn(0.0, MAX_POLL_S)
        call.respondJson(t.listen((seconds * 1000).toLong()))
    }

    post("/api/v1/teach") {
        val b = call.body()
        val attachments = b.optArray("attachments")
            ?: t.legacyAttachments(b.optArray("annotations") ?: JsonArray(emptyList()), b.optStr("image").orEmpty(), b.optStr("screenshot"))
        call.respondJson(t.teach(b.optStr("text").orEmpty(), attachments))
    }

    post("/api/v1/say") {
        val b = call.body()
        call.respondJson(t.say(b.optStr("text").orEmpty(), b.optArray("attachments")))
    }

    post("/api/v1/teach/stop") { call.respondJson(t.stop()) }

    post("/api/v1/teach/unlock") { call.respondJson(t.unlock()) }

    post("/api/v1/shot") {
        if (call.body().optBool("tray") == true) call.respondJson(t.trayAdd(NOW_SHOT)) else call.respondJson(t.shot())
    }

    get("/api/v1/tray") { call.respondJson(t.tray()) }

    post("/api/v1/tray") { call.respondJson(t.trayAdd(call.body())) }

    put("/api/v1/tray/{id}") { call.respondJson(t.trayEdit(call.parameters["id"]!!.toLong(), call.body())) }

    delete("/api/v1/tray/{id}") { call.respondJson(t.trayRemove(setOf(call.parameters["id"]!!.toLong()))) }

    delete("/api/v1/tray") { call.respondJson(t.trayRemove(null)) }

    get("/api/v1/tasks") { call.respondJson(t.tasks(call.query("workspace"))) }

    post("/api/v1/task") {
        val b = call.body()
        call.respondJson(t.task(b.str("name"), b.optStr("workspace"), b.optStr("by") ?: "ai"))
    }

    post("/api/v1/task/rename") {
        val b = call.body()
        call.respondJson(t.rename(b.str("name"), b.optStr("by") ?: "ai"))
    }

    post("/api/v1/task/delete") { call.respondJson(t.delete(call.body().optStr("by") ?: "ai")) }
}

const val MAX_POLL_S = 3600.0

private val NOW_SHOT = buildJsonObject { put("type", "shot"); put("file", "now") }
