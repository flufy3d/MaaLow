package io.github.flufy3d.maalow.record

import android.graphics.Bitmap
import android.graphics.Canvas
import io.github.flufy3d.maalow.store.writeAtomic
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ExecutorService

/**
 * Low-res previews for scrubbing: every [every]-th frame (frame i * every) as a [width]x[height] tile, [COLS]x[ROWS]
 * tiles per JPEG sheet, thumbs/000.jpg, 001.jpg, ... in frame order, left to right, top to bottom.
 */
internal class Thumbs(private val dir: File, val every: Int, val width: Int, val height: Int, private val io: ExecutorService?) {
    private var sheet: Bitmap? = null
    private var canvas: Canvas? = null
    var count = 0 // tiles added
        private set

    /** Tiles already on disk (full sheets from an interrupted recording): continue after them. */
    fun resume(tiles: Int) {
        count = tiles - tiles % PER_SHEET
    }

    /** Add the next tile (frame count * every). */
    fun add(tile: Bitmap) {
        val slot = count % PER_SHEET
        if (slot == 0) {
            sheet = Bitmap.createBitmap(COLS * width, ROWS * height, Bitmap.Config.ARGB_8888)
            canvas = Canvas(sheet!!)
        }
        canvas!!.drawBitmap(tile, ((slot % COLS) * width).toFloat(), ((slot / COLS) * height).toFloat(), null)
        count++
        if (count % PER_SHEET == 0) flush()
    }

    /** Write the current (possibly partial) sheet. */
    fun flush() {
        val bmp = sheet ?: return
        val index = (count - 1) / PER_SHEET
        sheet = null
        canvas = null
        val write = Runnable {
            val out = ByteArrayOutputStream(256 * 1024)
            bmp.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
            bmp.recycle()
            File(dir, "%03d.jpg".format(index)).writeAtomic(out.toByteArray())
        }
        io?.execute(write) ?: write.run()
    }

    fun json(): JsonObject = layout(every, width, height, count)

    companion object {
        const val COLS = 10
        const val ROWS = 10
        const val PER_SHEET = COLS * ROWS
        const val QUALITY = 70
        const val WIDTH = 192

        fun layout(every: Int, width: Int, height: Int, count: Int) = buildJsonObject {
            put("every", every)
            put("width", width)
            put("height", height)
            put("cols", COLS)
            put("rows", ROWS)
            put("count", count)
            put("sheets", (count + PER_SHEET - 1) / PER_SHEET)
        }

        /** Tiles for a clip of `frames` frames. */
        fun tilesFor(frames: Int, every: Int) = (frames + every - 1) / every
    }
}
