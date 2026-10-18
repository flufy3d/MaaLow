// MaaLow skill API: the globals a skill (workspace skills/<name>.js, an ES module) sees on the companion app.
// Served by the app at /api/v1/skills/maalow.d.ts and written to skills/ by `maalow sync`; do not edit the copy.
//
//   export const meta = { description: "close popups until the screen is clear", timeout: 30_000 };
//   export default function (args, ctx) { ... }   // run by POST /skill/run, schedules, or a pipeline node:
//                                                 //   {"action": "Custom", "custom_action": "<name>", "custom_action_param": {args}}
//   export function recognize(args, ctx) { ... }  // optional: {"recognition": "Custom", "custom_recognition": "<name>.recognize"}
//
// Calls are synchronous and block the skill's thread. Coordinates are in the capture space (1080x720 on the
// tablet, landscape), the same as pipeline ROIs. Import helpers with relative paths: import { f } from "./lib/util.js".
// Top-level module code runs when the skill loads (also when listing): keep it to declarations.

/** [x, y, width, height] */
type Box = [number, number, number, number];
/** [x, y] */
type Point = [number, number];

/** A screenshot, kept for the run (the last 8). */
interface Image {
    id: number;
    width: number;
    height: number;
    /** Frame number of the capture stream (of the frame this screenshot got). */
    seq: number;
    /** How old the frame was when taken, ms. */
    age_ms: number;
    /** Epoch ms when taken. */
    time: number;
}

interface Match {
    box: Box;
    score?: number;
    /** OCR */
    text?: string;
    /** Neural network detection */
    label?: string;
    cls_index?: number;
    count?: number;
}

/** Result of a recognition. score / text / label are those of the best match. */
interface Hit {
    hit: boolean;
    box: Box | null;
    score?: number;
    text?: string;
    label?: string;
    algorithm: string;
    /** Matches that passed the threshold (up to 50). */
    results: Match[];
    /** Time the recognition took, ms. */
    ms: number;
    /** Maa's raw detail, with { detail: true }. */
    detail?: any;
}

/** Something to click: a point, the center of a box, or a hit / match (its box). */
type Target = Point | Box | { box: Box | null; hit?: boolean } | { x: number; y: number };

interface RecoOptions {
    /** Image to look at; default: the latest screenshot (one is taken if there is none). */
    image?: Image;
    /** Region to look in. */
    roi?: Box;
    /** Include Maa's raw detail. */
    detail?: boolean;
}

interface NodeOptions extends RecoOptions {
    /** Pipeline fields to override for this call, e.g. { threshold: 0.7 }. */
    override?: Record<string, any>;
}

interface TemplateOptions extends RecoOptions {
    threshold?: number | number[];
    green_mask?: boolean;
    /** cv::TemplateMatchModes, default 5 (TM_CCOEFF_NORMED). */
    method?: number;
    order_by?: string;
}

interface ColorOptions extends RecoOptions {
    /** Lower / upper bounds per channel (RGB for method 4, the default), or several ranges. */
    lower: number[] | number[][];
    upper: number[] | number[][];
    /** Minimum number of matching pixels. */
    count?: number;
    connected?: boolean;
    method?: number;
}

interface OcrOptions extends RecoOptions {
    /** Text (or regexes) to look for; default: any text. */
    expected?: string | string[];
    threshold?: number;
    only_rec?: boolean;
}

interface DetectOptions extends RecoOptions {
    /** ONNX model, a path under the workspace's model/detect/ (a YOLOv8 / YOLO11 export; labels from its metadata). */
    model: string;
    expected?: number | number[];
    labels?: string[];
    threshold?: number | number[];
}

interface ClassifyOptions extends RecoOptions {
    /** ONNX model, a path under the workspace's model/classify/ (Maa resizes the roi to the model's input). */
    model: string;
    expected?: number | number[];
    labels?: string[];
}

/**
 * infer(): any ONNX model under the workspace's model/, on a region of a screenshot (or several frames of it).
 * Input = roi, resized to size, as color, (v / 255 - mean) / std per channel (uint8 models: the bytes), laid out as
 * the model's input. Frames are stacked as channels in the order given (frame 0's channels first).
 */
