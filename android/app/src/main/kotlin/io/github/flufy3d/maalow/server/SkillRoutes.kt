package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.store.optBool
import io.github.flufy3d.maalow.store.optLong
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.str
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Skills (workspace skills/<name>.js):
 *
 *     GET  /api/v1/skills?workspace=W          [{name, path, mtime, description, timeout, exports, recognition} | {..., error}]
 *     GET  /api/v1/skills/maalow.d.ts          the script API as TypeScript declarations
 *     POST /api/v1/skill/run {workspace?, name, args?, timeout?, wait?}
 *          {workspace, skill, trigger, ok, value | reason + error {name, message, file, line, column, stack}, ms, logs}
 *
 * A run holds the device lock (waiting for it) until the skill returns; POST /api/v1/stop ends it early.
 */
fun Route.skillRoutes(app: App) {
    fun workspaceOf(w: String?): String = w ?: app.defaultWorkspace() ?: error("no workspace")

    get("/api/v1/skills") {
        val ws = workspaceOf(call.query("workspace"))
        call.respondJson(withContext(Dispatchers.IO) { app.skills.list(ws) })
    }

    get("/api/v1/skills/maalow.d.ts") {
        call.respondBytes(app.skills.types, ContentType("application", "typescript"))
    }

    post("/api/v1/skill/run") {
        val b = call.body()
        val ws = workspaceOf(b.optStr("workspace"))
        val name = b.str("name")
        val args = b["args"] ?: JsonObject(emptyMap())
        val timeout = b.optLong("timeout")
        if (name !in app.skills.names(ws)) throw NoSuchElementException("no skill $name in $ws")
        if (b.optBool("wait") == false) {
            app.scope.launch { app.skills.run(ws, name, args, timeout) }
            call.respondJson(buildJsonObject { put("started", true) }, HttpStatusCode.Accepted)
        } else {
            call.respondJson(app.skills.run(ws, name, args, timeout))
        }
    }
}
