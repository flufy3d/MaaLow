package io.github.flufy3d.maalow.auto

import android.app.AlarmManager
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.Intent
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.util.Log
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.MainActivity
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.engine.ShizukuLink
import io.github.flufy3d.maalow.store.LenientJson
import io.github.flufy3d.maalow.store.PrettyJson
import io.github.flufy3d.maalow.store.readJsonObject
import io.github.flufy3d.maalow.store.writeAtomic
import io.github.flufy3d.maalow.store.writeJson
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.io.File
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

/** One entry of a workspace's schedules.json. */
@Serializable
data class Schedule(
    val id: String = "",
    /** Pipeline entry node to run to completion. */
    val node: String = "",
    /** Local time of day, "HH:mm". */
    val at: String = "",
    /** ISO weekdays (1 = Monday ... 7 = Sunday); empty means every day. */
    val days: List<Int> = emptyList(),
    val enabled: Boolean = true,
    /** Start the workspace's app first when it is not in front. */
    val launch: Boolean = true,
    /** How long to wait for the launched app to come to the front. */
    @SerialName("launch_wait_s") val launchWaitS: Int = 60,
    val note: String = "",
) {
    fun time(): LocalTime = LocalTime.parse(at)

    fun validate(): Schedule {
        require(ID.matches(id)) { "bad schedule id: $id" }
        require(node.isNotEmpty()) { "missing node" }
        require(runCatching { time() }.isSuccess) { "bad time: $at (want HH:mm)" }
        require(days.all { it in 1..7 }) { "days must be 1..7" }
        return this
    }

    /** First occurrence strictly after t (epoch ms). */
    fun next(t: Long, zone: ZoneId = ZoneId.systemDefault()): Long? {
        val day = Instant.ofEpochMilli(t).atZone(zone).toLocalDate()
        return (0L..8L).asSequence().map { day.plusDays(it) }
            .filter { days.isEmpty() || it.dayOfWeek.value in days }
            .map { it.atTime(time()).atZone(zone).toInstant().toEpochMilli() }
            .firstOrNull { it > t }
    }

    /** Latest occurrence at or before t. */
    fun prev(t: Long, zone: ZoneId = ZoneId.systemDefault()): Long? {
        val day = Instant.ofEpochMilli(t).atZone(zone).toLocalDate()
        return (0L..8L).asSequence().map { day.minusDays(it) }
            .filter { days.isEmpty() || it.dayOfWeek.value in days }
            .map { it.atTime(time()).atZone(zone).toInstant().toEpochMilli() }
            .firstOrNull { it <= t }
    }

    companion object {
        val ID = Regex("^[A-Za-z0-9_.-]+$")
    }
}

@Serializable
data class ScheduleFile(val schedules: List<Schedule> = emptyList())

/**
 * Timed tasks from every workspace's schedules.json. One exact alarm (setAlarmClock) is kept for the earliest
 * occurrence; when it fires the service calls [onAlarm], which runs what is due and sets the next alarm.
 * Runs go to runs.jsonl and the event log. Before running: Shizuku must be up, the screen is woken, a secure
 * keyguard means skip (never unlock), and the app is launched if it is not in front.
 */
class Scheduler(private val app: App) {
    private val stateFile = File(app.storeDir, "scheduler.json") // {"handled": {"ws/id": epoch ms}}
    private val runsFile = File(app.storeDir, "runs.jsonl")
    private val alarmLock = Mutex()
    private val runLock = Mutex()

    @Volatile var nextAlarm: Long? = null
        private set

    private fun file(ws: String) = File(app.workspaces.existing(ws), FILE)

    fun load(ws: String): List<Schedule> {
        val f = file(ws)
        if (!f.isFile) return emptyList()
        return LenientJson.decodeFromString(ScheduleFile.serializer(), f.readText()).schedules
    }

    private fun save(ws: String, list: List<Schedule>) {
        file(ws).writeAtomic((PrettyJson.encodeToString(ScheduleFile.serializer(), ScheduleFile(list)) + "\n").toByteArray())
    }

    private fun all(): List<Pair<String, Schedule>> = app.workspaces.list().flatMap { ws ->
        runCatching { load(ws) }.onFailure { Log.w(TAG, "bad $FILE in $ws", it) }.getOrDefault(emptyList()).map { ws to it }
    }

