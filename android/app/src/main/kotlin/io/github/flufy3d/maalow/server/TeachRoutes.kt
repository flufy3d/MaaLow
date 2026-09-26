package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.store.optArray
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.str
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.serialization.json.JsonArray

/**
 * Teaching session, same names as the PC teaching server:
 *
 *     GET  /api/v1/state                     current workspace, task, step count, last screenshot, AI presence
 *     GET  /api/v1/messages?since=N&before=M&limit=L   chat messages with N < id < M, the last L of them
 *     GET  /api/v1/listen?timeout=S          block until new teacher messages arrive
 *     POST /api/v1/teach {text, annotations, image, screenshot}   teacher message drawn on a screenshot
 *     POST /api/v1/say   {text}              AI reply shown in the UI
 *     POST /api/v1/shot                      save a fresh screenshot
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
        call.respondJson(
            t.teach(b.optStr("text").orEmpty(), b.optArray("annotations") ?: JsonArray(emptyList()), b.optStr("image").orEmpty(), b.optStr("screenshot")),
        )
    }

    post("/api/v1/say") { call.respondJson(t.say(call.body().str("text"))) }

    post("/api/v1/shot") { call.respondJson(t.shot()) }

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
