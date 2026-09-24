import hashlib
import io
import json
import urllib.error
import zipfile

import pytest

from maalow import sync
from maalow.sync import Filter, plan


def tree(**files):
    """A fake file tree: tree(a="x") -> {"a": {"sha256": "x", ...}}."""
    return {k: {"sha256": v, "size": 1, "mtime": 0} for k, v in files.items()}


def test_plan_first_sync_never_deletes():
    p = plan(tree(a="1", same="s", both="L"), tree(b="2", same="s", both="R"), {})
    assert (p.push, p.pull, p.delete_local, p.delete_remote) == (["a"], ["b"], [], [])
    assert p.conflicts == [{"path": "both", "local": "added", "remote": "added"}]
    assert p.unchanged == 1


def test_plan_first_sync_prefer_overwrites_but_still_no_deletes():
    p = plan(tree(a="1", both="L"), tree(b="2", both="R"), {}, prefer="remote")
    assert (p.push, p.pull, p.delete_local, p.delete_remote) == (["a"], ["b", "both"], [], [])


def test_plan_modified_and_added():
    base = {"lmod": "0", "rmod": "0", "same": "0"}
    p = plan(tree(lmod="1", rmod="0", same="0", new="n"), tree(lmod="0", rmod="2", same="0", rnew="m"), base)
    assert p.push == ["lmod", "new"]
    assert p.pull == ["rmod", "rnew"]
    assert p.conflicts == [] and p.unchanged == 1
    assert p.settled == {"lmod": "1", "new": "n", "rmod": "2", "rnew": "m", "same": "0"}


def test_plan_deletes_follow_baseline():
    base = {"ldel": "0", "rdel": "0", "gone": "0"}
    p = plan(tree(rdel="0"), tree(ldel="0"), base)
    assert p.delete_remote == ["ldel"]
    assert p.delete_local == ["rdel"]
    assert p.settled == {"ldel": None, "rdel": None, "gone": None}  # gone from both: dropped from the baseline


def test_plan_conflicts():
    base = {"both": "0", "delmod": "0", "moddel": "0"}
    p = plan(tree(both="1", moddel="1"), tree(both="2", delmod="2"), base)
    assert p.conflicts == [
        {"path": "both", "local": "modified", "remote": "modified"},
        {"path": "delmod", "local": "deleted", "remote": "modified"},
        {"path": "moddel", "local": "modified", "remote": "deleted"},
    ]
    assert p.actions() == 0 and "both" not in p.settled
    p = plan(tree(both="1", moddel="1"), tree(both="2", delmod="2"), base, prefer="local")
    assert (p.push, p.delete_remote) == (["both", "moddel"], ["delmod"])
    p = plan(tree(both="1", moddel="1"), tree(both="2", delmod="2"), base, prefer="remote")
    assert (p.pull, p.delete_local) == (["both", "delmod"], ["moddel"])


def test_plan_one_direction_skips_the_other_and_keeps_its_baseline():
    base = {"l": "0", "r": "0"}
    p = plan(tree(l="1", r="0"), tree(l="0", r="2"), base, direction="push")
    assert (p.push, p.pull, p.skipped) == (["l"], [], ["r"])
    assert "r" not in p.settled
    p = plan(tree(l="1", r="0"), tree(l="0", r="2"), base, direction="pull")
    assert (p.push, p.pull, p.skipped) == ([], ["r"], ["l"])


def test_filter():
    keep = Filter([sync.SCREENSHOTS, "memory"])
    assert keep("pipeline/main.json")
    assert keep("teaching/explore/steps.jsonl")
    assert not keep("teaching/explore/0001.png")
    assert not keep("teaching/0001.png")
    assert not keep("memory/k.json")
    assert not keep("templates/a.grid.png")
    assert not keep("pipeline/.main.json.tmp")
    assert keep("templates/menu.png")
    only = Filter(only=["pipeline", "workspace.json"])
    assert only("pipeline/a.json") and only("workspace.json") and not only("pipeline2/a.json")
    assert Filter(["*.bak"])("a/b.bak") is False


# ---- whole sync against an in-memory app


class FakeApp:
    """Just enough of the companion app's file API for sync()."""

    server = "http://tablet:8765"

    def __init__(self):
        self.files: dict[str, tuple[bytes, int]] = {}  # path -> (content, mtime)
        self.requests: list[str] = []
        self.types: bytes | None = None  # maalow.d.ts; None: an app without skills

    def entry(self, path):
        data, mtime = self.files[path]
        return {"path": path, "size": len(data), "mtime": mtime, "sha256": hashlib.sha256(data).hexdigest()}

    def get(self, path, timeout=120):
        self.requests.append("tree")
        if "workspace.json" not in self.files:
            return {"error": "IllegalStateException: no workspace: demo"}
        return [self.entry(p) for p in sorted(self.files)]

    def upload(self, method, path, file, ctype="", timeout=600):
        self.requests.append("batch")
        with zipfile.ZipFile(file) as z:
            manifest = json.loads(z.read(sync.BATCH))
            written = [n for n in z.namelist() if n != sync.BATCH]
            for n in written:
                self.files[n] = (z.read(n), manifest["mtime"][n])
        for p in manifest["delete"]:
            self.files.pop(p, None)
        return {"files": [self.entry(n) for n in written], "deleted": manifest["delete"]}

    def _open(self, method, path, data=None, *a, **kw):
        if path == "/skills/maalow.d.ts":
            if self.types is None:
                raise urllib.error.HTTPError(path, 404, "not found", {}, None)
            return io.BytesIO(self.types)
        self.requests.append("pull")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            for p in json.loads(data)["paths"]:
                if p in self.files:
                    z.writestr(p, self.files[p][0])
        buf.seek(0)
        return buf


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(sync, "SYNC_HOME", tmp_path / "state")
    root = tmp_path / "workspaces"
    (root / "demo" / "pipeline").mkdir(parents=True)
    (root / "demo" / "workspace.json").write_text("{}")
    (root / "demo" / "pipeline" / "main.json").write_text('{"A": {}}')
    return FakeApp(), root