    private fun key(ws: String, s: Schedule) = "$ws/${s.id}"

    // ---- handled marks: an occurrence at or before the mark is done (run, skipped or created later)

    private fun handled(): MutableMap<String, Long> = synchronized(stateFile) {
        readJsonObject(stateFile)?.get("handled")?.jsonObject?.mapValues { it.value.jsonPrimitive.long }?.toMutableMap()
            ?: mutableMapOf()
    }

    private fun mark(marks: Map<String, Long>) = synchronized(stateFile) {
        val h = handled()
        h.putAll(marks)
        stateFile.writeJson(buildJsonObject { put("handled", JsonObject(h.mapValues { JsonPrimitive(it.value) })) })
    }

    // ---- CRUD

    fun list(ws: String? = null): List<JsonObject> {
        val now = System.currentTimeMillis()
        return (if (ws == null) all() else load(ws).map { ws to it }).map { (w, s) -> describe(w, s, now) }
    }

    private fun describe(ws: String, s: Schedule, now: Long): JsonObject {
        val base = LenientJson.encodeToJsonElement(Schedule.serializer(), s).jsonObject
        return JsonObject(base + mapOf(
            "workspace" to JsonPrimitive(ws),
            "next" to JsonPrimitive(if (s.enabled) s.next(now) else null),
        ))
    }

    fun get(ws: String, id: String): Schedule = load(ws).firstOrNull { it.id == id } ?: throw NoSuchElementException("no schedule $ws/$id")

    /** Create or replace a schedule; its past occurrences never count as missed. */
    fun put(ws: String, s: Schedule): JsonObject = synchronized(this) {
        s.validate()
        save(ws, load(ws).filter { it.id != s.id } + s)
        mark(mapOf(key(ws, s) to System.currentTimeMillis()))
        reschedule()
        describe(ws, s, System.currentTimeMillis())
    }

    fun delete(ws: String, id: String): Boolean = synchronized(this) {
        val list = load(ws)
        if (list.none { it.id == id }) return false
        save(ws, list.filter { it.id != id })
        reschedule()
        true
    }

    // ---- alarm

