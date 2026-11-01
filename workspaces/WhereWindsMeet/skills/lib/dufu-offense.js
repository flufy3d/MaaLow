// 独夫 进攻 v2: a pure decision function (docs/dufu-offense-design.md 5). No touches, no clock, no logs, no screen
// reads: dufu2.js feeds it the tick's state and carries the action out on contact 3.
//
// Scheduling (design 5.1 / 5.2):
//   T0 (no action): chain still live (next.share >= 0.2 and a contact < 30 f ago), a gold-fireball window, the 火球雨
//     (run), the k2:c30 chain beat, 幕布 covered / sweeping, a drink, the execute wind-up, 1 s after a hit, a defense
//     press due now (defenseBusyUntil), no boss bar, no context at all (idle head and no pEmpty).
//   T1 execute (button) > T2 qishu (70 f, q .80) > T5 charge (陌刀, 45 f, q .85; opt-in, off by default, taken
//     before light only when the switch to 横刀 would be paid) > T3 follow (blue disc, 61 f, q .70) / light
//     (42 f, q .60) > T4 set (phase change / opening, 144 f, q .90; interface only in v1). The blue disc is checked
//     before light: P(empty 42) >= P(empty 61) always, so the literal order would make follow unreachable; the disc
//     is the game's own post-ok prompt.
//   P(empty f): the last contact's prefix group `next.share` (lib/dufu-offense-table.js) while that contact is < 30 f
//     old -- the design's low-share anchor (3.2: p1 ok low next.share + 30 f = .791 / .777 / .679 at 45 / 60 / 90)
//     scaled by (1 - share) / 0.8, e.g. share 0.8 -> .198 at 45 f (design's 串中 .178), share 0.2 -> .791. After
//     30 f the group says nothing about the gap any more: the pooled quiet_far anchor applies (p1 .809 / .757 /
//     .666 at 45 / 60 / 90, p2 .743 / .671 / .550; @see quietP). The caller may override any window with input.pEmpty.
//   The input `group` is the LAST CONTACT's prefix group (design 4: the contact history's group / k / next.share), not
//     the head's current prediction; it is null before the first contact or when the head gave no group then.
//   Weapon: 横刀 for light / follow. Phase 1 is 陌刀 by default: `needsHengdao` / `switchFirst` tell dufu2.js to tap the
//     switch first (24 f, then it confirms by the weapon template); the engine never presses anything. Phase 2 is
//     横刀 native, so an unread weapon there counts as 横刀. A 陌刀 / unread weapon in phase 1 is no light.
//   Near gate (dufu2.js's legacy ATK_NEAR_MS / ATK_DROP_MS = 1500 ms): light / follow / charge / set need a recent ok
//     or boss-bar drop ("near", reason code 26). execute (the button) and qishu are exempt: dufu.js qsTick casts 奇术
//     at the opening (before any hit/ok) or at a 气竭 window start, with no range gate, so it is a ranged skill.
//   Unknown last contact: a contact < 30 f old whose group is null / next.share null is not a quiet window -- the
//     caller sends pE = 0 and the engine returns "unknown" (27); only a >= 30 f gap uses the quiet_far anchor. The
//     处决 button stays above this (a strong signal).
//
// output: {action, tier, q, reason, needsHengdao, switchFirst, holdMs?} for an action, or null (decide) /
//   {action: null, tier: 0, q: 0, reason} (pick). TIER / REASON are the numeric trace codes.

const FRAME_MS = 1000 / 30;
/** the chain is "live" at or above this next.share (design 3.2 / 5.2) */
export const CHAIN_SHARE = 0.2;
/** ... and only this long after its last contact (design 5.1) */
export const CHAIN_CLEAR_F = 30;
/** 1 s after a hit: no action (design 5.1) */
export const HIT_QUIET_MS = 1000;
/** the legacy near gate (dufu2.js ATK_NEAR_MS / ATK_DROP_MS, legacy atkTick): light / follow / charge / set only
 *  after an ok or a boss-bar drop this recently. 1500 ms, not the 3 s of the old dufu.js OFF_OK_MS: dufu2's own
 *  legacy gate is authoritative here. */
