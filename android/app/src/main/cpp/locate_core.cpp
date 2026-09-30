// Locating a crop in a reference (locate_core.h). The steps follow scripts/map_locate.py, where they were checked
// on survey frames: crop mask (circle, wedge, dropped colors, saturated pixels, the region's edge), a band-pass over
// the masked-in pixels only (normalized convolution), the region's inside filtered apart from the rest, then masked
// ZNCC over a search window, coarse (every other position, half the template) and then fine around the best.

#include "locate_core.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace
{

constexpr double DEG = 57.29577951308232;

using Img = std::vector<float>;
using Mask = std::vector<uint8_t>;

int reflect101(int i, int n)
{
    if (n == 1) {
        return 0;
    }
    while (i < 0 || i >= n) {
        i = i < 0 ? -i : 2 * n - 2 - i;
    }
    return i;
}

std::vector<float> gauss_kernel(float sigma)
{
    // as cv::GaussianBlur picks it for float images: 4 sigma either side
    int k = int(std::lround(sigma * 8 + 1)) | 1;
    std::vector<float> g(k);
    double sum = 0;
    for (int i = 0; i < k; ++i) {
        double x = i - (k - 1) / 2.0;
        g[i] = float(std::exp(-x * x / (2.0 * sigma * sigma)));
        sum += g[i];
    }
    for (auto& v : g) {
        v = float(v / sum);
    }
    return g;
}

// separable Gaussian, reflect-101 border (cv::BORDER_DEFAULT)
Img blur(const Img& x, int w, int h, float sigma)
{
    auto g = gauss_kernel(sigma);
    int r = int(g.size()) / 2;
    Img t(size_t(w) * h), out(size_t(w) * h);
    for (int y = 0; y < h; ++y) {
        const float* row = &x[size_t(y) * w];
        for (int i = 0; i < w; ++i) {
            float s = 0;
            if (i >= r && i + r < w) {
                for (int k = -r; k <= r; ++k) {
                    s += g[k + r] * row[i + k];
                }
            }
            else {
                for (int k = -r; k <= r; ++k) {
                    s += g[k + r] * row[reflect101(i + k, w)];
                }
            }
            t[size_t(y) * w + i] = s;
        }
    }
    for (int y = 0; y < h; ++y) {
        for (int i = 0; i < w; ++i) {
            float s = 0;
            for (int k = -r; k <= r; ++k) {
                s += g[k + r] * t[size_t(reflect101(y + k, h)) * w + i];
            }
            out[size_t(y) * w + i] = s;
        }
    }
    return out;
}

// blur over the masked-in pixels only
Img nblur(const Img& x, const Mask& m, int w, int h, float sigma)
{
    Img xm(x.size()), mf(x.size());
    for (size_t i = 0; i < x.size(); ++i) {
        mf[i] = m[i] ? 1.f : 0.f;
        xm[i] = x[i] * mf[i];
    }
    Img num = blur(xm, w, h, sigma), den = blur(mf, w, h, sigma);
    for (size_t i = 0; i < x.size(); ++i) {
        num[i] /= std::max(den[i], 1e-3f);
    }
    return num;
}

// rect erode / dilate, border as cv (erode: outside counts as set, dilate: as clear)
Mask morph(const Mask& m, int w, int h, int k, bool erode)
{
    int r = k / 2;
    Mask t(m.size()), out(m.size());
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            uint8_t v = erode ? 1 : 0;
            for (int d = -r; d <= r; ++d) {
                int xx = x + d;
                uint8_t s = (xx < 0 || xx >= w) ? (erode ? 1 : 0) : m[size_t(y) * w + xx];
                v = erode ? (v & (s ? 1 : 0)) : (v | (s ? 1 : 0));
            }
            t[size_t(y) * w + x] = v;
        }
    }
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            uint8_t v = erode ? 1 : 0;
            for (int d = -r; d <= r; ++d) {
                int yy = y + d;
                uint8_t s = (yy < 0 || yy >= h) ? (erode ? 1 : 0) : t[size_t(yy) * w + x];
                v = erode ? (v & s) : (v | s);
            }
            out[size_t(y) * w + x] = v;
        }
    }
    return out;
}

struct Hsv
{
    uint8_t h, s, v;
};

