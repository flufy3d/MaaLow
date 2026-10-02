"""A stronghold (据点) route made from one recording: the teacher plays it through once (menu → 江湖行 → the stronghold's
card → stone → teleport → run there → fight → chest), marking nothing; this makes the teleport nodes, the minimap
references (outside / inside zoom), the route node and the one-click entry from it.

The route is not the recorded track played back: every place the character was seen on (fights included, where it got
pushed about) is ground that can be walked. On that map, the way between the stops found in the recording (actions on
the interaction list, a task count going up) is planned (A*, kept off the edges), then cut down to straight legs.

    uv run --extra cv python workspaces/WhereWindsMeet/tools/rec_route.py all data/wwm_jiurou --rec 20261002-025629
    uv run --extra cv python workspaces/WhereWindsMeet/tools/rec_route.py emit data/wwm_jiurou --name jiurou --rec 20261002-025629

`all` runs the steps in turn (each can be run alone, the same way):
    frames     <root>/rec/<n>.jpg from the recording (pull it first: maalow rec pull <id>)
    cache      rec/frames.npz (minimap discs, camera) and screens.json (what each frame shows)
    ocr        text.json: the tracker and the interaction list (PaddleOCR, wwm_ocr.py)
    icons      icons.json: the stronghold icon on the minimap (live: dark red blobs; taken: a template)
    bigmap     anchors.json (each look at the big map from the world screen), bigmap/ (a weak reference, not exported)
    register   reg.json: map shifts between frames 7, 10 and 30 apart
    locate     track.json, locate.json: every frame's place and zoom (k measured, see cmd_locate)
    eval       eval.json: held-out frames located in mosaics made without them
    mosaic     mosaic/ (and with --name, templates/locate/<name>_mosaic*)
    plan       targets.json, plan.json, plan.png: the stops, the walkable map, the route
    view       plan_view.png: the route over the mosaics, for the teacher
    emit       the stronghold's config, pipeline/stronghold_<id>.json (its one-click node), and the card's template
    check      the walkable map and the planner tried on another survey (e.g. 佛爷寨's) against the teacher's route
    anchors    a dry run's where() readings (route_seg.py ... check=true out=RUN.json) into device_anchors.json

On the device (the stronghold taken; tell the teacher first, these open the big map a lot):
    dryrun     the route with check: true; how far it got (each point's where() within CHECK_OFF)
    survey     walk points a-b the old way (big map, step, look again) grabbing frames: survey<N>/, placed by its looks
    auto       dry run → survey from where it went wrong → mosaic, plan, view, emit, push → again, until it passes

After a dry run with check: true, `anchors --run RUN.json` puts its where() readings into <root>/device_anchors.json
(device_fixes); then locate / mosaic / plan / emit again.

Positions are big map px (fully zoomed in) from the stronghold icon, x east / y south, as stronghold.js where() reads
them. Data (not committed): <root>/rec/<n>.jpg (the recording's frames, n = frame number, 30 fps) and what the steps
write next to it. The minimap matching is scripts/map_locate.py, the game's minimap tools/wwm_locate.py.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# the steps live in three modules; their names are all here too (tools import rec_route as rr)
from rr_map import *  # noqa: F401,F403,E402
from rr_map import _tpl  # noqa: F401,E402
from rr_plan import *  # noqa: F401,F403,E402
from rr_device import *  # noqa: F401,F403,E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("root", type=Path)
    ap.add_argument("--rec", help="frames: the recording id (workspaces/WhereWindsMeet/recordings/<id>/video.mp4)")
    ap.add_argument("--video", type=Path)
    ap.add_argument("--start", type=int, default=1, help="dryrun: the first point")
    ap.add_argument("--stops", action="store_true", help="plan: the old way (stops at the task counts, A* between)")
    ap.add_argument("--every", action="store_true", help="dryrun: read where() at every point, not just the config's checks")
    ap.add_argument("--points", help="survey: the route points to walk, e.g. 10-31")
    ap.add_argument("--at", help="survey: where the character is (x,y from where()), to go on from the nearest point")
    ap.add_argument("--rounds", type=int, default=4, help="auto: dry run / survey rounds at most")
    ap.add_argument("--run", help="anchors: route_seg.py out= files of dry runs with check=true, comma separated")
    ap.add_argument("--title", help="emit: the stronghold's name on its card (default: the recording's name)")
    ap.add_argument("--tracks", help="check: track.json files of another stronghold's survey, comma separated")
    ap.add_argument("--node", help="check: the stronghold whose route it is (e.g. Foye)")
    ap.add_argument("--pairs", default="0-2,7-9", help="check: point pairs i-j to plan between")
    ap.add_argument("--name", help="mosaic / emit: the stronghold's name in templates and nodes (e.g. jiurou)")
    ap.add_argument("--k-out", type=float, help="locate: big map px per minimap px zoomed out (default: measured)")
    ap.add_argument("--k-in", type=float, help="locate: the same zoomed in (default: k out / ZOOM_RATIO)")
    a = ap.parse_args()
    if a.cmd == "frames":
        cmd_frames(a.root, a.rec, a.video)
    elif a.cmd == "all":
        if not (a.root / REC / "frames.jsonl").exists():
            cmd_frames(a.root, a.rec, a.video)
        for f in (cmd_cache, cmd_ocr, cmd_icons, cmd_bigmap, cmd_register):
            print("==", f.__name__)
            f(a.root)
        print("== cmd_locate")
        cmd_locate(a.root, a.k_out, a.k_in)
        print("== cmd_eval")
        cmd_eval(a.root)
        print("== cmd_mosaic")
        cmd_mosaic(a.root, a.name, a.rec)
        print("== cmd_plan")
        cmd_plan(a.root, a.stops)
        cmd_view(a.root)
    elif a.cmd == "cache":
        cmd_cache(a.root)
    elif a.cmd == "bigmap":
        cmd_bigmap(a.root)
    elif a.cmd == "ocr":
        cmd_ocr(a.root)
    elif a.cmd == "register":
        cmd_register(a.root)
    elif a.cmd == "locate":
        cmd_locate(a.root, a.k_out, a.k_in)
    elif a.cmd == "mosaic":
        cmd_mosaic(a.root, a.name, a.rec)
    elif a.cmd == "eval":
        cmd_eval(a.root)
    elif a.cmd == "plan":
        cmd_plan(a.root, a.stops)
    elif a.cmd == "check":
        cmd_check(a.root, [Path(t) for t in a.tracks.split(",")], a.node, [tuple(int(v) for v in p.split("-")) for p in a.pairs.split(",")])
    elif a.cmd == "emit":
        cmd_emit(a.root, a.name, a.title, a.rec)
    elif a.cmd == "view":
        cmd_view(a.root)
    elif a.cmd == "dryrun":
        cmd_dryrun(a.root, a.name, a.start, a.every)
    elif a.cmd == "survey":
        a_, b_ = (int(v) for v in a.points.split("-"))
        cmd_survey(a.root, a.name, a_, b_, tuple(float(v) for v in a.at.split(",")) if a.at else None)
    elif a.cmd == "survey-build":
        for d in sorted(a.root.glob(f"{SURVEY}*")):
            if d.is_dir() and (d / "route.json").exists():
                survey_build(a.root, d)
    elif a.cmd == "auto":
        cmd_auto(a.root, a.name, a.rounds)
    elif a.cmd == "anchors":
        cmd_anchors(a.root, [Path(r) for r in a.run.split(",")])
    elif a.cmd == "icons":
        cmd_icons(a.root)


if __name__ == "__main__":
    main()
