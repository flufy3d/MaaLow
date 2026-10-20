"use strict";
const $ = id => document.getElementById(id);
const names = {
  source:"标签来源",reviewer:"复核者（人工确认必填姓名）",notes:"说明",
  attack_id:"招式身份 attack_id",combo_segment:"连段段号",phase:"游戏阶段",
  mechanisms:"机制标签数组（重击 / 抓取 / 幕布等，可并存）",
  recognizable_before_decision:"决策前可辨识性",earliest_cue_frame_range:"最早可见线索候选帧区间",
  observable_context:"可观察上下文：距离 / 朝向 / 玩家动作 / 受控状态",
  visual_contact_frame_range:"视觉接触区间 [起帧, 末帧]（未知填 null）",
  hp_drop_frames:"扣血帧数组",parry_feedback:"明确卸劲反馈证据数组",dodge_feedback:"明确闪避反馈证据数组",
  parryability:"可卸性",defense_evidence:"防守属性证据数组（须附条件和帧）",
  other_supported_defenses:"其他已获证据支持的应对方法",same_attack_sample_ids:"同招式已核实的其他 sample_id",
  factors:"可并存的因素",defense_mismatch:"防法不匹配",timing_or_execution_problem:"接触预测 / 执行问题",
  resource_conflict:"资源冲突",resource_state_evidence:"冷却 / 资源证据",
  model_action_evidence:"模型、决策与发送证据",evidence:"因果判断证据数组",missing_evidence:"缺失证据数组",
  damage_links:"已确认直接损伤关联（不自动纳入连锁）"
};
const choices = {
  source:["agent_candidate","human_confirmed","other_reliable_evidence"],
  recognizable_before_decision:["unknown","yes","no","conditional"],
  parryability:["unknown","confirmed_parryable","confirmed_unparryable","conditional"],
  defense_mismatch:["unknown","suspected","confirmed","not_supported"],
  timing_or_execution_problem:["unknown","suspected","confirmed","not_supported"],
  resource_conflict:["unknown","suspected","confirmed","not_supported"]
};
let index=0,stage=1,data=null,current=0,playing=false,dirty=false,request=0;
async function api(url, opts) {
  const r=await fetch(url,opts), v=await r.json();
  if(!r.ok) throw new Error(v.error||r.statusText);
  return v;
}
function error(e){$("error").textContent=String(e.message||e);}
function stop(){playing=false;$("play").textContent="播放";}
async function frame(n){
  const ticket=++request;
  current=Math.max(+$("from").value,Math.min(+$("to").value,Number(n)));
  $("frameNo").value=current;$("seek").value=current;$("time").textContent=`${(current/30).toFixed(3)} s`;
  const response=await fetch(`/api/frame?i=${index}&stage=${stage}&n=${current}`);
  if(!response.ok) throw new Error((await response.json()).error);
  const blob=await response.blob();
  if(ticket!==request)return;
  const old=$("frame").src;
  $("frame").src=URL.createObjectURL(blob);
  if(old.startsWith("blob:"))URL.revokeObjectURL(old);
}
function renderForm(value){
  $("form").replaceChildren();
  for(const [key,val] of Object.entries(value)){
    const label=document.createElement("label");
    label.textContent=names[key]||key;
    label.htmlFor="field_"+key;
    let input;
    if(choices[key]){
      input=document.createElement("select");
      for(const choice of choices[key]){
        const o=document.createElement("option");o.value=choice;o.textContent=choice;input.append(o);
      }
      input.value=val;
    }else if(typeof val==="object" || key==="notes"){
      input=document.createElement("textarea");
      input.value=key==="notes"?val:JSON.stringify(val,null,2);
      input.dataset.json=key==="notes"?"no":"yes";
    }else{
      input=document.createElement("input");input.value=val;
    }
    input.id="field_"+key;input.name=key;
    input.addEventListener("input",()=>{dirty=true;$("saved").textContent="有未保存修改";});
    $("form").append(label,input);
  }
}
function getValue(){
  const v={};
  for(const el of $("form").elements){
    if(el.name) v[el.name]=el.dataset.json==="yes"?JSON.parse(el.value):el.value;
  }
  return v;
}
function events(){
  $("events").replaceChildren();
  const filter=$("filter").value.toLowerCase();
  for(const e of data?.evidence?.events||[]){
    if(filter && !`${e.kind} ${e.detail}`.toLowerCase().includes(filter))continue;
    const tr=document.createElement("tr");
    for(const text of [e.event_index,`${e.estimated_video_frame.toFixed(2)} / ${(e.estimated_video_frame/30).toFixed(3)}`,e.kind,e.detail]){
      const td=document.createElement("td");td.textContent=text;tr.append(td);
    }
    tr.addEventListener("click",()=>{
      const n=Math.round(e.estimated_video_frame);
      if(n>=data.extendable[0]&&n<=data.extendable[1]){
        $("from").value=Math.min(+$("from").value,n);$("to").value=Math.max(+$("to").value,n);
        setRange();frame(n).catch(error);
      }
    });
    $("events").append(tr);
  }
}
function setRange(){
  let a=Math.max(data.extendable[0],Math.min(data.extendable[1],Math.round(+$("from").value)));
  let b=Math.max(a,Math.min(data.extendable[1],Math.round(+$("to").value)));
  $("from").value=a;$("to").value=b;$("seek").min=a;$("seek").max=b;
}
async function load(i,s){
  stop();
  const next=await api(`/api/sample?i=${i}&stage=${s}`);
  data=next;index=i;stage=s;dirty=false;$("error").textContent="";$("saved").textContent="";
  $("sample").value=index;$("stage").value=stage;$("warning").textContent=data.warning;
  $("formTitle").textContent=`${data.review_id} · 阶段 ${stage}`;
  $("from").value=data.range[0];$("to").value=data.range[1];setRange();
  renderForm(data.revisions.at(-1)?.value || data.saved || data.template);
  $("priorBox").hidden=stage===1;
  $("prior").textContent=JSON.stringify({stage1_original:data.stage1_original,stage2_original:data.stage2_original},null,2);
  $("evidence").hidden=stage!==3;
  $("reveal").hidden=stage===3;
  if(stage===3){
    $("metadata").textContent=JSON.stringify(data.sample,null,2);
    $("features").textContent=JSON.stringify({features:data.evidence.features,alignment:data.evidence.alignment},null,2);
    $("sourceLinks").replaceChildren();
    for(const [name,title] of [["video","原录像（跳到本样本）"],["seq","原 seq"],["run","原动作日志"],["features","原逐帧读数"],["source","当轮 Skill 快照"],["config","当轮配置"],["meta","录像元数据"]]){
      const a=document.createElement("a");a.textContent=title+" · ";a.target="_blank";
      a.href=name==="video"?`/api/video?i=${index}&stage=3#t=${data.sample.clip.time_seconds}`:`/api/source?i=${index}&stage=3&name=${name}`;
      $("sourceLinks").append(a);
    }
    events();
  }else{
    $("metadata").textContent="";$("features").textContent="";$("events").replaceChildren();
  }
  await frame(data.range[0]);
}
async function save(reveal){
  await api("/api/save",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({i:index,stage,value:getValue()})});
  dirty=false;$("saved").textContent="已保存；第一步原始判断不会被覆盖";
  if(reveal && stage<3)await load(index,stage+1);
}
function navigate(i,s){
  if(dirty && !confirm("当前修改尚未保存，仍然离开？"))return;
  load(i,s).catch(e=>{$("sample").value=index;$("stage").value=stage;error(e);});
}
$("save").onclick=()=>save(false).catch(error);
$("reveal").onclick=()=>save(true).catch(error);
$("stage").onchange=e=>navigate(index,+e.target.value);
$("sample").onchange=e=>navigate(+e.target.value,1);
$("prevSample").onclick=()=>navigate(Math.max(0,index-1),1);
$("nextSample").onclick=()=>navigate(Math.min($("sample").options.length-1,index+1),1);
$("back").onclick=()=>{stop();frame(current-1).catch(error);};
$("forward").onclick=()=>{stop();frame(current+1).catch(error);};
$("frameNo").onchange=e=>{stop();frame(+e.target.value).catch(error);};
$("seek").oninput=e=>{stop();frame(+e.target.value).catch(error);};
$("extend").onclick=()=>{stop();setRange();frame(current).catch(error);};
$("filter").oninput=events;
$("play").onclick=async()=>{
  if(playing){stop();return;}
  playing=true;$("play").textContent="暂停";
  try{
    while(playing && current<+$("to").value){
      const t=performance.now();await frame(current+1);
      await new Promise(r=>setTimeout(r,Math.max(0,1000/30-(performance.now()-t))));
    }
  }catch(e){error(e);}finally{stop();}
};
$("export").onclick=async()=>{
  try{
    const labels=await api("/api/export");
    const url=URL.createObjectURL(new Blob([JSON.stringify(labels,null,2)],{type:"application/json"}));
    const a=document.createElement("a");a.href=url;a.download="attack-audit-labels.json";a.click();URL.revokeObjectURL(url);
  }catch(e){error(e);}
};
window.addEventListener("beforeunload",e=>{if(dirty){e.preventDefault();e.returnValue="";}});
document.addEventListener("keydown",e=>{
  if(["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName))return;
  if(e.key==="ArrowLeft")$("back").click();
  if(e.key==="ArrowRight")$("forward").click();
});
api("/api/index").then(async v=>{
  for(let i=0;i<v.count;i++){const o=document.createElement("option");o.value=i;o.textContent=`复核 ${i+1} / ${v.count}`;$("sample").append(o);}
  const id=new URLSearchParams(location.search).get("sample");
  await load(Math.max(0,v.ids.indexOf(id)),1);
}).catch(error);