export const NEAR_OK_MS = 1500, NEAR_DROP_MS = 1500;
/** the window lengths the caller precomputes (input.pEmpty keys) */
export const WINDOWS = [18, 42, 45, 61, 70, 144];
// P(empty f) for a chain-ending group (next.share 0): the design's phase-1 low-share anchor (3.2), extended to the
// windows the actions use; 144 is the 整套 window, extrapolated past the measured 90 f (.679).
/** @type {Record<number, number>} */
const BASE_P = { 18: 0.86, 42: 0.80, 45: 0.79, 61: 0.76, 70: 0.73, 144: 0.50 };
// P(empty f) with no contact for >= 30 f ("quiet_far" in data/moveid/offense/empty.py: the previous contact is at
// least 30 f back; p1 .809 / .757 / .666 at 45 / 60 / 90, p2 .743 / .671 / .550; 42 / 61 / 70 interpolated, 144
// extrapolated). No group describes this window, so the pooled anchor is the prior.
/** @type {Record<1 | 2, Record<number, number>>} */
const QUIET_P = {
    1: { 18: 0.83, 42: 0.81, 45: 0.809, 61: 0.755, 70: 0.71, 144: 0.45 },
    2: { 18: 0.78, 42: 0.745, 45: 0.743, 61: 0.672, 70: 0.62, 144: 0.38 },
};
/** the action tier's required P(empty window) (design 3.3 / 5.2; conservative stage-1 values 2026-11-01, the middle
 *  step after the first live A/B: the old low thresholds let attacks start in front of contacts). `pick(input.q)` can
 *  override them for an A/B. */
export const Q = { execute: 0.80, qishu: 0.85, light: 0.70, follow: 0.80, set: 0.90, charge: 0.85 };
/** trace codes (result.offense.reasonNames is the reverse map) */
export const TIER = { none: 0, execute: 1, qishu: 2, light: 3, follow: 3, set: 4, charge: 5 };
export const REASON = {
    none: 0, button: 1, long: 2, disc: 3, short: 4, transition: 5, charge: 6,
    defense: 10, hit: 11, potion: 12, executeWindup: 13, curtain: 14, gold: 15, running: 16, c30: 17,
    chain: 18, idle: 19, noBoss: 20, weapon: 21, q42: 22, q61: 23, q70: 24, q144: 25, near: 26, unknown: 27,
    stale: 28, // dufu2.js layer only: a queued switch action canceled because its window went stale
    horizon: 29, // dufu2.js layer only: pWithin(commit+safety) was too high, so no attack started
};
/** @type {Record<number, string>} */
export const REASON_NAMES = Object.fromEntries(Object.entries(REASON).map(([k, v]) => [v, k]));

/**
 * P(no contact within `frames` frames) with no group to look up (a quiet window): the pooled quiet_far anchor.
 * @param {1 | 2} phase @param {number} frames @returns {number | null}
 */
export function quietP(phase, frames) {
    return QUIET_P[phase]?.[frames] ?? null;
}

/**
 * P(no contact within `frames` frames) for a group whose chain continues with probability `nextShare`.
 * The design's low-share anchor (next.share ~0.2) is the base; a higher share scales it down linearly and a lower
 * one up, clipped at 1. null when the share is unknown (idle).
 * @param {number | null | undefined} nextShare @param {number} frames @returns {number | null}
 */
export function emptyP(nextShare, frames) {
    const base = BASE_P[frames];
    if (base == null || typeof nextShare !== "number" || !isFinite(nextShare)) return null;
    const s = Math.max(0, Math.min(1, nextShare));
    return Math.max(0, Math.min(1, base * ((1 - s) / (1 - CHAIN_SHARE))));
}