    /** Set the alarm for the earliest enabled occurrence (or cancel it). */
    fun reschedule() {
        val now = System.currentTimeMillis()
        val h = handled()
        val next = all().filter { it.second.enabled }
            .mapNotNull { (ws, s) -> runCatching { s.next(maxOf(now, h[key(ws, s)] ?: 0)) }.getOrNull() }.minOrNull()
        val am = app.getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(
            app, 0, Intent(app, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_ALARM),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        if (next == null) {
            am.cancel(pi)
        } else if (am.canScheduleExactAlarms()) {
            val show = PendingIntent.getActivity(app, 0, Intent(app, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            am.setAlarmClock(AlarmManager.AlarmClockInfo(next, show), pi)
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi) // inexact fallback; shown in keepalive checks
        }
        nextAlarm = next
        Log.i(TAG, "next alarm: ${next?.let { Instant.ofEpochMilli(it) }}")
    }

    /** Run everything due now (a little early is fine), record older misses, then set the next alarm. */
    suspend fun onAlarm() {
        val due = alarmLock.withLock {
            val now = System.currentTimeMillis()
            val h = handled()
            val due = ArrayList<Triple<String, Schedule, Long>>()
            val touched = HashMap<String, Long>()
            for ((ws, s) in all()) {
                if (!s.enabled) continue
                val p = runCatching { s.prev(now + EARLY_MS) }.getOrNull() ?: continue
                if (p <= (h[key(ws, s)] ?: 0)) continue
                touched[key(ws, s)] = maxOf(now, p) // an early alarm must not bring the same occurrence back
                if (now - p > GRACE_MS) record(ws, s, "alarm", p, System.currentTimeMillis(), "skipped", "missed")
                else due += Triple(ws, s, p)
            }
            if (touched.isNotEmpty()) mark(touched)
            reschedule()
            due
        }
        for ((ws, s, p) in due) execute(ws, s, "alarm", p)
    }

    suspend fun trigger(ws: String, id: String): JsonObject = execute(ws, get(ws, id), "manual", null)

    private suspend fun execute(ws: String, s: Schedule, trigger: String, planned: Long?): JsonObject = runLock.withLock {
        val start = System.currentTimeMillis()
        val engine = app.engine
        fun done(status: String, reason: String? = null, extra: JsonObjectBuilder.() -> Unit = {}) =
            record(ws, s, trigger, planned, start, status, reason, extra)
        try {
            ShizukuLink.settle()
            when (ShizukuLink.state()) {
                ShizukuLink.State.NOT_RUNNING -> return done("skipped", "shizuku_not_running")
                ShizukuLink.State.NO_PERMISSION -> return done("skipped", "shizuku_no_permission")
                ShizukuLink.State.READY -> Unit
            }
            // A cold start (the alarm restarted the process) brings the engine up in a few seconds.
            withTimeoutOrNull(ENGINE_WAIT_MS) { while (engine.state != Engine.State.RUNNING) delay(200) }
                ?: return done("skipped", "engine_not_running") { engine.error?.let { put("error", it) } }

            val power = app.getSystemService(PowerManager::class.java)
            val woke = !power.isInteractive
            if (woke) {
                engine.act(buildJsonObject { put("type", "wake") })
                withTimeoutOrNull(3000) { while (!power.isInteractive) delay(100) }
                delay(1000)
            }
            val km = app.getSystemService(KeyguardManager::class.java)
            if (km.isKeyguardLocked) {
                if (km.isDeviceSecure) return done("skipped", "keyguard_secure") { put("woke", woke) }
                engine.shell("wm dismiss-keyguard") // swipe-only keyguard
                delay(1000)
            }

            val pkg = app.workspaces.packageOf(ws)
            var launched = false
            if (s.launch && pkg.isNotEmpty() && engine.foreground() != pkg) {
                engine.act(buildJsonObject { put("type", "start_app"); put("package", pkg) })
                launched = true
                withTimeoutOrNull(s.launchWaitS * 1000L) { while (engine.foreground() != pkg) delay(1000) }
                    ?: return done("failed", "launch_timeout") { put("woke", woke) }
            }

            val result = engine.exclusive("task:$ws/${s.node}") { engine.run(ws, s.node, once = false) }
            val hit = result["hit"]!!.jsonPrimitive.boolean
            done(if (hit) "ok" else "failed", if (hit) null else "task_failed") {
                put("woke", woke)
                put("launched", launched)
                put("nodes", result["nodes"]!!)
            }
        } catch (e: Exception) {
            Log.e(TAG, "run ${key(ws, s)} failed", e)
            done("error", "exception") { put("error", "${e.javaClass.simpleName}: ${e.message}") }
        }
    }

    private fun record(
        ws: String, s: Schedule, trigger: String, planned: Long?, start: Long, status: String, reason: String?,
        extra: JsonObjectBuilder.() -> Unit = {},
    ): JsonObject {
        val run = buildJsonObject {
            put("id", "$start-${s.id}")
            put("workspace", ws)
            put("schedule", s.id)
            put("node", s.node)
            put("trigger", trigger)
            planned?.let { put("planned", it) }
            put("start", start)
            put("end", System.currentTimeMillis())
            put("status", status)
            reason?.let { put("reason", it) }
            put("pid", Process.myPid())
            put("process_age_ms", SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime())
            extra()
        }
        synchronized(runsFile) { runsFile.appendText(run.toString() + "\n") }
        app.events.post("run") { run.forEach { (k, v) -> if (k != "id") put(k, v) }; put("run", run["id"]!!) }
        Log.i(TAG, "run: $run")
        return run
    }

    /** Latest runs first. */
    fun runs(limit: Int, ws: String? = null): List<JsonObject> = synchronized(runsFile) {
        if (!runsFile.isFile) return emptyList()
        runsFile.readLines().asReversed().asSequence().filter { it.isNotBlank() }
            .map { PrettyJson.parseToJsonElement(it).jsonObject }
            .filter { ws == null || it["workspace"]?.jsonPrimitive?.content == ws }
            .take(limit).toList()
    }

    companion object {
        const val TAG = "MaaLowScheduler"
        const val FILE = "schedules.json"
        const val EARLY_MS = 60_000L
        const val GRACE_MS = 30 * 60_000L
        const val ENGINE_WAIT_MS = 30_000L
    }
}
