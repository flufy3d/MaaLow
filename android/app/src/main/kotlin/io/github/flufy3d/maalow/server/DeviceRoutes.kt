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
import io.ktor.http.ContentType
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** Device, engine and settings routes. */
fun Route.deviceRoutes(app: App) {
    val maalow = app.engine

    get("/api/v1/status") { call.respondJson(status(app)) }

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
            val ok = maalow.exclusive("act") { app.teaching.checkNotStopped(); maalow.act(action) }
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
            call.respondJson(maalow.exclusive("task:$w/$node") {
                app.teaching.checkNotStopped()
                val lease = maalow.lease
                app.teaching.ended(lease, maalow.run(w, node, once))
            })
        }
    }

    // Stops the running task and any running skill; the device lock is released as they end. From the web UI
    // (the top bar) it is the teacher's stop: an AI run it ends answers "stopped by teacher".
    post("/api/v1/stop") {
        if (call.request.headers[CLIENT_HEADER] != "cli") {
            call.respondJson(app.teaching.stopTask())
            return@post
        }
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

    get("/api/v1/settings") { call.respondJson(settings(app)) }

    // {workspace?, guards_enabled?, guard_interval_ms?, record_bitrate?, https_url?}
    put("/api/v1/settings") {
        val body = call.body()
        body.optStr("workspace")?.let { if (it.isEmpty()) app.updateSettings { s -> s.copy(workspace = "") } else app.useWorkspace(it) }
        app.updateSettings { s ->
            s.copy(
                guardsEnabled = body.optBool("guards_enabled") ?: s.guardsEnabled,
                guardIntervalMs = body.optLong("guard_interval_ms") ?: s.guardIntervalMs,
                recordBitrate = body.optInt("record_bitrate")?.also { require(it in 250_000..50_000_000) { "record_bitrate out of range" } }
                    ?: s.recordBitrate,
                httpsUrl = body.optStr("https_url")?.trim()?.trimEnd('/')
                    ?.also { require(it.isEmpty() || it.startsWith("https://")) { "https_url 要以 https:// 开头" } }
                    ?: s.httpsUrl,
            )
        }
        call.respondJson(settings(app))
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

private fun settings(app: App): JsonObject = buildJsonObject {
    val s = app.settings()
    put("workspace", app.defaultWorkspace())
    put("guards_enabled", s.guardsEnabled)
    put("guard_interval_ms", s.guardIntervalMs)
    put("record_bitrate", s.recordBitrate)
    put("https_url", s.httpsUrl)
}

private fun status(app: App): JsonObject = buildJsonObject {
    val maalow = app.engine
    put("app", BuildConfig.VERSION_NAME)
    put("maa", runCatching { Maa.version() }.getOrDefault(""))
    put("shizuku", ShizukuLink.state().name.lowercase())
    put("engine", maalow.state.name.lowercase())
    maalow.error?.let { put("error", it) }
    put("busy", maalow.busy)
    put("skills", JsonArray(app.skills.running.map { JsonPrimitive(it) }))
    put("record", app.recorder.state())
    put("remote", app.remote.json())
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
