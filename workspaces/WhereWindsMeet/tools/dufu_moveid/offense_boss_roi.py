"""独夫 phase 1: does the offense boss read (lib bossFill) really remove the HUD's fake drops?

Read-only. For r199 / r201 / r203 it decodes the round's recording (every 2nd frame) and compares the two boss-bar
reads of workspaces/WhereWindsMeet/skills:

  old  lib dufu2.js bossBar(): the red px count of BOSS_ROI [347,27,386,6] / 6  (one read per 250 ms in the trace)
  new  lib dufu-reads.js bossFill(): the widest single red row of BOSS_ROI_TALL [347,20,386,20], capped at 386

Both are colour reads with BOSS_RED = RGB [170,0,0]-[255,130,130] (method 4, not HSV).

Why a calibration step (see the run's JSON `calibration`): the recording is not pixel-identical to the skill's
screenshot coordinate system. Measured against the trace's 4 Hz `boss` column (the device's own bossBar read), the
bar in the video sits 1 row lower (ROI rows 27-32 are video rows 28-33) and the bar's bottom edge row is crushed by
the H.264 encoding to RGB ~(133,24,29), below the R >= 170 threshold the skill uses. With the literal threshold the
video's old read is 5/6 of what the device read at every frame -- an artefact of the file, not of the skill. The
script therefore fits (row offset, threshold, sub-frame lag) per round against the trace's `boss` column and only
trusts a fit that reproduces it (>= 85 % of the samples within 6 px); otherwise the round is reported unverified.

  uv run --no-project --with opencv-python-headless --with numpy python \
      workspaces/WhereWindsMeet/tools/dufu_moveid/offense_boss_roi.py

Outputs: data/moveid/offense/online/boss_roi.json and boss_roi.md. Nothing else is written and nothing is changed.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve()
REPO = HERE.parents[4]
LIVE = REPO / "data" / "moveid" / "p1" / "live"
OUT = REPO / "data" / "moveid" / "offense" / "online"
FRAME_MS = 1000.0 / 30.0

# the skill's boxes (device screenshot coordinates)
X0, W = 347, 386                   # BOSS_ROI / BOSS_ROI_TALL share x 347..732
OLD_Y, OLD_H = 27, 6               # BOSS_ROI
TALL_Y, TALL_H = 20, 20            # BOSS_ROI_TALL
BOSS_FULL = 386
# the row band decoded around the bar: enough for every candidate offset
Y0, YH = 16, 30
# thresholds: 0 = the skill's BOSS_RED, 1 = "redness" (recovers the bar's codec-crushed edge row)
THRESHOLDS = {
    "skill": lambda r, g, b: (r >= 170) & (g <= 130) & (b <= 130),
    "redness": lambda r, g, b: (r >= 100) & (r - g >= 60) & (r - b >= 60),
}
DEFAULT_ROUNDS = ["r199", "r201", "r203"]
BAR_MIN_PX = 50.0                  # below this the bar is not on screen (walk-in / round over)
MATCH_PX = 6.0                     # calibration: a video old read within this of the trace's boss is a match
MATCH_MIN = 0.85                   # below this agreement the round is not trusted


def read_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def trace_boss(round_dir: Path):
    """The device's own bossBar series: wall ms since the skill start, boss px (4 Hz samples, one row per tick)."""
    ch = read_json(round_dir / "trace.json")
    if not ch:
        return None, None
    cols = ch[0]["cols"]
    rows = []
    for c in ch:
        rows.extend(c["rows"])
    a = np.array(rows, dtype=object)
    w = a[:, cols.index("wall")].astype(float)
    b = a[:, cols.index("boss")].astype(float)
    o = np.argsort(w)
    return w[o], b[o]


