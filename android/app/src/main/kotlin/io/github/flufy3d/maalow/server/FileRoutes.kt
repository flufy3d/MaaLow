package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.store.optArray
import io.github.flufy3d.maalow.store.str
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.request.receiveStream
import io.ktor.server.response.header
import io.ktor.server.response.respondFile
import io.ktor.server.response.respondOutputStream
import io.ktor.server.routing.Route
import io.ktor.server.routing.RoutingCall
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File

/**
 * Workspace files, for `maalow ws import|export` and `maalow sync`:
 *
 *     GET    /api/v1/workspaces                        workspace names
 *     GET    /api/v1/files/{ws}/                       file tree: [{path, size, mtime, sha256}]
 *     GET    /api/v1/files/{ws}/{path}                 file content
 *     PUT    /api/v1/files/{ws}/{path}?mtime=MS        write (workspace.json first creates a workspace)
 *     DELETE /api/v1/files/{ws}/{path}
 *     POST   /api/v1/files/{ws}                        batch: zip of files + .batch.json {mtime: {path: ms}, delete: [path]}
 *     GET    /api/v1/workspaces/{ws}/export.zip
 *     POST   /api/v1/workspaces/{ws}/export.zip        {"paths": [...]}: only these files
 *     POST   /api/v1/workspaces/{ws}/import?mode=merge|replace   body: zip
 */
fun Route.fileRoutes(app: App) {
    val ws = app.workspaces

    get("/api/v1/workspaces") { call.respondJson(JsonArray(ws.list().map { JsonPrimitive(it) })) }

    get("/api/v1/files/{ws}") { call.respondJson(withContext(Dispatchers.IO) { ws.tree(call.ws()) }) }

    post("/api/v1/files/{ws}") {
        val result = withContext(Dispatchers.IO) { ws.batch(call.ws(), call.receiveStream()) }
        val paths = result["files"]!!.jsonArray.map { it.jsonObject.str("path") } +
            result["deleted"]!!.jsonArray.map { it.jsonPrimitive.content }
        if (paths.any { it.startsWith("teaching/") }) app.teaching.reload(call.ws())
        call.respondJson(result)
    }

    get("/api/v1/files/{ws}/{path...}") {
        val path = call.path()
        if (path.isEmpty()) return@get call.respondJson(withContext(Dispatchers.IO) { ws.tree(call.ws()) })
        val f = ws.file(call.ws(), path)
        if (!f.isFile) throw NoSuchElementException("no such file: $path")
        call.response.header("X-Mtime", f.lastModified().toString())
        call.respondFile(f)
    }

    put("/api/v1/files/{ws}/{path...}") {
        val mtime = call.query("mtime")?.toLong()
        val entry = withContext(Dispatchers.IO) { ws.write(call.ws(), call.path(), call.receiveStream(), mtime) }
        call.respondJson(entry)
    }

    delete("/api/v1/files/{ws}/{path...}") {
        val ok = withContext(Dispatchers.IO) { ws.delete(call.ws(), call.path()) }
        call.respondJson(buildJsonObject { put("deleted", ok) }, if (ok) HttpStatusCode.OK else HttpStatusCode.NotFound)
    }

    get("/api/v1/workspaces/{ws}/export.zip") {
        val name = call.ws()
        ws.existing(name)
        call.response.header("Content-Disposition", "attachment; filename=\"$name.zip\"")
        call.respondOutputStream(ContentType.Application.Zip) { ws.export(name, this) }
    }

    post("/api/v1/workspaces/{ws}/export.zip") {
        val name = call.ws()
        ws.existing(name)
        val paths = call.body().optArray("paths")?.map { it.jsonPrimitive.content }.orEmpty()
        call.respondOutputStream(ContentType.Application.Zip) { ws.export(name, this, paths) }
    }

    post("/api/v1/workspaces/{ws}/import") {
        val mode = call.query("mode") ?: "merge"
        require(mode == "merge" || mode == "replace") { "mode must be merge or replace" }
        val tmp = File.createTempFile("import", ".zip", app.cacheDir)
        try {
            val result = withContext(Dispatchers.IO) {
                tmp.outputStream().use { call.receiveStream().copyTo(it) }
                ws.import(call.ws(), tmp, replace = mode == "replace")
            }
            app.teaching.reload(call.ws())
            call.respondJson(result)
        } finally {
            tmp.delete()
        }
    }
}

private fun RoutingCall.ws(): String = parameters["ws"]!!

private fun RoutingCall.path(): String = parameters.getAll("path").orEmpty().joinToString("/")
