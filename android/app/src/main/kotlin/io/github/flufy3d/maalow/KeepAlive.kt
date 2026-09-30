package io.github.flufy3d.maalow

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import io.github.flufy3d.maalow.engine.Engine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.lsposed.hiddenapibypass.HiddenApiBypass

/** What HyperOS needs so the service survives in the background and alarms fire: checks, settings pages, fixes. */
object KeepAlive {
    /** HyperOS/MIUI app op behind the "自启动" switch. */
    private const val OP_AUTO_START = 10008

    data class Check(val key: String, val label: String, val ok: Boolean?, val detail: String)

    fun checks(context: Context): List<Check> {
        val pkg = context.packageName
        val power = context.getSystemService(PowerManager::class.java)
        val alarms = context.getSystemService(AlarmManager::class.java)
        val auto = autoStart(context)
        return listOf(
            Check("autostart", "自启动", auto, if (auto == null) "无法读取（非 HyperOS？）" else if (auto) "允许" else "未允许"),
            power.isIgnoringBatteryOptimizations(pkg).let { Check("battery", "电池无限制", it, if (it) "无限制" else "受系统优化限制") },
            alarms.canScheduleExactAlarms().let { Check("exact_alarm", "精确闹钟", it, if (it) "允许" else "未允许") },
            context.getSystemService(ActivityManager::class.java).isBackgroundRestricted.let {
                Check("background", "后台运行", !it, if (it) "受限" else "不受限")
            },
            context.getSystemService(NotificationManager::class.java).areNotificationsEnabled().let {
                Check("notifications", "通知", it, if (it) "允许" else "未允许")
            },
            tailSocksCheck(context),
        )
    }

    /** TailSocks publishes the web UI as HTTPS (the remote stage needs it); it has to stay alive too. */
    private fun tailSocksCheck(context: Context): Check {
        val pkg = tailSocks(context) ?: return Check("tailsocks", "TailSocks（远程访问）", null, "未安装：只有远程画面用得到")
        val battery = context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(pkg)
        val auto = autoStart(context, pkg)
        return Check(
            "tailsocks", "TailSocks（远程访问）", battery && auto != false,
            "电池${if (battery) "无限制" else "受限"} · 自启动${if (auto == null) "未知" else if (auto) "允许" else "未允许"}",
        )
    }

    @Volatile private var tailSocksAt = 0L
    @Volatile private var tailSocksPkg: String? = null

    /** The installed TailSocks' package (found by name, looked up again every half minute), or null. */
    fun tailSocks(context: Context): String? {
        val now = System.currentTimeMillis()
        if (now - tailSocksAt < 30_000) return tailSocksPkg
        val pm = context.packageManager
        val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        tailSocksPkg = pm.queryIntentActivities(main, 0).map { it.activityInfo }.firstOrNull {
            it.packageName.contains("tailsocks", ignoreCase = true) || it.loadLabel(pm).toString().contains("TailSocks", ignoreCase = true)
        }?.packageName
        tailSocksAt = now
        return tailSocksPkg
    }

    fun json(context: Context): JsonObject = buildJsonObject {
        for (c in checks(context)) put(c.key, c.ok)
    }

    private fun autoStart(context: Context, pkg: String = context.packageName): Boolean? = runCatching {
        val ops = context.getSystemService(AppOpsManager::class.java)
        val uid = if (pkg == context.packageName) Process.myUid() else context.packageManager.getApplicationInfo(pkg, 0).uid
        val mode = HiddenApiBypass.invoke(
            AppOpsManager::class.java, ops, "checkOpNoThrow", OP_AUTO_START, uid, pkg,
        ) as Int
        mode == AppOpsManager.MODE_ALLOWED
    }.getOrNull()

    /** Settings page where the user can fix a check, or null. */
    fun settingsIntent(context: Context, key: String): Intent? {
        val pkg = context.packageName
        return when (key) {
            "autostart" -> Intent().setComponent(
                ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            )
            "battery", "background" -> Intent().setComponent(
                ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"),
            ).putExtra("package_name", pkg).putExtra("package_label", "MaaLow")
            "exact_alarm" -> Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$pkg"))
            "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
            "tailsocks" -> tailSocks(context)?.let {
                Intent().setComponent(ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"))
                    .putExtra("package_name", it).putExtra("package_label", "TailSocks")
            }
            else -> null
        }?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /** Fallback when a HyperOS page is missing: the app's details page. */
    fun detailsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Grant what shell can grant: autostart, battery whitelist, background running (TailSocks too). Returns command outputs. */
    suspend fun fix(context: Context, engine: Engine): JsonObject {
        val pkg = context.packageName
        val cmds = listOf(
            "appops set $pkg $OP_AUTO_START allow",
            "dumpsys deviceidle whitelist +$pkg",
            "appops set $pkg RUN_ANY_IN_BACKGROUND allow",
            "appops set $pkg SCHEDULE_EXACT_ALARM allow",
        ) + tailSocks(context)?.let {
            listOf("appops set $it $OP_AUTO_START allow", "dumpsys deviceidle whitelist +$it", "appops set $it RUN_ANY_IN_BACKGROUND allow")
        }.orEmpty()
        return buildJsonObject {
            for (c in cmds) put(c, engine.shell(c).let { (code, out) -> "exit=$code ${out.trim()}" })
        }
    }
}
