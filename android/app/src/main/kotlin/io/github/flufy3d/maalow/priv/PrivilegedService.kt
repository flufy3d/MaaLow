package io.github.flufy3d.maalow.priv

import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.SystemClock
import android.system.Os
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
import io.github.flufy3d.maalow.IPrivileged
import org.lsposed.hiddenapibypass.HiddenApiBypass
import java.lang.reflect.Method
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread
import kotlin.system.exitProcess

/**
 * Shizuku UserService, running as shell uid in its own app_process. Everything here is either a
 * hidden-API call that needs shell privileges or a thin loop around one. Shizuku (v13+) passes a Context.
 */
class PrivilegedService(private val context: Context) : IPrivileged.Stub() {

    init { // before the fields below, which use hidden APIs
        HiddenApiBypass.addHiddenApiExemptions("")
        Log.i(TAG, "privileged service up, pid=${Process.myPid()} uid=${Process.myUid()}")
    }

    private val mirrors = HashMap<Int, VirtualDisplay>()
    private var nextMirror = 1
    private val injector = Injector()
    private var inputThread: Thread? = null

    override fun destroy() {
        synchronized(mirrors) { mirrors.values.forEach { it.release() } }
        exitProcess(0)
    }

    override fun pid(): Int = Process.myPid()

    override fun mirror(surface: Surface, width: Int, height: Int, name: String): Int {
        // Hidden static API used by shell-uid tools (e.g. scrcpy): a virtual display mirroring an existing one.
        val create = DisplayManager::class.java.getMethod(
            "createVirtualDisplay",
            String::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType, Surface::class.java,
        )
        val display = create.invoke(null, name, width, height, Display.DEFAULT_DISPLAY, surface) as VirtualDisplay?
            ?: return -1
        synchronized(mirrors) {
            val id = nextMirror++
            mirrors[id] = display
            Log.i(TAG, "mirror $id: ${width}x$height '$name'")
            return id
        }
    }

    override fun release(id: Int) {
        synchronized(mirrors) { mirrors.remove(id) }?.release()
    }

    override fun attachInput(socket: ParcelFileDescriptor, width: Int, height: Int) {
        inputThread?.interrupt()
        inputThread = thread(name = "maalow-input", isDaemon = true) { readInput(socket, width, height) }
    }

    override fun exec(cmd: String): String {
        val p = ProcessBuilder("sh", "-c", cmd).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText()
        return "exit=${p.waitFor()}\n$out"
    }

    override fun displayInfo(): IntArray {
        val d = displayManager().getDisplay(Display.DEFAULT_DISPLAY)
        val size = android.graphics.Point()
        @Suppress("DEPRECATION") d.getRealSize(size)
        return intArrayOf(size.x, size.y, d.rotation)
    }

    private fun displayManager() = context.getSystemService(DisplayManager::class.java)

    // ---- input loop (wire format: see bridge.cpp)

    private fun readInput(socket: ParcelFileDescriptor, width: Int, height: Int) {
        val fd = socket.fileDescriptor
        val buf = ByteArray(24 + 4000)
        while (!Thread.currentThread().isInterrupted) {
            val n = try {
                Os.read(fd, buf, 0, buf.size)
            } catch (e: Exception) {
                Log.w(TAG, "input channel closed: $e")
                break
            }
            if (n <= 0) break
            if (n < 24) continue
            val bb = ByteBuffer.wrap(buf, 0, n).order(ByteOrder.LITTLE_ENDIAN)
            val type = bb.int
            val contact = bb.int
            val x = bb.int
            val y = bb.int
            val code = bb.int
            bb.int // display id, always 0 for now
            val text = String(buf, 24, n - 24, Charsets.UTF_8)
            val reply = try {
                handle(type, contact, x, y, code, text, width, height)
            } catch (e: Exception) {
                Log.e(TAG, "input $type failed", e)
                -1
            }
            if (type == START_GAME || type == STOP_GAME || type == INPUT) {
                val r = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(reply).array()
                try {
                    Os.write(fd, r, 0, 4)
                } catch (e: Exception) {
                    break
                }
            }
        }
        socket.close()
    }

