package io.github.flufy3d.maalow.skill

/**
 * JNI over QuickJS (libmaalow_js.so, quickjs-ng). A runtime is single-threaded: create, call and destroy it on one
 * thread; only [interrupt] may come from another. Scripts reach Kotlin through [Host.call] alone.
 */
object Js {
    init {
        System.loadLibrary("maalow_js")
    }

    /** Strings are UTF-8 bytes both ways (JNI's modified UTF-8 cannot carry characters outside the BMP). */
    interface Host {
        /** __host(op, json) from the script: JSON args in, JSON result out (null for undefined). Throw to fail. */
        fun call(op: String, args: ByteArray?): ByteArray?

        /** Source of an ES module, by its normalized name, e.g. "skills/lib/util.js". */
        fun module(name: ByteArray): ByteArray
    }

    /** Thrown by a host call to end the run: uncatchable in the script (stop, timeout). */
    class Stop(message: String) : RuntimeException(message)

    /** A runtime with __host installed and the prelude (a global script) evaluated; throws if the prelude fails. */
    external fun create(host: Host, prelude: ByteArray, preludeName: String): Long
    external fun destroy(h: Long)

    /**
     * Import module and take its export: a function is called with (args, ctx) JSON and awaited, anything else is
     * returned as is ("*": the export names). Result JSON: {"ok":true,"value":...[,"missing":true]} or
     * {"ok":false,"error":{"name","message","stack","interrupted"}}.
     */
    external fun call(h: Long, module: String, export: String, args: ByteArray, ctx: ByteArray): ByteArray

    /** Make running script code throw an uncatchable error at its next check (on), or clear that (off). */
    external fun interrupt(h: Long, on: Boolean)
}
