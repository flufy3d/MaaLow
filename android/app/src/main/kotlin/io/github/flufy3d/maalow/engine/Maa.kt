package io.github.flufy3d.maalow.engine

/** JNI over the MaaFramework C API (libmaalow_jni.so). Handles are native pointers. */
object Maa {
    /** Receives the custom actions / recognitions registered with [resourceRegisterCustom] (skills). */
    interface Custom {
        fun action(context: Long, taskId: Long, node: String, name: String, param: String, recoId: Long, box: IntArray): Boolean
        /** Returns the detail JSON on a hit (filling [out] with the box), null on a miss. */
        fun recognition(context: Long, taskId: Long, node: String, name: String, param: String, image: Long, roi: IntArray, out: IntArray): String?
    }

    @Volatile var custom: Custom? = null

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
    /** Register a skill as custom action "name" and custom recognition "name.recognize", served by [custom]. */
    external fun resourceRegisterCustom(h: Long, name: String): Boolean
    external fun resourceUnregisterCustom(h: Long, name: String)

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
    /** type: 0 down, 1 up */
    external fun controllerKeyState(h: Long, type: Int, code: Int): Boolean
    /** Screenshot into an image buffer. */
    external fun controllerScreencapInto(h: Long, image: Long): Boolean
    external fun controllerInputText(h: Long, text: String): Boolean
    external fun controllerStartApp(h: Long, intent: String): Boolean
    external fun controllerStopApp(h: Long, intent: String): Boolean

    external fun taskerCreate(): Long
    external fun taskerDestroy(h: Long)
    external fun taskerBind(h: Long, resource: Long, controller: Long): Boolean
    external fun taskerStop(h: Long)
    /** Runs to completion; returns {"id","status","entry","nodes":[{"name","completed","reco","action"}]}. */
    external fun taskerRun(h: Long, entry: String, overrideJson: String): String

    external fun imageCreate(): Long
    external fun imageDestroy(h: Long)
    /** PNG bytes. */
    external fun imageEncoded(h: Long): ByteArray

    // Locating a screen crop in a reference (locate_jni.cpp, skill/Locate.kt); params: Locator.paramsOf
    /** A preprocessed reference from ARGB pixels (alpha < 128: not known); 0 on bad input. */
    external fun locateRefCreate(argb: IntArray, w: Int, h: Int, params: FloatArray): Long
    external fun locateRefDestroy(h: Long)
    /** args: [crop center x, y, wedge heading or NaN, prior u, v, radius (ref px, < 0: all), params...]; [u, v, score, second, used] or null. */
    external fun locateRun(image: Long, ref: Long, args: FloatArray): FloatArray?

    // Inside a custom action / recognition (on the tasker's thread):
    external fun contextController(h: Long): Long
    /** A pipeline node's definition (JSON), or null if there is no such node. */
    external fun contextNodeData(h: Long, node: String): String?
    /** Recognition by pipeline node; returns {"id","hit","box","algorithm","detail"}. */
    external fun contextRecognize(h: Long, entry: String, overrideJson: String, image: Long): String
    /** Recognition by type ("TemplateMatch", "OCR", ...) and parameters; same result as [contextRecognize]. */
    external fun contextRecognizeDirect(h: Long, type: String, param: String, image: Long): String
    /** A nested pipeline task; same result as [taskerRun]. */
    external fun contextRunTask(h: Long, entry: String, overrideJson: String): String

    @JvmStatic
    fun onCustomAction(context: Long, taskId: Long, node: String, name: String, param: String, recoId: Long, box: IntArray): Boolean =
        custom?.action(context, taskId, node, name, param, recoId, box) ?: false

    @JvmStatic
    fun onCustomRecognition(
        context: Long, taskId: Long, node: String, name: String, param: String, image: Long, roi: IntArray, out: IntArray,
    ): String? = custom?.recognition(context, taskId, node, name, param, image, roi, out)

    const val STATUS_SUCCEEDED = 3000
}
