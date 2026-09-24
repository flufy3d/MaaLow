package io.github.flufy3d.maalow

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.engine.ShizukuLink
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.put

/**
 * Foreground service keeping the HTTP server, engine, guard loop and scheduler alive in the background. A
 * supervisor brings the engine back whenever Shizuku is (again) available and raises a notification when it is not.
 */
class MaaLowService : Service() {
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, e -> Log.e(TAG, "uncaught", e) },
    )
    private var wakeLock: PowerManager.WakeLock? = null
    private val engineLock = Mutex() // start/stop from the supervisor and from the restart button
    private var text = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "MaaLow", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(ALERTS, "MaaLow 提醒", NotificationManager.IMPORTANCE_HIGH))
        startForeground(ID_SERVICE, notification("启动中…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "maalow:service").apply { acquire() }
        val app = application as App
        app.server.start()
        app.guards.start(scope)
        scope.launch { supervise(app) }
        scope.launch { app.scheduler.reschedule() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as App
        when (intent?.action) {
            ACTION_RESTART_ENGINE -> scope.launch {
                engineLock.withLock { app.engine.restart() }
                update(app)
            }
            ACTION_ALARM -> scope.launch { app.scheduler.onAlarm() }
        }
        return START_STICKY
    }

    /** Every few seconds: follow Shizuku, (re)start the engine when it can run, keep the notifications current. */
    private suspend fun supervise(app: App) {
        var shizuku: ShizukuLink.State? = null
        var engine: Engine.State? = null
        var retryAt = 0L
        ShizukuLink.settle()
        while (true) {
            try {
                val s = ShizukuLink.state()
                if (s != shizuku) {
                    Log.i(TAG, "shizuku: $s")
                    app.events.post("shizuku") { put("state", s.name.lowercase()) }
                    alert(s)
                    shizuku = s
                }
                val e = app.engine.state
                val now = System.currentTimeMillis()
                if (s == ShizukuLink.State.READY && e != Engine.State.RUNNING && e != Engine.State.STARTING && now >= retryAt) {
                    engineLock.withLock { app.engine.restart() }
                    if (app.engine.state != Engine.State.RUNNING) retryAt = now + RETRY_MS
                }
                if (app.engine.state != engine) {
                    engine = app.engine.state
                    app.events.post("engine") {
                        put("state", engine.name.lowercase())
                        app.engine.error?.let { put("error", it) }
                    }
                }
                update(app)
            } catch (e: Exception) {
                Log.e(TAG, "supervisor", e)
            }
            delay(SUPERVISE_MS)
        }
    }

    private fun alert(s: ShizukuLink.State) {
        val nm = getSystemService(NotificationManager::class.java)
        val msg = when (s) {
            ShizukuLink.State.READY -> return nm.cancel(ID_ALERT)
            ShizukuLink.State.NOT_RUNNING -> "Shizuku 未运行：截图、点击和定时任务暂停。请打开 Shizuku 启动服务。"
            ShizukuLink.State.NO_PERMISSION -> "MaaLow 未获 Shizuku 授权：请打开 MaaLow 授权。"
        }
        val open = packageManager.getLaunchIntentForPackage(SHIZUKU_PACKAGE) ?: Intent(this, MainActivity::class.java)
        nm.notify(
            ID_ALERT,
            Notification.Builder(this, ALERTS)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle("MaaLow 无法控制设备")
                .setContentText(msg)
                .setStyle(Notification.BigTextStyle().bigText(msg))
                .setContentIntent(PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE))
                .setOngoing(true)
                .build(),
        )
    }

    private fun update(app: App) {
        val e = app.engine
        val t = e.error?.let { "引擎 ${e.state}：$it" } ?: listOfNotNull(
            "引擎 ${e.state}", e.busy?.let { "忙：$it" }, "端口 ${App.PORT}",
        ).joinToString(" · ")
        if (t == text) return
        text = t
        getSystemService(NotificationManager::class.java).notify(ID_SERVICE, notification(t))
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("MaaLow")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        val app = application as App
        app.guards.stop()
        scope.launch { app.engine.stop() }.invokeOnCompletion { scope.cancel() }
        app.server.stop()
        wakeLock?.release()
        super.onDestroy()
    }

    companion object {
        const val TAG = "MaaLowService"
        const val CHANNEL = "maalow"
        const val ALERTS = "maalow_alerts"
        const val ID_SERVICE = 1
        const val ID_ALERT = 2
        const val ACTION_RESTART_ENGINE = "restart_engine"
        const val ACTION_ALARM = "alarm"
        const val SHIZUKU_PACKAGE = "moe.shizuku.privileged.api"
        const val SUPERVISE_MS = 3000L
        const val RETRY_MS = 15_000L

        fun start(context: Context, action: String? = null) {
            context.startForegroundService(Intent(context, MaaLowService::class.java).setAction(action))
        }
    }
}
