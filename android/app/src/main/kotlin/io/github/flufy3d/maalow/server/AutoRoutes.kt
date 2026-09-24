package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.auto.Schedule
import io.github.flufy3d.maalow.store.LenientJson
import io.github.flufy3d.maalow.store.optArray
import io.github.flufy3d.maalow.store.optBool
import io.github.flufy3d.maalow.store.optLong
import io.github.flufy3d.maalow.store.optStr
import io.ktor.http.HttpStatusCode
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Guards, schedules, runs and events:
 *
 *     GET  /api/v1/guards?workspace=W        {workspace, guards, enabled, interval_ms, last}
 *     PUT  /api/v1/guards {workspace?, guards?, enabled?, interval_ms?}
 *     GET  /api/v1/schedules[?workspace=W]   all schedules with their next occurrence
 *     GET|PUT|DELETE /api/v1/schedules/{ws}/{id}
 *     POST /api/v1/schedules/{ws}/{id}/trigger[?wait=false]   run now (same checks as an alarm)
 *     GET  /api/v1/runs?limit=N&workspace=W  latest first
 *     GET  /api/v1/events?since=ID&timeout=S&type=T   long poll
 */
fun Route.autoRoutes(app: App) {
    fun workspaceOf(w: String?): String = w ?: app.defaultWorkspace() ?: error("no workspace")

    fun guards(w: String): JsonObject = buildJsonObject {
        val s = app.settings()
        put("workspace", w)
        put("guards", JsonArray(app.workspaces.guards(w).map { JsonPrimitive(it) }))
        put("enabled", s.guardsEnabled)
        put("interval_ms", s.guardIntervalMs)
        put("last", app.guards.last)
    }

    get("/api/v1/guards") { call.respondJson(guards(workspaceOf(call.query("workspace")))) }

    put("/api/v1/guards") {
        val b = call.body()
        val w = workspaceOf(b.optStr("workspace"))
        b.optArray("guards")?.let { list -> app.workspaces.setGuards(w, list.map { it.jsonPrimitive.content }) }
        if (b.optBool("enabled") != null || b.optLong("interval_ms") != null) {
            app.updateSettings { s ->
                s.copy(guardsEnabled = b.optBool("enabled") ?: s.guardsEnabled, guardIntervalMs = b.optLong("interval_ms") ?: s.guardIntervalMs)
            }
        }
        call.respondJson(guards(w))
    }

    get("/api/v1/schedules") { call.respondJson(app.scheduler.list(call.query("workspace"))) }

    get("/api/v1/schedules/{ws}/{id}") {
        val w = call.parameters["ws"]!!
        val s = app.scheduler.get(w, call.parameters["id"]!!)
        call.respondJson(app.scheduler.list(w).first { it["id"]!!.jsonPrimitive.content == s.id })
    }

    put("/api/v1/schedules/{ws}/{id}") {
        val body = call.body()
        val s = LenientJson.decodeFromJsonElement(Schedule.serializer(), JsonObject(body + ("id" to JsonPrimitive(call.parameters["id"]!!))))
        call.respondJson(app.scheduler.put(call.parameters["ws"]!!, s))
    }

    delete("/api/v1/schedules/{ws}/{id}") {
        val ok = app.scheduler.delete(call.parameters["ws"]!!, call.parameters["id"]!!)
        call.respondJson(buildJsonObject { put("deleted", ok) }, if (ok) HttpStatusCode.OK else HttpStatusCode.NotFound)
    }

    post("/api/v1/schedules/{ws}/{id}/trigger") {
        val w = call.parameters["ws"]!!
        val id = call.parameters["id"]!!
        app.scheduler.get(w, id) // 404 before going async
        if (call.query("wait") == "false") {
            app.scope.launch { app.scheduler.trigger(w, id) }
            call.respondJson(buildJsonObject { put("started", true) }, HttpStatusCode.Accepted)
        } else {
            call.respondJson(app.scheduler.trigger(w, id))
        }
    }

    get("/api/v1/runs") {
        call.respondJson(app.scheduler.runs(call.query("limit")?.toInt() ?: 20, call.query("workspace")))
    }

    get("/api/v1/events") {
        val since = call.query("since")?.toLong() ?: 0
        val seconds = (call.query("timeout")?.toDouble() ?: 0.0).coerceIn(0.0, MAX_POLL_S)
        call.respondJson(app.events.wait(since, (seconds * 1000).toLong(), call.query("type")))
    }
}
