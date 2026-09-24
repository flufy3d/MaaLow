package io.github.flufy3d.maalow.engine

/** JNI over the MaaFramework C API (libmaalow_jni.so). Handles are native pointers. */
object Maa {
    init {
        System.loadLibrary("maalow_jni")
    }

    external fun version(): String
    external fun setLogDir(dir: String): Boolean
    external fun setDebugMode(on: Boolean): Boolean

    external fun resourceCreate(): Long
    external fun resourceDestroy(h: Long)
    /** kind: 0 bundle, 1 pipeline, 2 image, 3 ocr model; blocks until loaded. */
    external fun resourceLoad(h: Long, kind: Int, path: String): Boolean
    external fun resourceNodeList(h: Long): String

    external fun controllerCreateNative(configJson: String): Long
    /** Offline controller serving one image file; returns a handle for imageController{Get,Destroy}. */
    external fun imageControllerCreate(path: String): Long
    external fun imageControllerGet(h: Long): Long
    external fun imageControllerDestroy(h: Long)
    external fun controllerDestroy(h: Long)
    external fun controllerUseRawSize(h: Long): Boolean
    external fun controllerConnect(h: Long): Boolean
    external fun controllerScreencap(h: Long): Boolean
    external fun controllerClick(h: Long, x: Int, y: Int): Boolean
    external fun controllerSwipe(h: Long, x1: Int, y1: Int, x2: Int, y2: Int, duration: Int): Boolean
    /** type: 0 down, 1 move, 2 up */
    external fun controllerTouch(h: Long, type: Int, contact: Int, x: Int, y: Int): Boolean
    external fun controllerKey(h: Long, code: Int): Boolean
    external fun controllerInputText(h: Long, text: String): Boolean
    external fun controllerStartApp(h: Long, intent: String): Boolean
    external fun controllerStopApp(h: Long, intent: String): Boolean

    external fun taskerCreate(): Long
    external fun taskerDestroy(h: Long)
    external fun taskerBind(h: Long, resource: Long, controller: Long): Boolean
    external fun taskerStop(h: Long)
    /** Runs to completion; returns {"status","entry","nodes":[{"name","completed","reco","action"}]}. */
    external fun taskerRun(h: Long, entry: String, overrideJson: String): String

    const val STATUS_SUCCEEDED = 3000
}
