package io.github.flufy3d.maalow

import android.app.Application
import io.github.flufy3d.maalow.auto.Guards
import io.github.flufy3d.maalow.auto.Scheduler
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.record.Frames
import io.github.flufy3d.maalow.record.Recorder
import io.github.flufy3d.maalow.record.Recordings
import io.github.flufy3d.maalow.remote.Remote
import io.github.flufy3d.maalow.server.ApiServer
import io.github.flufy3d.maalow.skill.Skills
import io.github.flufy3d.maalow.store.Events
import io.github.flufy3d.maalow.store.Settings
import io.github.flufy3d.maalow.store.Workspaces
import io.github.flufy3d.maalow.teach.Teaching
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.put
import java.io.File
import java.security.SecureRandom

class App : Application() {
    lateinit var engine: Engine
        private set
    lateinit var server: ApiServer
        private set
    lateinit var workspaces: Workspaces
        private set
    lateinit var events: Events
        private set
    lateinit var teaching: Teaching
        private set
    lateinit var guards: Guards
        private set
    lateinit var scheduler: Scheduler
        private set
    lateinit var skills: Skills
        private set
    lateinit var recorder: Recorder
        private set
    lateinit var recordings: Recordings
        private set
    lateinit var frames: Frames
        private set
    lateinit var remote: Remote
        private set

    /** Background work that outlives a request (e.g. a triggered run with wait=false). */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** External files dir: workspaces, settings, events and runs, all reachable with adb. */
    val storeDir: File by lazy { getExternalFilesDir(null)!! }

    @Volatile private var tokenValue: String? = null

    /** API token; also written to the external files dir so `adb shell cat` can fetch it. */
    val token: String
        get() = tokenValue ?: synchronized(this) {
            tokenValue ?: File(filesDir, "token").let { f ->
                if (!f.isFile) f.writeText(newToken())
                f.readText().trim().also { File(storeDir, "token.txt").writeText(it) }
            }.also { tokenValue = it }
        }

    private fun newToken() = ByteArray(18).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    /** A new token: every link and PC client holding the old one stops working at once. */
    fun resetToken(): String = synchronized(this) {
        val t = newToken()
        File(filesDir, "token").writeText(t)
        File(storeDir, "token.txt").writeText(t)
        tokenValue = t
        events.post("token_reset")
        t
    }

    private val settingsFile by lazy { File(storeDir, "settings.json") }

    fun settings(): Settings = Settings.load(settingsFile)

    fun updateSettings(change: (Settings) -> Settings): Settings = Settings.update(settingsFile, change)

    private var extraMirror: String? = null

    /**
     * Besides recognition's, one more mirror of the display at a time: recording ("record") or the remote view
     * ("remote"), whichever came first. Throws, saying why, when the other one has it.
     */
    fun claimMirror(owner: String) = synchronized(this) {
        when (extraMirror) {
            null, owner -> extraMirror = owner
            "remote" -> error("远程画面开着，先关掉再录制")
            else -> error("录制中，不能开远程画面")
        }
    }

    fun releaseMirror(owner: String) = synchronized(this) {
        if (extraMirror == owner) extraMirror = null
    }

    /** The workspace used when a request names none: the configured one, else the first. */
    fun defaultWorkspace(): String? =
        settings().workspace.takeIf { it.isNotEmpty() && workspaces.exists(it) } ?: workspaces.list().firstOrNull()

    /** Why the workspace cannot be switched away from, renamed or deleted right now; null when it can. */
    fun busyWith(ws: String): String? {
        if (recorder.recording || recorder.state()["saving"] != null) return "正在录制"
        skills.running.firstOrNull { it.startsWith("$ws/") }?.let { return "技能 ${it.substringAfter('/')} 正在运行" }
        val busy = engine.busy ?: return null
        return when {
            busy.startsWith("task:$ws/") -> "规则 ${busy.substringAfter('/')} 正在运行"
            busy.startsWith("teach:$ws/") -> "实时指导正在执行操作"
            else -> null
        }
    }

    /**
     * Make ws the current workspace: teaching, recording, guards and runs without a workspace all follow. The
     * teaching session is saved and moves to the new workspace's draft.
     */
    fun useWorkspace(ws: String) {
        require(workspaces.exists(ws)) { "没有工作区：$ws" }
        val cur = defaultWorkspace()
        if (cur == ws && settings().workspace == ws) return
        cur?.let { c -> busyWith(c)?.let { error("$it，先停止再切换工作区") } }
        updateSettings { it.copy(workspace = ws) }
        if (teaching.active && teaching.workspace != ws) teaching.task(Teaching.DEFAULT_TASK, ws, "teacher")
        events.post("workspace") { put("workspace", ws) }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        engine = Engine(this)
        workspaces = Workspaces(engine.workspaces)
        events = Events(File(storeDir, "events.jsonl"))
        skills = Skills(this)
        engine.custom = skills
        teaching = Teaching(this)
        frames = Frames()
        recordings = Recordings(this)
        recorder = Recorder(this)
        remote = Remote(this)
        engine.onPrivilegedGone = { recorder.stopAsync("engine"); remote.engineGone() }
        guards = Guards(this)
        scheduler = Scheduler(this)
        server = ApiServer(this)
        scope.launch(Dispatchers.IO) { recordings.recoverAll() } // cut short by a kill or crash
    }

    companion object {
        const val PORT = 8765
        lateinit var instance: App
            private set
    }
}