/** @param {string} reason @returns {{action: null, tier: 0, q: 0, reason: string}} */
const block = (reason) => ({ action: null, tier: 0, q: 0, reason });
/** @param {string} action @param {number} tier @param {number} q @param {string} reason @param {object} [extra] */
const act = (action, tier, q, reason, extra = {}) => ({ action, tier, q, reason, needsHengdao: false, switchFirst: false, ...extra });

/**
 * The legacy near gate: an ok within NEAR_OK_MS or a boss-bar drop within NEAR_DROP_MS. 0 = never happened (do not
 * read it as `now - 0`). `light / follow / charge / set` need it; `execute` (the button) and `qishu` (dufu.js qsTick:
 * opening / 气竭 only, no range gate) do not.
 * @param {{now?: number, lastOkAt?: number, lastDropAt?: number}} input @returns {boolean}
 */
export function nearNow(input) {
    const now = input.now ?? 0;
    const ok = typeof input.lastOkAt === "number" && input.lastOkAt > 0 && now - input.lastOkAt <= NEAR_OK_MS;
    const drop = typeof input.lastDropAt === "number" && input.lastDropAt > 0 && now - input.lastDropAt <= NEAR_DROP_MS;
    return ok || drop;
}

/**
 * The tick's decision with its reason (dufu2.js's trace); `decide` drops the null rows.
 * @param {{
 *   now: number, phase: 1 | 2, weapon: "" | "modao" | "hengdao", bossPx: number, qi?: number,
 *   executeButton?: boolean, blueDisc?: boolean, qishuReady?: boolean,
 *   lastContactAt?: number, lastContactKind?: "hit" | "ok" | "", lastHitAt?: number, lastDropAt?: number,
 *   lastOkAt?: number, group: {name: string, k?: number, nextShare: number | null} | null, // the last contact's group
 *   contactChainLen?: number, contactChainPos?: number,
 *   special?: {curtainCovered?: boolean, curtainSweep?: boolean, fireballRain?: boolean, goldFireball?: boolean,
 *              phaseTransition?: boolean, running?: boolean, potionPending?: boolean, executeWindup?: boolean,
 *              c30Chain?: boolean},
 *   defenseBusyUntil?: number, pEmpty?: Record<number, number | null>,
 *   q?: {execute: number, qishu: number, light: number, follow: number, set: number, charge: number},
 *   allow?: {set?: boolean, charge?: boolean},
 * }} input
 * @returns {{action: string | null, tier: number, q: number, reason: string, needsHengdao: boolean,
 *            switchFirst: boolean, holdMs?: number}}
 */
