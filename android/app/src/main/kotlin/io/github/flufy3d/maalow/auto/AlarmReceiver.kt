package io.github.flufy3d.maalow.auto

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import io.github.flufy3d.maalow.MaaLowService

/**
 * Schedule alarms, boot and app updates: hand over to the foreground service, which runs what is due and sets
 * the next alarm. Exact alarms and BOOT_COMPLETED both allow starting a foreground service from the background.
 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Log.i(Scheduler.TAG, "received ${intent.action}")
        MaaLowService.start(context, MaaLowService.ACTION_ALARM)
    }

    companion object {
        const val ACTION_ALARM = "io.github.flufy3d.maalow.ALARM"
    }
}
