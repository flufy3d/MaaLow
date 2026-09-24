/**
 * min / p50 / p95 / max / mean of a list of numbers.
 * @param {number[]} xs
 */
export function stats(xs) {
    if (xs.length === 0) return { n: 0 };
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const round = (x) => Math.round(x * 10) / 10;
    return {
        n: s.length,
        min: round(s[0]),
        p50: round(q(0.5)),
        p95: round(q(0.95)),
        max: round(s[s.length - 1]),
        mean: round(s.reduce((a, b) => a + b, 0) / s.length),
    };
}
