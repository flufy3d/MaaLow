// Push the app's event log past its big entries: the in-memory log keeps the last 1000 events (store/Events.kt KEEP) and
// the file is cut to them past 4000 lines, so dufu's trace events (~90 KB each with "feat") pile up to ~90 MB of heap
// (GET /events then runs out of memory, and a restart reads the whole file). tools/dufu_rounds.py runs this after
// taking a round's trace: n tiny events, so memory and the next file cut hold only small ones.
//   maalow do skill event_pad --args '{"n":1100}'
/** @type {SkillMeta} */
export const meta = { description: "post n tiny events to push big ones out of the app's event log", timeout: 120_000 };

/** @param {{n?: number}} [args] */
export default function (args = {}) {
    const n = args.n ?? 1100;
    for (let i = 0; i < n; i++) event("pad", i);
    return n;
}
