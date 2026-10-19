package io.github.flufy3d.maalow.auto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

/** One entry of a workspace's schedules.json. */
@Serializable
data class Schedule(
    val id: String = "",
    /** Pipeline entry node to run to completion; or: */
    val node: String = "",
    /** Skill (skills/<name>.js) to run, with args. */
    val skill: String = "",
    val args: JsonObject = JsonObject(emptyMap()),
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
        require(node.isNotEmpty() != skill.isNotEmpty()) { "give either node or skill" }
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
