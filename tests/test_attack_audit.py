"""Causal safeguards and offline review boundaries, without private recordings."""
import json
import sys
import threading
import urllib.error
import urllib.request
from collections import Counter
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1] / "workspaces/WhereWindsMeet/tools"
sys.path.insert(0, str(TOOLS))
import attack_audit as audit
from attack_review.server import ReviewStore, handler_for


def evidence():
    return [{"source": "fixture/video", "conditions": "fixture only", "frames": [10,12],
             "confidence": "high", "observation": "explicit fixture feedback"}]


def sample(i=0):
    return {"sample_id":f"r737-c{i:03d}-f00020", "round":737, "seq_contact":{"t":20,"type":"hit","hp_loss":.1},
            "root_id":"r737-c000-f00020", "source_group":"B", "seq_kind":"normal",
            "clip":{"from":0,"to":50,"anchor":20,"pre_decision_to":10,"extendable_to":100,"fps":30,"video":"private.mp4"}}


def make_store(tmp_path):
    s=sample()
    audit.write(tmp_path/"samples.json",[s])
    audit.write(tmp_path/"labels.json",{s["sample_id"]:audit.blank_label(s["sample_id"])})
    audit.write(tmp_path/"evidence"/f"{s['sample_id']}.json", {"events":[{"secret":"outcome"}]})
    return ReviewStore(tmp_path)


def test_hp_merge_and_threshold_do_not_assert_attack_identity():
    data=[1]*4+[.95]*3+[.90]*8+[.89]*4
    drops=audit.hp_drops([{"hp":h} for h in data])
    assert len(drops)==1
    assert drops[0]["frame"]==5
    assert [p["frame"] for p in drops[0]["parts"]]==[5,8]
    assert drops[0]["maxHP"]==pytest.approx(.10)
    assert audit.hp_drops([{"hp":None}]*5)==[]


def test_stages_keep_original_and_require_sequence():
    label=audit.blank_label("s")
    with pytest.raises(ValueError):
        audit.save_stage(label,2,audit.label_template(2))
    first=audit.label_template(1)
    label=audit.save_stage(label,1,first)
    label=audit.save_stage(label,2,audit.label_template(2))
    changed={**first,"attack_id":"later guess"}
    revised=audit.save_stage(label,1,changed)
    assert revised["stage1_original"]["attack_id"]=="unknown"
    assert revised["stage1_revisions"][0]["after_reveal"]
    assert label["stage1_revisions"]==[]
    assert not revised["human_confirmed"]


def test_claims_need_evidence_and_named_human():
    v=audit.label_template(2)
    v["parryability"]="confirmed_unparryable"
    with pytest.raises(ValueError):
        audit.validate_label_payload(2,v)
    v["defense_evidence"]=evidence()
    audit.validate_label_payload(2,v)
    v["source"]="human_confirmed"
    with pytest.raises(ValueError):
        audit.validate_label_payload(2,v)
    v["reviewer"]="Test fixture"
    audit.validate_label_payload(2,v)
    v3=audit.label_template(3)
    v3["defense_mismatch"]="confirmed"
    v3["evidence"]=["pressed then hurt"]
    with pytest.raises(ValueError):
        audit.validate_label_payload(3,v3)


def test_server_hides_future_and_logs(tmp_path,monkeypatch):
    store=make_store(tmp_path)
    v=store.sample_view(0,1)
    assert v["range"]==[0,10]
    assert "sample" not in v and "evidence" not in v
    assert "root_id" not in json.dumps(v)
    with pytest.raises(ValueError):
        store.sample_view(0,2)
    with pytest.raises(ValueError):
        store.frame(0,1,11)
    monkeypatch.setattr(audit,"read_frame",lambda p,n:n)
    assert store.frame(0,1,10)==10
    lab=audit.save_stage(store.label(0),1,audit.label_template(1))
    audit.write(tmp_path/"labels.json",{lab["sample_id"]:lab})
    v=store.sample_view(0,2)
    assert "evidence" not in v
    assert store.frame(0,2,99)==99
    with pytest.raises(ValueError):
        store.sample_view(0,3)
    lab=audit.save_stage(lab,2,audit.label_template(2))
    audit.write(tmp_path/"labels.json",{lab["sample_id"]:lab})
    assert store.sample_view(0,3)["evidence"]["events"]==[{"secret":"outcome"}]
    assert "evidence" not in store.sample_view(0,1)


