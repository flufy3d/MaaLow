package io.github.flufy3d.maalow.skill

import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.engine.Maa
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService

/**
 * Workspace skills: skills/<name>.js, ES modules run on QuickJS with the API in assets/skill/maalow.d.ts.
 *
 *     export const meta = { description: "...", timeout: 30000 }
 *     export default function (args, ctx) { ... }    // custom action, standalone run
 *     export function recognize(args, ctx) { ... }    // custom recognition (optional)
 *
 * Every skill is registered with Maa as custom action "name" and custom recognition "name.recognize" (the two share
 * one namespace), so pipeline nodes use it with "action": "Custom", "custom_action": name, custom_action_param being
 * the args (or "recognition": "Custom", "custom_recognition": "name.recognize", custom_recognition_param). A
 * standalone run is a one-node task doing just that (Engine.runSkill), so a skill always runs on the tasker's thread
 * inside a Maa context, under the device lock of whoever started the task. Code is read from disk on every run: a
 * synced file takes effect on the next run.
 */
class Skills(private val app: App) : Maa.Custom {
    internal val prelude: ByteArray by lazy { app.assets.open(PRELUDE_ASSET).use { it.readBytes() } }

    /** maalow.d.ts: the script API for editors and `maalow sync`. */
    val types: ByteArray by lazy { app.assets.open(TYPES_ASSET).use { it.readBytes() } }

    internal val timer: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { Thread(it, "maalow-skill-timer").apply { isDaemon = true } }
    internal val memoryLock = Any()
    private val active = CopyOnWriteArraySet<SkillRun>()

    /** Options of the standalone run in progress, picked up by the custom action of its one-node task. */
    private class Request(val timeoutMs: Long?, val trigger: String) {
        @Volatile var outcome: JsonObject? = null
    }

    @Volatile private var request: Request? = null

    private class Listing(val stamp: Long, val list: List<JsonObject>)

    private val listings = ConcurrentHashMap<String, Listing>()

    fun names(ws: String): List<String> = names(app.workspaces.existing(ws))

    /** Running skills, "workspace/name". */
    val running: List<String> get() = active.map { it.label }

    /**
     * Skills of a workspace: name, path, mtime, meta and exports, or the error loading hit (with file and line).
     * Loading runs each module's top-level code, without device access.
     */
    fun list(ws: String): List<JsonObject> {
        val dir = File(app.workspaces.existing(ws), DIR)
        val stamp = stamp(dir)
        listings[ws]?.let { if (it.stamp == stamp) return it.list }
        val list = names(ws).map { name ->
            val f = File(dir, "$name.js")
            buildJsonObject {
                put("name", name)
                put("path", "$DIR/${f.name}")
                put("mtime", f.lastModified())
                try {
                    val d = SkillRun(app, this@Skills, ws, 0L, "list").use { it.describe(name) }
                    val meta = d["meta"]!!.jsonObject
                    put("description", meta["description"] ?: JsonPrimitive(""))
                    put("timeout", meta["timeout"] ?: JsonPrimitive(SkillRun.DEFAULT_TIMEOUT_MS))
                    put("exports", d["exports"]!!)
                    put("recognition", d["exports"]!!.jsonArray.any { it.jsonPrimitive.content == "recognize" })
                } catch (e: SkillError) {
                    put("error", e.error)
                }
            }
        }
        listings[ws] = Listing(stamp, list)
        return list
    }

    /** Run a skill on its own (API, schedule): takes the device lock, waiting while it is busy. */
    suspend fun run(ws: String, name: String, args: JsonElement, timeoutMs: Long? = null, trigger: String = "api"): JsonObject {
        if (name !in names(ws)) throw NoSuchElementException("no skill $name in $ws")
        return app.engine.exclusive("skill:$ws/$name") {
            val req = Request(timeoutMs, trigger)
            request = req
            val task = try {
                app.engine.runSkill(ws, name, args)
            } finally {
                request = null
            }
            req.outcome ?: buildJsonObject {
                put("workspace", ws)
                put("skill", name)
                put("trigger", trigger)
                put("ok", false)
                put("reason", "not_run")
                put("error", buildJsonObject { put("message", "the skill did not run (task ${task["status"]})") })
            }
        }
    }

