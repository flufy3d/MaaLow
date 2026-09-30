// Locating a screen region inside a reference image at the same scale (e.g. a minimap in a map): masked
// zero-mean normalized cross-correlation, after the same preprocessing on both sides. Plain C++, no Maa or OpenCV:
// the app calls it through JNI (locate_jni.cpp), the PC checks it through ctypes (scripts/map_locate.py Native),
// against the OpenCV version there. What is game specific (the crop, what is masked out, the overlay's color) comes
// in LocParams, from the reference's JSON.
#pragma once

#include <cstdint>

extern "C" {

// An HSV range as OpenCV's 8-bit one (H 0-180, S and V 0-255), bounds included; lo > hi: matches nothing.
struct LocRange
{
    int lo[3];
    int hi[3];
};

constexpr int LOC_MAX_DROP = 8;

// How a crop (or a reference) is masked and turned into what gets matched; mirrors Config in scripts/map_locate.py.
struct LocParams
{
    int kind; // 0 raw, 1 hp (minus a blur), 2 dog (blur minus a wider blur), 3 grad, 4 canny
    float pre; // dog: the first blur
    float sigma; // hp / dog: the blur taken away; grad: pre-blur
    int size; // the crop: size x size, the searched point at ((size - 1) / 2, (size - 1) / 2)
    float r_in, r_out; // crop pixels used: r_in < r <= r_out from that point; r_out < 0: the whole square
    float wedge_r, wedge_half; // left out: r <= wedge_r within ± wedge_half degrees of loc_run's heading; <= 0: none
    int n_drop; // colors left out (marks drawn over the map), grown by `grow`
    LocRange drop[LOC_MAX_DROP];
    int grow;
    int sat_max; // > 0: leave out pixels more saturated than this (see-through scenery), the region color excepted
    int region_mode; // a see-through overlay of region's color: 0 flat (filtered apart, its edge left out), 1 mask, 2 none
    LocRange region;
    float region_gain; // flat: its inside's contrast times this
    int region_open, region_min, region_close; // its area: opened, dropped under region_min px, closed (kernel sizes)
    int region_edge; // flat: the band this wide around its border is left out
};

struct LocRef;

// A reference image (BGR rows of `stride` bytes; valid: w*h, nonzero where the map is known, may be null),
// preprocessed once.
LocRef* loc_ref_create(const uint8_t* bgr, int stride, const uint8_t* valid, int w, int h, const LocParams* p);
void loc_ref_destroy(LocRef* r);
int loc_ref_width(const LocRef* r);
int loc_ref_height(const LocRef* r);

// Match a p->size square crop (BGR, `stride` bytes per row) in the reference. wedge: the heading (compass degrees)
// for the wedge's mask, NaN if unknown. The crop's middle is searched within `radius` px (reference px, square) of
// (pu, pv); radius < 0: everywhere. out: [u, v, score, second, used px].
// Returns 0 when nothing could be matched (the search area is off the reference, or the crop is all masked).
int loc_run(const LocRef* r, const uint8_t* crop, int stride, float wedge, float pu, float pv, float radius,
            const LocParams* p, float out[5]);
}
