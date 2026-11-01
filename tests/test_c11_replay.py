"""c11 branch script / offline replay: the two required branches, the punish windows, and the early-dodge trap."""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "workspaces" / "WhereWindsMeet" / "tools" / "dufu_moveid"
SCRIPT = ROOT / "workspaces" / "WhereWindsMeet" / "move_scripts" / "c11.json"


def _load():
    sys.path.insert(0, str(TOOLS))
    spec = importlib.util.spec_from_file_location("c11_replay", TOOLS / "c11_replay.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def contact(f: float, grp: str, kind: str = "hit", colour: str = "none") -> dict:
    return {"frame": f, "kind": kind, "colour": colour,
            "dec": {"grp": grp, "truth_resp": "parry", "resp": "parry"}}


def press(f: float, kind: str, grp: str, remF: float = 4.0, lead: float = 5.0) -> dict:
    return {"f": f, "kind": kind, "gid": 7, "grp": grp, "pgold": 0.99, "pdodge": 0.9, "pparry": 0.1,
            "med": 6.0, "remF": remF, "lead": lead, "src": "gold" if kind == "dodge" else "resp"}


def trace_rows(qi: float = 50.0) -> list[dict]:
    return [{"f": 70.0, "grp": "k0:c11+c15+c23", "p": 0.9, "gold": 0.9, "med": 10.0, "qi": qi, "hp": 1.0},
            {"f": 71.0, "grp": "k0:c11+c15+c23", "p": 0.8, "gold": 0.8, "med": 9.0, "qi": qi, "hp": 1.0},
            {"f": 125.0, "grp": "k0:c6", "p": 0.1, "gold": 0.0, "med": 20.0, "qi": qi, "hp": 1.0}]


def classify(mod, ep, truth, presses, trace, video_end=400.0, allow_gold_parry=False):
    return mod.classify_episode(ep, truth, presses, trace, video_end, "extended", "r999", {},
                                allow_gold_parry=allow_gold_parry)


def test_script_schema_has_the_two_branches():
    mod = _load()
    script = mod.read_json(SCRIPT)
    assert script["id"] == "c11"
    ids = {b["id"] for b in script["beats"]}
    assert {"gold_opener", "followup_hitstun", "followup_after_dodge", "followup_after_parry"} <= ids
    assert script["beats"][0]["response"] == "dodge"
    assert script["beats"][0]["branches"]["hit"] == "followup_hitstun"
    assert script["beats"][0]["branches"]["dodge"] == "followup_after_dodge"
    assert script["forbidden"]["gold_parry"]


def test_gold_hit_branch_does_not_press_k1_k2():
    mod = _load()
    ep = [contact(100, "k0:c11+c15+c23", "hit", "gold"),
          contact(106, "k1:c11+c15+c23", "hit"),
          contact(112, "k2:c11", "hit")]
    truth = ep + [contact(200, "k0:c6")]
    row = classify(mod, ep, truth, [], trace_rows(50))
    assert row["observed_branch"] == "hit"
    assert row["script_branch"] == "dodge"  # the script's counterfactual k0 dodge
    assert row["k1_hits"] == 1 and row["k2_hits"] == 1
    assert row["followup_hits"] == 2
    assert row["hitstun_hits"] == 2
    assert all(b["script_response"] == "none" for b in row["followups"])
    assert row["parry_k1"] == 0 and row["parry_k2"] == 0
    assert row["punish_action"] == "light"  # post gap 88 f, qi 50: light (42) yes, follow (61) yes, execute no


def test_gold_dodged_branch_k1_still_hits_and_parry_is_zero():
    mod = _load()
    ep = [contact(100, "k1:c11+c15+c23", "hit")]
    truth = ep + [contact(200, "k0:c6")]
    presses = [press(60, "dodge", "k0:c11+c15+c23", remF=4.0, lead=5.0),
               press(95, "parry", "k1:c11+c15+c23", lead=5.0)]
    row = classify(mod, ep, truth, presses, trace_rows(50))
    assert row["observed_branch"] == "dodge"
    assert row["k0_dodged_proven"] is True
    assert row["script_branch"] == "dodge"
    assert row["k1_hits"] == 1
    assert row["parry_k1"] == 1 and row["parry_ok_k1"] == 0
    assert row["hitstun_hits"] == 0
    assert row["punish_action"] == "light"


def test_punish_windows_light_follow_execute_and_none():
    mod = _load()
    ep = [contact(100, "k0:c11+c15+c23", "hit", "gold"), contact(106, "k1:c11+c15+c23", "hit")]
    # last contact 106; hitstun ends 118. post gap = next truth - 106.
    none = classify(mod, ep, ep + [contact(120, "k0:c6")], [], trace_rows(50))
    assert none["punish_action"] is None and none["punish_available"] == []
    light = classify(mod, ep, ep + [contact(162, "k0:c6")], [], trace_rows(50))
    assert light["punish_action"] == "light"
    assert "light" in light["punish_available"] and "follow" not in light["punish_available"]
    follow = classify(mod, ep, ep + [contact(200, "k0:c6")], [], trace_rows(50))
    assert "follow" in follow["punish_available"]
    execute = classify(mod, ep, ep + [contact(200, "k0:c6")], [], trace_rows(10))
    assert execute["punish_action"] == "execute"
    assert execute["boss_qi_at_punish"] == 10


def test_early_actual_dodge_does_not_block_the_script_press():
    """r217/r219: the recorded c11Lead=14 dodge is still in its lock at t0-3; the script replaces it."""
    mod = _load()
    ep = [contact(100, "k0:c11+c15+c23", "hit", "gold")]
    truth = ep + [contact(200, "k0:c6")]
    presses = [press(86, "dodge", "k0:c11+c15+c23", remF=12.0, lead=14.0)]  # early, locks until 98
    row = classify(mod, ep, truth, presses, trace_rows(50))
    assert row["script_press_f"] == 97.0
    assert row["script_press_state"] == "idle"
    assert row["script_branch"] == "dodge"


def test_gold_parry_branch_is_diagnostic_only():
    mod = _load()
    ep = [contact(100, "k0:c11+c15+c23", "ok", "gold")]
    truth = ep + [contact(200, "k0:c6")]
    normal = classify(mod, ep, truth, [], trace_rows(50))
    assert normal["script_branch"] == "dodge"
    diagnostic = classify(mod, ep, truth, [], trace_rows(50), allow_gold_parry=True)
    assert diagnostic["script_branch"] == "ok"


def test_find_tell_needs_a_stable_two_row_run():
    mod = _load()
    trace = [{"f": 60.0, "grp": "k0:c11+c15+c23", "p": 0.3, "gold": 0.2, "med": 20.0, "qi": 50, "hp": 1},
             {"f": 70.0, "grp": "k0:c11+c15+c23", "p": 0.9, "gold": 0.9, "med": 12.0, "qi": 50, "hp": 1},
             {"f": 71.0, "grp": "k0:c11+c15+c23", "p": 0.8, "gold": 0.8, "med": 11.0, "qi": 50, "hp": 1}]
    tell = mod.find_tell(trace, 100.0)
    assert tell["f"] == 70.0 and tell["p"] == 0.9
