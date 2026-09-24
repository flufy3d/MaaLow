package io.github.flufy3d.maalow.store

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.long
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File

/**
 * Append-only event log (guard hits, task runs, skips, Shizuku and engine changes) kept in memory for long polls
 * and in events.jsonl on disk. Ids keep counting across restarts.
 */
class Events(private val file: File) {
    private val recent = ArrayDeque<JsonObject>()
    private val last = MutableStateFlow(0L)
    private var lines = 0

    init {
        if (file.isFile) {
            val all = file.readLines().filter { it.isNotBlank() }
            lines = all.size
            all.takeLast(KEEP).mapNotNull { runCatching { Json.parseToJsonElement(it).jsonObject }.getOrNull() }
                .forEach { recent.addLast(it) }
            last.value = recent.lastOrNull()?.get("id")?.jsonPrimitive?.long ?: 0
        }
    }

    fun post(type: String, fields: JsonObjectBuilder.() -> Unit = {}): JsonObject = synchronized(this) {
        val event = buildJsonObject {
            put("id", last.value + 1)
            put("time", System.currentTimeMillis())
            put("type", type)
            fields()
        }
        recent.addLast(event)
        if (recent.size > KEEP) recent.removeFirst()
        file.appendText(event.toString() + "\n")
        if (++lines > KEEP * 4) { // trim the file now and then
            file.writeAtomic(recent.joinToString("") { "$it\n" }.toByteArray())
            lines = recent.size
        }
        last.value = event["id"]!!.jsonPrimitive.long
        event
    }

    fun since(id: Long, type: String? = null): List<JsonObject> = synchronized(this) {
        recent.filter { it["id"]!!.jsonPrimitive.long > id && (type == null || it["type"]!!.jsonPrimitive.content == type) }
    }

    /** Events after id, waiting up to timeoutMs for the first one. */
    suspend fun wait(id: Long, timeoutMs: Long, type: String? = null): List<JsonObject> {
        val end = System.currentTimeMillis() + timeoutMs
        while (true) {
            val seen = last.value // read before checking, so an event posted in between still wakes us
            since(id, type).let { if (it.isNotEmpty()) return it }
            val left = end - System.currentTimeMillis()
            if (left <= 0) return emptyList()
            withTimeoutOrNull(left) { last.first { it > seen } } ?: return since(id, type)
        }
    }

    val lastId: Long get() = last.value

    companion object {
        const val KEEP = 1000
    }
}
