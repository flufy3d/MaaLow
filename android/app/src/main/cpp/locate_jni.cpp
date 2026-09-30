// JNI for skills' locate() (skill/Locate.kt): reference images in, crops cut from Maa screenshots.
// The matching itself is locate_core.cpp.

#include <jni.h>

#include <algorithm>
#include <cmath>
#include <vector>

#include "MaaFramework/MaaAPI.h"
#include "locate_core.h"

namespace
{

// [kind, pre, sigma, size, r_in, r_out, wedge_r, wedge_half, grow, sat_max, region_mode, region lo h s v, hi h s v,
// region_gain, region_open, region_min, region_close, region_edge, n_drop, then n_drop ranges (lo h s v, hi h s v)]
constexpr int PARAMS_LEN = 23;

LocRange range_of(const float* a)
{
    LocRange r;
    for (int i = 0; i < 3; ++i) {
        r.lo[i] = int(a[i]);
        r.hi[i] = int(a[3 + i]);
    }
    return r;
}

// false when the array is too short for its drop ranges
bool params_of(const float* a, int n, LocParams& p)
{
    p.kind = int(a[0]);
    p.pre = a[1];
    p.sigma = a[2];
    p.size = int(a[3]);
    p.r_in = a[4];
    p.r_out = a[5];
    p.wedge_r = a[6];
    p.wedge_half = a[7];
    p.grow = int(a[8]);
    p.sat_max = int(a[9]);
    p.region_mode = int(a[10]);
    p.region = range_of(a + 11);
    p.region_gain = a[17];
    p.region_open = int(a[18]);
    p.region_min = int(a[19]);
    p.region_close = int(a[20]);
    p.region_edge = int(a[21]);
    p.n_drop = std::clamp(int(a[22]), 0, LOC_MAX_DROP);
    if (n < PARAMS_LEN + 6 * p.n_drop) {
        return false;
    }
    for (int i = 0; i < p.n_drop; ++i) {
        p.drop[i] = range_of(a + PARAMS_LEN + 6 * i);
    }
    return true;
}

} // namespace

#define FN(ret, name) extern "C" JNIEXPORT ret JNICALL Java_io_github_flufy3d_maalow_engine_Maa_##name

// A reference from ARGB pixels (Bitmap.getPixels); alpha < 128 is where the map is not known.
FN(jlong, locateRefCreate)(JNIEnv* env, jobject, jintArray argb, jint w, jint h, jfloatArray params)
{
    const int n = env->GetArrayLength(params);
    if (env->GetArrayLength(argb) < w * h || n < PARAMS_LEN) {
        return 0;
    }
    jfloat* a = env->GetFloatArrayElements(params, nullptr);
    LocParams lp;
    bool ok = params_of(a, n, lp);
    env->ReleaseFloatArrayElements(params, a, JNI_ABORT);
    if (!ok) {
        return 0;
    }
    std::vector<uint8_t> bgr(size_t(w) * h * 3), valid(size_t(w) * h);
    jint* px = env->GetIntArrayElements(argb, nullptr);
    for (size_t i = 0; i < size_t(w) * h; ++i) {
        uint32_t c = uint32_t(px[i]);
        bgr[3 * i] = uint8_t(c);
        bgr[3 * i + 1] = uint8_t(c >> 8);
        bgr[3 * i + 2] = uint8_t(c >> 16);
        valid[i] = (c >> 24) >= 128;
    }
    env->ReleaseIntArrayElements(argb, px, JNI_ABORT);
    return reinterpret_cast<jlong>(loc_ref_create(bgr.data(), w * 3, valid.data(), w, h, &lp));
}

FN(void, locateRefDestroy)(JNIEnv*, jobject, jlong h)
{
    loc_ref_destroy(reinterpret_cast<LocRef*>(h));
}

// args: [crop center x, y (on screen), wedge heading (NaN: unknown), prior u, v (reference px), radius (< 0:
// everywhere), then the params]. Returns [u, v, score, second, used px], or null.
FN(jfloatArray, locateRun)(JNIEnv* env, jobject, jlong image, jlong ref, jfloatArray args)
{
    const int n = env->GetArrayLength(args);
    if (n < 6 + PARAMS_LEN) {
        return nullptr;
    }
    auto* img = reinterpret_cast<MaaImageBuffer*>(image);
    if (!img || MaaImageBufferIsEmpty(img) || MaaImageBufferChannels(img) != 3) {
        return nullptr;
    }
    const int w = MaaImageBufferWidth(img), h = MaaImageBufferHeight(img);
    const auto* data = static_cast<const uint8_t*>(MaaImageBufferGetRawData(img));
    jfloat* a = env->GetFloatArrayElements(args, nullptr);
    LocParams lp;
    bool ok = params_of(a + 6, n - 6, lp);
    float out[5];
    if (ok) {
        const int c = (lp.size - 1) / 2;
        const int x0 = int(std::lround(a[0])) - c, y0 = int(std::lround(a[1])) - c;
        ok = data && x0 >= 0 && y0 >= 0 && x0 + lp.size <= w && y0 + lp.size <= h;
        if (ok) {
            const uint8_t* crop = data + (size_t(y0) * w + x0) * 3;
            ok = loc_run(reinterpret_cast<LocRef*>(ref), crop, w * 3, a[2], a[3], a[4], a[5], &lp, out) != 0;
        }
    }
    env->ReleaseFloatArrayElements(args, a, JNI_ABORT);
    if (!ok) {
        return nullptr;
    }
    jfloatArray res = env->NewFloatArray(5);
    env->SetFloatArrayRegion(res, 0, 5, out);
    return res;
}
