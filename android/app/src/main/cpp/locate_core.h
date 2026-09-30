// Locating the character from the minimap: the minimap disc matched inside a reference image at the same scale
// (masked zero-mean normalized cross-correlation, after the same preprocessing on both sides). Plain C++, no Maa
// or OpenCV: the app calls it through JNI (locate_jni.cpp), the PC checks it through ctypes
// (scripts/minimap_locate.py --native), against the OpenCV version there.
#pragma once

#include <cstdint>

extern "C" {

// How a disc (or a reference) is turned into what gets matched; mirrors Prep in scripts/minimap_locate.py.
struct LocPrep
{
    int kind; // 0 raw, 1 hp (minus a blur), 2 dog (blur minus a wider blur), 3 grad, 4 canny
    float pre; // dog: the first blur
    float sigma; // hp / dog: the blur taken away; grad: pre-blur
    int r_use; // disc pixels used: within this radius
    int r_arrow; // the arrow in the middle
    int fan_r; // the camera fan, masked out to this radius, heading ± fan_half
    float fan_half;
    int sat_max; // > 0: leave out pixels more saturated than this (see-through leaves), the zone excepted
    int zone; // the stronghold zone's orange: 0 flat (filtered apart, its edge left out), 1 mask, 2 none
    float zone_gain;
};

struct LocRef;

// A reference image (BGR rows of `stride` bytes; valid: w*h, nonzero where the map is known, may be null),
// preprocessed once.
LocRef* loc_ref_create(const uint8_t* bgr, int stride, const uint8_t* valid, int w, int h, const LocPrep* p);
void loc_ref_destroy(LocRef* r);
int loc_ref_width(const LocRef* r);
int loc_ref_height(const LocRef* r);

// Match a 110x110 minimap disc (BGR, `stride` bytes per row; the character at (54, 54)) in the reference.
// cam: camera heading (compass degrees) for the fan's mask, NaN if unknown. The disc's middle is searched within
// `radius` px (reference px, square) of (pu, pv); radius < 0: everywhere. out: [u, v, score, second, used px].
// Returns 0 when nothing could be matched (the search area is off the reference, or the disc is all masked).
int loc_run(const LocRef* r, const uint8_t* disc, int stride, float cam, float pu, float pv, float radius,
            const LocPrep* p, float out[5]);
}