// cv::COLOR_BGR2HSV for 8-bit (H 0-180), same fixed point arithmetic
Hsv hsv(int b, int g, int r)
{
    constexpr int shift = 12;
    int v = std::max({ r, g, b });
    int vmin = std::min({ r, g, b });
    int diff = v - vmin;
    int s = v ? (diff * int((255 << shift) / double(v) + 0.5) + (1 << (shift - 1))) >> shift : 0;
    int vr = v == r ? -1 : 0;
    int vg = v == g ? -1 : 0;
    int h = (vr & (g - b)) + (~vr & ((vg & (b - r + 2 * diff)) + ((~vg) & (r - g + 4 * diff))));
    int hdiv = diff ? int((180 << shift) / (6.0 * diff) + 0.5) : 0;
    h = (h * hdiv + (1 << (shift - 1))) >> shift;
    h += h < 0 ? 180 : 0;
    return { uint8_t(std::min(h, 255)), uint8_t(std::min(s, 255)), uint8_t(v) };
}

bool in_range(const Hsv& c, const LocRange& r)
{
    return c.h >= r.lo[0] && c.h <= r.hi[0] && c.s >= r.lo[1] && c.s <= r.hi[1] && c.v >= r.lo[2] && c.v <= r.hi[2];
}

struct Pix
{
    Img gray;
    std::vector<Hsv> hsv;
};

Pix pixels(const uint8_t* bgr, int stride, int w, int h)
{
    Pix p;
    p.gray.resize(size_t(w) * h);
    p.hsv.resize(size_t(w) * h);
    for (int y = 0; y < h; ++y) {
        const uint8_t* row = bgr + size_t(y) * stride;
        for (int x = 0; x < w; ++x) {
            int b = row[3 * x], g = row[3 * x + 1], r = row[3 * x + 2];
            // cv::COLOR_BGR2GRAY fixed point
            p.gray[size_t(y) * w + x] = float((r * 4899 + g * 9617 + b * 1868 + (1 << 13)) >> 14);
            p.hsv[size_t(y) * w + x] = hsv(b, g, r);
        }
    }
    return p;
}

// the region's area (opened, holes closed), empty when it has fewer than region_min px
Mask region(const Pix& px, int w, int h, const LocParams& p)
{
    Mask z(size_t(w) * h);
    for (size_t i = 0; i < z.size(); ++i) {
        z[i] = in_range(px.hsv[i], p.region);
    }
    z = morph(morph(z, w, h, p.region_open, true), w, h, p.region_open, false); // open
    size_t n = 0;
    for (auto v : z) {
        n += v;
    }
    if (n == 0 || n < size_t(std::max(p.region_min, 0))) {
        return Mask(z.size(), 0);
    }
    return morph(morph(z, w, h, p.region_close, false), w, h, p.region_close, true); // close
}

// Canny as cv::Canny(img, 20, 50) with a 3x3 Sobel and the L1 gradient, edges 255
Img canny(const Img& b8, int w, int h, float lo, float hi)
{
    auto at = [&](int x, int y) { return b8[size_t(std::clamp(y, 0, h - 1)) * w + std::clamp(x, 0, w - 1)]; };
    std::vector<int> dx(size_t(w) * h), dy(size_t(w) * h), mag(size_t(w + 2) * (h + 2), 0);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            int gx = int(-at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
            int gy = int(-at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
            dx[size_t(y) * w + x] = gx;
            dy[size_t(y) * w + x] = gy;
            mag[size_t(y + 1) * (w + 2) + x + 1] = std::abs(gx) + std::abs(gy);
        }
    }
    auto M = [&](int x, int y) { return mag[size_t(y + 1) * (w + 2) + x + 1]; };
    constexpr int TG22 = 13573; // tan(22.5°) << 15
    std::vector<uint8_t> state(size_t(w) * h, 0); // 0 none, 1 weak, 2 strong
    std::vector<int> stack;
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            int m = M(x, y);
            if (m <= lo) {
                continue;
            }
            int xs = dx[size_t(y) * w + x], ys = dy[size_t(y) * w + x];
            long ax = std::abs(xs), ay = long(std::abs(ys)) << 15;
            long tg22x = ax * TG22;
            bool keep;
            if (ay < tg22x) {
                keep = m > M(x - 1, y) && m >= M(x + 1, y);
            }
            else {
                long tg67x = tg22x + (ax << 16);
                if (ay > tg67x) {
                    keep = m > M(x, y - 1) && m >= M(x, y + 1);
                }
                else {
                    int s = (xs ^ ys) < 0 ? -1 : 1;
                    keep = m > M(x - s, y - 1) && m > M(x + s, y + 1);
                }
            }
            if (!keep) {
                continue;
            }
            if (m > hi) {
                state[size_t(y) * w + x] = 2;
                stack.push_back(y * w + x);
            }
            else {
                state[size_t(y) * w + x] = 1;
            }
        }
    }
    while (!stack.empty()) {
        int i = stack.back();
        stack.pop_back();
        int x = i % w, y = i / w;
        for (int yy = y - 1; yy <= y + 1; ++yy) {
            for (int xx = x - 1; xx <= x + 1; ++xx) {
                if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
                    continue;
                }
                uint8_t& s = state[size_t(yy) * w + xx];
                if (s == 1) {
                    s = 2;
                    stack.push_back(yy * w + xx);
                }
            }
        }
    }
    Img out(size_t(w) * h);
    for (size_t i = 0; i < out.size(); ++i) {
        out[i] = state[i] == 2 ? 255.f : 0.f;
    }
    return out;
}

