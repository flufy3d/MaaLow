package io.github.flufy3d.maalow.server

import android.app.KeyguardManager
import android.app.NotificationManager
import android.os.PowerManager
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.BuildConfig
import io.github.flufy3d.maalow.KeepAlive
import io.github.flufy3d.maalow.MaaLowService
import io.github.flufy3d.maalow.engine.Bridge
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.engine.Maa
import io.github.flufy3d.maalow.engine.ShizukuLink
import io.github.flufy3d.maalow.store.optBool
import io.github.flufy3d.maalow.store.optInt
import io.github.flufy3d.maalow.store.optLong
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.str
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
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.routing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * The HTTP API shared by the web UI and the AI, under /api/v1. Every request except the web page itself needs the
 * token (Bearer header or ?token=). Route groups: device (here), teaching, files, automation (guards, schedules, events), web.
 */
class ApiServer(private val app: App) {
    private var server: EmbeddedServer<*, *>? = null
    private val maalow: Engine get() = app.engine

    @Synchronized
    fun start() {
        if (server != null) return
        server = embeddedServer(CIO, port = App.PORT, host = "0.0.0.0") {
            install(createApplicationPlugin("Token") {
                onCall { call ->
                    val path = call.request.path()
                    // the UI's page and scripts: no data in them, the page calls the API with the token it remembered
                    if (path == "/" || path.startsWith("/web/")) return@onCall
                    val auth = call.request.headers["Authorization"]?.removePrefix("Bearer ")?.trim()
                    val token = auth ?: call.request.queryParameters["token"]
                    if (token != app.token) call.respondJson(HttpStatusCode.Unauthorized, errorBody("bad or missing token"))
                    // the PC client marks its requests: the web UI shows how long ago the AI last did something
                    else if (call.request.headers[CLIENT_HEADER] == "cli" && path != "/api/v1/listen") app.teaching.aiActive(aiDoing(path))
                }
            })
            install(PartialContent) // video seeking in the replay page
            install(StatusPages) {
                exception<Throwable> { call, e ->
                    val code = when (e) {
                        is IllegalArgumentException -> HttpStatusCode.BadRequest
                        is NoSuchElementException -> HttpStatusCode.NotFound
                        is IllegalStateException -> HttpStatusCode.Conflict
                        else -> HttpStatusCode.InternalServerError
                    }
                    call.respondJson(code, errorBody(if (e is Teaching.Stopped) Teaching.STOPPED else "${e.javaClass.simpleName}: ${e.message}"))
                }
            }
            routing {
                deviceRoutes()
                teachRoutes(app)
                fileRoutes(app)
                workspaceRoutes(app)
                autoRoutes(app)
                skillRoutes(app)
                recordRoutes(app)
                webRoutes(app)
            }
        }.start(wait = false)
    }

    @Synchronized
    fun stop() {
        server?.stop(500, 1000)
        server = null
    }

