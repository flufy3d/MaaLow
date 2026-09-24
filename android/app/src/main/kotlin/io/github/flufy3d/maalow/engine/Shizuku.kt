package io.github.flufy3d.maalow.engine

import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import io.github.flufy3d.maalow.BuildConfig
import io.github.flufy3d.maalow.IPrivileged
import io.github.flufy3d.maalow.priv.PrivilegedService
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import rikka.shizuku.Shizuku
import kotlin.coroutines.resume

/** Shizuku state and the privileged UserService connection. */
object ShizukuLink {
    enum class State { NOT_RUNNING, NO_PERMISSION, READY }

    const val PERMISSION_REQUEST = 7

    fun state(): State = when {
        !Shizuku.pingBinder() -> State.NOT_RUNNING
        Shizuku.isPreV11() -> State.NOT_RUNNING
        Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED -> State.NO_PERMISSION
        else -> State.READY
    }

    /** Shizuku hands its binder over asynchronously after the process starts; wait a moment for it. */
    suspend fun settle(timeoutMs: Long = 5000) {
        withTimeoutOrNull(timeoutMs) { while (!Shizuku.pingBinder()) delay(100) }
    }

    fun requestPermission() {
        if (Shizuku.pingBinder()) Shizuku.requestPermission(PERMISSION_REQUEST)
    }

    private val args = Shizuku.UserServiceArgs(ComponentName(BuildConfig.APPLICATION_ID, PrivilegedService::class.java.name))
        .daemon(false)
        .processNameSuffix("priv")
        .debuggable(BuildConfig.DEBUG)
        .version(BuildConfig.VERSION_CODE)

    @Volatile var service: IPrivileged? = null
        private set
    private var connection: ServiceConnection? = null

    /** Bind the UserService (starting it as shell uid if needed). */
    suspend fun bind(onDied: () -> Unit): IPrivileged = withTimeout(15_000) {
        suspendCancellableCoroutine { cont ->
            val conn = object : ServiceConnection {
                override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                    if (binder == null || !binder.pingBinder()) return
                    val s = IPrivileged.Stub.asInterface(binder)
                    service = s
                    binder.linkToDeath({ service = null; onDied() }, 0)
                    if (cont.isActive) cont.resume(s)
                }

                override fun onServiceDisconnected(name: ComponentName?) {
                    service = null
                }
            }
            connection = conn
            Shizuku.bindUserService(args, conn)
        }
    }

    fun unbind() {
        connection?.let { runCatching { Shizuku.unbindUserService(args, it, true) } } // throws once Shizuku is gone
        connection = null
        service = null
    }
}