Img filter(const Img& g, const Mask& m, int w, int h, const LocParams& p)
{
    switch (p.kind) {
    case 0:
        return g;
    case 1: {
        Img b = nblur(g, m, w, h, p.sigma);
        for (size_t i = 0; i < b.size(); ++i) {
            b[i] = g[i] - b[i];
        }
        return b;
    }
    case 2: {
        Img a = nblur(g, m, w, h, p.pre), b = nblur(g, m, w, h, p.sigma);
        for (size_t i = 0; i < a.size(); ++i) {
            a[i] -= b[i];
        }
        return a;
    }
    case 3: {
        Img b = nblur(g, m, w, h, p.sigma), out(b.size());
        auto at = [&](int x, int y) { return b[size_t(reflect101(y, h)) * w + reflect101(x, w)]; };
        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                float gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
                float gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
                out[size_t(y) * w + x] = std::sqrt(gx * gx + gy * gy);
            }
        }
        return out;
    }
    default: {
        Img b = nblur(g, m, w, h, 1.f);
        for (auto& v : b) {
            v = std::floor(std::clamp(v, 0.f, 255.f));
        }
        return blur(canny(b, w, h, 20, 50), w, h, 1.f);
    }
    }
}

// the image to match: filtered, 0 outside the mask (eroded by one, since pixels next to a masked one see its fill)
Img prep(const Pix& px, const Mask& m, int w, int h, const LocParams& p, Mask& used)
{
    Img out;
    Mask z;
    bool split = false;
    if (p.region_mode == 0) {
        z = region(px, w, h, p);
        for (size_t i = 0; i < z.size() && !split; ++i) {
            split = z[i] && m[i];
        }
    }
    if (split) {
        Mask in(m.size()), rest(m.size());
        for (size_t i = 0; i < m.size(); ++i) {
            in[i] = m[i] && z[i];
            rest[i] = m[i] && !z[i];
        }
        Img a = filter(px.gray, in, w, h, p), b = filter(px.gray, rest, w, h, p);
        out.resize(a.size());
        for (size_t i = 0; i < a.size(); ++i) {
            out[i] = z[i] ? a[i] * p.region_gain : b[i];
        }
    }
    else {
        out = filter(px.gray, m, w, h, p);
    }
    used = morph(m, w, h, 3, true);
    for (size_t i = 0; i < out.size(); ++i) {
        if (!used[i]) {
            out[i] = 0;
        }
    }
    return out;
}

