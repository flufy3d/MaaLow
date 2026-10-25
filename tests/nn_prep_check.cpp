// PC harness for android/app/src/main/cpp/nn_prep.h (tests/test_nn_prep.py builds it with g++ -ffp-contract=off).
//
//   nn_prep_check run   <frames> <H> <W> <N> <specs> <impl> <out>    every frame x every spec, outputs concatenated
//   nn_prep_check bench <frames> <H> <W> <N> <specs> <impl> <reps>   ms per frame (all specs), best of reps passes
//
// frames: N raw BGR images (H x W x 3, packed). specs: lines "rx ry rw rh ow oh color interp". impl: new (nn_prep.h),
// old_fma / old_plain (the preprocessing infer() had before nn_prep.h, kept here verbatim as the reference: on the
// device clang fused its multiply-adds, emulated by old_fma with std::fma; old_plain rounds each operation).
#include "../android/app/src/main/cpp/nn_prep.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

namespace old
{
using nnprep::Tap;

std::vector<std::vector<Tap>> area_taps(int ssize, int dsize) { return nnprep::area_taps(ssize, dsize); }
std::vector<std::vector<Tap>> point_taps(int ssize, int dsize, bool linear) { return nnprep::point_taps(ssize, dsize, linear); }

inline uint8_t sat(float v)
{
    int i = int(std::lround(v));
    return uint8_t(std::clamp(i, 0, 255));
}

inline float madd(bool fma, float acc, float a, float b) { return fma ? std::fma(a, b, acc) : acc + a * b; }

template <bool FMA>
void prep(const uint8_t* img, int stride, int rx, int ry, int rw, int rh, int ow, int oh, int color, int interp, uint8_t* out)
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
                    b = madd(FMA, b, float(p[0]), vx.w);
                    g = madd(FMA, g, float(p[1]), vx.w);
                    r = madd(FMA, r, float(p[2]), vx.w);
                }
                acc[dx * 3] = madd(FMA, acc[dx * 3], b, vy.w);
                acc[dx * 3 + 1] = madd(FMA, acc[dx * 3 + 1], g, vy.w);
                acc[dx * 3 + 2] = madd(FMA, acc[dx * 3 + 2], r, vy.w);
            }
        }
        for (int i = 0; i < ow * 3; ++i) {
            bgr[i] = sat(acc[i]);
        }
        uint8_t* o = out + size_t(dy) * ow * (color == 0 ? 1 : 3);
        for (int dx = 0; dx < ow; ++dx) {
            const uint8_t b = bgr[dx * 3], g = bgr[dx * 3 + 1], r = bgr[dx * 3 + 2];
            if (color == 0) {
                o[dx] = uint8_t((b * 1868 + g * 9617 + r * 4899 + (1 << 13)) >> 14);
            }
            else if (color == 1) {
                o[dx * 3] = r;
                o[dx * 3 + 1] = g;
                o[dx * 3 + 2] = b;
            }
            else {
                o[dx * 3] = b;
                o[dx * 3 + 1] = g;
                o[dx * 3 + 2] = r;
            }
        }
    }
}
} // namespace old

struct Spec
{
    int rx, ry, rw, rh, ow, oh, color, interp;
    size_t bytes() const { return size_t(ow) * oh * (color == 0 ? 1 : 3); }
};

using Fn = void (*)(const uint8_t*, int, const Spec&, uint8_t*);

void run_new(const uint8_t* img, int stride, const Spec& s, uint8_t* out)
{
    nnprep::prep(img, size_t(stride), s.rx, s.ry, s.rw, s.rh, s.ow, s.oh, s.color, s.interp, out);
}

template <bool FMA>
void run_old(const uint8_t* img, int stride, const Spec& s, uint8_t* out)
{
    old::prep<FMA>(img, stride, s.rx, s.ry, s.rw, s.rh, s.ow, s.oh, s.color, s.interp, out);
}

int main(int argc, char** argv)
{
    if (argc != 9) {
        std::fprintf(stderr, "usage: %s run|bench frames H W N specs impl out|reps\n", argv[0]);
        return 2;
    }
    const std::string mode = argv[1];
    const int H = std::atoi(argv[3]), W = std::atoi(argv[4]), N = std::atoi(argv[5]);
    const std::string impl = argv[7];
    std::vector<uint8_t> frames(size_t(H) * W * 3 * N);
    {
        std::ifstream f(argv[2], std::ios::binary);
        f.read(reinterpret_cast<char*>(frames.data()), std::streamsize(frames.size()));
        if (!f) {
            std::fprintf(stderr, "short frames file\n");
            return 1;
        }
    }
    std::vector<Spec> specs;
    {
        std::ifstream f(argv[6]);
        Spec s;
        while (f >> s.rx >> s.ry >> s.rw >> s.rh >> s.ow >> s.oh >> s.color >> s.interp) specs.push_back(s);
    }
    Fn fn = impl == "new" ? run_new : impl == "old_fma" ? run_old<true> : impl == "old_plain" ? run_old<false> : nullptr;
    if (!fn) {
        std::fprintf(stderr, "unknown impl %s\n", impl.c_str());
        return 2;
    }
    size_t per = 0;
    for (const Spec& s : specs) per += s.bytes();
    std::vector<uint8_t> out(per * N);
    auto pass = [&] {
        size_t at = 0;
        for (int i = 0; i < N; ++i) {
            const uint8_t* img = frames.data() + size_t(i) * H * W * 3;
            for (const Spec& s : specs) {
                fn(img, W * 3, s, out.data() + at);
                at += s.bytes();
            }
        }
    };
    if (mode == "run") {
        pass();
        std::ofstream f(argv[8], std::ios::binary);
        f.write(reinterpret_cast<const char*>(out.data()), std::streamsize(out.size()));
        return f ? 0 : 1;
    }
    const int reps = std::atoi(argv[8]);
    double best = 1e30;
    for (int r = 0; r < reps; ++r) {
        auto t0 = std::chrono::steady_clock::now();
        pass();
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / N;
        best = std::min(best, ms);
    }
    std::printf("%.4f\n", best);
    return 0;
}
