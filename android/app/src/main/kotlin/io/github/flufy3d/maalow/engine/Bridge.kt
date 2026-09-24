package io.github.flufy3d.maalow.engine

import android.graphics.Bitmap
import android.view.Surface

/** The native device bridge (libmaalow_bridge.so), shared with MaaAndroidNativeControlUnit in this process. */
object Bridge {
    const val LIBRARY = "maalow_bridge"

    init {
        System.loadLibrary(LIBRARY)
    }

    /** Creates the frame reader; the returned Surface is handed to the privileged process to mirror into. */
    external fun nativeCreate(width: Int, height: Int): Surface?
    external fun nativeDestroy()

    /** Takes ownership of one end of a SOCK_SEQPACKET socketpair. */
    external fun nativeSetInputFd(fd: Int)

    /** [seq, capture timestamp ns, now ns, last convert ns, dropped frames] */
    external fun nativeStats(out: LongArray)

    /** Copies the latest frame into an ARGB_8888 bitmap of the frame size; returns its seq or -1. */
    external fun nativeSnapshot(bitmap: Bitmap, waitMs: Int): Long

    data class Stats(val seq: Long, val ageMs: Double, val convertMs: Double, val dropped: Long)

    fun stats(): Stats {
        val v = LongArray(5)
        nativeStats(v)
        return Stats(v[0], if (v[0] > 0) (v[2] - v[1]) / 1e6 else -1.0, v[3] / 1e6, v[4])
    }
}
