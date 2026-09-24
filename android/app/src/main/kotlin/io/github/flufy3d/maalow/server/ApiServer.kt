package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.BuildConfig
import io.github.flufy3d.maalow.engine.Bridge
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.engine.Maa
import io.github.flufy3d.maalow.engine.ShizukuLink
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.receiveText
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File

/** The HTTP API shared by the web UI and the AI. Every request needs the token. */
class ApiServer(private val app: App) {
    private var server: EmbeddedServer<*, *>? = null
    private val maalow: Engine get() = app.engine

    @Synchronized
    fun start() {
        if (server != null) return
        server = embeddedServer(CIO, port = App.PORT, host = "0.0.0.0") {
            install(createApplicationPlugin("Token") {
                onCall { call ->
                    val auth = call.request.headers["Authorization"]?.removePrefix("Bearer ")?.trim()
                    val token = auth ?: call.request.queryParameters["token"]
                    if (token != app.token) call.respondJson(HttpStatusCode.Unauthorized, error("bad or missing token"))
                }
            })
            install(StatusPages) {
                exception<Throwable> { call, e ->
                    val code = if (e is IllegalArgumentException) HttpStatusCode.BadRequest else HttpStatusCode.InternalServerError
                    call.respondJson(code, error("${e.javaClass.simpleName}: ${e.message}"))
                }
            }
            routing {
                get("/api/v1/status") { call.respondJson(status()) }

                get("/api/v1/screen") {
                    val png = call.request.queryParameters["fmt"] == "png"
                    val (seq, bytes) = withContext(Dispatchers.Default) {
                        if (png) maalow.snapshotPng() else maalow.snapshotJpeg()
                    }
                    call.response.header("X-Frame", seq.toString())
                    call.respondBytes(bytes, if (png) ContentType.Image.PNG else ContentType.Image.JPEG)
                }

                post("/api/v1/act") {
                    val body = call.body()
                    val ok = maalow.act(body["action"]!!.jsonObject)
                    call.respondJson(buildJsonObject { put("ok", ok) })
                }

                post("/api/v1/run") {
                    val body = call.body()
                    val once = body["once"]?.jsonPrimitive?.boolean ?: true
                    call.respondJson(maalow.run(body.str("workspace"), body.str("node"), once))
                }

                // Offline check of a node on a workspace image, e.g. {"workspace","node","path":"teaching/explore/0001.png"}
                post("/api/v1/check") {
                    val body = call.body()
                    val ws = body.str("workspace")
                    val file = File(File(maalow.workspaces, ws), body.str("path")).canonicalFile
                    check(file.path.startsWith(File(maalow.workspaces, ws).canonicalPath) && file.isFile) { "bad path" }
                    call.respondJson(maalow.check(ws, body.str("node"), file))
                }

                get("/api/v1/bench") {
                    call.respondJson(maalow.bench(call.request.queryParameters["n"]?.toInt() ?: 20))
                }
            }
        }.start(wait = false)
    }

    @Synchronized
    fun stop() {
        server?.stop(500, 1000)
        server = null
    }

    private fun status(): JsonObject = buildJsonObject {
        put("app", BuildConfig.VERSION_NAME)
        put("maa", runCatching { Maa.version() }.getOrDefault(""))
        put("shizuku", ShizukuLink.state().name.lowercase())
        put("engine", maalow.state.name.lowercase())
        maalow.error?.let { put("error", it) }
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
    }

    private fun error(msg: String) = buildJsonObject { put("error", msg) }

    private suspend fun ApplicationCall.body(): JsonObject {
        val text = receiveText()
        return if (text.isBlank()) JsonObject(emptyMap()) else Json.parseToJsonElement(text).jsonObject
    }

    private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.content ?: throw IllegalArgumentException("missing $key")
}

suspend fun ApplicationCall.respondJson(body: JsonElement, status: HttpStatusCode = HttpStatusCode.OK) =
    respondText(body.toString(), ContentType.Application.Json, status)

suspend fun ApplicationCall.respondJson(status: HttpStatusCode, body: JsonElement) = respondJson(body, status)
