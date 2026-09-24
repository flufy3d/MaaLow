from maalow.cli import main
from maalow.memory import MemoryStore
from maalow.recorder import Recorder
from maalow.skills import registry
from maalow.teaching import Annotation, AnnotationKind, TeachingSession, TeachingStep
from maalow.workspace import Workspace


def test_workspace_create_and_open(tmp_path):
    ws = Workspace.create(tmp_path, "demo")
    assert (ws.path / "pipeline").is_dir()
    assert Workspace.open(ws.path).config.name == "demo"
    assert Workspace.list(tmp_path) == ["demo"]


def test_recorder_roundtrip(tmp_path):
    ws = Workspace.create(tmp_path, "demo")
    session = TeachingSession(task="daily")
    session.add(TeachingStep("s1.png", "点击领取", [Annotation(AnnotationKind.RECT, [1, 2, 3, 4])]))
    rec = Recorder(ws)
    rec.save(session)
    assert rec.load("daily") == session


def test_memory(tmp_path):
    ws = Workspace.create(tmp_path, "demo")
    MemoryStore(ws).set("k", 1)
    assert MemoryStore(ws).get("k") == 1


def test_skills_registered():
    assert "ClosePopup" in registry.names()


def test_cli(tmp_path, capsys):
    assert main(["--root", str(tmp_path), "init", "demo"]) == 0
    main(["--root", str(tmp_path), "list"])
    assert "demo" in capsys.readouterr().out


def test_teaching_server_records_steps(tmp_path):
    import numpy as np

    from maalow.teaching.server import TeachingServer

    class FakeDevice:
        def __init__(self):
            self.clicks = []

        def screenshot(self):
            return np.zeros((72, 108, 3), dtype=np.uint8)

        def click(self, x, y):
            self.clicks.append((x, y))

    ws = Workspace.create(tmp_path, "demo")
    dev = FakeDevice()
    server = TeachingServer(ws, dev, "daily")
    out = server.act({"type": "click", "x": 5, "y": 6}, say="点击领取", wait_ms=0)
    assert dev.clicks == [(5, 6)]
    assert out["size"] == [108, 72]
    session = Recorder(ws).load("daily")
    assert session.steps[0].instruction == "点击领取"
    assert session.steps[0].screenshot == "teaching/daily/0001.png"
    assert session.steps[0].after == "teaching/daily/0002.png"


def test_teacher_annotations_go_on_next_step(tmp_path):
    import numpy as np

    from maalow.teaching.server import TeachingServer

    class FakeDevice:
        def screenshot(self):
            return np.zeros((72, 108, 3), dtype=np.uint8)

        def click(self, x, y):
            pass

    ws = Workspace.create(tmp_path, "demo")
    server = TeachingServer(ws, FakeDevice(), "daily")
    server.teach("点 1 号", [{"kind": "rect", "coords": [1, 2, 30, 40], "label": "1号框选"}])
    assert [m["text"] for m in server.listen(0)] == ["点 1 号"]
    assert server.listen(0) == []
    server.act({"type": "click", "x": 16, "y": 22}, wait_ms=0)
    step = Recorder(ws).load("daily").steps[0]
    assert step.instruction == "点 1 号"
    assert step.annotations == [Annotation(AnnotationKind.RECT, [1, 2, 30, 40], "1号框选")]
    assert len(TeachingServer(ws, FakeDevice(), "daily").since(0)) == 1  # chat survives restart


def test_guard_fires_on_captured_frame(tmp_path):
    import json
    import time

    import numpy as np
    from PIL import Image

    from maalow.device.replay import ImageController
    from maalow.teaching.server import TeachingServer

    rng = np.random.default_rng(0)
    screen = rng.integers(0, 255, (720, 1080, 3), dtype=np.uint8)
    ws = Workspace.create(tmp_path, "demo")
    Image.fromarray(screen[100:140, 200:260, ::-1]).save(ws.dir("templates") / "x.png")
    (ws.dir("pipeline") / "p.json").write_text(
        json.dumps({"ClosePopup": {"recognition": "TemplateMatch", "template": "x.png", "action": "Click"}})
    )
    ws.config.guards = ["ClosePopup"]
    ws.save()

    class Device:
        ctrl = ImageController(screen)

        def screenshot(self):
            return screen

    Device.ctrl.post_connection().wait()
    server = TeachingServer(ws, Device(), "daily")
    server.shot()
    for _ in range(100):
        if Device.ctrl.clicks:
            break
        time.sleep(0.05)
    x, y = Device.ctrl.clicks[0]
    assert 200 <= x < 260 and 100 <= y < 140


def test_waiting_until_ai_replies(tmp_path):
    from maalow.teaching.server import TeachingServer

    server = TeachingServer(Workspace.create(tmp_path, "demo"), object(), "daily")
    assert not server.state()["waiting"]
    server.teach("点签到", [])
    assert server.state()["waiting"]
    server.say("[自动] 规则 X 已触发", auto=True)
    assert server.state()["waiting"]  # guard notices are not an answer
    server.say("已签到")
    assert not server.state()["waiting"]
