from pathlib import Path

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






def test_client_config_precedence(tmp_path, monkeypatch):
    from maalow import client

    cfg = tmp_path / "config.toml"
    cfg.write_text('server = "http://tablet:8765"\ntoken = "from-file"\n', encoding="utf-8")
    monkeypatch.setattr(client, "CONFIG", cfg)
    monkeypatch.delenv("MAALOW_SERVER", raising=False)
    monkeypatch.setenv("MAALOW_TOKEN", "from-env")
    c = client.Client()
    assert (c.server, c.token) == ("http://tablet:8765", "from-env")
    assert client.Client("http://other:1/", "arg").server == "http://other:1"



def test_import_zip_skips_grids(tmp_path, monkeypatch):
    import zipfile

    from maalow.client import Client

    ws = Workspace.create(tmp_path, "demo")
    (ws.dir("teaching") / "t").mkdir()
    for name in ("0001.png", "0001.grid.png"):
        (ws.dir("teaching") / "t" / name).write_bytes(b"x")
    sent = {}

    def upload(self, method, path, file, ctype="", timeout=0):
        sent["path"], sent["names"] = path, sorted(zipfile.ZipFile(file).namelist())
        return {"files": len(sent["names"])}

    monkeypatch.setattr(Client, "upload", upload)
    Client("http://x", "t").import_dir("demo", ws.path, "replace")
    assert sent["path"] == "/workspaces/demo/import?mode=replace"
    assert sent["names"] == ["teaching/t/0001.png", "workspace.json"]


def test_workspace_ignores_retired_keys(tmp_path):
    ws = Workspace.create(tmp_path, "demo")
    (ws.path / "workspace.json").write_text(
        '{"name": "demo", "controller": "adb", "target": "1.2.3.4:5555", "package": "p"}', encoding="utf-8"
    )
    assert Workspace.open(ws.path).config.package == "p"


def test_do_fetches_screenshot_with_grid(tmp_path, monkeypatch):
    from PIL import Image

    from maalow import client
    from maalow.cli import _with_views

    ws = Workspace.create(tmp_path, "demo")

    def download(self, path, dest, timeout=0):
        assert path == "/files/demo/teaching/t/0001.png"
        dest.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (300, 200)).save(dest)
        return dest

    monkeypatch.setattr(client.Client, "download", download)
    out = _with_views(client.Client("http://x", "t"), tmp_path, {"workspace": "demo", "screenshot": "teaching/t/0001.png"})
    assert Path(out["image"]) == (ws.path / "teaching/t/0001.png").resolve()
    grid = Image.open(out["view"])
    assert grid.size == (300, 200) and grid.getpixel((100, 50)) == (255, 0, 255)  # grid line at x=100


def test_do_skill_posts_run_and_fails_on_skill_error(tmp_path, monkeypatch, capsys):
    import json

    from maalow import cli

    posts = []

    class App:
        def __init__(self, *a):
            pass

        def post(self, path, body=None, timeout=120):
            posts.append((path, body, timeout))
            return {"skill": body["name"], "ok": False, "reason": "error", "error": {"file": "skills/x.js", "line": 3}}

    monkeypatch.setattr(cli, "Client", App)
    assert main(["do", "skill", "x", "--args", '{"n": 2}', "--timeout", "5000"]) == 1
    assert posts == [("/skill/run", {"name": "x", "args": {"n": 2}, "wait": True, "timeout": 5000}, 65.0)]
    assert json.loads(capsys.readouterr().out)["error"]["line"] == 3
