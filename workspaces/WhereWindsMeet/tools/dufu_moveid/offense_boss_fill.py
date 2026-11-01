"""The offense boss-bar read (lib bossFill) replayed on the live videos: per-frame fill, then the real 2 s / 3 s damage
of every offense press. Offline only (no Pad, no skill changes).

    MOVEID_PHASE=1 uv run --no-project --with opencv-python-headless --with numpy python \
        workspaces/WhereWindsMeet/tools/dufu_moveid/offense_boss_fill.py [r205 r207 ...]

Out: data/moveid/offense/online/bossfill/<rec>.npz (fill int16, 30 fps) and bossfill.json / bossfill.md.
The old 6-row read is included per press for comparison (the trace `bossPx` of old rounds).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT, read_json, write_json  # noqa: E402

LIVE = OUT / "live"
ONLINE = OUT.parent / "offense" / "online"
STORE = ONLINE / "bossfill"
FRAME_MS = 1000 / 30
ROI = (347, 20, 386, 20)
RED_LO, RED_HI = np.array([170, 0, 0]), np.array([255, 130, 130])


def fill_frames(path: Path) -> np.ndarray:
    cap = cv2.VideoCapture(str(path))
    out = []
    while True:
        ok, img = cap.read()
        if not ok:
            break
        rgb = img[:, :, ::-1][ROI[1]:ROI[1] + ROI[3], ROI[0]:ROI[0] + ROI[2]]
        m = cv2.inRange(rgb, RED_LO, RED_HI)
        out.append(int((m > 0).sum(axis=1).max()))
    cap.release()
    return np.array(out, np.int16)


def envelope(fill: np.ndarray, win: int = 15) -> np.ndarray:
    """Max over a centred 0.5 s window, then a running minimum from the first full-bar sample.

    The bar never rises inside phase 1, but the HUD moves it 1-3 rows for a few frames (r199 47.07 s: a 365 bar reads
    241 for ~0.25 s) and a full-bar damage flash reads 386 for 1-2 frames (r205 272.9 s). The max filter removes both
    without touching a real step (it only delays it by <= win/2 frames); the running minimum removes the flash-up."""
    a = fill.astype(np.float64)
    if len(a) < win + 2:
        return fill.astype(np.int16)
    pad = win // 2
    p = np.pad(a, (pad, pad), mode="edge")
    mx = np.array([p[i:i + win].max() for i in range(len(a))])
    out = mx.copy()
    nz = np.where(mx > 50)[0]
    if not len(nz):
        return out.astype(np.int16)
    head = mx[:min(len(mx), nz[0] + 300)]
    ref = float(np.max(head)) if len(head) else 0.0
    start = int(np.argmax(mx >= 0.95 * ref)) if ref > 0 else 0
    out[start:] = np.minimum.accumulate(mx[start:])
    out[:start] = 0
    return out.astype(np.int16)


def round_fill(d: Path) -> tuple[np.ndarray, dict] | None:
    rid = (d / "rec.txt").read_text(encoding="utf-8").strip()
    video = LIVE / "video" / f"{rid}.mp4"
    meta = read_json(LIVE / "meta" / f"{rid}.json")
    if not video.exists() or not meta:
        return None
    STORE.mkdir(parents=True, exist_ok=True)
    npz = STORE / f"{rid}.npz"
    if npz.exists():
        z = np.load(npz)
        if "raw" in z.files:
            return envelope(z["raw"]), meta
        fill = fill_frames(video)
    else:
        fill = fill_frames(video)
    np.savez_compressed(npz, raw=fill, fill=envelope(fill), fps=30)
    return envelope(fill), meta


def false_drops(s: np.ndarray, win: int = 4) -> int:
    """A >=20 px drop that recovers to within 20% AFTER its trough within one second (4 samples at 4 Hz): a HUD shift,
    not damage. A monotone damage series never recovers, so it scores 0."""
    n = 0
    for i in range(len(s) - win):
        w = s[i + 1:i + 1 + win]
        j = int(np.argmin(w))
        d = float(s[i] - w[j])
        after = w[j + 1:]
        if d >= 20 and len(after) and float(after.max()) >= s[i] - 0.2 * d:
            n += 1
    return n


def round_damage(d: Path) -> dict | None:
    got = round_fill(d)
    if got is None:
        return None
    fill, meta = got
    res = (read_json(d / "result.json", {}) or {}).get("value") or {}
    trace = read_json(d / "trace.json", [])
    cols = trace[0]["cols"] if trace else []
    old = new4 = None
    if trace and "boss" in cols:
        jb, jw = cols.index("boss"), cols.index("wall")
        rows_ = [r for c in sorted(trace, key=lambda c: c["chunk"]) for r in c["rows"]]
        old = np.array([r[jb] for r in rows_], np.float64)
        wall = np.array([r[jw] for r in rows_], np.float64)
        fi = np.clip(((res.get("start", meta["started"]) - meta["started"] + wall) / FRAME_MS).astype(int),
                     0, len(fill) - 1)
        new4 = fill[fi].astype(np.float64)
    log = (res.get("offense") or {}).get("log") or []
    presses = [(int(e["t"]), str(e.get("a"))) for e in log if e.get("ev") == "press" and e.get("a") != "switch"]
    rows = []
    for t, a in presses:
        f = int(round((res["start"] - meta["started"] + t) / FRAME_MS))
        if f < 0 or f + 90 >= len(fill):
            continue
        # another press inside the 2 s / 3 s window: the drop cannot be attributed
        other2 = any(0 < t2 - t <= 2000 for t2, _ in presses)
        other3 = any(0 < t2 - t <= 3000 for t2, _ in presses)
        other1 = any(0 < t2 - t <= 1000 for t2, _ in presses)
        b0 = int(fill[f])
        b1 = int(fill[f + 60])
        b1s = int(fill[f + 30])
        lo = int(fill[f:f + 90].min())
        lo25 = int(fill[f + 10:f + 75].min())
        rows.append({"t": t, "a": a, "f": f, "b0": b0, "b2": b1, "b3": lo,
                     "dmgx": None if b0 <= 50 or lo25 <= 50 else max(0, b0 - lo25),
                     "dmg1": None if other1 or b0 <= 50 or b1s <= 50 else max(0, b0 - b1s),
                     "dmg2": None if other2 or b0 <= 50 or b1 <= 50 else max(0, b0 - b1),
                     "dmg3": None if other3 or b0 <= 50 or lo <= 50 else max(0, b0 - lo)})
    # the offense log's own land rows (old ROI) for the same presses
    lands = {(int(e["at"]) if e.get("at") is not None else -1): e.get("dmg") for e in log if e.get("ev") == "land"}
    for r in rows:
        r["old"] = lands.get(r["t"])
    nz = fill[fill > 50]
    b_first = int(nz[0]) if len(nz) else 0
    b_last = int(nz[-1]) if len(nz) else 0
    return {"round": d.name, "rec": str(meta.get("id")), "frames": int(len(fill)),
            "b_first": b_first, "b_last": b_last, "total": b_first - b_last,
            "old_false": false_drops(old) if old is not None and len(old) > 5 else None,
            "new_false": false_drops(new4), "presses": rows}


def main() -> None:
    names = sys.argv[1:]
    dirs = [LIVE / n for n in names] if names else sorted(p for p in LIVE.glob("r[0-9][0-9][0-9]") if int(p.name[1:]) >= 185)
    out = []
    for d in dirs:
        if not (d / "result.json").exists() or not (d / "rec.txt").exists():
            continue
        args = read_json(d / "args.json", {}) or {}
        if args.get("offense", "off") == "off" and not names:
            continue
        r = round_damage(d)
        if not r:
            continue
        out.append(r)
        print(f"{d.name} {args.get('offense')} frames {r['frames']} presses {len(r['presses'])}", flush=True)
    ONLINE.mkdir(parents=True, exist_ok=True)
    prev = read_json(ONLINE / "bossfill.json", {}) or {}
    merged = {x["round"]: x for x in prev.get("rounds", [])}
    for x in out:
        merged[x["round"]] = x
    out = [merged[k] for k in sorted(merged)]
    write_json(ONLINE / "bossfill.json", {"rounds": out})
    # summary: per action dmg2 / dmg3 (only attributable) and old-ROI land dmg
    lines = ["# 进攻按键真实伤害（bossFill 重放）", "",
             "dmg2 = 按键后 2 s 的血条下降（窗口内没有其它按键、两端血条可读）；dmg3 = 3 s 内最大下降；execute 用 dmgx（0.3–2.5 s 内最大下降，不受后续按键影响）。", "",
             "| 局 | 首 | 末 | 总伤害 | 按键 | 假掉 old/new |", "|---|---:|---:|---:|---:|---:|"]
    for x in out:
        lines.append(f"| {x['round']} | {x['b_first']} | {x['b_last']} | {x['total']} | {len(x['presses'])} | {x['old_false']}/{x['new_false']} |")
    lines += ["", "| 动作 | n | dmg2 中位 | dmg2 合计 | dmg3 中位 | dmg3 合计 | 0 伤占比 |", "|---|---:|---:|---:|---:|---:|---:|"]
    allrows = [r for x in out for r in x["presses"]]
    for a in ("execute", "qishu", "light", "follow", "charge"):
        key = "dmgx" if a == "execute" else "dmg2"
        v2 = [r[key] for r in allrows if r["a"] == a and r[key] is not None]
        v3 = [r["dmg3"] for r in allrows if r["a"] == a and r["dmg3"] is not None]
        if not v2 and not v3:
            continue
        zero = sum(1 for x in v2 if x <= 1) / len(v2) if v2 else None
        lines.append(f"| {a} | {len(v2)} | {np.median(v2) if v2 else 0:.1f} | {sum(v2):.0f} | "
                     f"{np.median(v3) if v3 else 0:.1f} | {sum(v3):.0f} | {'-' if zero is None else f'{zero:.0%}'} |")
    (ONLINE / "bossfill.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
