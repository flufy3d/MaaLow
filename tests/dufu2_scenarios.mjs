// The scenarios shared by tests/dufu2_scheduler.mjs and the old-vs-new touch comparison.
// Each factory returns a fresh object (the potion scenario keeps mutable state in its closure).
import { timeline } from "./dufu2_fake.mjs";

/** phase-1 finalized live config (2026-10-28): used as the old module's args in the A/B comparison */
export const FINAL_P1 = { phase: 1, model: "dufu1b", parryLead: 10, curtainGap: false, curtain2: true, chain11: false, attack: false };

const p1Contact = (gid, c, opts = {}) => ({ head: timeline({ phase: 1, gid, contacts: [c], ...opts }) });

export const SCENARIOS = {
    parry() {
        return { phase: 1, mode: "defend", fightMs: 3000, args: {}, scenario: p1Contact(1, 1500) };
    },
    parryLead6() {
        return { phase: 1, mode: "defend", fightMs: 3000, args: { parryLead: 6 }, scenario: p1Contact(1, 1500) };
    },
    gold() {
        return { phase: 1, mode: "defend", fightMs: 3000, args: {}, scenario: p1Contact(1, 1500, { col: 0, resp: 1 }) };
    },
    curtainCovered() {
        return { phase: 1, mode: "defend", fightMs: 2500, args: {}, scenario: { curtain: (t) => (t >= 1000 ? "covered" : null) } };
    },
    curtainGap() {
        return { phase: 1, mode: "defend", fightMs: 2500, args: { curtainGap: true }, scenario: { curtain: (t) => (t >= 1000 ? [600, 900] : null) } };
    },
    potion() {
        let picked = false;
        return {
            phase: 2, mode: "defend", fightMs: 4500, args: { potions: 1 },
            scenario: {
                // hp 50% -> 20% at 0.5 s (a hit), the slot turns to the other item at 1.5 s, potion back on the pick
                hp: (t) => (t < 500 ? 0.5 : t < 3500 ? 0.2 : 0.4),
                slot: (t) => (t >= 1500 && !picked ? false : undefined),
                onTap: (p) => { if (p[0] === 702 && p[1] === 575) picked = true; },
            },
        };
    },
    p2parry() {
        return {
            phase: 2, mode: "defend", fightMs: 3000, args: {},
            scenario: { head: timeline({ phase: 2, gid: 0, contacts: [1500], resp: 1 }) },
        };
    },
    c7() {
        return {
            phase: 2, mode: "defend", fightMs: 6000, args: {},
            scenario: { head: timeline({ phase: 2, gid: 4, contacts: [2500], from: 46, resp: 1 }) },
        };
    },
    shadow() {
        return {
            phase: 1, mode: "shadow", fightMs: 3600, args: { approach: false },
            scenario: { head: timeline({ phase: 1, gid: 1, contacts: [1000, 2000, 3000], col: 0, resp: 1 }) },
        };
    },
    curtain2() {
        return { phase: 1, mode: "defend", fightMs: 3000, args: {}, scenario: p1Contact(24, 1500, { resp: 1 }) };
    },
    curtain2Off() {
        return { phase: 1, mode: "defend", fightMs: 3000, args: { curtain2: false }, scenario: p1Contact(24, 1500, { resp: 1 }) };
    },
    pairOff() {
        return { phase: 1, mode: "defend", fightMs: 3000, args: { pair: 0 }, scenario: p1Contact(1, 1500) };
    },
};
