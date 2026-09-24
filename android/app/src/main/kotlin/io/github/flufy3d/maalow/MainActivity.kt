package io.github.flufy3d.maalow

import android.app.Activity
import android.content.ActivityNotFoundException
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import io.github.flufy3d.maalow.engine.Bridge
import io.github.flufy3d.maalow.engine.ShizukuLink
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonPrimitive
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Status page: Shizuku, engine, automation, HyperOS keep-alive checks, API address and token. */
class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var checks: LinearLayout
    private var shownChecks = ""
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
        checks = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
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
            addView(TextView(context).apply { text = "\n保活检查（HyperOS）"; textSize = 16f })
            addView(checks)
            addView(Button(context).apply {
                text = "用 Shizuku 一键设置（自启动、电池无限制、后台运行）"
                setOnClickListener { fix() }
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

    private fun fix() {
        val app = application as App
        app.scope.launch {
            val msg = runCatching { KeepAlive.fix(app, app.engine); "已设置" }.getOrElse { "设置失败：${it.message}" }
            runOnUiThread { Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show() }
        }
    }

    private fun open(key: String) {
        val intent = KeepAlive.settingsIntent(this, key) ?: return
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            startActivity(KeepAlive.detailsIntent(this))
        } catch (e: SecurityException) {
            startActivity(KeepAlive.detailsIntent(this))
        }
    }

    private fun refreshChecks() {
        val list = KeepAlive.checks(this)
        val sig = list.joinToString { "${it.key}=${it.ok}" }
        if (sig == shownChecks) return
        shownChecks = sig
        checks.removeAllViews()
        for (c in list) {
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            val mark = when (c.ok) { true -> "✓"; false -> "✗"; null -> "?" }
            row.addView(TextView(this).apply {
                text = "$mark ${c.label}：${c.detail}"
                textSize = 15f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            if (c.ok != true) row.addView(Button(this).apply {
                text = "去设置"
                setOnClickListener { open(c.key) }
            })
            checks.addView(row)
        }
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
        val time = SimpleDateFormat("MM-dd HH:mm", Locale.ROOT)
        status.text = listOf(
            "MaaLow ${BuildConfig.VERSION_NAME}",
            "Shizuku：$shizuku",
            "引擎：${e.state}${e.error?.let { "（$it）" } ?: ""}${e.busy?.let { " · 忙：$it" } ?: ""}",
            "画面：${e.width}x${e.height}，$frames",
            "工作区：${app.defaultWorkspace() ?: "无"}",
            "守护规则：${if (app.settings().guardsEnabled) "开" else "关"}，最近 ${app.guards.last["result"]?.jsonPrimitive?.content}",
            "下次定时：${app.scheduler.nextAlarm?.let { time.format(Date(it)) } ?: "无"}",
            "网页地址：",
            addrs,
            "Token：${app.token}",
        ).joinToString("\n")
        refreshChecks()
    }
}
