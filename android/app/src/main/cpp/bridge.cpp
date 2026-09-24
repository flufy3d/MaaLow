// MaaLow device bridge.
//
// MaaAndroidNativeControlUnit dlopen()s this library and calls three C functions:
//   GetLockedPixels / UnlockPixels   latest screen frame as BGR, pinned until unlocked
//   DispatchInputMessage             touch / key / text / app start-stop
//
// Frames: the privileged (Shizuku) process mirrors the display into the Surface of an AImageReader created
// here. The reader's callback thread converts each new RGBA frame to BGR into a 3-slot ring and publishes it;
// readers pin the newest slot with a refcount, so capture never blocks recognition and vice versa.
//
// Input: messages are written to a SOCK_SEQPACKET socket whose other end is read by the privileged process,
// which injects the events. Touches are fire-and-forget; app/text commands wait for a status reply.

#include <jni.h>

#include <android/bitmap.h>
#include <android/log.h>
#include <android/native_window_jni.h>
#include <arm_neon.h>
#include <media/NdkImageReader.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>

#define LOG_TAG "MaaLowBridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define EXPORT extern "C" __attribute__((visibility("default")))

// ---- ABI shared with MaaAndroidNativeControlUnit (source/MaaAndroidNativeControlUnit/General/AndroidExternalLib.h)

struct FrameInfo
{
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t stride = 0;
    uint32_t length = 0;
    void* data = nullptr;
    void* frame_ref = nullptr;
};

enum MethodType : int
{
    START_GAME = 1,
    STOP_GAME = 2,
    INPUT = 4,
    TOUCH_DOWN = 6,
    TOUCH_MOVE = 7,
    TOUCH_UP = 8,
    KEY_DOWN = 9,
    KEY_UP = 10
};

struct Position
{
    int x = 0;
    int y = 0;
};

struct StartGameArgs
{
    const char* package_name = nullptr;
    int force_stop = 0;
};

struct StopGameArgs
{
    const char* client_type = nullptr;
};

struct InputArgs
{
    const char* text = nullptr;
};

struct TouchArgs
{
    Position p {};
    int contact = 0;
};

struct KeyArgs
{
    int key_code = 0;
};

union ArgUnion
{
    StartGameArgs start_game;
    StopGameArgs stop_game;
    InputArgs input;
    TouchArgs touch;
    KeyArgs key;
};

struct MethodParam
{
    int display_id = 0;
    MethodType method = START_GAME;
    ArgUnion args {};
};

// ---- frame ring

namespace
{

constexpr int kSlots = 3;
constexpr int kMaxImages = 4;

struct Slot
{
    uint8_t* bgr = nullptr;
    std::atomic<int> refs { 0 };
    uint64_t seq = 0;
    int64_t timestamp_ns = 0; // capture time, CLOCK_MONOTONIC (AImage timestamp)
};

struct Bridge
{
    int width = 0;
    int height = 0;
    int stride = 0;
    Slot slots[kSlots];
    std::atomic<int> latest { -1 };
    std::atomic<uint64_t> seq { 0 };
    std::atomic<uint64_t> dropped { 0 };
    std::atomic<int64_t> convert_ns { 0 };
    AImageReader* reader = nullptr;
    std::mutex first_mu;
    std::condition_variable first_cv;

