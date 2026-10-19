// dufu.js's head slice labels and bin tables, frozen in model/dufu/unified_head2.json (the v1..v11 heads share the
// schema). Moved out of dufu.js verbatim in the stage-1 split (labels + pure decoding, 2026-10-19); the values must
// not change: decode() / futStats() / the marks index straight into these arrays.
export const COMBO_LABELS = ["bg", "irregular", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13", "T14"];
// v6 combo slot (comboV6 arg): gap to the NEXT segment of the chain; 0 bg | 1 single | 2..7 bins | 8 end (combo_v6.py)
export const COMBO6_LABELS = ["bg", "single", "g8-13", "g14-19", "g20-23", "g24-27", "g28-33", "g34-40", "end", "x9", "x10", "x11", "x12", "x13", "x14", "x15"];
export const COMBO6_CENTER = [10.5, 16.5, 21.5, 25.5, 30.5, 37.0]; // bin centers (frames), classes 2..7
export const STAGE_LABELS = ["bg", "pre", "next2", "next3", "next4+", "done"];
export const FUT_LABELS = ["1-3", "4-6", "7-9", "10-12", "13-15", "16-19", "20-24", "25-30", "31-40", "41-60", "none"];
export const FUT_LO = [1, 4, 7, 10, 13, 16, 20, 25, 31, 41]; // bin lower bounds (frames)
export const FUT_HI = [3, 6, 9, 12, 15, 19, 24, 30, 40, 60];
export const FUT_CENTER = [2, 5, 8, 11, 14, 17.5, 22, 27.5, 35.5, 50.5]; // bin centers (E[frames])
export const DEF_LABELS = ["none", "parry", "dodge", "curtain", "unknown"];
export const TELL_LABELS = ["none", "flare_other", "flare_grab", "flare_slam", "sweep", "curtain", "dark"];