interface InferOptions {
    /** Image to look at (frame offset 0); default: the latest screenshot (one is taken if there is none). */
    image?: Image;
    /** Region to cut; default: the whole image. */
    roi?: Box;
    /** [width, height] (or one number, square) to resize the region to; default: the model's input size. */
    size?: number | [number, number];
    /** Default "rgb". gray: OpenCV's BGR2GRAY of the resized region. */
    color?: "gray" | "rgb" | "bgr";
    /** Default "area" (OpenCV's INTER_AREA; linear when enlarging). */
    resize?: "area" | "linear" | "nearest";
    /** On the 0..1 scale: one value, one per color channel, or one per stacked channel. Default 0 / 1. */
    mean?: number | number[];
    std?: number | number[];
    /** Default: from the model's input shape (nchw unless its last dimension is the channel count). */
    layout?: "nchw" | "nhwc";
    /**
     * Offsets of the frames to stack, from the image (0), oldest first, e.g. [-4, -2, 0]: in capture stream frames
     * (Image.seq), or in units of frame_ms of capture time. Earlier frames come from this run's own screenshots
     * (the last 32 per preprocessing; the 8 kept images are preprocessed when first needed), the nearest one within
     * tolerance; if one is missing the result is { ready: false } (take screenshots often enough). Default [0].
     */
    frames?: number[];
    /** Offsets count in this many ms of capture time instead of stream frames, e.g. 1000 / 30 for a model trained on
     * 30 fps recordings (the stream only has a frame when the screen changed). The frame used is the one on screen
     * at that time (the last captured before it, when the run also has the stream frame right after it), else the
     * nearest within tolerance. */
    frame_ms?: number;
    /** How far (in offset units) the frame used may be from the one asked for. Default 1. */
    tolerance?: number;
    /** Post-processing of the first output. A vector output always gets index / score (/ label) of its largest. */
    post?: "none" | "softmax" | "sigmoid" | "yolo";
    /** Class names (else the model's "names" metadata, as YOLO exports have). */
    labels?: string[];
    /** yolo: minimum class score (default 0.25), NMS IoU (default 0.45), most detections (default 100). */
    threshold?: number;
    iou?: number;
    max_det?: number;
    /** All outputs (`outputs`) and the first in full, however long. */
    raw?: boolean;
    /** The preprocessed frames (HWC bytes each), to check against an offline pipeline. */
    input?: boolean;
    /**
     * The model's inputs after the image, one tensor each in that order (up to 4), e.g. a feature history and a
     * state / timing vector for a head model. float32 only; dims must equal the model input's (a batch dimension of
     * 1 or dynamic takes dim[0] 1), and `name`, when given, must be that model input's name. A model with no input
     * beyond the image takes no `extra`. A model with no image input at all (a head driven by its tensors alone, e.g.
     * a GRU over a feature window) takes all its inputs here - one tensor per input, in order - and no image is
     * looked at: no roi / size / color / frames work is done for it.
     *
     * A tensor's values come from `data` (a JSON float array), from `data_b64` instead (standard base64, padding
     * included, of the little-endian packed float32 bytes; dim product * 4 of them), or from the run's feature ring
     * `name` with `ring: true` (@see history): the ring's last 30 steps, oldest first, front-padded with the oldest
     * when short, as [1, 30, feature + aux] - `dim` must say exactly that shape.
     */
    extra?: { name?: string; dim: number[]; data?: number[]; data_b64?: string; ring?: boolean }[];
    /**
     * After this call succeeds, append its first output (a vector, e.g. the backbone's features: [N] or [1, N]) and
     * each entry's `aux` to the run's feature ring `name` (up to 30 entries, the oldest dropped; `reset: true` clears
     * the ring first), for a later `extra` with `ring: true` to assemble. The rings live in the run, gone with it.
     */
    history?: { name: string; aux: number[]; reset?: boolean }[];
    /** onnxruntime intra-op threads (default 1), busy-wait between ops (default false), provider (default "cpu").
     * A model is opened once per set of these and kept (reopened when its file changes). */
    threads?: number;
    spin?: boolean;
    provider?: "cpu" | "nnapi";
}

