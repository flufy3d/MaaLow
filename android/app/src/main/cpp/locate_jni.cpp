// JNI for skills' locate() (skill/Locate.kt): reference images in, minimap discs cut from Maa screenshots.
// The matching itself is locate_core.cpp.

#include <jni.h>

#include <cmath>
#include <vector>

#include "MaaFramework/MaaAPI.h"
#include "locate_core.h"

namespace
{

// [kind, pre, sigma, r_use, r_arrow, fan_r, fan_half, sat_max, zone, zone_gain]
LocPrep prep_of(const float* a)
{
    return LocPrep { int(a[0]), a[1], a[2], int(a[3]), int(a[4]), int(a[5]), a[6], int(a[7]), int(a[8]), a[9] };
}

constexpr int PREP_LEN = 10;

} // namespace

#define FN(ret, name) extern "C" JNIEXPORT ret JNICALL Java_io_github_flufy3d_maalow_engine_Maa_##name

// A reference from ARGB pixels (Bitmap.getPixels); alpha < 128 is where the map is not known.
FN(jlong, locateRefCreate)(JNIEnv* env, jobject, jintArray argb, jint w, jint h, jfloatArray prep)
{
    if (env->GetArrayLength(argb) < w * h || env->GetArrayLength(prep) < PREP_LEN) {
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
    jfloat* p = env->GetFloatArrayElements(prep, nullptr);
    LocPrep lp = prep_of(p);
    env->ReleaseFloatArrayElements(prep, p, JNI_ABORT);
    return reinterpret_cast<jlong>(loc_ref_create(bgr.data(), w * 3, valid.data(), w, h, &lp));
}

FN(void, locateRefDestroy)(JNIEnv*, jobject, jlong h)
{
    loc_ref_destroy(reinterpret_cast<LocRef*>(h));
}

// args: [minimap center x, y, camera heading (NaN: unknown), prior u, v (reference px), radius (< 0: everywhere),
// then the preprocessing]. Returns [u, v, score, second, used px], or null.
FN(jfloatArray, locateRun)(JNIEnv* env, jobject, jlong image, jlong ref, jfloatArray args)
{
    if (env->GetArrayLength(args) < 6 + PREP_LEN) {
        return nullptr;
    }
    auto* img = reinterpret_cast<MaaImageBuffer*>(image);
    if (!img || MaaImageBufferIsEmpty(img) || MaaImageBufferChannels(img) != 3) {
        return nullptr;
    }
    const int w = MaaImageBufferWidth(img), h = MaaImageBufferHeight(img);
    const auto* data = static_cast<const uint8_t*>(MaaImageBufferGetRawData(img));
    jfloat* a = env->GetFloatArrayElements(args, nullptr);
    const int x0 = int(std::lround(a[0])) - 54, y0 = int(std::lround(a[1])) - 54;
    LocPrep lp = prep_of(a + 6);
    float out[5];
    int ok = 0;
    if (data && x0 >= 0 && y0 >= 0 && x0 + 110 <= w && y0 + 110 <= h) {
        const uint8_t* disc = data + (size_t(y0) * w + x0) * 3;
        ok = loc_run(reinterpret_cast<LocRef*>(ref), disc, w * 3, a[2], a[3], a[4], a[5], &lp, out);
    }
    env->ReleaseFloatArrayElements(args, a, JNI_ABORT);
    if (!ok) {
        return nullptr;
    }
    jfloatArray res = env->NewFloatArray(5);
    env->SetFloatArrayRegion(res, 0, 5, out);
    return res;
}
