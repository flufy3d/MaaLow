"""infer()'s screenshot preprocessing (android/app/src/main/cpp/nn_prep.h) against cv2.resize, bit for bit.

The header is compiled for the PC with g++ (tests/nn_prep_check.cpp) and run on synthetic images and, when the
local data is there, real Pad screenshots / recording frames. Area downscaling must equal cv2 INTER_AREA exactly
(non-integer scales: resizeArea; integer ones: resizeAreaFast), which is what the PC training views use
(workspaces/WhereWindsMeet/tools/dufu_moveid/s2_views.py). Linear / nearest keep the old code.

Needs g++ and the cv extra:  uv run --extra cv pytest tests/test_nn_prep.py   (skipped otherwise)
"""
from __future__ import annotations

import random
import shutil
import subprocess
from pathlib import Path

import pytest

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

ROOT = Path(__file__).resolve().parents[1]
H, W = 720, 1080

# the three 独夫 views (s2_views.boxes(), resize area, bgr)
DUFU = [(0, 0, 1080, 720, 384, 240, 2, 0), (290, 55, 530, 530, 192, 192, 2, 0), (425, 190, 260, 260, 192, 192, 2, 0)]


@pytest.fixture(scope="module")
def exe(tmp_path_factory) -> Path:
    gxx = shutil.which("g++")
    if not gxx:
        pytest.skip("no g++")
    out = tmp_path_factory.mktemp("nn_prep") / "nn_prep_check"
    # no FMA contraction on the PC either: the device build keeps the area path's multiplies and adds apart (pragma)
    subprocess.run([gxx, "-O2", "-std=c++20", "-ffp-contract=off", "-static", "-o", str(out), str(ROOT / "tests/nn_prep_check.cpp")],
                   check=True)
    return out


def frames() -> np.ndarray:
    rng = np.random.default_rng(0)
    out = [
        rng.integers(0, 256, (H, W, 3), dtype=np.uint8),  # noise: many exact .5 sums at integer scales
        np.broadcast_to(np.arange(W, dtype=np.uint8)[None, :, None], (H, W, 3)).copy(),
        np.broadcast_to((np.arange(H) * 7 % 256).astype(np.uint8)[:, None, None], (H, W, 3)).copy(),
        np.full((H, W, 3), 255, np.uint8),
        (rng.integers(0, 2, (H, W, 3)) * 255).astype(np.uint8),
    ]
    pngs = sorted(ROOT.glob("data/moveid/student/pad/*/png/*.png"))
    out += [cv2.imread(str(p), cv2.IMREAD_COLOR) for p in pngs[:: max(1, len(pngs) // 8)][:8]]
    vids = sorted(ROOT.glob("data/moveid/video/*.mp4"))[:4]
    for v in vids:
        c = cv2.VideoCapture(str(v))
        c.set(cv2.CAP_PROP_POS_FRAMES, int(c.get(cv2.CAP_PROP_FRAME_COUNT)) // 2)
        ok, f = c.read()
        if ok and f.shape == (H, W, 3):
            out.append(f)
    return np.stack(out)


def specs() -> list[tuple]:
    rnd = random.Random(7)
    out = list(DUFU)
    for _ in range(25):  # any downscale
        rw, rh = rnd.randint(1, W), rnd.randint(1, H)
        out.append((rnd.randint(0, W - rw), rnd.randint(0, H - rh), rw, rh, rnd.randint(1, rw), rnd.randint(1, rh), rnd.choice([1, 2]), 0))
    for _ in range(15):  # integer scales per axis (resizeAreaFast when cv::resize's scale is within DBL_EPSILON)
        kx, ky = rnd.randint(1, 6), rnd.randint(1, 6)
        ow, oh = rnd.randint(1, W // kx), rnd.randint(1, H // ky)
        out.append((rnd.randint(0, W - ow * kx), rnd.randint(0, H - oh * ky), ow * kx, oh * ky, ow, oh, rnd.choice([1, 2]), 0))
    for kx, ky in [(2, 2), (3, 3), (4, 4), (2, 3), (1, 2), (5, 5), (1, 1)]:
        out.append((0, 0, W // kx * kx, H // ky * ky, W // kx, H // ky, 2, 0))
    return out


def run(exe: Path, tmp: Path, fr: np.ndarray, sp: list[tuple], impl: str) -> list[list[np.ndarray]]:
    fr.tofile(tmp / "frames.raw")
    (tmp / "specs.txt").write_text("".join(" ".join(map(str, s)) + "\n" for s in sp))
    subprocess.run([str(exe), "run", str(tmp / "frames.raw"), str(H), str(W), str(len(fr)), str(tmp / "specs.txt"), impl,
                    str(tmp / "out.raw")], check=True)
    data = np.fromfile(tmp / "out.raw", np.uint8)
    res, at = [], 0
    for _ in range(len(fr)):
        row = []
        for s in sp:
            ch = 1 if s[6] == 0 else 3
            n = s[4] * s[5] * ch
            row.append(data[at:at + n].reshape(s[5], s[4], ch))
            at += n
        res.append(row)
    assert at == data.size
    return res


def cv_ref(img: np.ndarray, s: tuple) -> np.ndarray:
    x, y, w, h, ow, oh, color, _ = s
    r = cv2.resize(img[y:y + h, x:x + w], (ow, oh), interpolation=cv2.INTER_AREA)
    return np.ascontiguousarray(r[..., ::-1]) if color == 1 else r


def test_area_matches_cv2(exe, tmp_path):
    fr, sp = frames(), specs()
    res = run(exe, tmp_path, fr, sp, "new")
    bad = []
    for j, s in enumerate(sp):
        n = sum(int(np.count_nonzero(res[i][j] != cv_ref(fr[i], s))) for i in range(len(fr)))
        if n:
            bad.append((s, n))
    assert not bad, bad


def test_other_paths_unchanged(exe, tmp_path):
    """Linear, nearest, area upscaling and gray: the same bytes as the code infer() had before nn_prep.h."""
    fr = frames()[:4]
    sp = [(0, 0, 1080, 720, 384, 240, 2, 1), (290, 55, 530, 530, 192, 192, 1, 2), (425, 190, 260, 260, 300, 300, 2, 0),
          (10, 10, 100, 50, 64, 64, 2, 0), (0, 0, 1080, 720, 384, 240, 0, 1), (0, 0, 1080, 720, 384, 240, 0, 0)]
    new, old = run(exe, tmp_path, fr, sp, "new"), run(exe, tmp_path, fr, sp, "old_plain")
    gray_area = len(sp) - 1  # gray goes through the new area path; its BGR -> gray step is the old one
    for i in range(len(fr)):
        for j in range(len(sp)):
            if j == gray_area:
                bgr = run(exe, tmp_path, fr[i:i + 1], [sp[j][:6] + (2, 0)], "new")[0][0]
                g = bgr.astype(np.int64)
                want = ((g[..., 0] * 1868 + g[..., 1] * 9617 + g[..., 2] * 4899 + (1 << 13)) >> 14).astype(np.uint8)
                assert np.array_equal(new[i][j][..., 0], want)
            else:
                assert np.array_equal(new[i][j], old[i][j]), sp[j]