interface Inference {
    /** false: an earlier frame was missing (no output then). */
    ready: boolean;
    /** Shape and values of the first output (values up to 4096, all with raw). */
    shape?: number[];
    output?: number[];
    outputs?: { name: string; shape: number[]; data: number[] }[];
    /** softmax / sigmoid of the output. */
    probs?: number[];
    /** Largest of probs (else of the output) and its label. */
    index?: number;
    score?: number;
    label?: string;
    /** yolo: detections in screen coordinates, best first; hit / box / score / label of the best. */
    hit?: boolean;
    box?: Box | null;
    detections?: { box: Box; score: number; cls_index: number; label?: string }[];
    /** The frames used, per offset: stream frame number and capture time relative to the image (ms); null: missing. */
    frames: ({ seq: number; ms: number } | null)[];
    input?: number[][];
    /** An `extra` tensor with `ring: true` was assembled: its entry count and the sum (double, oldest first) of the
     * assembled floats, for the caller to check against its own ring. */
    ring?: { len: number; sum: number };
    /** prep: preprocessing (with history), run: onnxruntime, total. */
    ms: { prep: number; run?: number; total: number };
}

interface ModelInfo {
    inputs: { name: string; type: string; shape: number[] }[];
    outputs: { name: string; type: string; shape: number[] }[];
    /** From the model's "names" metadata. */
    labels?: Record<string, string>;
}

interface LocateOptions {
    /** Screenshot to cut the crop from; default: the latest screenshot (one is taken if there is none). */
    image?: Image;
    /** Where the crop's middle should be, in the reference's units (e.g. big map px from a map icon): only within
     * `radius` of it is searched. Without it, the whole reference. */
    prior?: Point;
    /** Default 30. */
    radius?: number;
    /** Heading (compass degrees) of the reference's mask.wedge, left out around it (e.g. a minimap's camera fan);
     * without it, all the wedge could cover is left out. */
    wedge?: number | null;
    /** @deprecated the old name of `wedge`. */
    cam?: number | null;
    /** Only this zoom level of the reference. */
    zoom?: string;
    /** Skip the levels of other layers (a level's optional `layer`, e.g. "live" / "taken"); levels without one are
     * always tried. */
    layer?: string;
    /** Over the reference's, key by key: center (on screen), size (px, square). */
    crop?: { center?: Point; size?: number };
    /** Over the reference's, key by key: circle [inner, outer], wedge {r, half}, drop (HSV ranges {h, s, v: [lo, hi]},
     * OpenCV's H 0-180), grow, sat_max. */
    mask?: Record<string, any>;
    /** Over the reference's, key by key: h, s, v, mode (flat | mask | none), gain, open, min_px, close, edge. */
    regions?: Record<string, any>;
    /** Preprocessing, over the reference's: kind (raw | hp | dog | grad | canny), pre, sigma. */
    prep?: Record<string, number | string>;
}

interface Located {
    x: number;
    y: number;
    /** Normalized correlation of the match (-1..1). */
    score: number;
    /** Best score elsewhere (more than 4 px off): a match well above it is unambiguous. */
    second: number;
    /** The zoom level that matched best. */
    zoom: string;
    /** Its layer, if it has one. */
    layer?: string;
    /** Its scale: position units per reference px (e.g. big map px per minimap px). */
    k: number;
    /** Crop pixels compared. */
    used: number;
    ms: number;
    /** Score per zoom level tried. */
    levels: Record<string, number>;
}

interface WaitOptions extends NodeOptions {
    /** Give up after this many ms (default 10000); waitFor returns null then. */
    timeout?: number;
    /** Pause between checks, ms (default 100). */
    interval?: number;
}

interface NodeRun {
    /** The task succeeded and its last node completed. */
    hit: boolean;
    status: number;
    /** Nodes it went through. */
    nodes: string[];
}

interface SkillContext {
    workspace: string;
    skill: string;
    /** api | schedule | pipeline | recognition | skill */
    trigger: string;
    /** The pipeline node that called this skill (custom action / recognition). */
    node?: string;
    /** The box the node's recognition hit (custom action). */
    box?: Box | null;
    /** Custom recognition: the image to recognize on, and the node's roi. */
    image?: Image;
    roi?: Box;
    /** The skill that called this one through runSkill. */
    caller?: string;
}

interface SkillMeta {
    description?: string;
    /** ms a call may take (default 60000); the run is stopped after that. */
    timeout?: number;
}

// ---- screen and recognition

