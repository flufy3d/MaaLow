package io.github.flufy3d.maalow

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.github.flufy3d.maalow.engine.Bridge
import io.github.flufy3d.maalow.engine.ShizukuLink
import java.net.NetworkInterface

/** Status page: Shizuku state, engine state, API address and token. */
class MainActivity : Activity() {
    private lateinit var status: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        status = TextView(this).apply { textSize = 16f; setTextIsSelectable(true) }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(status)
            addView(Button(context).apply {
                text = "授权 Shizuku"
                setOnClickListener { ShizukuLink.requestPermission() }
            })
            addView(Button(context).apply {
                text = "启动 / 重启引擎"
                setOnClickListener { MaaLowService.start(context, MaaLowService.ACTION_RESTART_ENGINE) }
            })
        }
        setContentView(ScrollView(this).apply {
            addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        })
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != 0) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        MaaLowService.start(this)
    }

    override fun onResume() {
        super.onResume()
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }

    private fun refresh() {
        val app = application as App
        val e = app.engine
        val shizuku = when (ShizukuLink.state()) {
            ShizukuLink.State.NOT_RUNNING -> "未运行（请打开 Shizuku 并启动）"
            ShizukuLink.State.NO_PERMISSION -> "未授权（点下方按钮）"
            ShizukuLink.State.READY -> "正常"
        }
        val frames = if (e.state.name == "RUNNING") Bridge.stats().let { "帧 #${it.seq}，距今 ${"%.0f".format(it.ageMs)} ms" } else "-"
        val addrs = NetworkInterface.getNetworkInterfaces().toList().flatMap { it.inetAddresses.toList() }
            .filter { !it.isLoopbackAddress && it.hostAddress?.contains(':') == false }
            .joinToString("\n") { "  http://${it.hostAddress}:${App.PORT}/?token=${app.token}" }
        status.text = listOf(
            "MaaLow ${BuildConfig.VERSION_NAME}",
            "Shizuku：$shizuku",
            "引擎：${e.state}${e.error?.let { "（$it）" } ?: ""}",
            "画面：${e.width}x${e.height}，$frames",
            "网页地址：",
            addrs,
            "Token：${app.token}",
        ).joinToString("\n")
    }
}
