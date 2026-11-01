"""Offense episode tool: gap boundary, round-level split, and the same-key cooldown simulation (synthetic only)."""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "workspaces" / "WhereWindsMeet" / "tools" / "dufu_moveid"


def _load():
    sys.path.insert(0, str(TOOLS))
    spec = importlib.util.spec_from_file_location("offense_episodes", TOOLS / "offense_episodes.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _contact(frame: int, grp: str = "k0:c1", kind: str = "hit", resp: str = "parry") -> dict:
    return {"frame": frame, "kind": kind, "colour": "none",
            "dec": {"grp": grp, "resp": resp, "truth_resp": resp, "med": 0.0, "tte_err": 0.0, "fatal": True},
            "presses": []}


def test_episode_gap_30_merges_31_splits():
    mod = _load()
    cs = [_contact(100), _contact(130), _contact(161)]
    eps = mod.cluster_contacts(cs)
    assert [len(e) for e in eps] == [2, 1]

    built = mod.build_episodes("r185", cs, "train", {"fightMs": 3000}, {"groups": {}})
    assert [e["n"] for e in built] == [2, 1]
    assert built[0]["start"] == 100 and built[0]["end"] == 130
    assert built[0]["beats"][1]["gap"] == 30 and built[0]["beats"][1]["off"] == 30
    assert built[1]["beats"][0]["gap"] is None


def test_split_is_round_level_and_disjoint():
    mod = _load()
    splits = mod.split_rounds(["r191", "r185", "r187", "r186"])
    assert splits["train"] == ["r185", "r187"]
    assert splits["val"] == ["r186", "r191"]
    assert not set(splits["train"]) & set(splits["val"])
    assert set(splits["train"]) | set(splits["val"]) == {"r185", "r186", "r187", "r191"}
    # numeric ordering, not lexical: r99 is the first (train) round, r100 the second (val)
    numeric = mod.split_rounds(["r100", "r99"])
    assert numeric["train"] == ["r99"] and numeric["val"] == ["r100"]


def test_actionable_two_dodges_inside_cooldown_count_once():
    mod = _load()
    beats = [{"frame": 100, "truth_resp": "dodge", "grp": "k0:c11"},
             {"frame": 110, "truth_resp": "dodge", "grp": "k0:c11"}]
    out = mod.simulate_actionable(beats, "default")
    assert out["covered"] == 1
    assert out["flags"] == [True, False]

    boundary = [{"frame": 100, "truth_resp": "dodge", "grp": "k0:c11"},
                {"frame": 115, "truth_resp": "dodge", "grp": "k0:c11"}]
    assert mod.simulate_actionable(boundary, "default")["covered"] == 2

    # different keys do not share a cooldown
    mixed = [{"frame": 100, "truth_resp": "parry", "grp": "k0:c1"},
             {"frame": 102, "truth_resp": "dodge", "grp": "k0:c1"}]
    assert mod.simulate_actionable(mixed, "default")["covered"] == 2


def test_intended_mapping_uses_predicted_contact_within_4_frames():
    mod = _load()
    presses = [{"key": "parry", "frame": 96, "remF": 0, "group": "g", "src": "resp"},
               {"key": "dodge", "frame": 104, "remF": 0, "group": "g", "src": "gold"},
               {"key": "parry", "frame": 95, "remF": 0, "group": "g", "src": "resp"},
               {"key": "parry", "frame": 105, "remF": 0, "group": "g", "src": "resp"},
               {"key": "dodge", "frame": 100, "remF": 3, "group": "g", "src": "gold"}]
    got = mod.intended_for_beat(100, presses)
    assert [p["key"] for p in got] == ["parry", "dodge", "dodge"]
    assert [p["pred"] for p in got] == [96, 103, 104]
    assert [p["actual_lead"] for p in got] == [4, 0, -4]

    episodes = mod.build_episodes("r185", [_contact(100)], "train", {}, {"groups": {}}, presses=presses)
    assert [p["key"] for p in episodes[0]["beats"][0]["intended"]] == ["parry", "dodge", "dodge"]


def test_last_post_gap_uses_video_end_frame():
    mod = _load()
    cs = [_contact(100), _contact(130), _contact(161)]
    episodes = mod.build_episodes("r185", cs, "train", {}, {"groups": {}}, video_end_f=170)
    assert [e["n"] for e in episodes] == [2, 1]
    assert episodes[0]["post_gap_f"] == 31
    assert episodes[-1]["post_gap_f"] == 9

    missing = mod.build_episodes("r185", cs, "train", {}, {"groups": {}}, video_end_f=None)
    assert missing[-1]["post_gap_f"] is None


def test_beat_response_and_press_fields_are_preserved():
    mod = _load()
    c = _contact(100)
    c["presses"] = [{"key": "parry", "lead": 9.5}]
    ep = mod.build_episodes("r185", [c], "train", {"fightMs": 1000}, {"groups": {}})[0]
    b = ep["beats"][0]
    assert b["grp"] == "k0:c1" and b["k"] == 0
    assert b["truth_resp"] == "parry" and b["dec_resp"] == "parry"
    assert b["press_keys"] == ["parry"] and b["press_leads"] == [9.5]
    assert ep["prefix"] == "k0"