/** Take a screenshot; recognitions without { image } use the latest one. */
declare function screenshot(): Image;
/** Recognize with a pipeline node of this workspace (its recognition only; no action, no next). */
declare function recognize(node: string, opts?: NodeOptions): Hit;
/** Template match with templates/ images. */
declare function match(template: string | string[], opts?: TemplateOptions): Hit;
declare function color(opts: ColorOptions): Hit;
/** OCR; needs a PaddleOCR model (det.onnx, rec.onnx, keys.txt) in the workspace's model/ocr. */
declare function ocr(opts?: OcrOptions): Hit;
/** Neural network detection (NeuralNetworkDetect), e.g. a YOLO model. */
declare function detect(opts: DetectOptions): Hit;
/** Neural network classification (NeuralNetworkClassify), Maa's: one image, its fixed preprocessing. */
declare function classify(opts: ClassifyOptions): Hit;
/**
 * Run an ONNX model (a path under the workspace's model/, e.g. "ttc/ttc.onnx") on a screenshot region, with your own
 * preprocessing and several frames stacked as channels:
 *   infer("ttc/ttc.onnx", { roi: [240, 30, 600, 600], size: 96, color: "gray", frames: [-4, -2, 0],
 *                           frame_ms: 1000 / 30, mean: 0.45, std: 0.25, post: "softmax" })
 */
declare function infer(model: string, opts?: InferOptions): Inference;
/** Inputs and outputs (names, types, shapes) of a model under model/. */
declare function modelInfo(model: string): ModelInfo;
/**
 * Where a screen region (e.g. the minimap, for where the character is) is, matched inside a reference image drawn
 * at its scale: templates/<ref>.json (zoom levels, each an image with its position scale and origin; the crop, what
 * of it is left out (mask, regions) and the preprocessing; made offline, see scripts/map_locate.py). Every zoom
 * level is tried, the best one wins; null if none could be matched.
 */
declare function locate(ref: string, opts?: LocateOptions): Located | null;
/** Any Maa recognition type with its pipeline parameters, e.g. reco("FeatureMatch", { template: "a.png" }). */
declare function reco(type: string, param?: Record<string, any>, opts?: RecoOptions): Hit;
/**
 * Poll until the node hits (screenshot + recognize each time) or the function returns something truthy.
 * Returns that hit / value, or null on timeout.
 */
declare function waitFor(node: string, opts?: WaitOptions): Hit | null;
declare function waitFor<T>(check: () => T, opts?: WaitOptions): T | null;
/** Save an image as a PNG in the workspace, e.g. "captures/boss.png"; returns the path. */
declare function saveImage(image: Image, path: string): string;
/** The latest capture stream frame, without taking a screenshot. */
declare function frame(): Omit<Image, "id">;

// ---- input

declare function click(target: Target): void;
declare function click(x: number, y: number): void;
declare function longPress(target: Target, ms?: number): void;
/** Swipe from a to b over ms (default 300). */
declare function swipe(from: Target, to: Target, ms?: number): void;
/** Raw touches; contacts 0-9 can be down at the same time (multi-touch). */
declare const touch: {
    down(target: Target, contact?: number): void;
    move(target: Target, contact?: number): void;
    up(contact?: number): void;
};
/** Press an Android keycode (e.g. 4 back, 3 home). */
declare function key(code: number): void;
declare function keyDown(code: number): void;
declare function keyUp(code: number): void;
declare function inputText(text: string): void;
declare function back(): void;
declare function home(): void;
/** Start / stop an app; default: the workspace's package. */
declare function startApp(pkg?: string): void;
declare function stopApp(pkg?: string): void;

// ---- time

/** Sleep ms; wakes early (and throws) on stop or timeout. */
declare function sleep(ms: number): void;
/** ms left before this call's timeout. */
declare function remaining(): number;

// ---- output and state

/** A line in the run's logs (returned by /skill/run, and in logcat). */
declare function log(...values: any[]): void;
/** Same as log. */
declare const console: { log(...values: any[]): void; info(...values: any[]): void; warn(...values: any[]): void; error(...values: any[]): void };
/** An event in /events: {type: "skill_event", workspace, skill, name, data}. */
declare function event(name: string, data?: any): void;
/** The workspace's memory/memory.json (shared with the PC tools). */
declare const memory: {
    get<T = any>(key: string, fallback?: T): T;
    set(key: string, value: any): void;
    delete(key: string): void;
    all(): Record<string, any>;
};

// ---- composition

/** Run a pipeline task from a node (with its actions and next); once: check the current screen only; override: over
 * this node's fields; nodes: over any nodes of the run, by name (e.g. a generic chain's card template). */
declare function runNode(node: string, opts?: { once?: boolean; override?: Record<string, any>; nodes?: Record<string, Record<string, any>> }): NodeRun;
/** Run another skill's default export in this run; returns its result, throws its error (or its timeout). */
declare function runSkill<T = any>(name: string, args?: any): T;
