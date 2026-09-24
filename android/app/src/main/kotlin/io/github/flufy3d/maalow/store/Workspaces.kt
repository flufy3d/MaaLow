package io.github.flufy3d.maalow.store

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * Workspace directories under root, in the same layout as the PC tools (workspace.json, pipeline/, templates/,
 * teaching/, ...). All paths from clients are workspace-relative and checked to stay inside the workspace.
 */
class Workspaces(val root: File) {
    private data class Hash(val size: Long, val mtime: Long, val sha256: String)

    private val hashes = ConcurrentHashMap<String, Hash>()

    fun list(): List<String> =
        root.listFiles()?.filter { File(it, CONFIG).isFile && NAME.matches(it.name) }?.map { it.name }?.sorted() ?: emptyList()

    fun dir(ws: String): File {
        require(NAME.matches(ws)) { "bad workspace name: $ws" }
        return File(root, ws)
    }

    fun exists(ws: String) = File(dir(ws), CONFIG).isFile

    fun existing(ws: String): File = dir(ws).also { check(File(it, CONFIG).isFile) { "no workspace: $ws" } }

    /** A workspace-relative path, rejecting anything that would leave the workspace or touch temp files. */
    fun file(ws: String, path: String): File {
        val parts = path.replace('\\', '/').split('/').filter { it.isNotEmpty() }
        require(parts.isNotEmpty() && parts.none { it == ".." || it == "." || it.startsWith(".") }) { "bad path: $path" }
        val base = dir(ws)
        val f = File(base, parts.joinToString("/"))
        require(f.canonicalPath.startsWith(base.canonicalPath + File.separator)) { "bad path: $path" }
        return f
    }

    fun config(ws: String): JsonObject = readJsonObject(File(existing(ws), CONFIG)) ?: JsonObject(emptyMap())

    fun guards(ws: String): List<String> = config(ws).optArray("guards")?.map { it.jsonPrimitive.content } ?: emptyList()

    fun setGuards(ws: String, guards: List<String>) = synchronized(this) {
        val cfg = config(ws)
        File(dir(ws), CONFIG).writeJson(cfg.with("guards" to JsonArray(guards.map { JsonPrimitive(it) })))
    }

    fun packageOf(ws: String): String = config(ws).optStr("package").orEmpty()

    // ---- files

    private fun sha256(f: File): String {
        val key = f.path
        hashes[key]?.let { if (it.size == f.length() && it.mtime == f.lastModified()) return it.sha256 }
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        val hex = md.digest().joinToString("") { "%02x".format(it) }
        hashes[key] = Hash(f.length(), f.lastModified(), hex)
        return hex
    }

    private fun entry(ws: String, f: File): JsonObject = buildJsonObject {
        put("path", f.relativeTo(dir(ws)).invariantSeparatorsPath)
        put("size", f.length())
        put("mtime", f.lastModified())
        put("sha256", sha256(f))
    }

    private fun files(ws: String): List<File> =
        existing(ws).walkTopDown().onEnter { it == dir(ws) || !it.name.startsWith(".") }
            .filter { it.isFile && !it.name.startsWith(".") }.sortedBy { it.path }.toList()

    fun tree(ws: String): JsonArray = buildJsonArray { files(ws).forEach { add(entry(ws, it)) } }

    /** Write a file (creating the workspace when this is its workspace.json); mtime in epoch ms if given. */
    fun write(ws: String, path: String, input: InputStream, mtime: Long? = null): JsonObject {
        val f = file(ws, path)
        check(exists(ws) || f == File(dir(ws), CONFIG)) { "no workspace: $ws (write workspace.json first)" }
        f.writeAtomic(input)
        mtime?.let { f.setLastModified(it) }
        hashes.remove(f.path)
        return entry(ws, f)
    }

    fun delete(ws: String, path: String): Boolean {
        val f = file(ws, path)
        check(f != File(dir(ws), CONFIG)) { "refusing to delete $CONFIG" }
        return if (f.isDirectory) f.deleteRecursively() else f.delete()
    }

    // ---- zip

