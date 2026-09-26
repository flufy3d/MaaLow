package io.github.flufy3d.maalow.server

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.store.Workspaces
import io.github.flufy3d.maalow.store.optStr
import io.github.flufy3d.maalow.store.str
import io.ktor.http.ContentType
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.Route
import io.ktor.server.routing.RoutingCall
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * Workspace management for the web UI (only the web UI switches and manages workspaces; the app shows the current one):
 *
 *     GET    /api/v1/workspaces/info               {current, workspaces: [{name, package, app, tasks, recordings, ...}]}
 *     POST   /api/v1/workspaces {name, package}    create
 *     PATCH  /api/v1/workspaces/{ws} {package}
 *     POST   /api/v1/workspaces/{ws}/use           make it the current workspace
 *     POST   /api/v1/workspaces/{ws}/rename {name}
 *     POST   /api/v1/workspaces/{ws}/copy {name}   schedules in the copy start disabled
 *     DELETE /api/v1/workspaces/{ws}               move to the trash (not the current one)
 *     GET    /api/v1/trash                         [{id, name, deleted, expires, size, package}], purged after 7 days
 *     POST   /api/v1/trash/{id}/restore {name?}
 *     DELETE /api/v1/trash/{id}
 *     GET    /api/v1/apps                          launchable apps: [{package, label, system}]
 *     GET    /api/v1/apps/{package}/icon.png
 */
fun Route.workspaceRoutes(app: App) {
    val ws = app.workspaces
    val pm = app.packageManager
    val icons = ConcurrentHashMap<String, ByteArray>()

    fun label(pkg: String): String? =
        if (pkg.isEmpty()) null else runCatching { pm.getApplicationInfo(pkg, 0).loadLabel(pm).toString() }.getOrNull()

    fun checkName(name: String) = require(Workspaces.NAME.matches(name)) {
        "工作区名只能用英文字母、数字和 _ . -，且不能以 . 或 - 开头：$name"
    }

    fun info(name: String): JsonObject = ws.info(name).let { i ->
        val pkg = i.optStr("package").orEmpty()
        JsonObject(i + mapOf("app" to JsonPrimitive(label(pkg)), "busy" to JsonPrimitive(app.busyWith(name))))
    }

    /** Refuse to touch a workspace while something runs in it. */
    fun idle(name: String) = app.busyWith(name)?.let { error("$it，先停止再操作") }

    get("/api/v1/workspaces/info") {
        val list = withContext(Dispatchers.IO) { ws.list().map { info(it) } }
        call.respondJson(buildJsonObject {
            put("current", app.defaultWorkspace())
            put("workspaces", buildJsonArray { list.forEach { add(it) } })
        })
    }

    post("/api/v1/workspaces") {
        val b = call.body()
        val name = b.str("name").trim()
        checkName(name)
        withContext(Dispatchers.IO) { ws.create(name, b.optStr("package").orEmpty().trim()) }
        call.respondJson(info(name))
    }

    patch("/api/v1/workspaces/{ws}") {
        val name = call.ws()
        call.body().optStr("package")?.let { ws.setPackage(name, it.trim()) }
        call.respondJson(info(name))
    }

    post("/api/v1/workspaces/{ws}/use") {
        app.useWorkspace(call.ws())
        call.respondJson(buildJsonObject { put("current", app.defaultWorkspace()) })
    }

    post("/api/v1/workspaces/{ws}/rename") {
        val (from, to) = call.ws() to call.body().str("name").trim()
        checkName(to)
        idle(from)
        val current = app.defaultWorkspace() == from
        withContext(Dispatchers.IO) { ws.rename(from, to) }
        if (current || app.settings().workspace == from) app.updateSettings { it.copy(workspace = to) }
        app.teaching.moved(from, to)
        app.scheduler.renamed(from, to)
        app.events.post("workspace_renamed") { put("from", from); put("to", to) }
        call.respondJson(info(to))
    }

    post("/api/v1/workspaces/{ws}/copy") {
        val (from, to) = call.ws() to call.body().str("name").trim()
        checkName(to)
        withContext(Dispatchers.IO) { ws.copy(from, to) }
        app.scheduler.disableAll(to)
        call.respondJson(info(to))
    }

    delete("/api/v1/workspaces/{ws}") {
        val name = call.ws()
        ws.existing(name)
        check(app.defaultWorkspace() != name) { "不能删除当前工作区，先切换到别的工作区" }
        idle(name)
        val id = withContext(Dispatchers.IO) { ws.trash(name) }
        app.teaching.moved(name, null)
        app.scheduler.reschedule()
        app.events.post("workspace_deleted") { put("workspace", name); put("trash", id) }
        call.respondJson(buildJsonObject { put("trash", id) })
    }

    get("/api/v1/trash") { call.respondJson(withContext(Dispatchers.IO) { ws.trashList() }) }

    post("/api/v1/trash/{id}/restore") {
        val name = call.body().optStr("name")?.trim()?.takeIf { it.isNotEmpty() }?.also { checkName(it) }
        val restored = withContext(Dispatchers.IO) { ws.restore(call.parameters["id"]!!, name) }
        app.scheduler.reschedule()
        call.respondJson(info(restored))
    }

    delete("/api/v1/trash/{id}") {
        val ok = withContext(Dispatchers.IO) { ws.purge(call.parameters["id"]!!) }
        call.respondJson(buildJsonObject { put("deleted", ok) })
    }

    get("/api/v1/apps") {
        val list = withContext(Dispatchers.IO) {
            pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
                .map { it.activityInfo.applicationInfo }.distinctBy { it.packageName }.filter { it.packageName != app.packageName }
                .map { Triple(it.packageName, it.loadLabel(pm).toString(), it.flags and ApplicationInfo.FLAG_SYSTEM != 0) }
                .sortedWith(compareBy<Triple<String, String, Boolean>> { it.third }.thenBy { it.second })
        }
        call.respondJson(buildJsonArray {
            for ((pkg, name, system) in list) add(buildJsonObject {
                put("package", pkg)
                put("label", name)
                put("system", system)
            })
        })
    }

    get("/api/v1/apps/{pkg}/icon.png") {
        val pkg = call.parameters["pkg"]!!
        val png = icons[pkg] ?: withContext(Dispatchers.IO) {
            val d = try {
                pm.getApplicationIcon(pkg)
            } catch (e: PackageManager.NameNotFoundException) {
                throw NoSuchElementException("没有安装 $pkg")
            }
            val bmp = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888)
            d.setBounds(0, 0, ICON_PX, ICON_PX)
            d.draw(Canvas(bmp))
            ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray().also { icons[pkg] = it }
        }
        call.response.header("Cache-Control", "max-age=86400")
        call.respondBytes(png, ContentType.Image.PNG)
    }
}

private const val ICON_PX = 96

private fun RoutingCall.ws(): String = parameters["ws"]!!
