// Overview: the current workspace, the device, guards, schedules, recent runs, the link to share and keep-alive checks.
"use strict";
window.overview = (() => {
  let active = false, timer = 0, busy = false, showToken = false;
  let st = null, guards = null, schedules = [], runs = [], keep = [];
  const shown = {}; // card id -> html, to leave unchanged cards (and their focus / hover) alone

  function put(id, html) {
    if (shown[id] === html || $(id).querySelector(".dragging")) return; // never pull rows out from under a drag
    shown[id] = html;
    $(id).innerHTML = html;
    if (id === "ov-guards") delete shown["ov-guard-last"]; // redrawn empty inside it
  }

  const row = (ok, title, sub, action = "") =>
    `<div class="row"><span class="dot ${ok === true ? "ok" : ok === false ? "bad" : ""}"></span>
      <div class="k"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div>${action}</div>`;

  /** Same wording as the app (MainActivity.guardText). */
  function guardText(r) {
    if (!r) return "—";
    if (r.startsWith("engine_")) return "等待引擎";
    return {
      disabled: "已关闭", not_started: "未启动", no_workspace: "没有工作区", no_guards: "没有配置守护规则",
      busy: "设备忙，跳过", screen_off: "屏幕已关闭", not_foreground: "游戏不在前台", no_match: "巡检中，没有弹窗",
    }[r] || `刚处理了 ${r}`;
  }

  const DAYS = ["", "一", "二", "三", "四", "五", "六", "日"];
  const days = d => !d?.length || d.length === 7 ? "每天" : "每周" + d.map(x => DAYS[x]).join("、");

  function hero() {
    const name = wsStore.current, w = wsStore.info(name);
    if (!name) {
      return `<div class="empty" style="flex:1"><img src="web/mascot.png" alt=""><div>还没有工作区。先新建一个，再开始指导 MaaLow。</div>
        <button class="btn primary" data-go="workspaces">${svg("plus")}新建工作区</button></div>`;
    }
    const n = (k, label, go) => go ? `<button class="chip link" data-go="${go}" title="打开">${label} ${w?.[k] ?? 0}</button>`
      : `<span class="chip">${label} ${w?.[k] ?? 0}</span>`;
    return `${appIcon(w?.package, name)}
      <div class="bd">
        <div class="dim" style="font-size:12.5px">当前工作区</div>
        <div class="nm">${esc(name)}</div>
        <div class="dim">${esc(w?.app || (w?.package ? "未安装" : "未设置游戏"))}${w?.package ? ` · <span class="mono">${esc(w.package)}</span>` : ""}</div>
        <div class="chips">${n("tasks", "任务", "live")}${n("recordings", "录像", "replay")}${n("pipelines", "规则文件", "browse:pipelines")}${n("templates", "模板", "browse:templates")}${n("skills", "技能", "browse:skills")}${n("guards", "守护规则", "guards")}</div>
      </div>
      <div class="acts">
        <button class="btn primary" data-go="teach/live">${svg("chat")}指导</button>
        <button class="btn" data-go="teach/replay">${svg("film")}录像回放</button>
        <button class="btn" data-go="workspaces">${svg("layers")}管理</button>
      </div>`;
  }

  function device() {
    if (!st) return `<h2>${svg("cpu")}设备</h2><div class="none">连接中…</div>`;
    const sh = {
      ready: [true, "已连接"],
      no_permission: [false, "未授权：在平板上打开 MaaLow 点“授权”"],
      not_running: [false, "未运行：在平板上打开 Shizuku 启动服务"],
    }[st.shizuku] || [null, st.shizuku];
    const eng = st.engine === "running" ? [true, st.busy ? `运行中 · 忙：${esc(st.busy)}` : "运行中"]
      : st.engine === "starting" ? [null, "启动中…"] : [false, st.error ? `出错：${esc(st.error)}` : "未运行"];
    const f = st.frame || {};
    return `<h2>${svg("cpu")}设备</h2><div class="rows">
      ${row(sh[0], "Shizuku", sh[1])}
      ${row(eng[0], "引擎", eng[1], `<button class="btn sm" data-act="restart">${svg("refresh", "sm")}重启</button>`)}
      ${row(st.engine === "running" ? true : null, "画面", `${f.width}×${f.height}${f.seq != null ? ` · 第 ${f.seq} 帧 · ${Math.round(f.age_ms)} ms 前` : ""}`)}
      ${row(st.screen_on, "屏幕", `${st.screen_on ? "亮屏" : "息屏"}${st.keyguard?.locked ? " · 已锁屏" : ""}`)}
      ${row(null, "版本", `MaaLow ${esc(st.app)} · MaaFramework ${esc(st.maa)}`)}
    </div>`;
  }

  function guardCard() {
    const g = guards, on = g?.enabled;
    return `<h2>${svg("shield")}守护规则<span class="grow"></span><span class="dim" style="font-size:12.5px;font-weight:400">总开关</span>
        <label class="switch" title="${on ? "关闭" : "打开"}全部守护规则"><input type="checkbox" data-act="guards"${on ? " checked" : ""}><span></span></label></h2>
      <div class="dim" style="font-size:13px">从上往下检查，拖动调整顺序；开关和频率在“管理规则”里。</div>
      ${g ? guardsUi.names(g) : `<div class="none">读取中…</div>`}
      <div class="rows" id="ov-guard-last"></div>
      <div><button class="btn sm" data-go="guards">${svg("edit", "sm")}管理规则</button></div>`;
  }

  function scheduleCard() {
    const cur = wsStore.current;
    const list = [...schedules].sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
    return `<h2>${svg("clock")}定时任务<span class="grow"></span><span class="dim" style="font-size:12.5px">下次：${st?.next_alarm ? fmtWhen(st.next_alarm) : "没有"}</span></h2>
      ${list.length ? `<div class="rows">${list.map(s => row(s.enabled ? true : null,
        `${esc(s.at)} ${days(s.days)} · ${esc(s.note || s.skill || s.node)}`,
        `${s.skill ? "技能 " + esc(s.skill) : "规则 " + esc(s.node)}${s.workspace !== cur ? ` · <span class="chip">${esc(s.workspace)}</span>` : ""} · ${s.enabled ? "下次 " + fmtWhen(s.next) : "已停用"}`,
        `<button class="btn sm" data-act="trigger" data-ws="${esc(s.workspace)}" data-id="${esc(s.id)}" title="现在就运行一次">${svg("play", "sm")}运行</button>`)).join("")}</div>`
        : `<div class="none">没有定时任务。用 PC 端 maalow 或 schedules.json 添加。</div>`}`;
  }

  function runCard() {
    const status = r => r.status === "ok" ? true : r.status === "skipped" ? null : false;
    const what = { ok: "完成", skipped: "跳过", failed: "失败", error: "出错" };
    return `<h2>${svg("bolt")}最近运行</h2>
      ${runs.length ? `<div class="rows">${runs.map(r => row(status(r),
        `${esc(r.skill || r.node || r.schedule)} · ${what[r.status] || esc(r.status)}`,
        `${fmtWhen(r.start)} · ${r.trigger === "alarm" ? "定时" : "手动"} · ${esc(r.workspace)}${r.reason ? " · " + esc(r.reason) : ""}${r.end && r.start ? ` · ${Math.round((r.end - r.start) / 1000)} 秒` : ""}`)).join("")}</div>`
        : `<div class="none">还没有运行记录。</div>`}`;
  }

  const link = () => `${location.origin}/?token=${TOKEN}`;
  function shareCard() {
    const masked = TOKEN ? TOKEN.slice(0, 4) + "•".repeat(12) + TOKEN.slice(-4) : "—";
    return `<h2>${svg("link")}分享访问</h2>
      <div class="dim" style="font-size:13px">把链接发给同一网络下的人，他们用浏览器打开就能一起指导。链接里带 Token，别外传。</div>
      <div class="linkbox"><span class="v mono">${esc(location.origin)}/?token=…</span><button class="btn sm" data-act="copylink">${svg("copy", "sm")}复制链接</button></div>
      <div class="linkbox"><span class="v mono">${esc(showToken ? TOKEN : masked)}</span>
        <button class="btn icon sm ghost" data-act="eye" title="${showToken ? "隐藏" : "显示"}">${svg("eye", "sm")}</button>
        <button class="btn sm" data-act="copytoken">${svg("copy", "sm")}复制 Token</button></div>
      <div class="none">二维码、系统分享和重置 Token 在平板上的 MaaLow App 里。</div>`;
  }

  function keepCard() {
    return `<h2>${svg("shield")}后台保活（HyperOS）</h2>
      ${keep.length ? `<div class="rows">${keep.map(c => row(c.ok, esc(c.label), esc(c.detail))).join("")}</div>` : `<div class="none">读取中…</div>`}
      ${keep.some(c => c.ok === false) ? `<div class="none">没通过的项要在平板上的 MaaLow App 里设置。</div>` : ""}`;
  }

  function render() {
    const alerts = st?.alerts?.filter(Boolean) || [];
    put("ov-alerts", alerts.map(a => `<div class="banner">${svg("alert")}${esc(a)}</div>`).join(""));
    put("ov-hero", hero());
    put("ov-device", device());
    put("ov-guards", guardCard());
    const last = guards?.last; // its own element: "N 秒前" changes every poll, the rows above should not
    put("ov-guard-last", row(guards?.enabled ? true : null, "最近一次",
      guards?.enabled ? `${guardText(last?.result)}${last?.time ? ` · ${fmtAgo(last.time)}` : ""}` : "总开关已关闭"));
    put("ov-schedules", scheduleCard());
    put("ov-runs", runCard());
    put("ov-share", shareCard());
    put("ov-keepalive", keepCard());
  }

  async function load() {
    if (busy) return;
    busy = true;
    try {
      [st, guards, schedules, runs, keep] = await Promise.all([
        json("/status"),
        wsStore.current ? json("/guards").catch(() => null) : null,
        json("/schedules").catch(() => []),
        json("/runs?limit=8").catch(() => []),
        json("/keepalive").catch(() => []),
      ]);
    } catch (e) { /* app restarting */ }
    finally { busy = false; }
    if (active) render();
  }

  document.querySelector("#overview .page-in").addEventListener("click", async e => {
    const go = e.target.closest("[data-go]");
    if (go?.dataset.go === "guards") { guardsUi.edit(wsStore.current); return; }
    if (go?.dataset.go.startsWith("browse:")) { browseUi.open(wsStore.current, go.dataset.go.slice(7)); return; }
    if (go) { setMode(go.dataset.go); if (go.dataset.go === "workspaces" && !wsStore.current) wsPage.create(); return; }
    if (guards && e.target.closest("#ov-guards [data-g]")) { const g = await guardsUi.handle(e, wsStore.current, guards); if (g) { guards = g; render(); wsStore.refresh().catch(() => {}); } return; }
    const a = e.target.closest("[data-act]")?.dataset.act;
    if (!a) return;
    if (a === "copylink") copyText(link(), "已复制链接");
    if (a === "copytoken") copyText(TOKEN, "已复制 Token");
    if (a === "eye") { showToken = !showToken; render(); }
    if (a === "restart") {
      if (!await ui.confirm("正在运行的规则会中断，几秒后引擎重新连上。", { title: "重启引擎？", ok: "重启" })) return;
      try { await post("/engine/restart"); toast("正在重启引擎…"); } catch (err) { ui.alert(err.message, "重启失败"); }
    }
    if (a === "trigger") {
      const b = e.target.closest("[data-act]");
      if (!await ui.confirm(`现在运行 ${b.dataset.ws} / ${b.dataset.id}？会像定时触发一样先检查设备和游戏。`, { title: "立即运行", ok: "运行" })) return;
      try { await post(`/schedules/${enc(b.dataset.ws)}/${enc(b.dataset.id)}/trigger?wait=false`); toast("已开始运行，结果会出现在“最近运行”里"); }
      catch (err) { ui.alert(err.message, "运行失败"); }
    }
  });
  document.querySelector("#overview .page-in").addEventListener("change", async e => {
    if (guards && e.target.closest("#ov-guards [data-g]")) { const g = await guardsUi.handle(e, wsStore.current, guards); if (g) { guards = g; render(); wsStore.refresh().catch(() => {}); } return; }
    if (e.target.dataset.act !== "guards") return;
    try { guards = await json("/guards", { method: "PUT", body: JSON.stringify({ enabled: e.target.checked }) }); }
    catch (err) { ui.alert(err.message, "设置失败"); }
    render();
  });

  sortable($("ov-guards"), ".row[data-g]", async rs => {
    const g = guards && await guardsUi.reorder(wsStore.current, guards, rs.map(r => r.dataset.g));
    if (g) guards = g;
    delete shown["ov-guards"]; // the rows were moved in place: redraw even if nothing was saved
    render();
  });

  function enter() {
    active = true;
    render();
    load();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) load(); }, 3000);
  }
  function leave() { active = false; clearInterval(timer); }

  return { enter, leave, refresh: () => { if (active) load(); } };
})();