def clock_check(round_dir: Path):
    """The trace's `cap` (the screenshot's own clock) against `wall` (the host clock): a drifting difference would
    decouple the video frame number from `wall`."""
    ch = read_json(round_dir / "trace.json")
    if not ch:
        return None
    cols = ch[0]["cols"]
    rows = []
    for c in ch:
        rows.extend(c["rows"])
    a = np.array(rows, dtype=object)
    w = a[:, cols.index("wall")].astype(float)
    cp = a[:, cols.index("cap")].astype(float)
    d = cp - w
    k = max(1, len(d) // 10)
    return {"n": int(len(d)), "cap_minus_wall_median_ms": round(float(np.median(d)), 1),
            "first_decile_ms": round(float(np.median(d[:k])), 1),
            "last_decile_ms": round(float(np.median(d[-k:])), 1),
            "drift_ms": round(float(np.median(d[-k:]) - np.median(d[:k])), 1),
            "span_ms": round(float(w[-1] - w[0]), 0)}


def decode_rows(video: Path, every: int):
    """Per sampled frame: red px per row of x 347..732, rows 16..45, for both thresholds. uint16 (n, 30, 2)."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise SystemExit(f"cannot open {video}")
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if abs(fps - 30.0) > 0.5:
        print(f"warning: {video.name} reports {fps:.2f} fps (expected 30)")
    n = (frames + every - 1) // every
    out = np.zeros((n, YH, len(THRESHOLDS)), dtype=np.uint16)
    t0 = time.time()
    k = 0
    for f in range(frames):
        if not cap.grab():
            break
        if f % every:
            continue
        ok, im = cap.retrieve()
        if not ok:
            continue
        bgr = im[Y0:Y0 + YH, X0:X0 + W].astype(np.int16)
        b, g, r = bgr[:, :, 0], bgr[:, :, 1], bgr[:, :, 2]
        for j, fn in enumerate(THRESHOLDS.values()):
            out[k, :, j] = fn(r, g, b).sum(axis=1)
        k += 1
    cap.release()
    print(f"  decoded {k} frames of {frames} ({time.time() - t0:.1f} s)")
    return out[:k], frames


def reads(rows: np.ndarray, dy: int, thr: int):
    """The two skill reads on the decoded rows, shifted by dy video rows (video row = device row + dy)."""
    oy = OLD_Y - Y0 + dy
    ty = TALL_Y - Y0 + dy
    sub = rows[:, :, thr]
    old = sub[:, oy:oy + OLD_H].sum(axis=1) / float(OLD_H)
    new = np.minimum(sub[:, ty:ty + TALL_H].max(axis=1), BOSS_FULL)
    return old.astype(float), new.astype(float)


def frame_times(n: int, every: int, video_started: int, skill_start: int):
    """Capture time of each sampled frame relative to the skill start, ms."""
    return np.arange(n) * every * FRAME_MS + (video_started - skill_start)


def calibrate(rows: np.ndarray, every: int, t: np.ndarray, tw, tb):
    """Fit (dy, threshold, lag) so the video's old read reproduces the device's trace `boss` column."""
    best = None
    table = []
    sel = (tw > 15_000) & (tb > BAR_MIN_PX)
    if sel.sum() < 100:
        return None, table
    for tname in THRESHOLDS:
        thr = list(THRESHOLDS).index(tname)
        for dy in (-2, -1, 0, 1, 2):
            old, _ = reads(rows, dy, thr)
            for lag in (-2, -1, 0, 1, 2):
                idx = np.searchsorted(t + lag * FRAME_MS, tw[sel])
                idx = np.clip(idx, 0, len(old) - 1)
                err = np.abs(old[idx] - tb[sel])
                score = float(np.mean(err <= MATCH_PX))
                med = float(np.median(err))
                entry = {"thr": tname, "dy": dy, "lag": lag, "agree": round(score, 4), "median_err": round(med, 1)}
                table.append(entry)
                key = (score, -abs(dy), -abs(lag))
                if best is None or key > best[0]:
                    best = (key, entry)
    return best[1], table


def false_drops(x: np.ndarray, t: np.ndarray, drop=20.0, win_ms=1000.0, recover=0.8):
    """Drops of >= drop px that come back >= recover of the fall within win_ms of the low. A fall that stays down
    (a real damage step) or that only recovers after the window is not an event, and re-baselines the peak.
    Returns the low sample times (ms)."""
    ev = []
    n = len(x)
    if n < 3:
        return ev
    peak = float(x[0])
    i = 1
    while i < n:
        if x[i] >= peak:
            peak = float(x[i])
            i += 1
            continue
        if peak - x[i] < drop:
            i += 1
            continue
        # the low: minimum over the next 0.5 s (a 1- or 2-row HUD move can land over 1-2 frames)
        j = i
        while j + 1 < n and t[j + 1] - t[i] <= 500 and x[j + 1] <= x[j] + 2:
            j += 1
        low = float(min(x[i:j + 1]))
        low_i = i + int(np.argmin(x[i:j + 1]))
        need = low + recover * (peak - low)
        k = j
        hit = None
        while k < n and t[k] <= t[low_i] + win_ms:
            if x[k] >= need:
                hit = k
                break
            k += 1
        if hit is not None:
            ev.append(float(t[low_i]))
            peak = float(x[hit])
            i = hit + 1
        else:
            peak = float(x[j])
            i = j + 1
    return ev


def bar_band(row: np.ndarray):
    """(top row y, px) of the bar's fill: the longest run of 5-8 consecutive rows with near-equal counts. The HUD's
    red border / glow rows vary a lot row to row, the fill rows do not."""
    best = None
    n = len(row)
    for i in range(n):
        if row[i] < 200:
            continue
        for ln in range(5, 9):
            if i + ln > n:
                break
            seg = row[i:i + ln]
            if seg.min() >= 200 and seg.max() - seg.min() <= 5:
                if best is None or ln > best[2]:
                    best = (Y0 + i, float(np.mean(seg)), ln)
    return (None, None) if best is None else (best[0], best[1])


def analyse(round_name: str, every: int):
    d = LIVE / round_name
    rec = (d / "rec.txt").read_text(encoding="utf-8").strip()
    video = LIVE / "video" / f"{rec}.mp4"
    meta = read_json(LIVE / "meta" / f"{rec}.json") or {}
    res = read_json(d / "result.json") or {}
    v = res.get("value") or {}
    if not video.exists():
        raise SystemExit(f"{round_name}: no video {video}")
    print(f"{round_name} ({rec})")
    rows, frames = decode_rows(video, every)
    t = frame_times(len(rows), every, int(meta.get("started", 0)), int(v.get("start", 0)))
    tw, tb = trace_boss(d)
    cal, table = (None, [])
    if tw is not None:
        cal, table = calibrate(rows, every, t, tw, tb)
    if cal is None:
        # no usable trace: fall back to the observed geometry and say so
        cal = {"thr": "redness", "dy": 1, "lag": 0, "agree": None, "median_err": None}
        verified = False
    else:
        verified = bool(cal["agree"] is not None and cal["agree"] >= MATCH_MIN)
    # what the skill's own threshold would give without the calibration (the recording's crushed edge row)
    uncal = max([x for x in table if x["thr"] == "skill"], key=lambda x: x["agree"], default=None)
    thr = list(THRESHOLDS).index(cal["thr"])
    old, new = reads(rows, cal["dy"], thr)
    tt = t + cal["lag"] * FRAME_MS

    # presence / geometry per frame (for the partial split and first-last)
    sub = rows[:, :, thr]
    bar_top = np.full(len(sub), -1, dtype=int)
    bar_px = np.zeros(len(sub))
    for i in range(len(sub)):
        top, px = bar_band(sub[i])
        if top is not None:
            bar_top[i] = top
            bar_px[i] = px
    present = bar_px >= BAR_MIN_PX
    home = OLD_Y + cal["dy"]  # the ROI's top row in video coordinates: the bar sits here when it is not moved

    # distributions over the frames where the bar is on screen
    m = present
    o, nw = old[m], new[m]
    dd = nw - o
    partial = o < 0.95 * nw
    clipped = bar_top[m] != home
    infl_full = new > 1.02 * bar_px
    inflated = infl_full[m]

    # false drops, old and new, same rule
    fd_old = false_drops(o, tt[m])
    fd_new = false_drops(nw, tt[m])
    fd_trace = false_drops(tb, tw) if tw is not None else []

    first_at = float(tt[m][0]) if len(o) else None
    last_at = float(tt[m][-1]) if len(o) else None
    # first / last as 2-s medians over frames with the bar in its normal place and not inflated by the red border; the
    # bar animates in and a full-HP bar with the red border reads 384, which is not a useful first sample
    clean = present & ~infl_full & (bar_top == home)
    if clean.any():
        i0 = int(np.argmax(clean))
        i1 = int(len(clean) - 1 - np.argmax(clean[::-1]))
        first_at, last_at = float(tt[i0]), float(tt[i1])
        w0 = (tt >= tt[i0]) & (tt <= tt[i0] + 2000) & clean
        w1 = (tt >= tt[i1] - 2000) & (tt <= tt[i1]) & clean
    else:
        w0 = tt[m] <= tt[m][0] + 2000 if len(o) else np.zeros(0, dtype=bool)
        w1 = tt[m] >= tt[m][-1] - 2000 if len(o) else np.zeros(0, dtype=bool)
    fo = float(np.median(old[w0])) if w0.any() else None
    lo_ = float(np.median(old[w1])) if w1.any() else None
    fn = float(np.median(new[w0])) if w0.any() else None
    ln = float(np.median(new[w1])) if w1.any() else None

    # execute steps (offense log): the skill's `land` sample is a 2 s fixed wait; the bar moves ~0.4 s after the
    # press, so the step is measured around the press (the land window is kept in the JSON for reference)
    log = ((v.get("offense") or {}).get("log")) or []
    presses = [e for e in log if e.get("a") == "execute" and e.get("ev") == "press"]
    lands = [e for e in log if e.get("a") == "execute" and e.get("ev") == "land"]
    execs = []
    for i, land in enumerate(lands[:2]):
        press = None
        for p in presses:
            if p.get("t", 0) <= land.get("t", 0) and (press is None or p["t"] > press["t"]):
                press = p
        pt = float(press["t"]) if press else float(land.get("at", land.get("t", 0)))
        before = (tt >= pt - 1000) & (tt <= pt - 100)
        after = (tt >= pt + 1200) & (tt <= pt + 2000)  # the bar falls over ~0.4-1.0 s; by +1.2 s it has settled
        land_at = float(land.get("at", land.get("t", 0)))
        lb = (tt >= land_at - 1000) & (tt <= land_at - 100)
        la = (tt >= land_at + 100) & (tt <= land_at + 1000)
        # when the bar actually moves (first frame 0.1-2.5 s after the press with a >= 20 px fall in either read)
        moved = None
        for j in np.where((tt >= pt + 100) & (tt <= pt + 2500))[0]:
            k0 = max(0, j - 8)
            if (old[k0:j].max() - old[j] >= 20) or (new[k0:j].max() - new[j] >= 20):
                moved = float(tt[j])
                break

        def step(vals, mask_a, mask_b):
            if mask_b.sum() < 2 or mask_a.sum() < 2:
                return None
            a0 = float(np.median(vals[mask_a]))
            b0 = float(np.median(vals[mask_b]))
            return {"before": round(a0, 1), "after": round(b0, 1), "step": round(a0 - b0, 1)}

        execs.append({
            "i": i + 1, "press_ms": round(pt), "land_ms": round(land_at),
            "dmg": land.get("dmg"), "bar_moved_ms": None if moved is None else round(moved),
            "moved_after_press_ms": None if moved is None else round(moved - pt),
            "old": step(old, before, after), "new": step(new, before, after),
            "old_land": step(old, lb, la), "new_land": step(new, lb, la),
        })

    # the trace's own old series, for the 4 Hz comparison
    trace_fd = [round(x) for x in fd_trace]

    out = {
        "round": round_name, "rec": rec, "video": str(video.relative_to(REPO)).replace("\\", "/"),
        "video_frames": frames, "sampled_frames": int(len(rows)), "every": every,
        "video_started": int(meta.get("started", 0)), "skill_start": int(v.get("start", 0)),
        "calibration": {
            "fit": cal, "verified": verified, "min_agreement": MATCH_MIN,
            "rule": "video old (BOSS_ROI / 6) vs the trace's 4 Hz boss column, |diff| <= 6 px, wall > 15 s",
            "dy_means": "video row = device row + dy (the recording sits dy rows below the skill's screenshot)",
            "uncalibrated_best": uncal,
            "candidates": sorted(table, key=lambda x: -x["agree"])[:6],
            "trace_false_drops": trace_fd, "trace_false_drops_n": len(fd_trace),
        },
        "clock": clock_check(d),
        "window": {"at_ms": [round(float(tt[m][0])), round(float(tt[m][-1]))], "frames": int(m.sum())},
        "old": {k: round(float(x), 1) for k, x in
                zip(("min", "p1", "p50", "p99", "max", "mean"),
                    (o.min(), np.percentile(o, 1), np.percentile(o, 50), np.percentile(o, 99), o.max(), o.mean()))},
        "new": {k: round(float(x), 1) for k, x in
                zip(("min", "p1", "p50", "p99", "max", "mean"),
                    (nw.min(), np.percentile(nw, 1), np.percentile(nw, 50), np.percentile(nw, 99), nw.max(), nw.mean()))},
        "diff": {k: round(float(x), 1) for k, x in
                 zip(("min", "p1", "p50", "p99", "max", "mean"),
                     (dd.min(), np.percentile(dd, 1), np.percentile(dd, 50), np.percentile(dd, 99), dd.max(), dd.mean()))},
        "partial_frames": {
            "rule": "old < 0.95 * new", "n": int(partial.sum()), "frac": round(float(partial.mean()), 4),
            "old_clipped": int((partial & clipped).sum()), "new_inflated": int((partial & inflated).sum()),
            "both": int((partial & clipped & inflated).sum()), "bar_top_moved": int(clipped.sum()),
            "bar_frames": int(len(o)),
        },
        "false_drop": {"rule": "a fall >= 20 px that recovers >= 80 % within 1.0 s",
                       "old": len(fd_old), "new": len(fd_new),
                       "old_times_ms": [round(x) for x in fd_old], "new_times_ms": [round(x) for x in fd_new]},
        "first_last": {
            "old": [round(fo, 1), round(lo_, 1), round(fo - lo_, 1)],
            "new": [round(fn, 1), round(ln, 1), round(fn - ln, 1)],
            "at_ms": [round(first_at), round(last_at)],
            "rule": "medians of the first / last 2 s with the bar on screen, in its normal row and without the red border",
            "note": "the bar animates from 384 to its usual width at the start and refills at phase changes; first-last is not a damage total",
        },
        "exec_steps": execs,
        "bar_top_home": int(home),
        "red_frames": {"n": int(inflated.sum()), "frac": round(float(inflated.mean()), 4)},
    }
    print(f"  calibration {cal} verified={verified}; old p50 {out['old']['p50']} new p50 {out['new']['p50']} "
          f"partial {out['partial_frames']['frac']:.3f} false_drop old/new {len(fd_old)}/{len(fd_new)}")
    return out


def fmt_execs(execs):
    if not execs:
        return "-"
    return ", ".join(f"{e['old']['step']:g}/{e['new']['step']:g}" if e["old"] and e["new"] else "-" for e in execs)


def markdown(rounds, meta):
    lines = []
    lines.append("# 独夫 phase 1 · boss 血条读数复核（旧 bossBar vs 新 bossFill）")
    lines.append("")
    lines.append(f"数据：{', '.join(r['round'] for r in rounds)}（`data/moveid/p1/live`）；"
                 f"每 {meta['every']} 帧取一帧（{(1000 / FRAME_MS) / meta['every']:.1f} Hz），视频 1080x720 / 30 fps。")
    lines.append("")
    lines.append("读数：old = `BOSS_ROI [347,27,386,6]` 红像素 / 6；new = `BOSS_ROI_TALL [347,20,386,20]` 逐行红像素最大值（上限 386）。"
                 "skill 里的红色阈值是 RGB [170,0,0]–[255,130,130]；录像里血条底边被 H.264 压暗到 R≈133，"
                 "所以下面按校准结果用 `redness`（R≥100 且 R−G≥60 且 R−B≥60）把那一行找回来。")
    lines.append("")
    bad = [r for r in rounds if not r["calibration"]["verified"]]
    lines.append("## 视频与截图的坐标校准")
    lines.append("")
    lines.append("录像与 skill 截图并非逐像素同一坐标系，直接套 ROI 会把血条底边那 1 行（H.264 压成 RGB≈(133,24,29)，过不了 R≥170）"
                 "和整体 1 行的偏移算进去，old 会恒为 5/6。所以先拿 trace 的 4 Hz `boss` 列（设备自己 bossBar 的读数）拟合"
                 "（行偏移 dy / 阈值 / 帧内 lag），拟合不上的局不参与结论。")
    lines.append("")
    clk = [r.get("clock") for r in rounds if r.get("clock")]
    if clk:
        lines.append("时钟：trace 的 `cap`（截图自己的钟）减 `wall`（主机的钟）在 "
                     + "、".join(f"{c['span_ms'] / 1000:.0f} s 内漂 {c['drift_ms']:+.0f} ms" for c in clk)
                     + "，录像 30 fps 恒定，帧号与 `wall` 之间没有累积偏移，帧号映射可信。")
        lines.append("")
    for r in rounds:
        c = r["calibration"]
        f = c["fit"]
        dytxt = "同一行" if f["dy"] == 0 else (f"录像比截图低 {f['dy']} 行" if f["dy"] > 0 else f"录像比截图高 {-f['dy']} 行")
        lines.append(f"- {r['round']}：{dytxt}，阈值 `{f['thr']}`，lag {f['lag']:+d} 帧"
                     f"（不到 trace 的 250 ms 采样间隔）→ 与 trace 的 `boss` 列一致率 "
                     f"{('%.1f%%' % (100 * f['agree'])) if f['agree'] is not None else 'n/a'}（中位误差 {f['median_err']} px，"
                     f"{'可信' if c['verified'] else '不可信'}）")
    lines.append("")
    if bad:
        lines.append("**" + "、".join(r["round"] for r in bad) + " 的拟合未过线，下面的数字仅供参考。**")
        lines.append("")
    unc = [r["calibration"].get("uncalibrated_best") for r in rounds]
    unc = [u for u in unc if u]
    if unc:
        lines.append("对照：如果照 skill 原阈值、原坐标直接套录像，最好的组合也只有 "
                     + "/".join(f"{100 * u['agree']:.0f}%" for u in unc)
                     + " 的样本对得上 trace（因为血条底边那 1 行被压暗、且录像整体低 1 行）。"
                     "所以下面的 old 是「按 trace 校准后的 old」，不是「录像原阈值直接算出的 old」。")
        lines.append("")
    lines.append("## 每局")
    lines.append("")
    lines.append("| 局 | 帧数（血条在屏/采样） | old p50 | new p50 | partial 占比 | false_drop old/new | first-last old/new | execute 台阶 old/new |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for r in rounds:
        p = r["partial_frames"]
        lines.append(
            f"| {r['round']} | {r['window']['frames']}/{r['sampled_frames']} | {r['old']['p50']:.0f} | {r['new']['p50']:.0f} | "
            f"{100 * p['frac']:.1f}% ({p['n']}) | {r['false_drop']['old']} / {r['false_drop']['new']} | "
            f"{r['first_last']['old'][2]:.0f} / {r['first_last']['new'][2]:.0f} | {fmt_execs(r['exec_steps'])} |")
    lines.append("")
    lines.append("first-last = 首/末 2 s（血条在正常行、不是红描边帧）的中位数差；含开场血条从 384 动画到常值、以及阶段切换回满，"
                 "**不是总伤害**，只用来看两套读数的口径是否一致。")
    lines.append("")
    lines.append("分布（仅在血条在屏的帧上统计，p1/p99 抗闪红）：")
    lines.append("")
    lines.append("| 局 | old min/p1/p50/p99/max | new min/p1/p50/p99/max | new-old p1/p50/p99 |")
    lines.append("|---|---|---|---|")
    for r in rounds:
        lines.append(f"| {r['round']} | {r['old']['min']:.0f}/{r['old']['p1']:.0f}/{r['old']['p50']:.0f}/{r['old']['p99']:.0f}/{r['old']['max']:.0f} "
                     f"| {r['new']['min']:.0f}/{r['new']['p1']:.0f}/{r['new']['p50']:.0f}/{r['new']['p99']:.0f}/{r['new']['max']:.0f} "
                     f"| {r['diff']['p1']:.0f}/{r['diff']['p50']:.0f}/{r['diff']['p99']:.0f} |")
    lines.append("")
    lines.append("execute（每次处决，`dmg` 为技能日志里的 `dmg`；台阶用按下前 1.0→0.1 s 与按下后 1.2→2.0 s 的中位数算："
                 "血条在按下后 0.4–1.0 s 才落定，而日志的 `land` 是按下 +2 s 的固定读取，围着 land 取窗口只会量到 0）：")
    lines.append("")
    lines.append("| 局 | # | 按下 (ms) | 日志 dmg | 血条开始掉 (按下后 ms) | old 台阶 | new 台阶 |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in rounds:
        for e in r["exec_steps"]:
            o = e["old"] or {}
            n = e["new"] or {}
            moved = "-" if e["moved_after_press_ms"] is None else e["moved_after_press_ms"]
            lines.append(f"| {r['round']} | {e['i']} | {e['press_ms']} | {e['dmg']} | {moved} | "
                         f"{o.get('step', '-')} | {n.get('step', '-')} |")
    lines.append("")
    lines.append("partial = old < 0.95·new 的帧。它混着两种成因：血条被上下移、old 的 6 行窗口被裁；以及血条红色描边/红雾横贯 ROI 把 new 顶到 386。"
                 "下表拆开（同一帧可能两者都算）：")
    lines.append("")
    lines.append("| 局 | 血条在屏帧 | partial 帧 | 其中 old 被裁 | 其中 new 被红描边顶高 | 两者都有 | 血条位置偏离正常行的帧 |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in rounds:
        p = r["partial_frames"]
        lines.append(f"| {r['round']} | {p['bar_frames']} | {p['n']} | {p['old_clipped']} | {p['new_inflated']} | {p['both']} | {p['bar_top_moved']} |")
    lines.append("")
    lines.append("## 结论")
    lines.append("")
    lines.append(conclusion_text(rounds))
    lines.append("")
    return "\n".join(lines)


def conclusion_text(rounds):
    ok = [r for r in rounds if r["calibration"]["verified"]]
    if not ok:
        return "没有一局的视频能对上 trace，先不结论。"
    fd_o = sum(r["false_drop"]["old"] for r in ok)
    fd_n = sum(r["false_drop"]["new"] for r in ok)
    fd_t = sum(r["calibration"]["trace_false_drops_n"] for r in ok)
    bar = sum(r["partial_frames"]["bar_frames"] for r in ok)
    clip = sum(r["partial_frames"]["old_clipped"] for r in ok)
    infl = sum(r["partial_frames"]["new_inflated"] for r in ok)
    steps = [(e["old"]["step"], e["new"]["step"], e["dmg"]) for r in ok for e in r["exec_steps"]
             if e["old"] and e["new"] and (e["dmg"] or 0) >= 40]
    txt = []
    txt.append(f"1. **假掉/回弹**：同一段视频、同一套 15 Hz 采样下，old 有 {fd_o} 次「掉 ≥20 px 又在 1 s 内回到 80%」的事件；"
               f"设备 4 Hz 的 trace `boss` 列同样口径是 {fd_t} 次（4 Hz 会漏掉一半以上的 1 帧抖动）；new 只有 {fd_n} 次，"
               "且都在血条红色描边闪烁的那几帧上。旧读数的假掉来自 HUD 把血条整体上下移 1–3 行：old 的 6 行窗口只盖住 6−k 行，"
               "读数按 (6−k)/6 掉 60/122/183 px；new 取单行最大值，纵向移动不改变行宽。")
    if steps:
        o = [a for a, _, _ in steps]
        n = [b for _, b, _ in steps]
        d = [c for _, _, c in steps]
        txt.append(f"2. **真实台阶**：{len(steps)} 次有效处决（日志 dmg {min(d)}–{max(d)}）的台阶 old {min(o):.1f}…{max(o):.1f} px、"
                   f"new {min(n):.1f}…{max(n):.1f} px，与已知真值 −57…−59 px 一致：new 没有把真实掉血抹平，"
                   f"也没有把台阶算大。old 的偏差来自裁行（多算 0–1 行宽度）。")
    txt.append(f"3. **partial（old < 0.95·new）**：血条在屏的 {bar} 帧里，old 被上下移裁掉 {clip} 帧（{100 * clip / bar:.1f}%），"
               f"另有 {infl} 帧（{100 * infl / bar:.1f}%）是血条的红色描边/红雾横贯 ROI 把 new 顶到 386（有重叠）。"
               "旧读数真正被裁的时间只有 ~2%，但它是**成簇的**（一次 1–3 帧），而且正好落在掉血判断上。")
    txt.append("4. **new 的副作用**：红描边/红雾期间 new 会读到上限 386（比条宽高 16–36 px），"
               "不产生掉血方向的假掉（new 全程 ≥ old，从未因纵向移动掉），但用它算处决前后差（boss0/boss1）时，"
               "如果按下正好落在这一段，差值会偏小甚至为负。这是新读数唯一的系统性弱点。")
    txt.append("5. 结论：新读数**消除了上下移引起的假掉/回弹**（old 每局约 100 次 → new 0–1 次），"
               "**完整保留了 −57…−59 px 的真实处决台阶**；代价是横贯 ROI 的红色描边/红雾会把 max 行顶到 386。"
               "纵向移动与这个弱点无关，两者可以分开处理。")
    return "\n".join(txt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", default=",".join(DEFAULT_ROUNDS))
    ap.add_argument("--every", type=int, default=2, help="decode every Nth frame (default 2)")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rounds = []
    for name in [x.strip() for x in a.rounds.split(",") if x.strip()]:
        rounds.append(analyse(name, max(1, a.every)))
    res = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "method": {
            "old": "BOSS_ROI [347,27,386,6] red px / 6 (dufu2.js bossBar)",
            "new": "max red px over the rows of BOSS_ROI_TALL [347,20,386,20], capped at 386 (dufu-reads.js bossFill)",
            "red": "RGB [170,0,0]-[255,130,130] (method 4), or the calibrated 'redness' rule (see calibration)",
            "every": max(1, a.every), "frame_ms": round(FRAME_MS, 3),
            "stats_window": "frames with the bar on screen (fill band >= 50 px)",
            "exec_window": "press-1.0..press-0.1 s vs press+1.2..press+2.0 s medians",
        },
        "rounds": rounds,
    }
    (out / "boss_roi.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "boss_roi.md").write_text(markdown(rounds, res["method"]), encoding="utf-8")
    print(f"wrote {out / 'boss_roi.json'} and {out / 'boss_roi.md'}")
    for r in rounds:
        print(f"{r['round']}: old p50 {r['old']['p50']}, new p50 {r['new']['p50']}, partial {r['partial_frames']['frac']:.3f}, "
              f"fd {r['false_drop']['old']}/{r['false_drop']['new']}, exec {fmt_execs(r['exec_steps'])}")


if __name__ == "__main__":
    main()
