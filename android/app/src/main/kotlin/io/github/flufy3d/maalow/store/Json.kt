package io.github.flufy3d.maalow.store

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.io.InputStream

/** Json for files people read: indented like the PC tools write them. */
val PrettyJson = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
    ignoreUnknownKeys = true
    encodeDefaults = true
}

val LenientJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
}

fun JsonObject.str(key: String): String =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString || it.content.isNotEmpty() }?.content
        ?: throw IllegalArgumentException("missing $key")

fun JsonObject.optStr(key: String): String? = (this[key] as? JsonPrimitive)?.content
fun JsonObject.optInt(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull
fun JsonObject.optLong(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
fun JsonObject.optBool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
fun JsonObject.optArray(key: String): JsonArray? = this[key] as? JsonArray

fun JsonObject.with(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(this + pairs)

fun readJsonObject(file: File): JsonObject? =
    if (file.isFile) Json.parseToJsonElement(file.readText()).jsonObject else null

fun File.writeAtomic(bytes: ByteArray) = writeAtomic(bytes.inputStream())

/** Write through a temp file so readers never see half a file. */
fun File.writeAtomic(input: InputStream) {
    parentFile?.mkdirs()
    val tmp = File(parentFile, ".$name.tmp")
    tmp.outputStream().use { input.copyTo(it) }
    if (!tmp.renameTo(this)) {
        delete()
        check(tmp.renameTo(this)) { "cannot write $this" }
    }
}

fun File.writeJson(element: JsonElement) = writeAtomic((PrettyJson.encodeToString(JsonElement.serializer(), element) + "\n").toByteArray())
