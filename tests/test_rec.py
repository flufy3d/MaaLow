from maalow import rec, sync
from maalow.sync import Filter


class FakeClient:
    def __init__(self, routes):
        self.routes = routes

    def get(self, path, timeout=120):
        return self.routes[path]


META = {"id": "20260925-101500", "name": "boss", "note": "", "state": "ready", "frames": 900, "duration_ms": 30000,
        "fps": 30, "width": 1080, "height": 720}


def test_labels_digest():
    base = "/recordings/WWM/20260925-101500"
    labels = {"version": 3, "fps": 30, "frames": {
        "120": {"rev": 2, "note": "red flash: dodge", "annotations": [
            {"kind": "rect", "coords": [500, 200, 80, 60], "label": "red glow"},
            {"kind": "click", "coords": [1018, 490], "label": "dodge"}]},
        "15": {"rev": 1, "note": "", "annotations": [{"kind": "arrow", "coords": [1, 2, 3, 4], "label": ""}]},
    }}
    out = rec.labels(FakeClient({base: META, f"{base}/labels": labels}), "WWM", "20260925-101500")
    assert out["labeled_frames"] == 2
    assert [f["frame"] for f in out["frames"]] == [15, 120]  # numeric order
    f = out["frames"][1]
    assert f["time_ms"] == 4000 and f["note"] == "red flash: dodge"
    assert f["annotations"][1] == {"n": 2, "kind": "click", "coords": [1018, 490], "label": "dodge"}
    assert f["text"] == ["1号框选 x=500 y=200 w=80 h=60：red glow", "2号点击点 (1018, 490)：dodge"]
    assert out["frames"][0]["text"] == ["1号箭头 (1, 2) → (3, 4)"]
    assert out["recording"]["frames"] == 900


def test_resolve():
    recs = [{"id": "20260925-101500", "state": "recording"}, {"id": "20260925-091500", "state": "ready"},
            {"id": "20260924-231500", "state": "ready"}]
    c = FakeClient({"/recordings?workspace=WWM": recs})
    assert rec.resolve(c, "WWM", "latest") == "20260925-091500"  # the newest finished one
    assert rec.resolve(c, "WWM", "20260924") == "20260924-231500"
    try:
        rec.resolve(c, "WWM", "20260925")
        assert False
    except RuntimeError as e:
        assert "ambiguous" in str(e)


def test_sync_leaves_out_videos_by_default():
    keep = Filter([sync.SCREENSHOTS, *sync.VIDEOS])
    assert not keep("recordings/20260925-101500/video.mp4")
    assert not keep("recordings/20260925-101500/thumbs/000.jpg")
    assert keep("recordings/20260925-101500/labels.json")
    assert keep("recordings/20260925-101500/meta.json")
    assert not keep("recordings/20260925-101500/.stream.h264")  # the app's in-progress files