    int input_fd = -1;
    std::mutex input_mu;
};

Bridge g;

int64_t now_ns()
{
    timespec ts {};
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return int64_t(ts.tv_sec) * 1000000000 + ts.tv_nsec;
}

void rgba_to_bgr(const uint8_t* src, int src_stride, uint8_t* dst, int dst_stride, int w, int h)
{
    for (int y = 0; y < h; ++y) {
        const uint8_t* s = src + size_t(y) * src_stride;
        uint8_t* d = dst + size_t(y) * dst_stride;
        int x = 0;
        for (; x + 16 <= w; x += 16) {
            uint8x16x4_t rgba = vld4q_u8(s + x * 4);
            uint8x16x3_t bgr;
            bgr.val[0] = rgba.val[2];
            bgr.val[1] = rgba.val[1];
            bgr.val[2] = rgba.val[0];
            vst3q_u8(d + x * 3, bgr);
        }
        for (; x < w; ++x) {
            d[x * 3] = s[x * 4 + 2];
            d[x * 3 + 1] = s[x * 4 + 1];
            d[x * 3 + 2] = s[x * 4];
        }
    }
}

void on_image(void*, AImageReader* reader)
{
    AImage* image = nullptr;
    if (AImageReader_acquireLatestImage(reader, &image) != AMEDIA_OK || !image) {
        return;
    }
    uint8_t* data = nullptr;
    int len = 0, row_stride = 0, w = 0, h = 0;
    int64_t ts = 0;
    AImage_getPlaneData(image, 0, &data, &len);
    AImage_getPlaneRowStride(image, 0, &row_stride);
    AImage_getWidth(image, &w);
    AImage_getHeight(image, &h);
    AImage_getTimestamp(image, &ts);

    int latest = g.latest.load();
    int target = -1;
    for (int i = 0; i < kSlots; ++i) {
        if (i != latest && g.slots[i].refs.load() == 0) {
            target = i;
            break;
        }
    }
    if (target < 0 || !data || w != g.width || h != g.height) {
        g.dropped.fetch_add(1);
        AImage_delete(image);
        return;
    }

    int64_t t0 = now_ns();
    Slot& slot = g.slots[target];
    rgba_to_bgr(data, row_stride, slot.bgr, g.stride, w, h);
    AImage_delete(image);
    slot.seq = g.seq.fetch_add(1) + 1;
    slot.timestamp_ns = ts ? ts : t0;
    g.convert_ns.store(now_ns() - t0);
    g.latest.store(target);
    if (slot.seq == 1) {
        std::lock_guard lock(g.first_mu);
        g.first_cv.notify_all();
    }
}

// Pin the newest slot; returns nullptr if no frame arrived within wait_ms.
Slot* pin_latest(int wait_ms)
{
    if (g.latest.load() < 0 && wait_ms > 0) {
        std::unique_lock lock(g.first_mu);
        g.first_cv.wait_for(lock, std::chrono::milliseconds(wait_ms), [] { return g.latest.load() >= 0; });
    }
    for (;;) {
        int idx = g.latest.load();
        if (idx < 0) {
            return nullptr;
        }
        Slot& slot = g.slots[idx];
        slot.refs.fetch_add(1);
        if (g.latest.load() == idx) {
            return &slot;
        }
        slot.refs.fetch_sub(1); // a newer frame was published meanwhile; pin that one
    }
}

void release_slots()
{
    for (auto& slot : g.slots) {
        free(slot.bgr);
        slot.bgr = nullptr;
        slot.refs = 0;
        slot.seq = 0;
    }
    g.latest = -1;
}

// ---- input wire format, little endian: int32 type, contact, x, y, code, display_id, then UTF-8 string bytes

bool send_message(const MethodParam& p, bool wait_reply, int& reply)
{
    int32_t head[6] = { p.method, 0, 0, 0, 0, p.display_id };
    const char* str = nullptr;
    switch (p.method) {
    case TOUCH_DOWN:
    case TOUCH_MOVE:
    case TOUCH_UP:
        head[1] = p.args.touch.contact;
        head[2] = p.args.touch.p.x;
        head[3] = p.args.touch.p.y;
        break;
    case KEY_DOWN:
    case KEY_UP:
        head[4] = p.args.key.key_code;
        break;
    case START_GAME:
        str = p.args.start_game.package_name;
        head[4] = p.args.start_game.force_stop;
        break;
    case STOP_GAME:
        str = p.args.stop_game.client_type;
        break;
    case INPUT:
        str = p.args.input.text;
        break;
    }
    size_t str_len = str ? strlen(str) : 0;
    if (str_len > 4000) {
        return false;
    }
    uint8_t buf[sizeof(head) + 4000];
    memcpy(buf, head, sizeof(head));
    if (str_len) {
        memcpy(buf + sizeof(head), str, str_len);
    }

    std::lock_guard lock(g.input_mu);
    if (g.input_fd < 0) {
        LOGE("input channel not attached");
        return false;
    }
    if (send(g.input_fd, buf, sizeof(head) + str_len, MSG_NOSIGNAL) < 0) {
        LOGE("input send failed: %s", strerror(errno));
        return false;
    }
    if (!wait_reply) {
        reply = 0;
        return true;
    }
    int32_t r = -1;
    if (recv(g.input_fd, &r, sizeof(r), 0) != sizeof(r)) {
        LOGE("input reply failed: %s", strerror(errno));
        return false;
    }
    reply = r;
    return true;
}

} // namespace

// ---- MaaAndroidNativeControlUnit entry points

EXPORT FrameInfo GetLockedPixels()
{
    Slot* slot = pin_latest(2000);
    if (!slot) {
        return {};
    }
    FrameInfo info;
    info.width = g.width;
    info.height = g.height;
    info.stride = g.stride;
    info.length = g.stride * g.height;
    info.data = slot->bgr;
    info.frame_ref = slot;
    return info;
}

EXPORT int UnlockPixels(FrameInfo info)
{
    if (!info.frame_ref) {
        return -1;
    }
    static_cast<Slot*>(info.frame_ref)->refs.fetch_sub(1);
    return 0;
}

EXPORT int DispatchInputMessage(MethodParam param)
{
    bool wait = param.method == START_GAME || param.method == STOP_GAME || param.method == INPUT;
    int reply = -1;
    if (!send_message(param, wait, reply)) {
        return -1;
    }
    return reply;
}

