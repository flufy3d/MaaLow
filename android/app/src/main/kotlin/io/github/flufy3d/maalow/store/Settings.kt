package io.github.flufy3d.maalow.store

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.io.File

/** Device-local settings (settings.json in the external files dir); workspaces stay portable. */
@Serializable
data class Settings(
    /** Workspace used when a request names none (teaching, guards). */
    val workspace: String = "",
    @SerialName("guards_enabled") val guardsEnabled: Boolean = true,
    @SerialName("guard_interval_ms") val guardIntervalMs: Long = 2000,
    /** H.264 bit rate of screen recordings, bits per second. */
    @SerialName("record_bitrate") val recordBitrate: Int = 10_000_000, // 3 Mbps blurred the minimap (2026-10-02 test)
    /** The web UI's HTTPS address (TailSocks Serve), e.g. https://maalow-pad.tailea818a.ts.net; the remote stage needs it. */
    @SerialName("https_url") val httpsUrl: String = "",
) {
    companion object {
        private val lock = Any()

        fun load(file: File): Settings = synchronized(lock) {
            if (file.isFile) runCatching { LenientJson.decodeFromString(serializer(), file.readText()) }.getOrNull() ?: Settings()
            else Settings()
        }

        fun update(file: File, change: (Settings) -> Settings): Settings = synchronized(lock) {
            change(load(file)).also { file.writeAtomic(PrettyJson.encodeToString(serializer(), it).toByteArray()) }
        }
    }
}
