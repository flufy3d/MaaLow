package io.github.flufy3d.maalow.skill

import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import io.github.flufy3d.maalow.App
import io.github.flufy3d.maalow.engine.Maa
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.lsposed.hiddenapibypass.HiddenApiBypass
import java.io.File

/**
 * The optional QNN plugin: a separate APK ([PACKAGE], android/qnnplugin) that carries onnxruntime with the QNN
 * execution provider and Qualcomm's QNN libraries (HTP backend and its per-generation stub / skel), nothing else.
 * MaaLow itself ships none of it. infer()'s provider "qnn" loads it from the plugin's nativeLibraryDir into this
 * process (Maa.nnQnnLoad, beside MaaFramework's own onnxruntime, see nn_jni.cpp) the first time it is asked for.
 *
 * The plugin must be signed with MaaLow's key (it is native code run in this process), and installed with its
 * libraries extracted (it declares extractNativeLibs). Once loaded it stays loaded: after the plugin is updated,
 * restart MaaLow. When it is missing or fails to load, the reason is kept and checked again only when the plugin's
 * package changes (looked up at most every [RECHECK_MS]).
 */
internal class QnnPlugin(private val app: App) {
    /** The plugin's lib dir, once its runtime is loaded. */
    @Volatile var dir: String? = null
        private set

    /** Why it is not loaded (null when it is, or nothing tried yet). */
    @Volatile var error: String? = null
        private set

    /** Bumped when the runtime gets loaded: models that fell back to cpu before are reopened. */
    @Volatile var generation = 0
        private set

    private var triedStamp = Long.MIN_VALUE // the package's lastUpdateTime at the last load attempt (-1: not installed)
    private var checkedAt = 0L

    /** The plugin's lib dir with its runtime loaded, or null ([error] says why). */
    @Synchronized
    fun ensure(): String? {
        dir?.let { return it }
        val now = SystemClock.elapsedRealtime()
        if (triedStamp != Long.MIN_VALUE && now - checkedAt < RECHECK_MS) return null
        checkedAt = now
        val info = info()
        val stamp = info?.lastUpdateTime ?: -1L
        if (stamp == triedStamp) return null
        triedStamp = stamp
        error = load(info)
        if (error == null) generation++
        return dir
    }

    private fun info() = try {
        app.packageManager.getPackageInfo(PACKAGE, 0)
    } catch (e: PackageManager.NameNotFoundException) {
        null
    }

    /** Load it; null when loaded ([dir] set), else why not. */
    private fun load(info: android.content.pm.PackageInfo?): String? {
        if (info == null) return "the QNN plugin ($PACKAGE) is not installed"
        if (app.packageManager.checkSignatures(app.packageName, PACKAGE) != PackageManager.SIGNATURE_MATCH) {
            return "the QNN plugin is not signed with MaaLow's key"
        }
        val lib = info.applicationInfo?.nativeLibraryDir ?: return "the QNN plugin has no native library dir"
        if (!File(lib, "libonnxruntime.so").isFile) return "the QNN plugin's libraries are not extracted in $lib"
        val err = runCatching { Maa.nnQnnLoad(lib) }.getOrElse { it.message ?: it.toString() }
        if (err.isNotEmpty()) return err
        dir = lib
        return null
    }

    /** For /status and nnProviders(): installed / version without loading anything; loaded, onnxruntime, error. */
    fun json(): JsonObject = buildJsonObject {
        val info = info()
        put("installed", info != null)
        info?.versionName?.let { put("version", it) }
        put("loaded", dir != null)
        if (dir != null) put("onnxruntime", runCatching { Maa.nnQnnVersion() }.getOrDefault(""))
        error?.let { put("error", it) }
    }

    companion object {
        const val PACKAGE = "io.github.flufy3d.maalow.qnn"
        const val RECHECK_MS = 5000L

        /** The SoC (chip) as Android reports it, for /status and nnProviders(). */
        fun soc(): JsonObject = buildJsonObject {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                put("manufacturer", Build.SOC_MANUFACTURER)
                put("model", Build.SOC_MODEL)
            }
            put("hardware", Build.HARDWARE)
            put("board", Build.BOARD)
            prop("ro.board.platform")?.let { put("platform", it) }
            prop("ro.soc.model")?.let { if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) put("model", it) }
            put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
        }

        private fun prop(key: String): String? = runCatching {
            HiddenApiBypass.invoke(Class.forName("android.os.SystemProperties"), null, "get", key) as String
        }.getOrNull()?.takeIf { it.isNotEmpty() }
    }
}
