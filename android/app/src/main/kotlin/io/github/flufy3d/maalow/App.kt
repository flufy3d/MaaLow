package io.github.flufy3d.maalow

import android.app.Application
import io.github.flufy3d.maalow.engine.Engine
import io.github.flufy3d.maalow.server.ApiServer
import java.io.File
import java.security.SecureRandom

class App : Application() {
    lateinit var engine: Engine
        private set
    lateinit var server: ApiServer
        private set

    /** API token; also written to the external files dir so `adb shell cat` can fetch it. */
    val token: String by lazy {
        val f = File(filesDir, "token")
        if (!f.isFile) {
            val bytes = ByteArray(18).also { SecureRandom().nextBytes(it) }
            f.writeText(bytes.joinToString("") { "%02x".format(it) })
        }
        f.readText().trim().also { File(getExternalFilesDir(null), "token.txt").writeText(it) }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        engine = Engine(this)
        server = ApiServer(this)
    }

    companion object {
        const val PORT = 8765
        lateinit var instance: App
            private set
    }
}
