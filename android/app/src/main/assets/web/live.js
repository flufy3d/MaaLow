// Live teaching: take a screenshot, draw numbered marks on it, tell MaaLow (the AI on the PC) what to do.
"use strict";

let workspace = ""; // of the teaching session, from /state
const fileUrl = p => `${API}/files/${encodeURIComponent(workspace)}/${p}?token=${encodeURIComponent(TOKEN)}`;

const cv = $("cv"), ctx = cv.getContext("2d");
let tool = "rect", marks = [], draft = null, img = new Image(), shot = "", seen = 0;

function setTool(t) {
  tool = t;
  document.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
}
document.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => setTool(b.dataset.tool));
setTool("rect");

function render() {
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0);
  marks.forEach((m, i) => drawMark(ctx, m, i + 1));
  if (draft) drawMark(ctx, draft, 0);
  $("empty").style.display = shot ? "none" : "flex";
  cv.style.visibility = shot ? "visible" : "hidden";
}

// pointer events: mouse, pen and touch (the page may be opened on the tablet itself)
let start = null;
cv.onpointerdown = e => {
  if (!shot) return;
  cv.setPointerCapture(e.pointerId);
  start = canvasPos(cv, e);
  if (tool === "click") { marks.push(toMark("click", start, start)); start = null; render(); }
};
cv.onpointermove = e => {
  const p = canvasPos(cv, e);
  $("info").textContent = `(${p[0]}, ${p[1]}) · ${cv.width}×${cv.height}`;
  if (start) { draft = toMark(tool, start, p); render(); }
};
cv.onpointerup = e => {
  if (!start) return;
  const m = toMark(tool, start, canvasPos(cv, e));
  start = null; draft = null;
  if (!tinyMark(m)) marks.push(m);
  render();
};
cv.onpointercancel = () => { start = null; draft = null; render(); };
$("undo").onclick = () => { marks.pop(); render(); };
$("clear").onclick = () => { marks = []; render(); };

// A screenshot is a saved workspace file; marks are drawn on it and sent with its path.
function show(path) {
  const next = new Image();
  next.onload = () => { img = next; shot = path; cv.width = next.naturalWidth; cv.height = next.naturalHeight; render(); };
  next.src = fileUrl(path);
}

let shooting = false;
async function takeShot() {
  if (shooting) return;
  shooting = true;
  const label = $("shot").querySelector("span");
  label.textContent = "截图中…";
  try {
    const s = await post("/shot");
    workspace = s.workspace;
    marks = [];
    show(s.screenshot);
  } catch (e) {
    ui.alert(e.message, "截图失败");
  } finally {
    shooting = false;
    label.textContent = "截图";
  }
}
$("shot").onclick = takeShot;

// the AI acted: show its new screenshot, unless the teacher is in the middle of drawing
function followShot(path) {
  if (path && path !== shot && !marks.length && !start) show(path);
}

function addMsg(m) {
  const d = document.createElement("div");
  if (m.role === "system") {
    d.className = "msg system";
    d.textContent = `${m.time} · ${m.text}`;
    return d;
  }
  d.className = "msg " + m.role + (m.auto ? " auto" : "");
  if (m.role === "ai") {
    const av = new Image();
    av.className = "av"; av.src = "web/mascot.png"; av.alt = "";
    d.appendChild(av);
  }
  const b = document.createElement("div");
  b.className = "bub";
  if (!m.auto) b.innerHTML = `<div class="meta">${m.role === "ai" ? "MaaLow" : "你"} · ${esc(m.time)}</div>`;
  b.appendChild(document.createTextNode((m.text || "") + (m.auto ? ` · ${m.time}` : "")));
  if (m.note) {
    const i = new Image();
    i.className = "note"; i.src = fileUrl(m.note); i.onclick = () => window.open(i.src);
    b.appendChild(i);
  }
  d.appendChild(b);
  return d;
}

// The chat shows the latest PAGE messages; older ones load on demand (the log on disk keeps everything).
const PAGE = 200;
let first = 0; // id of the oldest message shown
function showOlder(more) {
  $("older")?.remove();
  if (!more) return;
  const a = document.createElement("a");
  a.id = "older"; a.textContent = "加载更早的消息";
  a.onclick = loadOlder;
  $("log").prepend(a);
}
async function loadOlder() {
  const log = $("log"), ms = await json(`/messages?before=${first}&limit=${PAGE}`);
  if (!ms.length) return showOlder(false);
  const h = log.scrollHeight, top = log.firstChild?.id === "older" ? log.firstChild.nextSibling : log.firstChild;
  ms.forEach(m => log.insertBefore(addMsg(m), top));
  first = ms[0].id;
  showOlder(first > 1);
  log.scrollTop += log.scrollHeight - h; // keep the view where it was
}
function appendMsgs(ms) {
  const log = $("log");
  ms.forEach(m => log.appendChild(addMsg(m)));
  if (ms.length) { seen = ms[ms.length - 1].id; log.scrollTop = log.scrollHeight; }
}

/** The AI's presence, in the top bar. */
function setAiStatus(ai) {
  const p = $("aipill"), dot = p.querySelector(".dot");
  const [text, cls, tip] = {
    listening: ["MaaLow 在线", "ok", "MaaLow 正在监听，发消息就会处理"],
    busy: ["MaaLow 处理中", "warn pulse", "MaaLow 正在处理上一条消息"],
    away: ["MaaLow 未在监听", "bad", "PC 端没有在监听：消息会排队。在 PC 上让 Claude “开始指导”"],
  }[ai] || ["MaaLow", "", ""];
  p.querySelector(".t").textContent = text;
  dot.className = "dot " + cls;
  p.className = ai === "away" ? "away" : "";
  p.title = tip;
}

