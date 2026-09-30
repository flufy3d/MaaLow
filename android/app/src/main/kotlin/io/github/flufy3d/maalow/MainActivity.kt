package io.github.flufy3d.maalow

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import io.github.flufy3d.maalow.engine.Bridge
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.engine.Maa
import io.github.flufy3d.maalow.engine.ShizukuLink
import io.github.flufy3d.maalow.ui.MaaLowTheme
import io.github.flufy3d.maalow.ui.Mono
import io.github.flufy3d.maalow.ui.Palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonPrimitive
import java.net.Inet4Address
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Status page: the current workspace (switched in the web UI), web links and token to share, engine and Shizuku,
 * HyperOS keep-alive checks. Workspaces are managed in the web UI only; this page just shows the current one.
 */
class MainActivity : ComponentActivity() {
    private var resumed by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != 0) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        MaaLowService.start(this)
        setContent { MaaLowTheme { Home(application as App, resumed) } }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
    }

    override fun onPause() {
        resumed = false
        super.onPause()
    }
}

/** A web address of this device, with where it is reachable from. */
private data class Link(val label: String, val url: String)

/** Everything the page shows, read once a second. */
private data class Snap(
    val shizuku: ShizukuLink.State,
    val engine: Engine.State,
    val engineError: String?,
    val busy: String?,
    val screen: String,
    val frame: String,
    val workspace: String?,
    val pkg: String,
    val guardCount: Int,
    val scheduleCount: Int,
    val guardsOn: Boolean,
    val guardResult: String,
    val nextAlarm: Long?,
    val recording: Boolean,
    val checks: List<KeepAlive.Check>,
    val links: List<Link>,
    val token: String,
)

private fun read(app: App): Snap {
    val e = app.engine
    val ws = app.defaultWorkspace()
    val running = e.state == Engine.State.RUNNING
    val stats = if (running) Bridge.stats() else null
    return Snap(
        shizuku = ShizukuLink.state(),
        engine = e.state,
        engineError = e.error,
        busy = e.busy,
        screen = "${e.width}×${e.height}",
        frame = stats?.let { "帧 #${it.seq} · ${"%.0f".format(it.ageMs)} ms 前" } ?: "无画面",
        workspace = ws,
        pkg = ws?.let { runCatching { app.workspaces.packageOf(it) }.getOrNull() }.orEmpty(),
        guardCount = ws?.let { runCatching { app.workspaces.guards(it).size }.getOrNull() } ?: 0,
        scheduleCount = ws?.let { runCatching { app.scheduler.load(it).count { s -> s.enabled } }.getOrNull() } ?: 0,
        guardsOn = app.settings().guardsEnabled,
        guardResult = app.guards.last["result"]?.jsonPrimitive?.content.orEmpty(),
        nextAlarm = app.scheduler.nextAlarm,
        recording = app.recorder.recording,
        checks = KeepAlive.checks(app),
        links = links(app.token, app.settings().httpsUrl),
        token = app.token,
    )
}

/**
 * The HTTPS address if set (TailSocks: remote access and the remote stage), then IPv4 addresses, the LAN first; each
 * labeled by its network. Tailscale / VPN addresses are left out: from afar the page is opened over HTTPS.
 */
private fun links(token: String, https: String): List<Link> {
    val lan = NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }.flatMap { ni ->
        ni.inetAddresses.toList().filterIsInstance<Inet4Address>().mapNotNull { a ->
            val ip = a.hostAddress.orEmpty()
            val n = ni.name.lowercase()
            val (rank, label) = when {
                n.startsWith("wlan") -> 0 to "局域网 Wi‑Fi"
                n.startsWith("eth") -> 1 to "有线网络"
                n.startsWith("ap") || n.startsWith("swlan") || n.contains("softap") -> 2 to "本机热点"
                n.startsWith("tun") || n.contains("tailscale") || isCgnat(ip) -> return@mapNotNull null
                n.startsWith("rmnet") || n.startsWith("ccmni") -> 5 to "移动网络"
                else -> 4 to ni.name
            }
            rank to Link(label, "http://$ip:${App.PORT}/?token=$token")
        }
    }.sortedBy { it.first }.map { it.second }
    return listOfNotNull(https.takeIf { it.isNotEmpty() }?.let { Link("HTTPS（远程访问）", "$it/?token=$token") }) + lan
}

private fun isCgnat(ip: String): Boolean {
    val p = ip.split('.').mapNotNull { it.toIntOrNull() }
    return p.size == 4 && p[0] == 100 && p[1] in 64..127
}

