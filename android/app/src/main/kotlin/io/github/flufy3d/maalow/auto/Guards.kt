package io.github.flufy3d.maalow.auto

import android.os.PowerManager
import android.util.Log
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.engine.Engine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Background guard loop: while the device is idle and the workspace's app is in front, check the guard nodes
 * (popups, idle screens) every interval and run the first that matches. Shares the device lock with tasks and
 * teaching, and never waits for it.
 */
class Guards(private val app: App) {
    private var job: Job? = null

    /** Outcome of the latest tick, for GET /guards. */
    @Volatile var last: JsonObject = buildJsonObject { put("result", "not_started") }
        private set
    private var lastError = ""

    fun start(scope: CoroutineScope) {
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                delay(app.settings().guardIntervalMs.coerceAtLeast(MIN_INTERVAL_MS))
                val result = try {
                    tick()
                } catch (e: Exception) {
                    val msg = "${e.javaClass.simpleName}: ${e.message}"
                    if (msg != lastError) {
                        Log.w(TAG, "guard check failed", e)
                        app.events.post("guard_error") { put("error", msg) }
                    }
                    lastError = msg
                    "error"
                }
                last = buildJsonObject {
                    put("time", System.currentTimeMillis())
                    put("result", result)
                }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    /** One check; returns what happened: a node name on a hit, else the reason it did nothing. */
    private suspend fun tick(): String {
        val s = app.settings()
        if (!s.guardsEnabled) return "disabled"
        val ws = app.defaultWorkspace() ?: return "no_workspace"
        val guards = app.workspaces.guards(ws)
        if (guards.isEmpty()) return "no_guards"
        val engine = app.engine
        if (engine.state != Engine.State.RUNNING) return "engine_${engine.state.name.lowercase()}"
        if (engine.busy != null) return "busy"
        if (!app.getSystemService(PowerManager::class.java).isInteractive) return "screen_off"
        val pkg = app.workspaces.packageOf(ws)
        if (pkg.isNotEmpty() && engine.foreground() != pkg) return "not_foreground"
        val hit = engine.tryExclusive("guard:$ws") {
            guards.firstOrNull { engine.run(ws, it, once = true)["hit"]!!.jsonPrimitive.boolean }.orEmpty()
        } ?: return "busy"
        if (hit.isEmpty()) return "no_match"
        lastError = ""
        app.events.post("guard") {
            put("workspace", ws)
            put("node", hit)
        }
        app.teaching.onGuard(ws, hit)
        return hit
    }

    companion object {
        const val TAG = "MaaLowGuards"
        const val MIN_INTERVAL_MS = 500L
    }
}