    private fun Route.deviceRoutes() {
        get("/api/v1/status") { call.respondJson(status()) }

        get("/api/v1/screen") {
            val png = call.request.queryParameters["fmt"] == "png"
            val (seq, bytes) = withContext(Dispatchers.Default) {
                if (png) maalow.snapshotPng() else maalow.snapshotJpeg()
            }
            call.response.header("X-Frame", seq.toString())
            call.respondBytes(bytes, if (png) ContentType.Image.PNG else ContentType.Image.JPEG)
        }

        // {action, say?, wait?, record?}: recorded as a teaching step (with a screenshot after) unless record=false.
        post("/api/v1/act") {
            app.teaching.checkNotStopped()
            val body = call.body()
            val action = body["action"]!!.jsonObject
            if (body.optBool("record") != false) {
                call.respondJson(app.teaching.act(action, body.optStr("say").orEmpty(), body.optLong("wait") ?: 1500))
            } else {
                val ok = maalow.exclusive("act") { maalow.act(action) }
                call.respondJson(buildJsonObject { put("ok", ok) })
            }
        }

        // {node, once?, workspace?, record?}: in the teaching session (screenshot after) unless record=false.
        post("/api/v1/run") {
            app.teaching.checkNotStopped()
            val body = call.body()
            val node = body.str("node")
            val once = body.optBool("once") ?: true
            val ws = body.optStr("workspace")
            if (body.optBool("record") != false && (ws == null || ws == app.teaching.workspace)) {
                call.respondJson(app.teaching.run(node, once))
            } else {
                val w = ws ?: app.defaultWorkspace() ?: error("no workspace")
                call.respondJson(maalow.exclusive("task:$w/$node") { maalow.run(w, node, once) })
            }
        }

        // Stops the running task and any running skill; the device lock is released as they end.
        post("/api/v1/stop") {
            val skills = app.skills.stop()
            maalow.stopTask()
            call.respondJson(buildJsonObject {
                put("busy", maalow.busy)
                put("skills_stopped", skills)
            })
        }

        // Offline check of a node on a workspace image, e.g. {"workspace","node","path":"teaching/explore/0001.png"}
        post("/api/v1/check") {
            val body = call.body()
            val ws = body.str("workspace")
            val file = app.workspaces.file(ws, body.str("path"))
            require(file.isFile) { "no such image: ${body.str("path")}" }
            call.respondJson(maalow.check(ws, body.str("node"), file))
        }

        get("/api/v1/bench") {
            call.respondJson(maalow.bench(call.request.queryParameters["n"]?.toInt() ?: 20))
        }

        get("/api/v1/settings") { call.respondJson(settings()) }

        // {workspace?, guards_enabled?, guard_interval_ms?, record_bitrate?}
        put("/api/v1/settings") {
            val body = call.body()
            body.optStr("workspace")?.let { if (it.isEmpty()) app.updateSettings { s -> s.copy(workspace = "") } else app.useWorkspace(it) }
            app.updateSettings { s ->
                s.copy(
                    guardsEnabled = body.optBool("guards_enabled") ?: s.guardsEnabled,
                    guardIntervalMs = body.optLong("guard_interval_ms") ?: s.guardIntervalMs,
                    recordBitrate = body.optInt("record_bitrate")?.also { require(it in 250_000..50_000_000) { "record_bitrate out of range" } }
                        ?: s.recordBitrate,
                )
            }
            call.respondJson(settings())
        }

        // Same as the app's restart button; the supervisor reports the new state in /status a moment later.
        post("/api/v1/engine/restart") {
            MaaLowService.start(app, MaaLowService.ACTION_RESTART_ENGINE)
            call.respondJson(buildJsonObject { put("restarting", true) })
        }

        get("/api/v1/keepalive") {
            call.respondJson(buildJsonArray {
                KeepAlive.checks(app).forEach { c ->
                    add(buildJsonObject {
                        put("key", c.key)
                        put("label", c.label)
                        put("ok", c.ok)
                        put("detail", c.detail)
                    })
                }
            })
        }

        post("/api/v1/keepalive/fix") { call.respondJson(KeepAlive.fix(app, maalow)) }
    }

    private fun settings(): JsonObject = buildJsonObject {
        val s = app.settings()
        put("workspace", app.defaultWorkspace())
        put("guards_enabled", s.guardsEnabled)
        put("guard_interval_ms", s.guardIntervalMs)
        put("record_bitrate", s.recordBitrate)
    }

    private fun status(): JsonObject = buildJsonObject {
        put("app", BuildConfig.VERSION_NAME)
        put("maa", runCatching { Maa.version() }.getOrDefault(""))
        put("shizuku", ShizukuLink.state().name.lowercase())
        put("engine", maalow.state.name.lowercase())
        maalow.error?.let { put("error", it) }
        put("busy", maalow.busy)
        put("skills", JsonArray(app.skills.running.map { JsonPrimitive(it) }))
        put("record", app.recorder.state())
        put("workspace", app.defaultWorkspace())
        put("frame", buildJsonObject {
            put("width", maalow.width)
            put("height", maalow.height)
            if (maalow.state == Engine.State.RUNNING) {
                val s = Bridge.stats()
                put("seq", s.seq)
                put("age_ms", s.ageMs)
                put("convert_ms", s.convertMs)
                put("dropped", s.dropped)
            }
        })
        val km = app.getSystemService(KeyguardManager::class.java)
        put("screen_on", app.getSystemService(PowerManager::class.java).isInteractive)
        put("keyguard", buildJsonObject {
            put("locked", km.isKeyguardLocked)
            put("secure", km.isDeviceSecure)
        })
        put("keepalive", KeepAlive.json(app))
        put("guards", buildJsonObject {
            put("enabled", app.settings().guardsEnabled)
            put("last", app.guards.last)
        })
        put("next_alarm", app.scheduler.nextAlarm)
        put("alerts", buildJsonArray {
            app.getSystemService(NotificationManager::class.java).activeNotifications
                .filter { it.id == MaaLowService.ID_ALERT }
                .forEach { add(JsonPrimitive(it.notification.extras.getCharSequence("android.text")?.toString())) }
        })
        put("last_event", app.events.lastId)
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
    path.startsWith("/api/v1/files/") || path.startsWith("/api/v1/sync") -> "同步文件"
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