// the crop's pixels that show the map: in the circle, not the wedge, dropped colors, the region's edge (or all of it)
Mask crop_mask(const Pix& px, const LocParams& p, float wedge)
{
    const int D = p.size, C = (D - 1) / 2;
    Mask m(size_t(D) * D);
    for (int y = 0; y < D; ++y) {
        for (int x = 0; x < D; ++x) {
            float r = std::hypot(float(x - C), float(y - C));
            bool ok = p.r_out < 0 || (r <= p.r_out && r > p.r_in);
            if (ok && p.wedge_r > 0 && r <= p.wedge_r) {
                if (std::isnan(wedge)) {
                    ok = false;
                }
                else {
                    float a = float(std::atan2(double(x - C), double(C - y)) * DEG);
                    a = std::fmod(a + 360.f, 360.f);
                    float da = std::fabs(std::fmod(std::fmod(a - wedge + 180.f, 360.f) + 360.f, 360.f) - 180.f);
                    ok = da > p.wedge_half;
                }
            }
            m[size_t(y) * D + x] = ok;
        }
    }
    Mask bad(m.size(), 0);
    bool any = false;
    const int n_drop = std::clamp(p.n_drop, 0, LOC_MAX_DROP);
    for (size_t i = 0; i < m.size(); ++i) {
        const Hsv& c = px.hsv[i];
        bool b = p.sat_max > 0 && c.s > p.sat_max && !in_range(c, p.region);
        for (int k = 0; k < n_drop && !b; ++k) {
            b = in_range(c, p.drop[k]);
        }
        bad[i] = b;
        any |= b;
    }
    if (any) {
        bad = morph(bad, D, D, p.grow, false);
        for (size_t i = 0; i < m.size(); ++i) {
            m[i] &= !bad[i];
        }
    }
    if (p.region_mode != 2) {
        Mask z = region(px, D, D, p);
        if (std::find(z.begin(), z.end(), 1) != z.end()) {
            Mask cut = z;
            if (p.region_mode == 0) {
                Mask dil = morph(z, D, D, p.region_edge, false), ero = morph(z, D, D, p.region_edge, true);
                for (size_t i = 0; i < cut.size(); ++i) {
                    cut[i] = dil[i] && !ero[i];
                }
            }
            for (size_t i = 0; i < m.size(); ++i) {
                m[i] &= !cut[i];
            }
        }
    }
    return m;
}

struct Tmpl
{
    std::vector<int> off; // into the reference, from the window's top left
    std::vector<float> t; // zero mean
    double tt = 0; // sum of t^2
};

Tmpl make_tmpl(const Img& t, const Mask& used, int D, int ref_w, int parity)
{
    Tmpl out;
    double mean = 0;
    int n = 0;
    for (int y = 0; y < D; ++y) {
        for (int x = 0; x < D; ++x) {
            if (used[size_t(y) * D + x] && (parity < 0 || ((x + y) & 1) == parity)) {
                mean += t[size_t(y) * D + x];
                ++n;
            }
        }
    }
    if (!n) {
        return out;
    }
    mean /= n;
    for (int y = 0; y < D; ++y) {
        for (int x = 0; x < D; ++x) {
            if (used[size_t(y) * D + x] && (parity < 0 || ((x + y) & 1) == parity)) {
                float v = float(t[size_t(y) * D + x] - mean);
                out.off.push_back(y * ref_w + x);
                out.t.push_back(v);
                out.tt += double(v) * v;
            }
        }
    }
    return out;
}

float zncc(const float* R, const Tmpl& T)
{
    const size_t n = T.off.size();
    float s1[4] = { 0, 0, 0, 0 }, s2[4] = { 0, 0, 0, 0 }, st[4] = { 0, 0, 0, 0 };
    size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        for (int k = 0; k < 4; ++k) {
            float r = R[T.off[i + k]];
            s1[k] += r;
            s2[k] += r * r;
            st[k] += T.t[i + k] * r;
        }
    }
    for (; i < n; ++i) {
        float r = R[T.off[i]];
        s1[0] += r;
        s2[0] += r * r;
        st[0] += T.t[i] * r;
    }
    double S1 = double(s1[0]) + s1[1] + s1[2] + s1[3];
    double S2 = double(s2[0]) + s2[1] + s2[2] + s2[3];
    double ST = double(st[0]) + st[1] + st[2] + st[3];
    double var = S2 - S1 * S1 / double(n);
    double den = std::sqrt(std::max(var, 0.0) * T.tt);
    return den > 1e-6 ? float(ST / den) : -1.f;
}

} // namespace

struct LocRef
{
    int w = 0, h = 0;
    Img img;
};

