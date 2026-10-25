// Screenshot preprocessing for skills' infer() (nn_jni.cpp): crop a region of a BGR image, resize it, convert its
// color. Plain C++ with no JNI / Maa / onnxruntime inside, so the PC test (tests/test_nn_prep.py) compiles this very
// file and checks it against cv2.resize.
//
// Area downscaling (interp 0 with the output no larger than the region, the case models are trained on) is
// OpenCV's resizeArea, reproduced bit for bit: the same tables (computeResizeAreaTab, with cv::resize's scale), the
// same float operations in the same order, each multiply and add rounded on its own (no FMA, as cv2 on the PC), and
// cvRound's round-half-to-even. Only the work is arranged differently: flat tap tables padded to a fixed count (a
// zero-weight tap adds an exact +0), every source row filtered horizontally once (OpenCV filters a row shared by two
// output rows twice, with the same result), and the vertical sum over contiguous floats. Integer scales take
// OpenCV's resizeAreaFast instead (@see area_fast). Everything else (linear, nearest, area upscaling) is
// prep_generic, as before.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <map>
#include <vector>

namespace nnprep
{

// ---- generic path (linear / nearest / area upscaling), unchanged

// OpenCV's INTER_AREA weights (computeResizeAreaTab): per output index, (source index, weight) pairs.
struct Tap
{
    int src;
    float w;
};

inline std::vector<std::vector<Tap>> area_taps(int ssize, int dsize)
{
    const double scale = double(ssize) / dsize;
    std::vector<std::vector<Tap>> taps(dsize);
    for (int dx = 0; dx < dsize; ++dx) {
        double fsx1 = dx * scale, fsx2 = fsx1 + scale;
        double cell = std::min(scale, ssize - fsx1);
        int sx1 = int(std::ceil(fsx1)), sx2 = int(std::floor(fsx2));
        sx2 = std::min(sx2, ssize - 1);
        sx1 = std::min(sx1, sx2);
        auto& t = taps[dx];
        if (sx1 - fsx1 > 1e-3) {
            t.push_back({ sx1 - 1, float((sx1 - fsx1) / cell) });
        }
        for (int sx = sx1; sx < sx2; ++sx) {
            t.push_back({ sx, float(1.0 / cell) });
        }
        if (fsx2 - sx2 > 1e-3) {
            t.push_back({ sx2, float(std::min(std::min(fsx2 - sx2, 1.0), cell) / cell) });
        }
    }
    return taps;
}

// Bilinear (OpenCV INTER_LINEAR: half-pixel centers, edges clamped) or nearest (floor(dx * scale)).
inline std::vector<std::vector<Tap>> point_taps(int ssize, int dsize, bool linear)
{
    const double scale = double(ssize) / dsize;
    std::vector<std::vector<Tap>> taps(dsize);
    for (int dx = 0; dx < dsize; ++dx) {
        if (!linear) {
            taps[dx].push_back({ std::min(int(dx * scale), ssize - 1), 1.f });
            continue;
        }
        double f = (dx + 0.5) * scale - 0.5;
        int x0 = int(std::floor(f));
        float a = float(f - x0);
        if (x0 < 0) {
            x0 = 0;
            a = 0;
        }
        if (x0 >= ssize - 1) {
            x0 = ssize - 1;
            a = 0;
        }
        taps[dx].push_back({ x0, 1.f - a });
        if (a > 0) {
            taps[dx].push_back({ x0 + 1, a });
        }
    }
    return taps;
}

inline uint8_t sat(float v)
{
    int i = int(std::lround(v));
    return uint8_t(std::clamp(i, 0, 255));
}

// One output row's BGR bytes -> out row in color 0 gray (cv::COLOR_BGR2GRAY's fixed point), 1 rgb, 2 bgr.
inline void put_row(const uint8_t* bgr, int ow, int color, uint8_t* o)
{
    if (color == 2) {
        std::memcpy(o, bgr, size_t(ow) * 3);
        return;
    }
    for (int dx = 0; dx < ow; ++dx) {
        const uint8_t b = bgr[dx * 3], g = bgr[dx * 3 + 1], r = bgr[dx * 3 + 2];
        if (color == 0) {
            o[dx] = uint8_t((b * 1868 + g * 9617 + r * 4899 + (1 << 13)) >> 14);
        }
        else {
            o[dx * 3] = r;
            o[dx * 3 + 1] = g;
            o[dx * 3 + 2] = b;
        }
    }
}

// interp 0 area (upscaling: linear, per axis), 1 linear, 2 nearest; float taps, lround.
inline void prep_generic(const uint8_t* img, size_t stride, int rx, int ry, int rw, int rh, int ow, int oh, int color, int interp,
                         uint8_t* out)
{
    const bool area = interp == 0;
    auto tx = area && rw >= ow ? area_taps(rw, ow) : point_taps(rw, ow, interp != 2);
    auto ty = area && rh >= oh ? area_taps(rh, oh) : point_taps(rh, oh, interp != 2);
    std::vector<float> acc(size_t(ow) * 3);
    std::vector<uint8_t> bgr(size_t(ow) * 3);
    for (int dy = 0; dy < oh; ++dy) {
        std::fill(acc.begin(), acc.end(), 0.f);
        for (const Tap& vy : ty[dy]) {
            const uint8_t* src = img + size_t(ry + vy.src) * stride + size_t(rx) * 3;
            for (int dx = 0; dx < ow; ++dx) {
                float b = 0, g = 0, r = 0;
                for (const Tap& vx : tx[dx]) {
                    const uint8_t* p = src + vx.src * 3;
                    b += p[0] * vx.w;
                    g += p[1] * vx.w;
                    r += p[2] * vx.w;
                }
                acc[dx * 3] += b * vy.w;
                acc[dx * 3 + 1] += g * vy.w;
                acc[dx * 3 + 2] += r * vy.w;
            }
        }
        for (int i = 0; i < ow * 3; ++i) {
            bgr[i] = sat(acc[i]);
        }
        put_row(bgr.data(), ow, color, out + size_t(dy) * ow * (color == 0 ? 1 : 3));
    }
}

// ---- area downscaling, as OpenCV

// cv::resize's scale for an axis: 1 / (dsize / ssize), not ssize / dsize (the two can differ in the last bit).
inline double cv_scale(int ssize, int dsize)
{
    return 1. / (double(dsize) / ssize);
}

// computeResizeAreaTab, laid out flat: output i takes taps [i * k, i * k + k) of (source index, weight), in OpenCV's
// order, padded at the end with weight-0 taps on its last source index.
struct AreaTab
{
    int k = 0;
    std::vector<int> src;
    std::vector<float> w;
};

inline AreaTab area_tab(int ssize, int dsize)
{
    const double scale = cv_scale(ssize, dsize);
    std::vector<std::vector<Tap>> taps(dsize);
    size_t k = 1;
    for (int dx = 0; dx < dsize; ++dx) {
        double fsx1 = dx * scale;
        double fsx2 = fsx1 + scale;
        double cell = std::min(scale, ssize - fsx1);
        int sx1 = int(std::ceil(fsx1)), sx2 = int(std::floor(fsx2));
        sx2 = std::min(sx2, ssize - 1);
        sx1 = std::min(sx1, sx2);
        auto& t = taps[dx];
        if (sx1 - fsx1 > 1e-3) {
            t.push_back({ sx1 - 1, float((sx1 - fsx1) / cell) });
        }
        for (int sx = sx1; sx < sx2; ++sx) {
            t.push_back({ sx, float(1.0 / cell) });
        }
        if (fsx2 - sx2 > 1e-3) {
            t.push_back({ sx2, float(std::min(std::min(fsx2 - sx2, 1.), cell) / cell) });
        }
        if (t.empty()) { // cannot happen for ssize >= dsize; keeps the padding below defined
            t.push_back({ std::min(sx1, ssize - 1), 0.f });
        }
        k = std::max(k, t.size());
    }
    AreaTab tab;
    tab.k = int(k);
    tab.src.resize(size_t(dsize) * k);
    tab.w.resize(size_t(dsize) * k);
    for (int dx = 0; dx < dsize; ++dx) {
        for (size_t j = 0; j < k; ++j) {
            const bool real = j < taps[dx].size();
            tab.src[dx * k + j] = real ? taps[dx][j].src : taps[dx].back().src;
            tab.w[dx * k + j] = real ? taps[dx][j].w : 0.f;
        }
    }
    return tab;
}

// Both axes' tables for a region size -> output size, kept per thread for the sizes last used (a skill asks for the
// same few every frame).
struct AreaPlan
{
    AreaTab tx, ty;
};

inline const AreaPlan& area_plan(int rw, int ow, int rh, int oh)
{
    thread_local std::map<std::array<int, 4>, AreaPlan> plans;
    const std::array<int, 4> key { rw, ow, rh, oh };
    auto it = plans.find(key);
    if (it != plans.end()) {
        return it->second;
    }
    if (plans.size() >= 16) {
        plans.clear();
    }
    return plans.emplace(key, AreaPlan { area_tab(rw, ow), area_tab(rh, oh) }).first->second;
}

// Everything below rounds each product and sum on its own, as OpenCV's resizeArea does on the PC: no FMA.
#if defined(__clang__)
#define NNPREP_NO_CONTRACT _Pragma("clang fp contract(off)")
#else
#define NNPREP_NO_CONTRACT
#endif

// Four floats as one vector (NEON / SSE through the compilers' vector extension): lane-wise IEEE multiplies and
// adds, the same as the scalar ones.
typedef float F4 __attribute__((vector_size(16)));

// The row's n bytes as floats (one more is written: f has n + 1).
inline void to_float(const uint8_t* src, int n, float* f)
{
    for (int i = 0; i < n; ++i) {
        f[i] = float(src[i]);
    }
    f[n] = 0.f;
}

// buf[dx] = sum over the taps of dx, in order, of pixel[tap] * weight, from 0 (OpenCV: buf[dx] = 0; buf[dx] += S * a).
// A pixel is f[tap * 3 ..] loaded as 4 floats: lanes b, g, r and the next pixel's b, whose sum is never used.
template <int K>
inline void hrow(const float* f, const AreaTab& tx, int ow, F4* buf)
{
    NNPREP_NO_CONTRACT
    const int k = K > 0 ? K : tx.k;
    const int* si = tx.src.data();
    const float* wi = tx.w.data();
    for (int dx = 0; dx < ow; ++dx, si += k, wi += k) {
        F4 acc = F4 { 0.f, 0.f, 0.f, 0.f };
        for (int j = 0; j < k; ++j) {
            const float w = wi[j];
            F4 p;
            std::memcpy(&p, f + size_t(si[j]) * 3, sizeof p);
            const F4 t = p * F4 { w, w, w, w };
            acc = acc + t;
        }
        buf[dx] = acc;
    }
}

using HRow = void (*)(const float*, const AreaTab&, int, F4*);

inline HRow hrow_for(int k)
{
    switch (k) {
    case 1: return hrow<1>;
    case 2: return hrow<2>;
    case 3: return hrow<3>;
    case 4: return hrow<4>;
    case 5: return hrow<5>;
    case 6: return hrow<6>;
    default: return hrow<0>;
    }
}

// cvRound (round half to even) of 0 <= v < 2^22, saturated to uint8: adding and subtracting 1.5 * 2^23 rounds to an
// integer in the default rounding mode.
inline uint8_t round_u8(float v)
{
    NNPREP_NO_CONTRACT
    const float magic = 12582912.f;
    const float r = (v + magic) - magic;
    return uint8_t(std::min(r, 255.f));
}

// OpenCV's resizeArea (non-integer scales; rw >= ow, rh >= oh).
inline void area_down(const uint8_t* img, size_t stride, int rx, int ry, int rw, int rh, int ow, int oh, int color, uint8_t* out)
{
    NNPREP_NO_CONTRACT
    const AreaPlan& plan = area_plan(rw, ow, rh, oh);
    const AreaTab& tx = plan.tx;
    const AreaTab& ty = plan.ty;
    const HRow h = hrow_for(tx.k);
    std::vector<float> row(size_t(rw) * 3 + 1);
    std::vector<F4> buf(static_cast<size_t>(ow)), sum(static_cast<size_t>(ow));
    std::vector<uint8_t> bgr(size_t(ow) * 3);
    int last = -1; // source row now in buf
    const uint8_t* base = img + size_t(ry) * stride + size_t(rx) * 3;
    for (int dy = 0; dy < oh; ++dy) {
        bool first = true;
        for (int j = 0; j < ty.k; ++j) {
            const float beta = ty.w[size_t(dy) * ty.k + j];
            if (j > 0 && beta == 0.f) {
                break; // padding (a real tap never weighs 0)
            }
            const int sy = ty.src[size_t(dy) * ty.k + j];
            if (sy != last) {
                to_float(base + size_t(sy) * stride, rw * 3, row.data());
                h(row.data(), tx, ow, buf.data());
                last = sy;
            }
            const F4 bv = F4 { beta, beta, beta, beta };
            const F4* b = buf.data();
            F4* s = sum.data();
            if (first) { // OpenCV: sum = beta * buf, then sum += beta * buf
                for (int i = 0; i < ow; ++i) s[i] = bv * b[i];
                first = false;
            }
            else {
                for (int i = 0; i < ow; ++i) {
                    const F4 t = bv * b[i];
                    s[i] = s[i] + t;
                }
            }
        }
        for (int i = 0; i < ow; ++i) {
            bgr[i * 3] = round_u8(sum[i][0]);
            bgr[i * 3 + 1] = round_u8(sum[i][1]);
            bgr[i * 3 + 2] = round_u8(sum[i][2]);
        }
        put_row(bgr.data(), ow, color, out + size_t(dy) * ow * (color == 0 ? 1 : 3));
    }
}

// cv::resize's test for resizeAreaFast on an axis: its scale within DBL_EPSILON of an integer k (saturate_cast<int>:
// round half to even). 1080 -> 360 is not one (1 / (360 / 1080.) = 3.0000000000000004): resizeArea takes it.
inline bool area_fast_axis(int ssize, int dsize, int& k)
{
    const double scale = cv_scale(ssize, dsize);
    k = int(std::nearbyint(scale));
    return std::abs(scale - k) < 2.220446049250313e-16;
}

// OpenCV's resizeAreaFast for 3 channels, kx * ky source pixels per output pixel (ssize = k * dsize on both axes):
// 2 x 2 is its SIMD path's (sum + 2) >> 2 (rounding halves up, rows finished the same way), any other the scalar
// saturate_cast<uchar>(sum * (1.f / area)) (cvRound: halves to even).
inline void area_fast(const uint8_t* img, size_t stride, int rx, int ry, int kx, int ky, int ow, int oh, int color, uint8_t* out)
{
    NNPREP_NO_CONTRACT
    const size_t n = size_t(ow) * 3;
    std::vector<int> sum(n);
    std::vector<uint8_t> bgr(n);
    const float scale = 1.f / float(kx * ky);
    const bool two = kx == 2 && ky == 2;
    for (int dy = 0; dy < oh; ++dy) {
        std::fill(sum.begin(), sum.end(), 0);
        for (int j = 0; j < ky; ++j) {
            const uint8_t* s = img + size_t(ry + dy * ky + j) * stride + size_t(rx) * 3;
            int* d = sum.data();
            for (int dx = 0; dx < ow; ++dx, s += 3 * kx, d += 3) {
                for (int i = 0; i < kx; ++i) {
                    d[0] += s[i * 3];
                    d[1] += s[i * 3 + 1];
                    d[2] += s[i * 3 + 2];
                }
            }
        }
        for (size_t i = 0; i < n; ++i) {
            bgr[i] = two ? uint8_t((sum[i] + 2) >> 2) : round_u8(float(sum[i]) * scale);
        }
        put_row(bgr.data(), ow, color, out + size_t(dy) * ow * (color == 0 ? 1 : 3));
    }
}

// Crop roi of a BGR image (stride bytes per row), resize to ow x oh (interp 0 area, 1 linear, 2 nearest; area
// upscaling is linear, as in OpenCV), then color 0 gray, 1 rgb, 2 bgr. Out: HWC, 1 or 3 channels.
inline void prep(const uint8_t* img, size_t stride, int rx, int ry, int rw, int rh, int ow, int oh, int color, int interp, uint8_t* out)
{
    if (interp == 0 && rw >= ow && rh >= oh) {
        int kx = 0, ky = 0;
        if (area_fast_axis(rw, ow, kx) && area_fast_axis(rh, oh, ky)) {
            area_fast(img, stride, rx, ry, kx, ky, ow, oh, color, out);
        }
        else {
            area_down(img, stride, rx, ry, rw, rh, ow, oh, color, out);
        }
        return;
    }
    prep_generic(img, stride, rx, ry, rw, rh, ow, oh, color, interp, out);
}

} // namespace nnprep