    /** Zip the workspace, or only the given paths (missing ones are skipped). */
    fun export(ws: String, out: OutputStream, paths: List<String>? = null) {
        val list = paths?.map { file(ws, it) }?.filter { it.isFile } ?: files(ws)
        ZipOutputStream(out).use { zip ->
            for (f in list) {
                zip.putNextEntry(ZipEntry(f.relativeTo(dir(ws)).invariantSeparatorsPath).apply { time = f.lastModified() })
                f.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    /**
     * Import a zip of a workspace. Entries may sit at the zip root or under one top folder. merge: add and overwrite
     * files; replace: the workspace becomes exactly the zip contents.
     */
    fun import(ws: String, zip: File, replace: Boolean): JsonObject = synchronized(this) {
        val names = ZipInputStream(zip.inputStream()).use { z ->
            generateSequence { z.nextEntry }.filter { !it.isDirectory }.map { it.name.replace('\\', '/') }.toList()
        }
        val prefix = when {
            CONFIG in names -> ""
            else -> names.map { it.substringBefore('/', "") }.distinct().singleOrNull()
                ?.takeIf { it.isNotEmpty() && "$it/$CONFIG" in names }?.let { "$it/" }
                ?: throw IllegalArgumentException("zip has no $CONFIG")
        }
        val target = dir(ws)
        val stage = if (replace) File(root, ".import-$ws-${System.currentTimeMillis()}") else target
        var count = 0
        try {
            ZipInputStream(zip.inputStream()).use { z ->
                for (e in generateSequence { z.nextEntry }) {
                    val name = e.name.replace('\\', '/')
                    if (e.isDirectory || !name.startsWith(prefix)) continue
                    val rel = name.removePrefix(prefix)
                    val f = if (replace) File(stage, file(ws, rel).relativeTo(target).path) else file(ws, rel)
                    f.writeAtomic(z)
                    count++
                }
            }
            if (replace) {
                val trash = File(root, ".trash-$ws-${System.currentTimeMillis()}")
                if (target.exists()) check(target.renameTo(trash)) { "cannot move old $ws aside" }
                if (!stage.renameTo(target)) {
                    trash.renameTo(target)
                    error("cannot move imported $ws into place")
                }
                trash.deleteRecursively()
            }
        } finally {
            if (replace && stage.exists()) stage.deleteRecursively()
        }
        hashes.keys.removeAll { it.startsWith(target.path + File.separator) }
        buildJsonObject {
            put("workspace", ws)
            put("mode", if (replace) "replace" else "merge")
            put("files", count)
        }
    }

    /**
     * Apply a batch from `maalow sync`: a zip whose entries are files to write, plus an optional [BATCH] entry
     * {"mtime": {path: ms}, "delete": [path]}. Writes go in zip order (workspace.json first creates a workspace),
     * then mtimes are set and deletes run.
     */
    fun batch(ws: String, input: InputStream): JsonObject = synchronized(this) {
        var manifest: JsonObject? = null
        val written = mutableListOf<String>()
        ZipInputStream(input).use { z ->
            for (e in generateSequence { z.nextEntry }) {
                val name = e.name.replace('\\', '/')
                when {
                    e.isDirectory -> {}
                    name == BATCH -> manifest = Json.parseToJsonElement(z.readBytes().decodeToString()).jsonObject
                    else -> {
                        val f = file(ws, name)
                        check(exists(ws) || f == File(dir(ws), CONFIG)) { "no workspace: $ws (write workspace.json first)" }
                        f.writeAtomic(z)
                        hashes.remove(f.path)
                        written.add(name)
                    }
                }
            }
        }
        val mtimes = manifest?.get("mtime")?.jsonObject.orEmpty()
        for (path in written) mtimes[path]?.jsonPrimitive?.longOrNull?.let { file(ws, path).setLastModified(it) }
        val deleted = manifest?.optArray("delete")?.map { it.jsonPrimitive.content }?.filter { delete(ws, it) }.orEmpty()
        buildJsonObject {
            put("workspace", ws)
            put("files", buildJsonArray { written.forEach { add(entry(ws, file(ws, it))) } })
            put("deleted", JsonArray(deleted.map { JsonPrimitive(it) }))
        }
    }

    companion object {
        const val BATCH = ".batch.json"
        const val CONFIG = "workspace.json"
        val NAME = Regex("^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
    }
}
