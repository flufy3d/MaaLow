package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.ktor.http.ContentType
import io.ktor.http.defaultForFileExtension
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import java.io.File
import java.io.FileNotFoundException

/**
 * The teaching web UI, from the APK's assets/web, overridden file by file by files/web/ in the external files dir
 * so the page can be changed with `adb push` without reinstalling. Open it as /?token=...
 */
fun Route.webRoutes(app: App) {
    val overlay = File(app.storeDir, "web")

    suspend fun serve(call: io.ktor.server.application.ApplicationCall, path: String) {
        require(path.split('/').none { it == ".." || it.startsWith(".") }) { "bad path" }
        val local = File(overlay, path)
        val bytes = if (local.isFile) local.readBytes() else try {
            app.assets.open("web/$path").use { it.readBytes() }
        } catch (e: FileNotFoundException) {
            throw NoSuchElementException("not found: $path")
        }
        call.response.headers.append("Cache-Control", "no-store")
        call.respondBytes(bytes, ContentType.defaultForFileExtension(path.substringAfterLast('.', "")))
    }

    get("/") { serve(call, "index.html") }
    get("/web/{path...}") { serve(call, call.parameters.getAll("path").orEmpty().joinToString("/")) }
}
