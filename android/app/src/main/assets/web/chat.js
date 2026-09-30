// Teaching: a task's conversation with MaaLow (the AI on the PC). Messages carry text and attachments (a screenshot
// with its marks, a recording with an optional focus); the teacher gathers attachments in the tray from the stages
// (live screenshots, recordings), then sends. The page is #teach/<stage>[/...], e.g. #teach/replay/<recording>/<frame>.
"use strict";
window.teach = (() => {
  let workspace = "", task = "", session = -1, steps = 0, talk = 0, seen = 0, trayRev = -1;
  let st = {}, polledAt = 0, waitingSince = 0, stage = "live", active = false;
  let tray = [], recs = null, recsFor = "", sending = false;
  const fileUrl = p => withToken(`${API}/files/${enc(workspace)}/${p.split("/").map(enc).join("/")}`);

  // ---- stages

  /** Show a stage in the shared frame (its toolbar group and bottom slot come with it); the frame stays put. */
  function setStage(s, rest = "") {
    if (!["live", "replay", "remote"].includes(s)) s = "live";
    const was = stage;
    stage = s;
    $("teach").dataset.stage = s;
    document.querySelectorAll("#modes [data-stage]").forEach(b => b.classList.toggle("on", b.dataset.stage === s));
    if (!active) return;
    if (was === "replay" && s !== "replay") replay.leave();
    if (was === "live" && s !== "live") live.leave();
    if (was === "remote" && s !== "remote") remote.leave();
    if (s === "replay") replay.enter(rest);
    else if (s === "remote") { remote.enter(); history.replaceState(null, "", "#teach/remote"); }
    else { live.enter(); history.replaceState(null, "", "#teach/live"); }
    renderTray();
  }
  document.querySelectorAll("#modes [data-stage]").forEach(b => b.onclick = () => { if (!b.disabled && b.dataset.stage !== stage) setStage(b.dataset.stage); });

  /** Page entered; rest: "live", "replay/<id>/<frame>" (from the address). */
  function enter(rest = "") {
    active = true;
    const [s, ...more] = (rest || stage).split("/");
    stage = "";
    setStage(s, [s, ...more].join("/"));
    const log = $("log");
    log.scrollTop = log.scrollHeight;
  }
  function leave() {
    active = false;
    if (stage === "replay") replay.leave(); else if (stage === "remote") remote.leave(); else live.leave();
  }

  // ---- recordings the messages refer to (names, lengths, thumbnails)

  async function loadRecs(force) {
    if (!workspace) return [];
    if (!force && recs && recsFor === workspace) return recs;
    try { recs = await json(`/recordings?workspace=${enc(workspace)}`); recsFor = workspace; } catch (e) { recs = recs || []; }
    return recs;
  }
  /** The replay stage loaded the list: keep it, and redraw cards whose recording was not known yet. */
  function setRecs(list, ws) {
    if (ws !== workspace) return;
    recs = list; recsFor = ws;
    document.querySelectorAll("#log .att.rec[data-rec]").forEach(d => d.replaceWith(recCard(JSON.parse(d.dataset.att))));
    renderTray();
  }
  const recOf = id => recs?.find(r => r.id === id);

  // ---- messages

  function shotEl(a, cls = "") {
    const d = document.createElement("div");
    d.className = "att shot " + cls;
    d.innerHTML = a.note ? `<img src="${fileUrl(a.note)}" alt="" loading="lazy">` // drawn by the old web UI
      : `<img src="${fileUrl(a.file)}" alt="" loading="lazy">${marksSvg(a.annotations)}`;
    return d;
  }
  function bigShot(a) {
    const d = shotEl(a, "big");
    const list = (a.annotations || []).map((m, i) => `<div class="mkline"><span class="chip" style="background:${COLORS[m.kind]}">${i + 1} ${NAMES[m.kind]}</span>${esc(m.label || "")}</div>`).join("");
    ui.dialog({ title: "截图", wide: true, body: d.outerHTML + (a.text ? `<div class="msgtext">${esc(a.text)}</div>` : "") + list, actions: [{ label: "关闭", value: true, kind: "primary" }] });
  }
  /** The attachment's own text, under it. */
  function caption(a) {
    if (!a.text) return null;
    const c = document.createElement("div");
    c.className = "cap";
    c.textContent = a.text;
    return c;
  }
  function recCard(a) {
    const r = recOf(a.rec), d = document.createElement("div");
    d.className = "att rec" + (r ? "" : recs ? " gone" : "");
    d.dataset.att = JSON.stringify(a);
    if (!r) d.dataset.rec = a.rec; // unknown yet: redrawn when the list arrives
    d.innerHTML = r
      ? `<div class="th" style="${thumbStyle(workspace, r, 88)}"></div><div class="bd"><div class="nm">${svg("film", "sm")} ${esc(r.name)}</div>
         <div class="sub">${fmtClock(r.duration_ms)} · ${focusText(a.focus)}</div></div>`
      : `<div class="bd"><div class="nm">${svg("film", "sm")} ${recs ? "录像已删除" : "录像"}</div><div class="sub">${esc(a.rec)} · ${focusText(a.focus)}</div></div>`;
    if (r) { d.title = "在录像回放里打开"; d.onclick = () => openRec(a.rec, a.focus); }
    return d;
  }
  function openRec(id, focus) {
    if (mode !== "teach") setMode("teach");
    setStage("replay", `replay/${id}/${focus ? focus.from : 0}`);
  }
  function attsEl(list) {
    const box = document.createElement("div");
    box.className = "atts";
    for (const a of list) {
      const one = document.createElement("div");
      one.className = "att1";
      if (a.type === "shot") { const d = shotEl(a); d.onclick = () => bigShot(a); one.appendChild(d); }
      else if (a.type === "recording") one.appendChild(recCard(a));
      const c = caption(a);
      if (c) one.appendChild(c);
      box.appendChild(one);
    }
    return box;
  }

  function addMsg(m) {
    const d = document.createElement("div");
    if (m.role === "system") {
      d.className = "msg system" + (m.text === "老师叫停了" ? " stop" : "");
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
    if (m.text || m.auto) b.appendChild(document.createTextNode((m.text || "") + (m.auto ? ` · ${m.time}` : "")));
    if (m.attachments?.length) b.appendChild(attsEl(m.attachments));
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
  const needsRecs = ms => ms.some(m => m.attachments?.some(a => a.type === "recording" && !recOf(a.rec)));
  async function loadOlder() {
    const log = $("log"), ms = await json(`/messages?before=${first}&limit=${PAGE}`);
    if (!ms.length) return showOlder(false);
    if (needsRecs(ms)) await loadRecs(true);
    const h = log.scrollHeight, top = log.firstChild?.id === "older" ? log.firstChild.nextSibling : log.firstChild;
    ms.forEach(m => log.insertBefore(addMsg(m), top));
    first = ms[0].id;
    showOlder(first > 1);
    log.scrollTop += log.scrollHeight - h; // keep the view where it was
  }
  // keep the newest message in view while it is (images arriving later make it taller)
  let stick = true;
  $("log").addEventListener("scroll", () => { const l = $("log"); stick = l.scrollHeight - l.scrollTop - l.clientHeight < 80; });
  $("log").addEventListener("load", () => { if (stick) $("log").scrollTop = $("log").scrollHeight; }, true);
  async function appendMsgs(ms) {
    if (!ms.length) return;
    if (needsRecs(ms)) await loadRecs(true);
    const log = $("log");
    ms.filter(m => m.id > seen).forEach(m => log.appendChild(addMsg(m)));
    seen = Math.max(seen, ms[ms.length - 1].id);
    if (stick || ms.some(m => m.role === "teacher")) { log.scrollTop = log.scrollHeight; stick = true; }
  }

  // ---- state: who is doing what, polled

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const s = await json("/state");
      polledAt = Date.now();
      if (s.session !== session || s.task !== task || s.workspace !== workspace) { // another (or a cleared) session: reload its chat
        const wsChanged = s.workspace !== workspace;
        task = s.task; workspace = s.workspace; session = s.session; seen = 0; trayRev = -1;
        if (wsChanged) { recs = null; live.reset(); }
        $("log").innerHTML = "";
        await loadRecs();
        const ms = await json(`/messages?limit=${PAGE}`);
        await appendMsgs(ms);
        first = ms.length ? ms[0].id : 0;
        showOlder(first > 1);
        loadTasks();
      } else if (s.steps !== steps || s.talk !== talk) loadTasks(); // counts in the list
      steps = s.steps; talk = s.talk;
      if (s.waiting && !st.waiting) waitingSince = Date.now();
      st = s;
      const draft = s.task === "explore";
      $("task").textContent = `${draft ? "草稿" : "任务"} · 第 ${s.steps} 步`;
      document.querySelectorAll("#taskbar .draft").forEach(b => b.style.display = draft ? "" : "none");
      document.querySelectorAll("#taskbar .named").forEach(b => b.style.display = draft ? "none" : "");
      if (s.tray_rev !== trayRev) await loadTray(s.tray_rev);
      live.follow(s.screenshot);
      await appendMsgs(await json("/messages?since=" + seen));
      renderStatus();
    } catch (e) { /* app restarting */ }
    finally { polling = false; }
  }
  setInterval(poll, 1500); poll();
  setInterval(renderStatus, 1000);

  /** The top bar's control indicator and the chat's status line. */
  const CONTROL = {
    idle: ["空闲", ""], ai: ["AI 执行中", "warn pulse"], task: ["任务运行中", "ok pulse"], stopped: ["已停止", "bad"], teacher: ["老师操控中", "warn"],
  };
  const FORCE_AFTER_MS = 3 * 60_000;
  function idleMs() { // since the AI last did something (or since the wait began, if it never did)
    const since = Date.now() - polledAt;
    return st.ai_idle_ms != null ? Math.min(st.ai_idle_ms + since, Date.now() - waitingSince) : Date.now() - waitingSince;
  }
  function renderStatus() {
    const [ct, cc] = CONTROL[st.control] || CONTROL.idle, pill = $("ctlpill");
    pill.querySelector(".t").textContent = ct;
    pill.querySelector(".dot").className = "dot " + cc;
    pill.className = st.control || "";
    const el = $("status"), force = $("force");
    let dot = "", text = "", canForce = false;
    const secs = ms => ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round(ms % 60_000 / 1000)} 秒`;
    const did = st.ai_idle_ms != null && st.ai_did ? ` · 最后活动 ${secs(Math.max(0, st.ai_idle_ms + Date.now() - polledAt))}前（${st.ai_did}）` : "";
    if (st.stopped) {
      dot = "bad"; text = "已停止：等 MaaLow 说明做到哪一步" + did;
      canForce = idleMs() >= FORCE_AFTER_MS;
    } else if (st.waiting) {
      dot = "warn pulse"; text = `等待 MaaLow 回复 · ${secs(Date.now() - waitingSince)}${did}`;
      canForce = idleMs() >= FORCE_AFTER_MS;
    } else if (st.ai === "listening") { dot = "ok"; text = "MaaLow 在线，发消息就会处理"; }
    else { dot = "bad"; text = "MaaLow 未在监听：消息会排队。在 PC 上让 Claude “开始指导”"; }
    el.querySelector(".dot").className = "dot " + dot;
    el.querySelector(".t").textContent = text;
    el.className = st.waiting ? "waiting" : "";
    force.textContent = canForce ? "强制解锁" : "";
    force.style.display = canForce ? "" : "none";
    renderCompose();
  }

  // ---- tasks: one task is one case being taught; its steps and chat live in teaching/<task>.*
  async function loadTasks() {
    const sel = $("tasksel");
    try {
      const ts = await json("/tasks?workspace=" + enc(workspace));
      sel.innerHTML = ts.map(t => `<option value="${esc(t.name)}">${t.name === "explore" ? "草稿" : esc(t.name)}（${t.steps} 步 · ${t.talk} 条对话）</option>`).join("");
    } catch (e) {
      sel.innerHTML = `<option>${esc(task)}</option>`;
    }
    sel.value = task;
  }
  async function taskOp(path, body, what) {
    await live.flush();
    try {
      await post(path, { ...body, by: "teacher" });
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
    if (await ui.confirm(`它的对话、${steps} 个步骤、截图和待发托盘都会删掉，不能恢复。`, { title: `删除任务 ${task}？`, ok: "删除", danger: true })) taskOp("/task/delete", {}, "删除任务");
  };
  $("savedraft").onclick = async () => {
    const name = await ui.prompt("任务名", { title: "把草稿另存为任务", placeholder: "例如：每日签到", ok: "保存" });
    if (name) taskOp("/task/rename", { name }, "另存为任务");
  };
  $("cleardraft").onclick = async () => {
    if (await ui.confirm(`草稿里的对话、${steps} 个步骤、截图和待发托盘都会删掉，不能恢复。想保留就先“另存为任务”。`, { title: "清空草稿？", ok: "清空", danger: true })) {
      taskOp("/task/delete", {}, "清空草稿");
    }
  };

  // ---- the tray: attachments waiting to be sent, kept in the app per task (a reload or another page sees them)

  async function loadTray(rev) {
    try {
      const t = await json("/tray");
      tray = t.items; trayRev = rev ?? t.rev;
    } catch (e) { return; }
    renderTray();
    live.trayChanged(tray); replay.trayChanged(tray);
  }
  const trayGot = (item, rev) => {
    const i = tray.findIndex(t => t.id === item.id);
    if (i >= 0) tray[i] = item; else tray.push(item);
    renderTray();
    return item;
  };
  /** Put an attachment in the tray; returns the item (with its id). */
  async function addToTray(att) {
    const item = await post("/tray", att);
    return trayGot(item);
  }
  async function updateTray(id, change) {
    const item = await json(`/tray/${id}`, { method: "PUT", body: JSON.stringify(change) });
    return trayGot(item);
  }
  async function removeFromTray(id) {
    const t = await json(`/tray/${id}`, { method: "DELETE" });
    tray = t.items;
    renderTray();
    live.trayChanged(tray); replay.trayChanged(tray);
  }
  /** A fresh screenshot into the tray, opened on the live stage (open = false: the remote stage keeps watching). */
  async function takeShot(open = true) {
    const item = trayGot(await post("/shot", { tray: true }));
    if (!open) { renderTray(); return item; }
    if (stage !== "live") setStage("live");
    live.edit(item);
    return item;
  }

  /** Each item: a thumbnail, how many marks, the start of its text; the one being edited on a stage stands out. */
  function renderTray() {
    const el = $("tray"), edited = [live.editing(), replay.editing()];
    const snippet = t => t ? esc(t.length > 14 ? t.slice(0, 13) + "…" : t) : "";
    el.innerHTML = tray.map(it => {
      const btns = `<button data-act="edit" title="${it.type === "shot" ? "载入实时截图舞台，继续改标注和说明" : "载入录像回放，继续改范围和说明"}">${svg("edit", "sm")}</button>
        <button data-act="del" title="从托盘里删掉">${svg("x", "sm")}</button>`;
      const on = edited.includes(it.id) ? " on" : "";
      if (it.type === "shot") {
        const n = it.annotations.length;
        return `<div class="ti${on}" data-id="${it.id}"><div class="att shot mini"><img src="${fileUrl(it.file)}" alt="">${marksSvg(it.annotations)}</div>
          <div class="tx"><span class="n">${n ? n + " 个标注" : "截图"}</span><span class="s">${snippet(it.text) || '<span class="none">没写说明</span>'}</span></div>${btns}</div>`;
      }
      const r = recOf(it.rec);
      return `<div class="ti rec${on}" data-id="${it.id}"><div class="th" style="${r ? thumbStyle(workspace, r, 64) : ""}"></div>
        <div class="tx"><span class="n">${esc(r ? r.name : recs ? "录像已删除" : it.rec)} · ${focusText(it.focus)}</span><span class="s">${snippet(it.text) || '<span class="none">没写说明</span>'}</span></div>${btns}</div>`;
    }).join("");
    el.style.display = tray.length ? "" : "none";
    renderCompose();
  }
  $("tray").onclick = async e => {
    const row = e.target.closest(".ti");
    if (!row) return;
    const it = tray.find(t => String(t.id) === row.dataset.id), act = e.target.closest("[data-act]")?.dataset.act;
    if (!it) return;
    if (act === "del") {
      try { await removeFromTray(it.id); } catch (err) { toast("删除失败：" + err.message); }
    } else if (it.type === "shot") {
      if (stage !== "live") setStage("live");
      live.edit(it);
    } else {
      openRec(it.rec, it.focus);
      replay.editItem(it);
    }
  };

  // ---- compose: only the send button locks while waiting for the reply; stop is for then

  const waiting = () => !!st.waiting;
  function renderCompose() {
    const text = $("text").value.trim();
    $("send").disabled = sending || waiting() || (!text && !tray.length);
    $("send").title = waiting() ? "等 MaaLow 回复后才能发下一条" : "";
    $("stopai").disabled = !waiting() || !!st.stopped;
  }
  $("text").oninput = renderCompose;

  async function send() {
    const text = $("text").value.trim();
    if (sending || waiting() || (!text && !tray.length)) return;
    sending = true; renderCompose();
    try {
      await live.flush(); // marks still being saved go with the message
      await post("/teach", { text, attachments: tray });
      $("text").value = "";
      tray = []; renderTray(); live.trayChanged(tray);
      waitingSince = Date.now(); st = { ...st, waiting: true };
      poll();
    } catch (e) {
      ui.alert(e.message, "发送失败");
    } finally {
      sending = false;
      renderCompose();
    }
  }
  $("send").onclick = send;
  $("text").onkeydown = e => {
    if (e.key === "Enter" && e.ctrlKey && !e.repeat && !e.isComposing) { e.preventDefault(); send(); }
  };
  $("stopai").onclick = async () => {
    try {
      st = await post("/teach/stop");
      toast("已叫停：MaaLow 接下来的操作都会被拒绝，等它说明做到哪一步", 3500);
    } catch (e) { ui.alert(e.message, "停止失败"); }
    renderStatus(); poll();
  };
  $("force").onclick = async () => {
    const mins = Math.floor(idleMs() / 60_000);
    if (!await ui.confirm(`MaaLow 已经 ${mins} 分钟没有动静了。解锁后可以接着发消息，MaaLow 回来时会看到“老师跳过了等待”。`, { title: "强制解锁？", ok: "解锁" })) return;
    try { st = await post("/teach/unlock"); } catch (e) { ui.alert(e.message, "解锁失败"); }
    renderStatus(); poll();
  };

  return {
    enter, leave, setStage, setRecs, addToTray, updateTray, takeShot, renderTray, fileUrl,
    get stage() { return stage; }, get workspace() { return workspace; }, get tray() { return tray; },
  };
})();
