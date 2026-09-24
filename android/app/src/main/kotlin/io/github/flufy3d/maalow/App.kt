package io.github.flufy3d.maalow

import android.app.Application
import io.github.flufy3d.maalow.auto.Guards
import io.github.flufy3d.maalow.auto.Scheduler
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.server.ApiServer
import io.github.flufy3d.maalow.skill.Skills
import io.github.flufy3d.maalow.store.Events
import io.github.flufy3d.maalow.store.Settings
import io.github.flufy3d.maalow.store.Workspaces
import io.github.flufy3d.maalow.teach.Teaching
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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

    /** Background work that outlives a request (e.g. a triggered run with wait=false). */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** External files dir: workspaces, settings, events and runs, all reachable with adb. */
    val storeDir: File by lazy { getExternalFilesDir(null)!! }

    /** API token; also written to the external files dir so `adb shell cat` can fetch it. */
    val token: String by lazy {
        val f = File(filesDir, "token")
        if (!f.isFile) {
            val bytes = ByteArray(18).also { SecureRandom().nextBytes(it) }
            f.writeText(bytes.joinToString("") { "%02x".format(it) })
        }
        f.readText().trim().also { File(storeDir, "token.txt").writeText(it) }
    }

    private val settingsFile by lazy { File(storeDir, "settings.json") }

    fun settings(): Settings = Settings.load(settingsFile)

    fun updateSettings(change: (Settings) -> Settings): Settings = Settings.update(settingsFile, change)

    /** The workspace used when a request names none: the configured one, else the first. */
    fun defaultWorkspace(): String? =
        settings().workspace.takeIf { it.isNotEmpty() && workspaces.exists(it) } ?: workspaces.list().firstOrNull()

    override fun onCreate() {
        super.onCreate()
        instance = this
        engine = Engine(this)
        workspaces = Workspaces(engine.workspaces)
        events = Events(File(storeDir, "events.jsonl"))
        skills = Skills(this)
        engine.custom = skills
        teaching = Teaching(this)
        guards = Guards(this)
        scheduler = Scheduler(this)
        server = ApiServer(this)
    }

    companion object {
        const val PORT = 8765
        lateinit var instance: App
            private set
    }
}