def run(app, root, **kw):
    return sync.sync(app, "demo", root, **kw)


def test_sync_roundtrip(env):
    app, root = env
    ws = root / "demo"
    out = run(app, root)
    assert out["push"] == ["pipeline/main.json", "workspace.json"] and "error" not in out
    assert app.files["pipeline/main.json"][1] == (ws / "pipeline/main.json").stat().st_mtime_ns // 1_000_000

    out = run(app, root)  # nothing changed: one tree request, nothing sent
    assert out["unchanged"] == 2 and not out["push"] and not out["pull"]

    (ws / "templates").mkdir()
    (ws / "templates" / "t.png").write_bytes(b"png")
    app.requests.clear()
    out = run(app, root)
    assert out["push"] == ["templates/t.png"] and app.requests == ["tree", "batch"]

    app.files["teaching/explore/steps.jsonl"] = (b"step\n", 1_700_000_000_000)
    app.files["teaching/explore/0001.png"] = (b"shot", 1_700_000_000_000)
    out = run(app, root, direction="pull", exclude=[sync.SCREENSHOTS])  # the CLI default
    assert out["pull"] == ["teaching/explore/steps.jsonl"]
    out = run(app, root, direction="pull")
    assert out["pull"] == ["teaching/explore/0001.png"]
    assert (ws / "teaching/explore/0001.png").read_bytes() == b"shot"
    assert (ws / "teaching/explore/0001.png").stat().st_mtime == 1_700_000_000

    (ws / "templates" / "t.png").unlink()
    del app.files["teaching/explore/steps.jsonl"]
    out = run(app, root)
    assert (out["delete_remote"], out["delete_local"]) == (["templates/t.png"], ["teaching/explore/steps.jsonl"])
    assert "templates/t.png" not in app.files and not (ws / "teaching/explore/steps.jsonl").exists()


def test_sync_conflict_is_not_overwritten(env):
    app, root = env
    run(app, root)
    (root / "demo" / "pipeline" / "main.json").write_text('{"A": {"local": 1}}')
    app.files["pipeline/main.json"] = (b'{"A": {"remote": 1}}', 1)
    out = run(app, root)
    assert out["conflicts"] == [{"path": "pipeline/main.json", "local": "modified", "remote": "modified"}]
    assert "error" in out
    assert app.files["pipeline/main.json"][0] == b'{"A": {"remote": 1}}'
    assert (root / "demo" / "pipeline" / "main.json").read_text() == '{"A": {"local": 1}}'
    out = run(app, root, prefer="local")
    assert out["push"] == ["pipeline/main.json"] and "error" not in out
    assert app.files["pipeline/main.json"][0] == b'{"A": {"local": 1}}'


def test_sync_first_time_with_existing_files_deletes_nothing(env):
    app, root = env
    app.files = {"workspace.json": (b"{}", 1), "pipeline/old.json": (b"{}", 1)}
    out = run(app, root)
    assert out["pull"] == ["pipeline/old.json"] and out["push"] == ["pipeline/main.json"]
    assert not out["delete_local"] and not out["delete_remote"]


def test_sync_dry_run_changes_nothing(env):
    app, root = env
    out = run(app, root, dry_run=True)
    assert out["dry_run"] and out["push"] and app.files == {}
    assert not sync.state_file(app.server, "demo").exists()


def test_sync_writes_skill_types_and_pushes_them(env):
    app, root = env
    ws = root / "demo"
    app.types = b"declare function click(x: number, y: number): void;\n"
    out = run(app, root)
    assert out["types"] == sync.TYPES
    assert (ws / sync.TYPES).read_bytes() == app.types
    assert json.loads((ws / sync.TSCONFIG).read_text())["compilerOptions"]["checkJs"]
    assert {sync.TYPES, sync.TSCONFIG} <= set(out["push"])

    (ws / sync.TSCONFIG).write_text("{}")  # the user's own settings stay
    out = run(app, root)
    assert "types" not in out and out["push"] == [sync.TSCONFIG]
    app.types = b"// newer app\n"
    out = run(app, root)
    assert out["types"] == sync.TYPES and out["push"] == [sync.TYPES]
    assert (ws / sync.TSCONFIG).read_text() == "{}"


def test_cli_sync_parser(env, monkeypatch, capsys):
    from maalow import cli

    app, root = env
    monkeypatch.setattr(cli, "Client", lambda *a: app)
    assert cli.main(["--root", str(root), "sync", "demo", "--push", "--dry-run"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["direction"] == "push" and out["dry_run"]
