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
    /** Frame number of the capture stream. */
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
    /** ONNX model name (e.g. a YOLO export). Model loading is not wired up yet (replay-guidance phase). */
    model: string;
    expected?: number | number[];
    labels?: string[];
    threshold?: number | number[];
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

/** Run a pipeline task from a node (with its actions and next); once: check the current screen only. */
declare function runNode(node: string, opts?: { once?: boolean; override?: Record<string, any> }): NodeRun;
/** Run another skill's default export in this run; returns its result, throws its error (or its timeout). */
declare function runSkill<T = any>(name: string, args?: any): T;
