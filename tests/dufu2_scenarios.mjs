// The scenarios shared by tests/dufu2_scheduler.mjs and the old-vs-new touch comparison.
// Each factory returns a fresh object (the potion scenario keeps mutable state in its closure).
import { frameMs, timeline } from "./dufu2_fake.mjs";

/** phase-1 finalized live config (2026-10-28): used as the old module's args in the A/B comparison */
export const FINAL_P1 = { phase: 1, model: "dufu1b", parryLead: 10, curtainGap: false, curtain2: true, chain11: false, attack: false };

const p1Contact = (gid, c, opts = {}) => ({ head: timeline({ phase: 1, gid, contacts: [c], ...opts }) });

/** The boss bar steps 300 -> 290 at t0: two low samples ~500 ms later open the legacy near gate (lastDropAt). */
const bossDrop = (t0) => (t) => (t >= t0 ? 290 : 300);

/** tte distribution: p in `bin`, 1-p at TTE_NONE (46). bin > 20 keeps the layer's pWithin(20) guard at 0, so it is
 *  purely a commit-horizon signal. */
const tteAt = (p, bin = 30) => {
    const a = new Array(47).fill(0);
    a[bin] = p;
    a[46] = 1 - p;
    return a;
};

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
    // ---- 进攻 v2 (args.offense:"v2"; tests/dufu_offense.mjs has the pure engine table) ----
    offExecute() {
        return {
            phase: 1, mode: "defend", fightMs: 2200, args: { offense: "v2" },
            scenario: {
                head: () => ({ gid: 0, med: 46, col: 2, resp: 2 }), // k0:c0, next.share .0179
                qi: () => 5, execute: (t) => t < 800, qishu: () => true, weapon: () => "modao",
            },
        };
    },
    offQishu() {
        // k1:c3 (gid 17, next.share 0) is a parry: an ok at 800, then its chain-ending group is the last contact;
        // P(empty 70) from that group is .91 (>= the stage-1 q .90), so 奇术 goes right after the detection.
        const tl = timeline({ phase: 1, gid: 17, contacts: [800], resp: 1 });
        return {
            phase: 1, mode: "defend", fightMs: 2400, args: { offense: "v2" },
            scenario: {
                head: (t) => (t < 900 ? tl(t) : { gid: 97, med: 46, col: 2, resp: 2 }),
                qi: (t) => (t >= 800 ? 240 : 300),
                qishu: (t) => t >= 800, weapon: () => "modao", // not ready in the opening: the post-ok window only
            },
        };
    },
    offLight() {
        let switched = false;
        const tl = timeline({ phase: 1, gid: 4, contacts: [400], resp: 1 }); // an ok at 400 opens the near gate
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: (t) => (t < 450 ? tl(t) : { gid: 97, med: 46, col: 2, resp: 2 }),
                qi: (t) => (t >= 400 ? 240 : 300),
                weapon: () => (switched ? "hengdao" : "modao"),
                onTap: (p) => { if (p[0] === 993 && p[1] === 320) switched = true; },
            },
        };
    },
    offChain() {
        const tl = timeline({ phase: 1, gid: 1, contacts: [800], resp: 1 }); // a parry contact at 800: an ok
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: (t) => (t < 900 ? tl(t) : { gid: 97, med: 46, col: 2, resp: 2 }),
                qi: (t) => (t >= 800 ? 240 : 300), // the ok's 真气 step (<= QI_JUMP 80)
                weapon: () => "hengdao", // no switch: the light itself is the touch to look for
            },
        };
    },
    offGoldFireball() {
        return {
            phase: 2, mode: "defend", fightMs: 8000, args: { offense: "v2" },
            scenario: {
                // k0:c11+c40 (gid 7) is dodged at ~950 (the gold-fireball window opens); after it ends, a k0:c3 ok at
                // 6400 opens the near gate and the first post-window 轻击 goes (~6430).
                head: (t) => {
                    if (t >= 950 && t <= 1050) return { gid: 7, med: Math.round((1000 - t) / frameMs), col: 0, resp: 1 };
                    if (t >= 6000 && t <= 6410) return { gid: 2, med: Math.round((6400 - t) / frameMs), col: 2, resp: 1 }; // k0:c5, parry
                    return { gid: 87, med: 46, col: 2, resp: 2 };
                },
                qi: (t) => (t >= 6400 ? 240 : 300), weapon: () => "",
            },
        };
    },
    offRain() {
        return {
            phase: 2, mode: "defend", fightMs: 4500, args: { offense: "v2" },
            scenario: {
                head: (t) => {
                    if (t >= 500 && t <= 900) return { gid: 4, med: Math.max(0, Math.round((800 - t) / frameMs)), col: 2, resp: 1 }; // k0:c7
                    if (t > 900) return { gid: 1, med: 46, col: 2, resp: 2 };
                    return { gid: 87, med: 46, col: 2, resp: 2 };
                },
                weapon: () => "", boss: bossDrop(800),
            },
        };
    },
    offRainFree() {
        // no 火球雨: a k0:c5 ok at 1400 opens the near gate and the 轻击 goes (P42 from that group .99 >= q .80)
        const tl = timeline({ phase: 2, gid: 2, contacts: [1400], resp: 1 });
        return {
            phase: 2, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: (t) => (t < 1450 ? tl(t) : { gid: 87, med: 46, col: 2, resp: 2 }),
                qi: (t) => (t >= 1400 ? 240 : 300), weapon: () => "",
            },
        };
    },
    offFollow() {
        const tl = timeline({ phase: 1, gid: 4, contacts: [400], resp: 1 }); // an ok at 400: the near gate
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: (t) => (t < 450 ? tl(t) : { gid: 97, med: 46, col: 2, resp: 2 }),
                qi: (t) => (t >= 400 ? 240 : 300),
                blueDisc: () => true, weapon: () => "hengdao", // the disc is already up when the ok at 400 lands
            },
        };
    },
    offFollowOff() {
        const tl = timeline({ phase: 1, gid: 4, contacts: [400], resp: 1 });
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: (t) => (t < 450 ? tl(t) : { gid: 97, med: 46, col: 2, resp: 2 }),
                qi: (t) => (t >= 400 ? 240 : 300), weapon: () => "hengdao",
            },
        };
    },
    offPreemptGold() {
        return {
            phase: 1, mode: "defend", fightMs: 2200, args: { offense: "v2" },
            scenario: {
                // the boss drop at 300 opens the near gate; the switch starts ~780, the c11 gold tell at 1300 cancels it
                head: (t) => ({ gid: 35, med: 46, col: t >= 1300 ? 0 : 2, resp: 2 }), // k2:c11 (phase 1)
                weapon: () => "modao", boss: bossDrop(300),
            },
        };
    },
    offPreemptDefense() {
        const tl = timeline({ phase: 1, gid: 1, contacts: [1500], resp: 1 });
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: (t) => (t < 1300 ? { gid: 43, med: 46, col: 2, resp: 2 } : tl(t)),
                weapon: () => "modao", boss: bossDrop(300),
            },
        };
    },
    offChargePreempt() {
        const tl = timeline({ phase: 1, gid: 4, contacts: [400], resp: 1 }); // a chain-ending ok at 400
        return {
            phase: 1, mode: "defend", fightMs: 1800, args: { offense: "v2", offenseCharge: true },
            scenario: {
                // 陌刀 蓄力 after the ok's group (next.share .033); the gold tell at 900 releases the held finger
                head: (t) => (t < 450 ? tl(t) : { gid: 97, med: 46, col: t >= 900 ? 0 : 2, resp: 2 }),
                qi: (t) => (t >= 400 ? 240 : 300),
                weapon: () => "modao",
            },
        };
    },
    offNearNone() {
        // quiet, no ok and no boss drop: the near gate stays shut and nothing may start (execute is not up here)
        return {
            phase: 2, mode: "defend", fightMs: 2500, args: { offense: "v2" },
            scenario: { head: () => ({ gid: 87, med: 46, col: 2, resp: 2 }), weapon: () => "" },
        };
    },
    offGoldContact() {
        // k4:c11+c41 (gid 56, name has c11, not the k0:c11+c40 goldSeq opener) hits at 1000; the c11 quiet keeps the
        // offense off until 2500 ms after the contact's capture time (~833). A boss drop at 1500 opens near at ~2000,
        // so only goldNow stops the light until ~3333; then the quiet phase-2 light goes (P42 .745 >= q .70).
        return {
            phase: 2, mode: "defend", fightMs: 4500, args: { offense: "v2" },
            scenario: {
                head: (t) => (t >= 900 && t <= 1010
                    ? { gid: 56, med: Math.round((1000 - t) / frameMs), col: 2, resp: 2 }
                    : { gid: 87, med: 46, col: 2, resp: 2 }),
                hp: (t) => (t >= 1000 ? 0.7 : 1),
                boss: bossDrop(1500), weapon: () => "",
            },
        };
    },
    offGoldContactP1() {
        // phase 1's k2:c11 (gid 35) is dodge / unparryable / fatal, not a normal move: a hit at 1000 keeps the
        // offense off until 2500 ms after the contact (~833); the boss drop at 1500 opens near, then the quiet
        // phase-1 light (P42 .81 >= .70) goes at ~3334.
        return {
            phase: 1, mode: "defend", fightMs: 4500, args: { offense: "v2" },
            scenario: {
                head: (t) => (t >= 900 && t <= 1010
                    ? { gid: 35, med: Math.round((1000 - t) / frameMs), col: 2, resp: 2 }
                    : { gid: 97, med: 46, col: 2, resp: 2 }),
                hp: (t) => (t >= 1000 ? 0.7 : 1),
                boss: bossDrop(1500), weapon: () => "hengdao",
            },
        };
    },
    offOpeningQishu() {
        // the boss bar is up (300) with no contact yet: the opening 奇术 window (dufu.js qsWhere) fires without near
        return {
            phase: 2, mode: "defend", fightMs: 2000, args: { offense: "v2" },
            scenario: { head: () => ({ gid: 87, med: 46, col: 2, resp: 2 }), qishu: () => true, weapon: () => "" },
        };
    },
    offSwitchStale() {
        // A boss drop at 100 opens near; the switch starts at ~533 while 陌刀; a parry for the 800 contact is pressed
        // at ~467 and its ok lands at 800 (no defense press due then); the 横刀 template only reads from 900, so the
        // confirmation at ~1033 must cancel "stale" (a contact arrived after the switch started). A second drop at
        // 1500 reopens near after the 30 f unknown window and the light goes normally.
        const tl = timeline({ phase: 1, gid: 1, contacts: [800], resp: 1 });
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: (t) => (t < 520 ? tl(t) : { gid: 97, med: 46, col: 2, resp: 2 }),
                qi: (t) => (t >= 800 ? 240 : 300),
                weapon: (t) => (t >= 900 ? "hengdao" : "modao"),
                boss: (t) => (t >= 1500 ? 280 : t >= 100 ? 290 : 300),
            },
        };
    },
    offSwitchNearExpired() {
        // No new contact: the near gate from the drop at 100 (lastDropAt refreshes to ~1000 while the 300 sample is in
        // the 1.2 s ring) expires at ~2500; the switch confirms only at ~2780 -> stale.
        return {
            phase: 1, mode: "defend", fightMs: 3500, args: { offense: "v2" },
            scenario: {
                head: () => ({ gid: 97, med: 46, col: 2, resp: 2 }),
                weapon: (t) => (t >= 2700 ? "hengdao" : "modao"), boss: bossDrop(100),
            },
        };
    },
    offHorizonHigh() {
        // near at ~750; the head's tte has 30% within 30 f -> pWithin(42) = .30 >= .25: the light must not even switch
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: () => ({ gid: 97, med: 46, col: 2, resp: 2, tte: tteAt(0.30) }),
                weapon: () => "modao", boss: bossDrop(300),
            },
        };
    },
    offHorizonLow() {
        // the same window with 10% within 30 f: pWithin(42) = .10 < .25 -> 轻击 at ~750
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: () => ({ gid: 97, med: 46, col: 2, resp: 2, tte: tteAt(0.10) }),
                weapon: () => "hengdao", boss: bossDrop(300),
            },
        };
    },
    offSwitchHorizon() {
        // horizon is .10 when the switch starts (~533) and .30 when it confirms (~1033): stale
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: (t) => ({ gid: 97, med: 46, col: 2, resp: 2, tte: tteAt(t >= 600 ? 0.30 : 0.10) }),
                weapon: (t) => (t >= 900 ? "hengdao" : "modao"), boss: bossDrop(100),
            },
        };
    },
    offNearDrop() {
        // quiet phase 1, one boss-bar drop at 300 ms: near opens ~750 ms and the 横刀 轻击 goes (quiet P42 .81 >= q .80)
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: { head: () => ({ gid: 97, med: 46, col: 2, resp: 2 }), weapon: () => "hengdao", boss: bossDrop(300) },
        };
    },
    offUnknownContact() {
        // An ok at 800 whose group the head drops before the detection tick (lastContactGid = -1): the 30 f after it
        // must be "unknown", not the quiet_far prior; the ok still opens the near gate for the light afterwards.
        const c = 800;
        return {
            phase: 1, mode: "defend", fightMs: 3000, args: { offense: "v2" },
            scenario: {
                head: (t) => (t >= c - 12 * frameMs && t < c - 2 * frameMs
                    ? { gid: 1, med: Math.round((c - t) / frameMs), col: 2, resp: 1 }
                    : { gid: 97, med: 46, col: 2, resp: 2 }),
                qi: (t) => (t >= c ? 240 : 300),
                weapon: () => "hengdao",
            },
        };
    },
    offOff() {
        return {
            phase: 1, mode: "defend", fightMs: 2200, args: { offense: "off" },
            scenario: {
                head: () => ({ gid: 0, med: 46, col: 2, resp: 2 }), qi: () => 5,
                execute: () => true, qishu: () => true, blueDisc: () => true, weapon: () => "modao",
            },
        };
    },
};