let task = "", session = -1, steps = 0, talk = 0, polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const s = await json("/state");
    const draft = s.task === "explore";
    if (s.session !== session || s.task !== task || s.workspace !== workspace) { // another (or a cleared) session: reload its chat
      if (s.workspace !== workspace && workspace) { shot = ""; marks = []; render(); } // another workspace: its screenshots differ
      task = s.task; workspace = s.workspace; session = s.session; seen = 0;
      $("log").innerHTML = "";
      const ms = await json(`/messages?limit=${PAGE}`);
      appendMsgs(ms);
      first = ms.length ? ms[0].id : 0;
      showOlder(first > 1);
      loadTasks();
    } else if (s.steps !== steps || s.talk !== talk) loadTasks(); // counts in the list
    steps = s.steps;
    talk = s.talk;
    $("task").textContent = `${draft ? "草稿" : "任务"} · 第 ${s.steps} 步`;
    document.querySelectorAll("#taskinfo .draft").forEach(b => b.style.display = draft ? "" : "none");
    document.querySelectorAll("#taskinfo .named").forEach(b => b.style.display = draft ? "none" : "");
    followShot(s.screenshot);
    setWaiting(s.waiting);
    setAiStatus(s.ai);
    appendMsgs(await json("/messages?since=" + seen));
  } catch (e) { /* app restarting */ }
  finally { polling = false; }
}
setInterval(poll, 1500); poll();

// ---- tasks: one task is one case being taught; its steps and chat live in teaching/<task>.*
async function loadTasks() {
  const sel = $("tasksel");
  try {
    const ts = await json("/tasks?workspace=" + encodeURIComponent(workspace));
    sel.innerHTML = ts.map(t => `<option value="${esc(t.name)}">${t.name === "explore" ? "草稿" : esc(t.name)}（${t.steps} 步 · ${t.talk} 条对话）</option>`).join("");
  } catch (e) {
    sel.innerHTML = `<option>${esc(task)}</option>`;
  }
  sel.value = task;
}
async function taskOp(path, body, what) {
  try {
    await post(path, { ...body, by: "teacher" });
    marks = []; render();
  } catch (e) {
    ui.alert(e.message, what + "失败");
  }
  await poll();
  loadTasks();
}
const switchTask = name => taskOp("/task", { name, workspace }, "切换任务");
$("tasksel").onchange = e => { if (e.target.value !== task) switchTask(e.target.value); };
$("newtask").onclick = async () => {
  const name = await ui.prompt("任务名", { title: "新任务", placeholder: "例如：每日签到", ok: "开始" });
  if (name) switchTask(name);
};
$("endtask").onclick = async () => {
  if (await ui.confirm(`已记录的步骤都已保存，之后可以在下拉框里选回来继续。`, { title: `结束任务 ${task}？`, ok: "结束任务" })) switchTask("explore");
};
$("deltask").onclick = async () => {
  if (await ui.confirm(`它的对话、${steps} 个步骤和截图都会删掉，不能恢复。`, { title: `删除任务 ${task}？`, ok: "删除", danger: true })) taskOp("/task/delete", {}, "删除任务");
};
$("savedraft").onclick = async () => {
  const name = await ui.prompt("任务名", { title: "把草稿另存为任务", placeholder: "例如：每日签到", ok: "保存" });
  if (name) taskOp("/task/rename", { name }, "另存为任务");
};
$("cleardraft").onclick = async () => {
  if (await ui.confirm(`草稿里的对话、${steps} 个步骤和截图都会删掉，不能恢复。想保留就先“另存为任务”。`, { title: "清空草稿？", ok: "清空", danger: true })) {
    taskOp("/task/delete", {}, "清空草稿");
  }
};

// lock the composer from sending until the AI answers, so instructions are not repeated
let waitingSince = 0, forced = false;
function setWaiting(w) {
  if (w && !waitingSince) waitingSince = Date.now();
  if (!w) { waitingSince = 0; forced = false; }
  const locked = w && !forced;
  $("compose").classList.toggle("locked", locked);
  $("thinking").style.display = locked ? "flex" : "none";
  const secs = waitingSince ? Math.round((Date.now() - waitingSince) / 1000) : 0;
  $("elapsed").textContent = secs + " 秒";
  $("force").style.display = secs >= 60 ? "inline" : "none";
}
$("force").onclick = () => { forced = true; setWaiting(true); };
setInterval(() => { if (waitingSince) setWaiting(true); }, 1000);

let sending = false;
async function send() {
  const text = $("text").value.trim();
  if (sending || (!text && !marks.length)) return;
  if ($("compose").classList.contains("locked")) return;
  sending = true;
  try {
    const labeled = marks.map((m, i) => ({ ...m, label: `${i + 1}号${NAMES[m.kind]}` }));
    const image = marks.length ? cv.toDataURL("image/png") : "";
    await post("/teach", { text, annotations: labeled, image, screenshot: shot });
    $("text").value = ""; marks = []; render();
    forced = false; setWaiting(true); poll();
  } catch (e) {
    ui.alert(e.message, "发送失败");
  } finally {
    sending = false;
  }
}
$("send").onclick = send;
$("text").onkeydown = e => {
  if (e.key === "Enter" && e.ctrlKey && !e.repeat && !e.isComposing) { e.preventDefault(); send(); }
};
window.addEventListener("keydown", e => {
  if (mode !== "live" || ui.isOpen()) return;
  if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const t = TOOLS[Number(e.key) - 1];
  if (t) setTool(t);
  if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey) takeShot();
  if (e.key === "z" && e.ctrlKey) { marks.pop(); render(); }
  if (e.key === "Escape") { start = null; draft = null; render(); }
});
render();
