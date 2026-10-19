package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.teach.Teaching
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.partialcontent.PartialContent
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.path
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondText
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * The HTTP API shared by the web UI and the AI, under /api/v1. Every request except the web page itself needs the
 * token (Bearer header or ?token=). Route groups: device, teaching, files, workspaces, automation (guards,
 * schedules, runs, events), skills, recordings, remote, web.
 */
class ApiServer(private val app: App) {
    private var server: EmbeddedServer<*, *>? = null

    @Synchronized
    fun start() {
        if (server != null) return
        server = embeddedServer(CIO, port = App.PORT, host = "0.0.0.0") {
            install(createApplicationPlugin("Token") {
                onCall { call ->
                    val path = call.request.path()
                    // the UI's page and scripts: no data in them, the page calls the API with the token it remembered;
                    // the remote WebSocket takes the token in its first message (kept out of URLs and logs)
                    if (path == "/" || path.startsWith("/web/") || path == REMOTE_PATH) return@onCall
                    val auth = call.request.headers["Authorization"]?.removePrefix("Bearer ")?.trim()
                    val token = auth ?: call.request.queryParameters["token"]
                    if (token != app.token) call.respondJson(HttpStatusCode.Unauthorized, errorBody("bad or missing token"))
                    // the PC client marks its requests: the web UI shows how long ago the AI last did something
                    else if (call.request.headers[CLIENT_HEADER] == "cli" && path != "/api/v1/listen") app.teaching.aiActive(aiDoing(path))
                }
            })
            install(PartialContent) // video seeking in the replay page
            install(WebSockets) // the remote stage
            install(StatusPages) {
                exception<Throwable> { call, e ->
                    val code = when (e) {
                        is IllegalArgumentException -> HttpStatusCode.BadRequest
                        is NoSuchElementException -> HttpStatusCode.NotFound
                        is IllegalStateException -> HttpStatusCode.Conflict
                        else -> HttpStatusCode.InternalServerError
                    }
                    call.respondJson(code, errorBody(if (e is Teaching.Stopped) e.message.orEmpty() else "${e.javaClass.simpleName}: ${e.message}"))
                }
            }
            routing {
                deviceRoutes(app)
                teachRoutes(app)
                fileRoutes(app)
                workspaceRoutes(app)
                autoRoutes(app)
                skillRoutes(app)
                recordRoutes(app)
                remoteRoutes(app)
                webRoutes(app)
            }
        }.start(wait = false)
    }

    @Synchronized
    fun stop() {
        server?.stop(500, 1000)
        server = null
    }
}

fun errorBody(msg: String) = buildJsonObject { put("error", msg) }

/** Header the PC client (maalow CLI) sends with every request. */
const val CLIENT_HEADER = "X-MaaLow-Client"

/** What an AI request was, in a few words for the web UI. */
private fun aiDoing(path: String): String = when {
    path == "/api/v1/act" -> "操作"
    path == "/api/v1/run" -> "运行节点"
    path == "/api/v1/skill/run" -> "运行技能"
    path == "/api/v1/shot" || path == "/api/v1/screen" -> "截图"
    path == "/api/v1/say" -> "回复"
    path.startsWith("/api/v1/recordings") -> "看录像"
    path.startsWith("/api/v1/files/") -> "同步文件"
    path.startsWith("/api/v1/task") -> "切换任务"
    path.startsWith("/api/v1/record") -> "录制"
    path.startsWith("/api/v1/skills") -> "查看技能"
    path == "/api/v1/state" || path == "/api/v1/status" || path == "/api/v1/messages" -> "查看状态"
    else -> path.removePrefix("/api/v1/").substringBefore('/')
}

suspend fun ApplicationCall.body(): JsonObject {
    val text = receiveText()
    return if (text.isBlank()) JsonObject(emptyMap()) else Json.parseToJsonElement(text).jsonObject
}

fun ApplicationCall.query(name: String): String? = request.queryParameters[name]

suspend fun ApplicationCall.respondJson(body: JsonElement, status: HttpStatusCode = HttpStatusCode.OK) =
    respondText(body.toString(), ContentType.Application.Json, status)

suspend fun ApplicationCall.respondJson(status: HttpStatusCode, body: JsonElement) = respondJson(body, status)

suspend fun ApplicationCall.respondJson(list: List<JsonObject>) = respondJson(JsonArray(list))