// ---- JNI for io.github.flufy3d.maalow.engine.Bridge

extern "C" JNIEXPORT jobject JNICALL
    Java_io_github_flufy3d_maalow_engine_Bridge_nativeCreate(JNIEnv* env, jobject, jint width, jint height)
{
    if (g.reader) {
        LOGE("bridge already created");
        return nullptr;
    }
    g.width = width;
    g.height = height;
    g.stride = width * 3;
    for (auto& slot : g.slots) {
        slot.bgr = static_cast<uint8_t*>(aligned_alloc(64, (size_t(g.stride) * height + 63) / 64 * 64));
    }
    media_status_t st = AImageReader_newWithUsage(
        width,
        height,
        AIMAGE_FORMAT_RGBA_8888,
        AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN | AHARDWAREBUFFER_USAGE_GPU_COLOR_OUTPUT,
        kMaxImages,
        &g.reader);
    if (st != AMEDIA_OK) {
        LOGE("AImageReader_newWithUsage failed: %d", st);
        release_slots();
        g.reader = nullptr;
        return nullptr;
    }
    AImageReader_ImageListener listener { nullptr, on_image };
    AImageReader_setImageListener(g.reader, &listener);
    ANativeWindow* window = nullptr;
    AImageReader_getWindow(g.reader, &window);
    LOGI("bridge created %dx%d", width, height);
    return ANativeWindow_toSurface(env, window);
}

extern "C" JNIEXPORT void JNICALL Java_io_github_flufy3d_maalow_engine_Bridge_nativeDestroy(JNIEnv*, jobject)
{
    if (g.reader) {
        AImageReader_delete(g.reader);
        g.reader = nullptr;
    }
    release_slots();
    std::lock_guard lock(g.input_mu);
    if (g.input_fd >= 0) {
        close(g.input_fd);
        g.input_fd = -1;
    }
}

// Takes ownership of fd (one end of a SOCK_SEQPACKET socketpair).
extern "C" JNIEXPORT void JNICALL Java_io_github_flufy3d_maalow_engine_Bridge_nativeSetInputFd(JNIEnv*, jobject, jint fd)
{
    std::lock_guard lock(g.input_mu);
    if (g.input_fd >= 0) {
        close(g.input_fd);
    }
    g.input_fd = fd;
    if (fd >= 0) {
        timeval tv { 30, 0 };
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    }
}

// out: [seq, capture timestamp ns, now ns, last convert ns, dropped frames]
extern "C" JNIEXPORT void JNICALL Java_io_github_flufy3d_maalow_engine_Bridge_nativeStats(JNIEnv* env, jobject, jlongArray out)
{
    jlong v[5] = { 0, 0, now_ns(), g.convert_ns.load(), jlong(g.dropped.load()) };
    if (Slot* slot = pin_latest(0)) {
        v[0] = jlong(slot->seq);
        v[1] = slot->timestamp_ns;
        slot->refs.fetch_sub(1);
    }
    env->SetLongArrayRegion(out, 0, 5, v);
}

// Copy the latest frame into an ARGB_8888 bitmap of the same size; returns the frame seq, or -1.
extern "C" JNIEXPORT jlong JNICALL
    Java_io_github_flufy3d_maalow_engine_Bridge_nativeSnapshot(JNIEnv* env, jobject, jobject bitmap, jint wait_ms)
{
    AndroidBitmapInfo info {};
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS || int(info.width) != g.width
        || int(info.height) != g.height || info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        return -1;
    }
    Slot* slot = pin_latest(wait_ms);
    if (!slot) {
        return -1;
    }
    void* pixels = nullptr;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS) {
        slot->refs.fetch_sub(1);
        return -1;
    }
    for (int y = 0; y < g.height; ++y) {
        const uint8_t* s = slot->bgr + size_t(y) * g.stride;
        uint8_t* d = static_cast<uint8_t*>(pixels) + size_t(y) * info.stride;
        int x = 0;
        for (; x + 16 <= g.width; x += 16) {
            uint8x16x3_t bgr = vld3q_u8(s + x * 3);
            uint8x16x4_t rgba;
            rgba.val[0] = bgr.val[2];
            rgba.val[1] = bgr.val[1];
            rgba.val[2] = bgr.val[0];
            rgba.val[3] = vdupq_n_u8(255);
            vst4q_u8(d + x * 4, rgba);
        }
        for (; x < g.width; ++x) {
            d[x * 4] = s[x * 3 + 2];
            d[x * 4 + 1] = s[x * 3 + 1];
            d[x * 4 + 2] = s[x * 3];
            d[x * 4 + 3] = 255;
        }
    }
    AndroidBitmap_unlockPixels(env, bitmap);
    jlong seq = jlong(slot->seq);
    slot->refs.fetch_sub(1);
    return seq;
}