export function pick(input) {
    const now = input.now ?? 0;
    const sp = input.special ?? {};
    // ---- T0 (design 5.1): nothing may start here
    if ((input.defenseBusyUntil ?? 0) > now) return block("defense");
    if (input.lastHitAt && now - input.lastHitAt < HIT_QUIET_MS) return block("hit");
    if (sp.potionPending) return block("potion");
    if (sp.executeWindup) return block("executeWindup");
    if (sp.curtainCovered || sp.curtainSweep) return block("curtain");
    if (sp.goldFireball) return block("gold");
    if (sp.fireballRain || sp.running) return block("running");
    if (sp.c30Chain) return block("c30");
    if ((input.bossPx ?? 0) <= 50) return block("noBoss");
    const near = nearNow(input);
    const phase = input.phase ?? 2;
    const weapon = input.weapon ?? "";
    const q = input.q ?? Q; // the stage-1 defaults; dufu2.js may override via args.offenseQ for an A/B
    // 横刀? phase 2 is native (an unread weapon cannot be 陌刀 there); phase 1 must be read
    const heng = phase === 2 ? weapon !== "modao" : weapon === "hengdao";
    const switchFirst = !heng && (phase === 2 || weapon === "modao");
    const hengAction = (/** @type {string} */ action, /** @type {number} */ q, /** @type {string} */ why) =>
        act(action, TIER[action], q, why, { needsHengdao: true, switchFirst });
    // ---- T4 整套 (phase change): its own window; everything else waits a transition out.
    // Interface only in v1 (dufu2.js does not run it): allow.set is off by default. The 整套 needs the near gate.
    if (sp.phaseTransition) {
        if (input.allow?.set && pEmpty(input, null, 144) >= q.set) {
            return near ? act("set", TIER.set, q.set, "transition", { needsHengdao: true, switchFirst }) : block("near");
        }
        return block("transition");
    }
    // ---- T1 气竭 处决: the button is the window (P(empty 45) = 1.00 in the design); no group and no near needed
    // (the button only shows next to a staggered boss, but the button itself is the strong signal).
    if (input.executeButton) return act("execute", TIER.execute, q.execute, "button");
    // the group is the last contact's prefix group (design 4: the contact history's group / k / next.share). It is
    // null in a quiet spell (>= 30 f, no contact yet); the caller's pEmpty then carries the quiet_far anchor.
    const g = input.group;
    const share = g && typeof g.nextShare === "number" && isFinite(g.nextShare) ? g.nextShare : null;
    if (!g && !input.pEmpty) return block("idle");
    // a contact < 30 f old with no group (the head was idle / the group is idle) is NOT a quiet window: every pE is
    // 0 (the caller) and the engine does not fall back to quiet_far. execute above is the only way past this.
    if (input.lastContactAt && now - input.lastContactAt < CHAIN_CLEAR_F * FRAME_MS && share == null) return block("unknown");
    // 串中: the last contact's group continues the chain and it is < 30 f old (design 5.1)
    if (share != null && share >= CHAIN_SHARE && input.lastContactAt && now - input.lastContactAt < CHAIN_CLEAR_F * FRAME_MS) return block("chain");
    const pE = (/** @type {number} */ f) => pEmpty(input, share, f);
    // ---- T2 奇术: a long window only; dufu.js qsTick allows it at the opening / a 气竭 window with no range gate
    if (input.qishuReady && pE(70) >= q.qishu) return act("qishu", TIER.qishu, q.qishu, "long");
    // ---- the legacy near gate (dufu2 ATK_NEAR_MS / ATK_DROP_MS): everything below needs a recent ok / boss drop
    if (!near) return block("near");
    // ---- T5 陌刀 蓄力 (真气 only; opt-in, off by default): in phase 1 陌刀 a charge is taken instead of paying the
    // 24 f switch that light would need. Off unless the caller sets allow.charge; the design lists it last because it
    // deals no HP, and with light always available in the same window a literal last place would be unreachable.
    if (input.allow?.charge && phase === 1 && weapon === "modao" && pE(45) >= q.charge) {
        return act("charge", TIER.charge, q.charge, "charge", { holdMs: 700 });
    }
    // ---- T3 the 横刀 ok follow-up (the blue disc) and 轻击
    if (input.blueDisc && heng && pE(61) >= q.follow) return hengAction("follow", q.follow, "disc");
    if (pE(42) >= q.light) {
        if (heng) return hengAction("light", q.light, "short");
        if (switchFirst) return hengAction("light", q.light, "short");
        return block("weapon"); // phase 1, weapon unread: do not toggle blind
    }
    // why nothing: which window failed (the trace's atkReason)
    if (input.blueDisc && pE(61) < q.follow) return block("q61");
    if (input.qishuReady && pE(70) < q.qishu) return block("q70");
    return block("q42");
}

/** @param {{pEmpty?: Record<number, number | null>}} input @param {number} share @param {number} f */
function pEmpty(input, share, f) {
    const given = input.pEmpty?.[f];
    if (typeof given === "number" && isFinite(given)) return given;
    return emptyP(share, f) ?? 0;
}

/** The design's contract: the action or null (pick() carries the blocked reason for the trace). */
export function decide(input) {
    const d = pick(input);
    return d.action ? d : null;
}