def test_http_gate_and_static_ui(tmp_path):
    store=make_store(tmp_path)
    server=ThreadingHTTPServer(("127.0.0.1",0),handler_for(store))
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    base=f"http://127.0.0.1:{server.server_port}"
    try:
        with urllib.request.urlopen(base+"/") as response:
            assert '离线复核' in response.read().decode()
        with urllib.request.urlopen(base+"/api/sample?i=0&stage=1") as response:
            assert "evidence" not in json.load(response)
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(base+"/api/sample?i=0&stage=3")
        assert error.value.code==400
        request=urllib.request.Request(base+"/api/save",data=b"{}",headers={
            "Content-Type":"application/json","Origin":"https://untrusted.example"})
        with pytest.raises(urllib.error.HTTPError):
            urllib.request.urlopen(request)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_sampling_reproducible_separate_groups():
    population=[]
    for k in audit.ROUNDS:
        for phase in ("early","middle","late"):
            for i in range(20):
                population.append({"sample_id":f"{k}-{phase}-{i:03d}", "round":k,"elapsed_phase":phase,
                    "is_root":i<10,"seq_kind":"normal","seq_contact":{"hp_loss":.05+i*.001 if i<10 else None,
                    "type":"hit" if i<10 else "ok","prev_gap":30},"feature_at_anchor":{"hp":.7}})
    a,strata=audit.choose_samples(population,42)
    b,_=audit.choose_samples(population,42)
    assert a==b and len(a)==90
    assert len({c["sample_id"] for c in a})==90
    assert Counter(c["source_group"] for c in a)=={"A":60,"B":30}
    assert all(c["weight"]==5 for c in a if c["source_group"]=="A")
    assert all(c["weight"] is None for c in a if c["source_group"]=="B")
    assert all(s["N"]==20 and s["n"]==4 for s in strata)


def test_report_does_not_count_candidates_or_follow_damage(tmp_path):
    samples=[sample(0),sample(1)]
    samples[1]["seq_contact"]["hp_loss"]=.2
    audit.write(tmp_path/"samples.json",samples)
    audit.write(tmp_path/"population.json",samples)
    audit.write(tmp_path/"rounds.json",[{"round":737,"alive_minutes":2,"result_from_log":"dead",
                "seq_hits":2,"seq_ok":0,"runtime_hits":2,"runtime_ok":0}])
    for s in samples:
        s["is_root"]=s is samples[0]
        audit.write(tmp_path/"evidence"/f"{s['sample_id']}.json",{"events":[]})
    audit.write(tmp_path/"population.json",samples)
    labels={s["sample_id"]:audit.blank_label(s["sample_id"]) for s in samples}
    lab=labels[samples[0]["sample_id"]]
    v3=audit.label_template(3)
    v3.update(defense_mismatch="confirmed",evidence=evidence())
    lab["stage3"]=v3
    audit.write(tmp_path/"labels.json",labels)
    audit.report(tmp_path)
    x=audit.read(tmp_path/"analysis.json")
    assert x["confirmed_mismatch_damage_maxHP"]==0
    assert x["unknown_sample_damage_fraction"]==pytest.approx(1)
    v3["source"]="other_reliable_evidence"
    audit.write(tmp_path/"labels.json",labels)
    audit.report(tmp_path)
    x=audit.read(tmp_path/"analysis.json")
    assert x["confirmed_mismatch_damage_maxHP"]==.1
    assert x["theoretical_sample_upper_bound_maxHP_per_recorded_minute"]==.05
    assert x["unknown_sample_damage_maxHP"]==.2
    assert x["confirmed_mismatch_roots"]==["r737-c000-f00020"]


def test_command_time_is_not_shifted_by_glow():
    events=audit.map_events([[1100,100,"press","dodge left k0 fut c+9f"]],1000)
    assert events[0]["estimated_video_frame"]==3
    assert events[0]["predicted_contact_frame_proxy"]==12
    assert events[0]["game_execution_frame"] is None
    assert events[0]["device_ack_ms"] is None
