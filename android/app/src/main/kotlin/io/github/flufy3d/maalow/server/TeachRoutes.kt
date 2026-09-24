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
 *     GET  /api/v1/messages?since=N          chat log after message N
 *     GET  /api/v1/listen?timeout=S          block until new teacher messages arrive
 *     POST /api/v1/teach {text, annotations, image, screenshot}   teacher message drawn on a screenshot
 *     POST /api/v1/say   {text}              AI reply shown in the UI
 *     POST /api/v1/shot                      save a fresh screenshot
 *     POST /api/v1/task  {name, workspace?}  save the session and switch to another task
 *
 * act and run are in ApiServer (they also serve non-teaching callers).
 */
fun Route.teachRoutes(app: App) {
    val t = app.teaching

    get("/api/v1/state") { call.respondJson(t.state()) }

    get("/api/v1/messages") { call.respondJson(t.since(call.query("since")?.toInt() ?: 0)) }

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

    post("/api/v1/task") {
        val b = call.body()
        call.respondJson(t.task(b.str("name"), b.optStr("workspace")))
    }
}

const val MAX_POLL_S = 3600.0
