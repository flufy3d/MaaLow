"""Delete from the Pad the recordings that the rounds reference AND that pull.py verified (nothing else).

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/delete.py          # dry run: show what would go
    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/delete.py --yes    # delete

Candidates = referenced by a round (common.rounds()) and pull_status ok and bars present, and right now: the local
data/moveid/video/<id>.mp4 size == the Pad's meta size, 3 byte samples still equal. The list goes to
data/moveid/deleted.txt before anything is deleted; each DELETE is confirmed by the meta GET answering "no such
recording" afterwards, and the Pad's list is checked at the end (every unreferenced recording must still be there).
labels.json (when the Pad has one) is saved to data/moveid/meta/<id>.labels.json first. Results: deleted.json.
"""
from __future__ import annotations

import argparse
import time
import urllib.error
import urllib.parse
import urllib.request

from common import META, OUT, STATUS, VIDEO, WS, read_json, rounds, write_json
from pull import _req, _url, bars_ok, bytes_ok

from maalow.client import Client


def pad_list(client: Client) -> dict:
    lst = client.get(f"/recordings?workspace={urllib.parse.quote(WS)}", timeout=600)
    if isinstance(lst, dict):
        raise SystemExit(f"list failed: {lst}")
    return {r["id"]: r for r in lst}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="really delete")
    a = ap.parse_args()
    client = Client()
    st = read_json(STATUS, {})
    ref = {rd["rec"]: rd["key"] for rd in rounds()}
    pad = pad_list(client)
    cands, skipped = [], []
    for rid in ref:
        if rid not in pad:
            continue
        e = st.get(rid, {})
        f = VIDEO / f"{rid}.mp4"
        why = None
        if not e.get("ok"):
            why = "not verified"
        elif not f.exists() or not bars_ok(rid):
            why = "local file / bars missing"
        elif f.stat().st_size != pad[rid].get("size"):
            why = f"size {f.stat().st_size} != pad {pad[rid].get('size')}"
        (skipped if why else cands).append((rid, why))
    keep = sorted(set(pad) - set(ref))
    print(f"pad {len(pad)}, referenced on pad {sum(r in pad for r in ref)}, candidates {len(cands)}, "
          f"skipped {len(skipped)}, unreferenced kept {len(keep)}: {keep}")
    for rid, why in skipped:
        print(f"  skip {ref[rid]} {rid}: {why}")
    if not a.yes:
        print("dry run; --yes to delete")
        return
    prev = (OUT / "deleted.txt").read_text(encoding="utf-8").split() if (OUT / "deleted.txt").exists() else []
    ids = [rid for rid, _ in cands]
    (OUT / "deleted.txt").write_text("\n".join(sorted(set(prev) | set(ids))) + "\n", encoding="utf-8")
    log = read_json(OUT / "deleted.json", {})
    for rid in ids:
        meta = client.get(f"/recordings/{urllib.parse.quote(WS)}/{urllib.parse.quote(rid)}")
        f = VIDEO / f"{rid}.mp4"
        if "error" in meta or int(meta.get("size", -1)) != f.stat().st_size or not bytes_ok(client, rid, f, f.stat().st_size):
            print(f"{rid}: re-check failed, not deleted ({meta.get('error', 'size/bytes')})")
            log[rid] = {"deleted": False, "why": "re-check failed"}
            continue
        try:
            with urllib.request.urlopen(_req(client, _url(client, rid, "/labels")), timeout=60) as r:
                (META / f"{rid}.labels.json").write_bytes(r.read())
        except urllib.error.HTTPError:
            pass
        req = _req(client, _url(client, rid))
        req.method = "DELETE"
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read().decode()
        except urllib.error.HTTPError as e:
            body = f"HTTP {e.code} {e.read()[:200]!r}"
        after = client.get(f"/recordings/{urllib.parse.quote(WS)}/{urllib.parse.quote(rid)}")
        gone = "error" in after
        log[rid] = {"deleted": gone, "response": body, "at": time.strftime("%Y-%m-%d %H:%M:%S"), "round": ref[rid]}
        write_json(OUT / "deleted.json", log)
        print(f"{ref[rid]} {rid}: {body} -> gone {gone}", flush=True)
    pad2 = pad_list(client)
    missing_keep = [k for k in keep if k not in pad2]
    still = [rid for rid in ids if rid in pad2]
    print(f"after: pad {len(pad2)}; deleted confirmed {sum(log.get(r, {}).get('deleted', False) for r in ids)}/{len(ids)}; "
          f"still on pad {still}; unreferenced missing {missing_keep}; pad now: {sorted(pad2)}")


if __name__ == "__main__":
    main()
