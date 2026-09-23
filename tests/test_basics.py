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
