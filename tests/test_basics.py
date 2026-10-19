import json
from pathlib import Path

from maalow.cli import main
from maalow.skills import names as skill_names
from maalow.workspace import Workspace


def test_workspace_create(tmp_path):
    ws = Workspace.create(tmp_path, "demo")
    assert (ws.path / "pipeline").is_dir()
    assert json.loads((ws.path / "workspace.json").read_text())["name"] == "demo"
    assert Workspace.list(tmp_path) == ["demo"]


def test_skills_registered():
    assert "ClosePopup" in skill_names()


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


def test_import_zip_skips_generated_files(tmp_path, monkeypatch):
    import zipfile

    from maalow.client import Client

    ws = Workspace.create(tmp_path, "demo")
    (ws.path / "teaching" / "t").mkdir()
    for name in ("0001.png", "0001.grid.png", "0001.marks.png", "download.part"):
        (ws.path / "teaching" / "t" / name).write_bytes(b"x")
    sent = {}

    def upload(self, method, path, file, ctype="", timeout=0):
        sent["path"], sent["names"] = path, sorted(zipfile.ZipFile(file).namelist())
        return {"files": len(sent["names"])}

    monkeypatch.setattr(Client, "upload", upload)
    Client("http://x", "t").import_dir("demo", ws.path, "replace")
    assert sent["path"] == "/workspaces/demo/import?mode=replace"
    assert sent["names"] == ["teaching/t/0001.png", "workspace.json"]


def test_do_fetches_screenshot_with_grid(tmp_path, monkeypatch):
    from PIL import Image

    from maalow import client
    from maalow.views import with_views

    ws = Workspace.create(tmp_path, "demo")

    def download(self, path, dest, timeout=0):
        assert path == "/files/demo/teaching/t/0001.png"
        dest.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (300, 200)).save(dest)
        return dest

    monkeypatch.setattr(client.Client, "download", download)
    out = with_views(client.Client("http://x", "t"), tmp_path, {"workspace": "demo", "screenshot": "teaching/t/0001.png"})
    assert Path(out["image"]) == (ws.path / "teaching/t/0001.png").resolve()
    grid = Image.open(out["view"])
    assert grid.size == (300, 200) and grid.getpixel((100, 50)) == (255, 0, 255)  # grid line at x=100


def test_cli_do_network_error_is_json(monkeypatch, capsys):
    from maalow import cli

    class App:
        def __init__(self, *a):
            pass

        def get(self, path, timeout=120):
            raise OSError("connection refused")

    monkeypatch.setattr(cli, "Client", App)
    assert main(["do", "state"]) == 1
    assert json.loads(capsys.readouterr().out) == {"error": "OSError: connection refused"}


def test_cli_do_skill_posts_run_and_fails_on_skill_error(tmp_path, monkeypatch, capsys):
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


def test_listen_expands_attachments(tmp_path, monkeypatch):
    from PIL import Image

    from maalow import client, rec
    from maalow.views import with_views

    Workspace.create(tmp_path, "demo")

    def download(self, path, dest, timeout=0):
        dest.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (300, 200)).save(dest)
        return dest

    monkeypatch.setattr(client.Client, "download", download)
    monkeypatch.setattr(rec, "labels", lambda c, ws, rid: {"recording": {"name": "boss", "frames": 900, "fps": 30},
                                                           "frames": [{"frame": 12, "time_ms": 400, "note": "red", "text": ["1号框选"], "annotations": []}]})
    monkeypatch.setattr(rec, "frame", lambda c, ws, rid, n: {"view": f"frame-{n}.grid.png"})
    msg = {"workspace": "demo", "role": "teacher", "text": "", "attachments": [
        {"type": "shot", "file": "teaching/t/0001.png", "annotations": [{"kind": "rect", "coords": [150, 20, 50, 40], "label": ""}]},
        {"type": "recording", "rec": "r1", "focus": {"from": 12, "to": 12}},
        {"type": "recording", "rec": "r2"},
    ]}
    shot, focused, plain = with_views(client.Client("http://x", "t"), tmp_path, [msg])[0]["attachments"]
    view = Image.open(shot["view"])
    assert shot["view"].endswith(".marks.png") and view.getpixel((175, 20)) == (255, 77, 79)  # the box's top edge
    assert shot["marks"] == ["1号框选 x=150 y=20 w=50 h=40"]
    assert focused["frames"] == 900 and focused["labels"] == [{"frame": 12, "time_ms": 400, "note": "red", "text": ["1号框选"]}]
    assert focused["view"] == "frame-12.grid.png" and "view" not in plain


def test_say_posts_attachments(monkeypatch, capsys):
    from maalow import cli

    posts = []

    class App:
        def __init__(self, *a):
            pass

        def post(self, path, body=None, timeout=120):
            posts.append((path, body))
            return {"id": 3}

    monkeypatch.setattr(cli, "Client", App)
    assert main(["do", "say", "这个？", "--attach", '{"type":"shot","file":"now"}',
                 "--attach", '{"type":"recording","rec":"r1","focus":{"from":5,"to":5}}']) == 0
    assert posts == [("/say", {"text": "这个？", "attachments": [
        {"type": "shot", "file": "now"}, {"type": "recording", "rec": "r1", "focus": {"from": 5, "to": 5}}]})]


def test_say_rejects_a_screenshot_outside_the_workspace(tmp_path, monkeypatch, capsys):
    from maalow import cli

    class App:
        def __init__(self, *a):
            pass

        def get(self, path, timeout=120):
            return {"workspace": "demo"}

    monkeypatch.setattr(cli, "Client", App)
    outside = tmp_path / "elsewhere.png"
    outside.write_bytes(b"x")
    assert main(["--root", str(tmp_path / "workspaces"), "do", "say", "look",
                 "--attach", json.dumps({"type": "shot", "file": str(outside)})]) == 1
    assert "outside workspace" in json.loads(capsys.readouterr().out)["error"]