extern "C" {

LocRef* loc_ref_create(const uint8_t* bgr, int stride, const uint8_t* valid, int w, int h, const LocParams* p)
{
    auto* r = new LocRef;
    r->w = w;
    r->h = h;
    Pix px = pixels(bgr, stride, w, h);
    Mask m(size_t(w) * h, 1);
    if (valid) {
        for (size_t i = 0; i < m.size(); ++i) {
            m[i] = valid[i] ? 1 : 0;
        }
    }
    LocParams q = *p;
    q.sat_max = 0;
    Mask used;
    r->img = prep(px, m, w, h, q, used);
    return r;
}

void loc_ref_destroy(LocRef* r)
{
    delete r;
}

int loc_ref_width(const LocRef* r)
{
    return r->w;
}

int loc_ref_height(const LocRef* r)
{
    return r->h;
}

int loc_run(const LocRef* r, const uint8_t* crop, int stride, float wedge, float pu, float pv, float radius,
            const LocParams* p, float out[5])
{
    const int D = p->size, C = (D - 1) / 2;
    if (D < 3) {
        return 0;
    }
    Pix px = pixels(crop, stride, D, D);
    Mask m = crop_mask(px, *p, wedge);
    Mask used;
    Img t = prep(px, m, D, D, *p, used);
    // top left positions of the window
    int x0 = 0, y0 = 0, x1 = r->w - D, y1 = r->h - D;
    if (radius >= 0) {
        x0 = std::max(x0, int(std::floor(pu - radius - C)));
        y0 = std::max(y0, int(std::floor(pv - radius - C)));
        x1 = std::min(x1, int(std::ceil(pu + radius - C)));
        y1 = std::min(y1, int(std::ceil(pv + radius - C)));
    }
    if (x1 < x0 || y1 < y0) {
        return 0;
    }
    Tmpl full = make_tmpl(t, used, D, r->w, -1);
    if (full.off.size() < 200) {
        return 0;
    }
    const float* R = r->img.data();
    const int nw = x1 - x0 + 1, nh = y1 - y0 + 1;
    const bool coarse = size_t(nw) * nh > 400;
    // coarse pass: every other position, half the template (a checkerboard of it)
    Tmpl half = coarse ? make_tmpl(t, used, D, r->w, 0) : Tmpl{};
    const Tmpl& T0 = coarse ? half : full;
    const int step = coarse ? 2 : 1;
    std::vector<float> sc;
    std::vector<int> gx, gy;
    float best = -2;
    int bx = x0, by = y0;
    for (int y = y0; y <= y1; y += step) {
        for (int x = x0; x <= x1; x += step) {
            float s = zncc(R + size_t(y) * r->w + x, T0);
            sc.push_back(s);
            gx.push_back(x);
            gy.push_back(y);
            if (s > best) {
                best = s;
                bx = x;
                by = y;
            }
        }
    }
    // fine: full template around the best
    auto score = [&](int x, int y) {
        if (x < 0 || y < 0 || x > r->w - D || y > r->h - D) {
            return -1.f;
        }
        return zncc(R + size_t(y) * r->w + x, full);
    };
    if (coarse) {
        int cx = bx, cy = by;
        best = -2;
        for (int y = cy - 2; y <= cy + 2; ++y) {
            for (int x = cx - 2; x <= cx + 2; ++x) {
                if (x < x0 || y < y0 || x > x1 || y > y1) {
                    continue;
                }
                float s = score(x, y);
                if (s > best) {
                    best = s;
                    bx = x;
                    by = y;
                }
            }
        }
    }
    else {
        best = score(bx, by);
    }
    // sub-pixel: parabola through the neighbors
    auto para = [](float a, float b, float c) {
        float den = a - 2 * b + c;
        return den < 0 ? std::clamp(0.5f * (a - c) / den, -0.5f, 0.5f) : 0.f;
    };
    float fx = (bx > x0 && bx < x1) ? para(score(bx - 1, by), best, score(bx + 1, by)) : 0.f;
    float fy = (by > y0 && by < y1) ? para(score(bx, by - 1), best, score(bx, by + 1)) : 0.f;
    // the second peak: the best (coarse) score more than 4 px away
    float second = -1;
    for (size_t i = 0; i < sc.size(); ++i) {
        if (std::hypot(float(gx[i] - bx), float(gy[i] - by)) > 4.f) {
            second = std::max(second, sc[i]);
        }
    }
    out[0] = bx + fx + C;
    out[1] = by + fy + C;
    out[2] = best;
    out[3] = second;
    out[4] = float(full.off.size());
    return 1;
}
}