    /** Stop every running skill (they end at their next step); returns how many there were. */
    fun stop(): Int {
        val runs = active.toList()
        runs.forEach { it.stop() }
        return runs.size
    }

    // ---- Maa custom action / recognition

    override fun action(context: Long, taskId: Long, node: String, name: String, param: String, recoId: Long, box: IntArray): Boolean {
        val ws = app.engine.loadedWorkspace ?: return false
        val req = if (node == Engine.SKILL_NODE) request else null
        val ctx = buildJsonObject {
            if (req == null) put("node", node)
            put("box", if (req == null && (box[2] > 0 || box[3] > 0)) boxJson(box) else JsonNull) // not the one-node task's DirectHit
        }
        val out = execute(ws, name, "default", args(param), ctx, context, req?.timeoutMs, req?.trigger ?: "pipeline", 0L)
        req?.outcome = out
        return out["ok"]?.jsonPrimitive?.booleanOrNull == true && out["value"] != JsonPrimitive(false)
    }

    override fun recognition(
        context: Long, taskId: Long, node: String, name: String, param: String, image: Long, roi: IntArray, out: IntArray,
    ): String? {
        val ws = app.engine.loadedWorkspace ?: return null
        val skill = name.removeSuffix(RECOGNIZE)
        val ctx = buildJsonObject {
            put("node", node)
            put("roi", boxJson(roi))
            put("image", buildJsonObject {
                put("id", 0)
                put("width", app.engine.width)
                put("height", app.engine.height)
            })
        }
        val r = execute(ws, skill, "recognize", args(param), ctx, context, null, "recognition", image)
        if (r["ok"]?.jsonPrimitive?.booleanOrNull != true) return null
        // A hit is true, a box, or {box?, hit?, ...}; null, false or {hit: false} is a miss.
        val v = r["value"]
        val box = when {
            v == null || v is JsonNull -> return null
            v is JsonPrimitive -> if (v.booleanOrNull == false) return null else roi
            v is JsonArray -> boxOf(v) ?: roi
            v is JsonObject -> {
                if (v["hit"]?.jsonPrimitive?.booleanOrNull == false) return null
                (v["box"] as? JsonArray)?.let { boxOf(it) } ?: roi
            }
            else -> roi
        }
        box.copyInto(out)
        return (v as? JsonObject ?: buildJsonObject { put("value", v) }).toString()
    }

    private fun execute(
        ws: String, name: String, export: String, args: JsonElement, ctx: JsonObject, context: Long, timeoutMs: Long?,
        trigger: String, image: Long,
    ): JsonObject {
        val run = SkillRun(app, this, ws, context, trigger)
        active += run
        try {
            return run.top(name, export, args, ctx, timeoutMs, image)
        } finally {
            active -= run
            run.close()
        }
    }

    private fun args(param: String): JsonElement =
        if (param.isBlank()) JsonObject(emptyMap()) else runCatching { Json.parseToJsonElement(param) }.getOrElse { JsonPrimitive(param) }

    private fun boxJson(b: IntArray) = buildJsonArray { b.forEach { add(JsonPrimitive(it)) } }

    private fun boxOf(a: JsonArray): IntArray? =
        a.takeIf { it.size == 4 }?.map { it.jsonPrimitive.intOrNull ?: return null }?.toIntArray()

    companion object {
        const val DIR = "skills"
        const val PRELUDE_ASSET = "skill/prelude.js"
        const val TYPES_ASSET = "skill/maalow.d.ts"
        /** Suffix of a skill's custom recognition name. */
        const val RECOGNIZE = ".recognize"
        val NAME = Regex("^[A-Za-z0-9_][A-Za-z0-9_-]*$")

        /** Skill names in a workspace directory: skills/<name>.js at the top level (subdirectories hold libraries). */
        fun names(ws: File): List<String> =
            File(ws, DIR).listFiles()?.filter { it.isFile && it.name.endsWith(".js") }?.map { it.name.removeSuffix(".js") }
                ?.filter { NAME.matches(it) }?.sorted() ?: emptyList()

        /** Changes whenever a file under skills/ is added, removed, resized or touched. */
        private fun stamp(dir: File): Long =
            dir.walkTopDown().filter { it.isFile }.sortedBy { it.path }
                .fold(17L) { h, f -> ((h * 31 + f.path.hashCode()) * 31 + f.length()) * 31 + f.lastModified() }
    }
}
