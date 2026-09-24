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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Foreground service keeping the HTTP server and engine alive while the app is in the background. */
class MaaLowService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "MaaLow", NotificationManager.IMPORTANCE_LOW))
        startForeground(1, notification("启动中…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "maalow:service").apply { acquire() }
        val app = application as App
        app.server.start()
        scope.launch {
            app.engine.start()
            update(app)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as App
        if (intent?.action == ACTION_RESTART_ENGINE) scope.launch {
            app.engine.stop()
            app.engine.start()
            update(app)
        }
        return START_STICKY
    }

    private fun update(app: App) {
        val text = app.engine.error ?: "引擎 ${app.engine.state} · 端口 ${App.PORT}"
        getSystemService(NotificationManager::class.java).notify(1, notification(text))
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
        scope.launch { app.engine.stop() }.invokeOnCompletion { scope.cancel() }
        app.server.stop()
        wakeLock?.release()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL = "maalow"
        const val ACTION_RESTART_ENGINE = "restart_engine"

        fun start(context: Context, action: String? = null) {
            context.startForegroundService(Intent(context, MaaLowService::class.java).setAction(action))
        }
    }
}
