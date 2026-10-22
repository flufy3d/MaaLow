// The head's pure decoding math (softmax / argmax / headOut / futStats); the bins come from lib/dufu-labels.js.
import { FUT_CENTER } from "./dufu-labels.js";

/** @typedef {{probs: number[], arg: number, p: number, label: string}} HeadOut */

/** @param {number[]} out @param {number} off @param {number} n */
export function softmax(out, off, n) {
    let mx = -Infinity;
    for (let i = 0; i < n; i++) mx = Math.max(mx, out[off + i]);
    const p = new Array(n).fill(0);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        p[i] = Math.exp(out[off + i] - mx);
        sum += p[i];
    }
    for (let i = 0; i < n; i++) p[i] /= sum;
    return p;
}

/** @param {number[]} p */
export function argmax(p) {
    let a = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[a]) a = i;
    return a;
}

/** @param {number[]} p @param {string[]} labels @returns {HeadOut} */
export function headOut(p, labels) {
    const arg = argmax(p);
    return { probs: p, arg, p: p[arg], label: labels[arg] };
}

/** @param {number[]} p @returns {{none: number, sum: number, exp: number, mode: number, i1: number, p1: number, i2: number, p2: number}} */
export function futStats(p) {
    let sum = 0, e = 0, i1 = -1, p1 = 0, i2 = -1, p2 = 0;
    for (let i = 0; i < 10; i++) {
        const v = p[i] ?? 0;
        sum += v;
        e += v * FUT_CENTER[i];
        if (v > p1) {
            i2 = i1;
            p2 = p1;
            i1 = i;
            p1 = v;
        } else if (v > p2) {
            i2 = i;
            p2 = v;
        }
    }
    return { none: p[10] ?? 0, sum, exp: sum > 0 ? e / sum : Infinity, mode: i1, i1, p1, i2, p2 };
}