    private fun handle(type: Int, contact: Int, x: Int, y: Int, code: Int, text: String, w: Int, h: Int): Int {
        when (type) {
            TOUCH_DOWN, TOUCH_MOVE, TOUCH_UP -> {
                val (px, py) = toDisplay(x, y, w, h)
                return if (injector.touch(type, contact, px, py)) 0 else -1
            }
            KEY_DOWN -> return if (injector.key(KeyEvent.ACTION_DOWN, code)) 0 else -1
            KEY_UP -> return if (injector.key(KeyEvent.ACTION_UP, code)) 0 else -1
            START_GAME -> {
                val pkg = text.trim()
                if (code != 0) exec("am force-stop $pkg")
                return if (exec("monkey -p $pkg -c android.intent.category.LAUNCHER 1").startsWith("exit=0")) 0 else -1
            }
            STOP_GAME -> return if (exec("am force-stop ${text.trim()}").startsWith("exit=0")) 0 else -1
            INPUT -> return if (exec("input text '${text.replace("'", "'\\''")}'").startsWith("exit=0")) 0 else -1
        }
        return -1
    }

    /** Frame (aspect-fit mirror of the display) -> display logical coordinates in the current rotation. */
    private fun toDisplay(x: Int, y: Int, w: Int, h: Int): Pair<Float, Float> {
        val (lw, lh) = displayInfo()
        val scale = minOf(w.toFloat() / lw, h.toFloat() / lh)
        val ox = (w - lw * scale) / 2
        val oy = (h - lh * scale) / 2
        val px = ((x + 0.5f - ox) / scale).coerceIn(0f, lw - 1f)
        val py = ((y + 0.5f - oy) / scale).coerceIn(0f, lh - 1f)
        return px to py
    }

    companion object {
        const val TAG = "MaaLowPriv"
        const val START_GAME = 1
        const val STOP_GAME = 2
        const val INPUT = 4
        const val TOUCH_DOWN = 6
        const val TOUCH_MOVE = 7
        const val TOUCH_UP = 8
        const val KEY_DOWN = 9
        const val KEY_UP = 10
    }
}

/** Multi-touch and key injection through the hidden InputManagerGlobal.injectInputEvent. */
private class Injector {
    private val manager: Any
    private val inject: Method

    init {
        val cls = try {
            Class.forName("android.hardware.input.InputManagerGlobal")
        } catch (e: ClassNotFoundException) {
            Class.forName("android.hardware.input.InputManager")
        }
        manager = cls.getMethod("getInstance").invoke(null)!!
        inject = cls.getMethod("injectInputEvent", InputEvent::class.java, Int::class.javaPrimitiveType)
    }

    private val active = ArrayList<Int>() // contact ids in pointer-index order
    private val coords = HashMap<Int, MotionEvent.PointerCoords>()
    private var downTime = 0L

    @Synchronized
    fun touch(type: Int, contact: Int, x: Float, y: Float): Boolean {
        val now = SystemClock.uptimeMillis()
        val c = coords.getOrPut(contact) { MotionEvent.PointerCoords() }
        if (type != PrivilegedService.TOUCH_UP || contact !in active) { // Maa's touch up carries no position: lift where it is
            c.x = x
            c.y = y
        }
        c.pressure = 1f
        c.size = 1f
        val action = when (type) {
            PrivilegedService.TOUCH_DOWN -> {
                if (contact in active) return true
                if (active.isEmpty()) downTime = now
                active.add(contact)
                if (active.size == 1) MotionEvent.ACTION_DOWN
                else MotionEvent.ACTION_POINTER_DOWN or (active.indexOf(contact) shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
            }
            PrivilegedService.TOUCH_MOVE -> {
                if (contact !in active) return false
                MotionEvent.ACTION_MOVE
            }
            else -> {
                if (contact !in active) return true
                if (active.size == 1) MotionEvent.ACTION_UP
                else MotionEvent.ACTION_POINTER_UP or (active.indexOf(contact) shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
            }
        }
        val props = Array(active.size) { i ->
            MotionEvent.PointerProperties().apply {
                id = active[i]
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
        }
        val pcs = Array(active.size) { i -> coords[active[i]]!! }
        val event = MotionEvent.obtain(
            downTime, now, action, active.size, props, pcs, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0,
        )
        val ok = send(event)
        event.recycle()
        if (type == PrivilegedService.TOUCH_UP) {
            active.remove(contact)
            coords.remove(contact)
        }
        return ok
    }

    fun key(action: Int, code: Int): Boolean {
        val now = SystemClock.uptimeMillis()
        val event = KeyEvent(
            now, now, action, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD,
        )
        return send(event)
    }

    // 1 = INJECT_INPUT_EVENT_MODE_WAIT_FOR_RESULT: returns once dispatched, without waiting for the app to handle it.
    private fun send(event: InputEvent): Boolean = try {
        (inject.invoke(manager, event, 1) as Boolean).also { if (!it) Log.w(PrivilegedService.TAG, "inject rejected: $event") }
    } catch (e: java.lang.reflect.InvocationTargetException) {
        Log.w(PrivilegedService.TAG, "inject failed: $event", e.targetException)
        false
    }
}