/** What the last guard check did, in words. */
fun guardText(r: String): String = when {
    r == "disabled" -> "已关闭"
    r == "not_started" -> "未启动"
    r == "no_workspace" -> "没有工作区"
    r == "no_guards" -> "没有配置守护规则"
    r.startsWith("engine_") -> "等待引擎"
    r == "busy" -> "设备忙，跳过"
    r == "screen_off" -> "屏幕已关闭"
    r == "not_foreground" -> "游戏不在前台"
    r == "no_match" -> "巡检中，没有弹窗"
    r.isEmpty() -> "—"
    else -> "刚处理了 $r"
}

private fun engineText(s: Snap): String = when (s.engine) {
    Engine.State.RUNNING -> s.busy?.let { "运行中 · 忙：$it" } ?: "运行中"
    Engine.State.STARTING -> "启动中…"
    Engine.State.STOPPED -> "未运行"
    Engine.State.ERROR -> "出错：${s.engineError.orEmpty()}"
}

private fun shizukuText(s: ShizukuLink.State) = when (s) {
    ShizukuLink.State.READY -> "已连接"
    ShizukuLink.State.NO_PERMISSION -> "未授权"
    ShizukuLink.State.NOT_RUNNING -> "未运行，请打开 Shizuku 启动服务"
}

private fun copy(context: Context, text: String, sensitive: Boolean) {
    val clip = ClipData.newPlainText("MaaLow", text)
    if (sensitive && Build.VERSION.SDK_INT >= 33) {
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    }
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
}

private fun share(context: Context, url: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain")
        .putExtra(Intent.EXTRA_TEXT, "MaaLow 网页指导：$url\n（同一网络下用浏览器打开，链接里带访问令牌，别外传）")
    context.startActivity(Intent.createChooser(send, "分享 MaaLow 链接"))
}

private fun qr(text: String, px: Int = 720): ImageBitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, px, px, mapOf(EncodeHintType.MARGIN to 1))
    val pixels = IntArray(m.width * m.height) { i -> if (m[i % m.width, i / m.width]) 0xFF28292D.toInt() else -1 }
    return Bitmap.createBitmap(pixels, m.width, m.height, Bitmap.Config.ARGB_8888).asImageBitmap()
}

@Composable
private fun Home(app: App, resumed: Boolean) {
    var snap by remember { mutableStateOf(read(app)) }
    LaunchedEffect(resumed) {
        while (resumed) {
            snap = withContext(Dispatchers.Default) { read(app) }
            delay(1000)
        }
    }
    var qrFor by remember { mutableStateOf<Link?>(null) }
    var askReset by remember { mutableStateOf(false) }
    val context = LocalContext.current

    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) { // also the text color outside cards
    Box(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).safeDrawingPadding(),
        contentAlignment = Alignment.TopCenter,
    ) {
        BoxWithConstraints(Modifier.widthIn(max = 1100.dp).padding(horizontal = 16.dp, vertical = 12.dp)) {
            val wide = maxWidth >= 760.dp
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Header(snap)
                if (wide) {
                    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            WorkspaceCard(snap)
                            WebCard(snap, onQr = { qrFor = it }, onReset = { askReset = true })
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            StatusCard(snap)
                            KeepAliveCard(app, snap)
                        }
                    }
                } else {
                    WorkspaceCard(snap)
                    WebCard(snap, onQr = { qrFor = it }, onReset = { askReset = true })
                    StatusCard(snap)
                    KeepAliveCard(app, snap)
                }
                Text(
                    "MaaLow ${BuildConfig.VERSION_NAME} · MaaFramework ${runCatching { Maa.version() }.getOrDefault("?")} · 端口 ${App.PORT}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = 8.dp),
                )
            }
        }
    }
    }

    qrFor?.let { link ->
        AlertDialog(
            onDismissRequest = { qrFor = null },
            confirmButton = { TextButton(onClick = { qrFor = null }) { Text("关闭") } },
            dismissButton = { TextButton(onClick = { share(context, link.url) }) { Text("分享") } },
            title = { Text("扫码打开网页") },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    val img = remember(link.url) { qr(link.url) }
                    Image(img, "二维码", Modifier.size(260.dp).clip(RoundedCornerShape(12.dp)).background(Color.White))
                    Text(link.label, style = MaterialTheme.typography.labelLarge)
                    Text(link.url, style = Mono, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
        )
    }

    if (askReset) {
        AlertDialog(
            onDismissRequest = { askReset = false },
            confirmButton = {
                Button(
                    onClick = {
                        askReset = false
                        app.resetToken()
                        snap = read(app)
                        Toast.makeText(context, "已重置，旧链接已失效", Toast.LENGTH_SHORT).show()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                ) { Text("重置") }
            },
            dismissButton = { TextButton(onClick = { askReset = false }) { Text("取消") } },
            title = { Text("重置 Token？") },
            text = {
                Text("生成新的访问令牌。之前发出去的链接、已打开的网页和 PC 上的 maalow 命令行都会立刻失效，需要用新链接或新 Token 重新配置。")
            },
        )
    }
}

@Composable
private fun Header(s: Snap) {
    val problems = listOf(s.shizuku != ShizukuLink.State.READY, s.engine != Engine.State.RUNNING).count { it } +
        s.checks.count { it.ok == false }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Image(
            painterResource(R.drawable.mascot), "MaaLow",
            Modifier.size(60.dp).clip(CircleShape).background(Palette.Cream)
                .border(2.dp, MaterialTheme.colorScheme.onBackground, CircleShape).padding(5.dp),
        )
        Column(Modifier.weight(1f)) {
            Text("MaaLow", style = MaterialTheme.typography.headlineSmall)
            Text("基于 MaaFramework 的可教学低代码视觉自动化平台", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Pill(if (problems == 0) "一切正常" else "$problems 项待处理", if (problems == 0) Palette.Green else Palette.Orange)
    }
}

@Composable
private fun Pill(text: String, color: Color) {
    Surface(shape = CircleShape, color = color.copy(alpha = 0.16f), border = BorderStroke(1.dp, color.copy(alpha = 0.6f))) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(color))
            Spacer(Modifier.width(6.dp))
            Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onBackground)
        }
    }
}

@Composable
private fun Section(
    title: String,
    icon: ImageVector,
    trailing: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                trailing()
            }
            content()
        }
    }
}

@Composable
private fun appIcon(pkg: String): ImageBitmap? {
    val context = LocalContext.current
    return remember(pkg) {
        if (pkg.isEmpty()) null
        else runCatching { context.packageManager.getApplicationIcon(pkg).toBitmap(144, 144).asImageBitmap() }.getOrNull()
    }
}

@Composable
private fun appLabel(pkg: String): String? {
    val context = LocalContext.current
    return remember(pkg) {
        if (pkg.isEmpty()) null
        else runCatching { context.packageManager.let { pm -> pm.getApplicationInfo(pkg, 0).loadLabel(pm).toString() } }.getOrNull()
    }
}

@Composable
private fun WorkspaceCard(s: Snap) {
    Section("当前工作区", Icons.Outlined.Folder) {
        if (s.workspace == null) {
            Text("还没有工作区。在网页上新建一个，或用 PC 端 maalow sync 推送。", color = MaterialTheme.colorScheme.onSurfaceVariant)
            return@Section
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            val icon = appIcon(s.pkg)
            Box(
                Modifier.size(56.dp).clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center,
            ) {
                if (icon != null) Image(icon, null, Modifier.size(56.dp))
                else Text(s.workspace.take(1).uppercase(), style = MaterialTheme.typography.headlineSmall)
            }
            Column(Modifier.weight(1f)) {
                Text(s.workspace, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(appLabel(s.pkg) ?: if (s.pkg.isNotEmpty()) "未安装" else "未设置游戏", s.pkg.ifEmpty { null }).joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip("守护规则 ${s.guardCount} 条 · ${if (s.guardsOn) "开" else "关"}")
            Chip("定时任务 ${s.scheduleCount} 个")
            if (s.recording) Chip("● 录制中", Palette.Red)
        }
        Text(
            "在网页上切换和管理工作区，这里会自动跟着变。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Chip(text: String, color: Color? = null) {
    Surface(shape = RoundedCornerShape(8.dp), color = color?.copy(alpha = 0.14f) ?: MaterialTheme.colorScheme.surfaceVariant) {
        Text(
            text, style = MaterialTheme.typography.labelMedium, color = color ?: MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
        )
    }
}

/** Copy icon that turns into a check mark for a moment. */
@Composable
private fun CopyButton(text: String, sensitive: Boolean = false) {
    val context = LocalContext.current
    var done by remember { mutableStateOf(false) }
    LaunchedEffect(done) { if (done) { delay(1500); done = false } }
    IconButton(onClick = { copy(context, text, sensitive); done = true }) {
        Icon(
            if (done) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
            if (done) "已复制" else "复制",
            tint = if (done) Palette.Green else MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
private fun WebCard(s: Snap, onQr: (Link) -> Unit, onReset: () -> Unit) {
    val context = LocalContext.current
    Section("网页访问", Icons.Outlined.Language) {
        Text(
            "在电脑或其他设备的浏览器打开下面的链接（链接里带 Token）。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (s.links.isEmpty()) Text("没有联网：连上 Wi‑Fi 后这里会显示地址。", color = MaterialTheme.colorScheme.error)
        s.links.forEachIndexed { i, link ->
            if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(link.label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    Text(link.url.substringBefore("/?"), style = Mono, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                CopyButton(link.url)
                IconButton(onClick = { onQr(link) }) { Icon(Icons.Outlined.QrCode2, "二维码") }
                IconButton(onClick = { share(context, link.url) }) { Icon(Icons.Outlined.Share, "分享") }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        var show by remember { mutableStateOf(false) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Token", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text(
                    if (show) s.token else s.token.take(4) + "•".repeat(12) + s.token.takeLast(4),
                    style = Mono, maxLines = 2,
                )
            }
            IconButton(onClick = { show = !show }) {
                Icon(if (show) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (show) "隐藏" else "显示")
            }
            CopyButton(s.token, sensitive = true)
        }
        OutlinedButton(
            onClick = onReset,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.5f)),
        ) { Text("重置 Token") }
    }
}

@Composable
private fun StatusRow(ok: Boolean?, title: String, value: String, action: (@Composable () -> Unit)? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        val (icon, tint) = when (ok) {
            true -> Icons.Outlined.CheckCircle to Palette.Green
            false -> Icons.Outlined.ErrorOutline to MaterialTheme.colorScheme.error
            null -> Icons.AutoMirrored.Outlined.HelpOutline to MaterialTheme.colorScheme.onSurfaceVariant
        }
        Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        action?.invoke()
    }
}

@Composable
private fun StatusCard(s: Snap) {
    val context = LocalContext.current
    val time = remember { SimpleDateFormat("MM-dd HH:mm", Locale.ROOT) }
    Section("运行状态", Icons.Outlined.Memory) {
        StatusRow(s.shizuku == ShizukuLink.State.READY, "Shizuku", shizukuText(s.shizuku)) {
            if (s.shizuku == ShizukuLink.State.NO_PERMISSION) FilledTonalButton(onClick = { ShizukuLink.requestPermission() }) { Text("授权") }
        }
        StatusRow(s.engine == Engine.State.RUNNING, "引擎", engineText(s)) {
            TextButton(onClick = { MaaLowService.start(context, MaaLowService.ACTION_RESTART_ENGINE) }) {
                Text(if (s.engine == Engine.State.RUNNING) "重启" else "启动")
            }
        }
        StatusRow(if (s.engine == Engine.State.RUNNING) true else null, "画面", "${s.screen} · ${s.frame}")
        StatusRow(if (s.guardsOn) true else null, "守护规则", if (s.guardsOn) guardText(s.guardResult) else "已关闭（在网页概览里打开）")
        StatusRow(null, "下次定时", s.nextAlarm?.let { time.format(Date(it)) } ?: "没有")
    }
}

@Composable
private fun KeepAliveCard(app: App, s: Snap) {
    val context = LocalContext.current
    fun open(key: String) {
        val intent = KeepAlive.settingsIntent(context, key) ?: return
        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            context.startActivity(KeepAlive.detailsIntent(context))
        } catch (e: SecurityException) {
            context.startActivity(KeepAlive.detailsIntent(context))
        }
    }
    Section("后台保活（HyperOS）", Icons.Outlined.Shield) {
        for (c in s.checks) {
            StatusRow(c.ok, c.label, c.detail) {
                if (c.ok != true && KeepAlive.settingsIntent(context, c.key) != null) TextButton(onClick = { open(c.key) }) { Text("去设置") }
            }
        }
        if (s.checks.any { it.ok == false || (it.ok == null && it.key != "tailsocks") }) { // not installed: nothing to fix
            Button(
                onClick = {
                    app.scope.launch {
                        val msg = runCatching { KeepAlive.fix(app, app.engine); "已设置" }.getOrElse { "设置失败：${it.message}" }
                        withContext(Dispatchers.Main) { Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("用 Shizuku 一键设置") }
        }
    }
}
