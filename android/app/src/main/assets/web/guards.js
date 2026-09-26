// Guard rules of a workspace: which pipeline nodes are checked while the game is in front, each switchable on and off.
// guards: the ones checked (workspace.json guards), off: switched off but kept (extra.guards_off), intervals: per
// guard check interval (extra.guard_intervals), nodes: all nodes; those with "guard_candidate": true can be added.
"use strict";
window.guardsUi = (() => {
  const nodeOf = (g, n) => g.nodes?.find(x => x.name === n);
  const sub = (g, n) => {
    const x = nodeOf(g, n);
    return x ? `${esc(x.desc || "没有说明")} · <span class="mono">${esc(x.file)}</span>` : `<span style="color:var(--red)">pipeline 里找不到这个节点</span>`;
  };

  /** The guards as shown: the saved order (off ones included), then any not in it. [[name, on], ...] */
  function list(g) {
    const on = new Set(g?.guards || []), off = new Set(g?.off || []);
    const names = [...new Set([...(g?.order || []), ...(g?.guards || []), ...(g?.off || [])])].filter(n => on.has(n) || off.has(n));
    return names.map(n => [n, on.has(n)]);
  }

  const EVERY = [500, 1000, 2000, 5000, 10000, 30000, 60000]; // 500: the loop's tick, the fastest a guard can go
  const secs = ms => ms >= 60000 ? `${ms / 60000} 分钟` : `${ms / 1000} 秒`;
  /** How often a guard is checked: its own interval, or the default. */
  function every(g, n) {
    const own = g.intervals?.[n], def = g.interval_ms || 2000;
    const opts = [...new Set([...EVERY, own].filter(Boolean))].sort((a, b) => a - b);
    return `<select class="every" data-gi title="多久检查一次">
      <option value=""${own ? "" : " selected"}>默认（${secs(def)}）</option>
      ${opts.map(ms => `<option value="${ms}"${own === ms ? " selected" : ""}>每 ${secs(ms)}</option>`).join("")}</select>`;
  }
  // a fixed time: text that ticks ("N 分钟前") would redraw the rows, and close an open select, on every poll
  const lastHit = (g, n) => { const h = g.stats?.[n]?.hit; return h ? ` · 上次命中 ${fmtWhen(h)}` : ""; };

  /** Just the names in order, draggable (the overview); switches and intervals are in the editor. */
  function names(g) {
    const all = list(g);
    if (!all.length) return `<div class="none">还没有守护规则。点“管理规则”，从候选节点里挑随时可能冒出来的画面（比如空闲幻灯片）。</div>`;
    return `<div class="rows">${all.map(([n, on], i) => `<div class="row slim" data-g="${esc(n)}">
        <span class="drag" data-drag title="拖动调整顺序：从上往下检查">${svg("grip")}</span>
        <div class="k"><b${on ? "" : ` class="dim"`}>${i + 1}. ${esc(n)}</b></div>${on ? "" : `<span class="chip">已停用</span>`}</div>`).join("")}</div>`;
  }

  /** Rows of the guards: a drag handle, a switch, how often (and a remove button when removable). */
  function rows(g, removable = false) {
    const all = list(g);
    if (!all.length) return `<div class="none">还没有守护规则。从下面的候选里挑随时可能冒出来的画面（比如空闲幻灯片）。</div>`;
    return `<div class="rows">${all.map(([n, on], i) => `<div class="row" data-g="${esc(n)}">
        <span class="drag" data-drag title="拖动调整顺序：从上往下检查">${svg("grip")}</span>
        <label class="switch" title="${on ? "停用" : "启用"}这条规则"><input type="checkbox" data-gt${on ? " checked" : ""}><span></span></label>
        <div class="k"><b${on ? "" : ` class="dim"`}>${i + 1}. ${esc(n)}</b><small>${sub(g, n)}${lastHit(g, n)}</small></div>
        ${every(g, n)}
        ${removable ? `<button class="btn icon sm ghost" data-gx title="移出守护规则（节点本身不删）">${svg("x", "sm")}</button>` : ""}
      </div>`).join("")}</div>`;
  }

  /** Save [[name, on], ...] in this order: the on ones are checked in it. */
  const save = (ws, items, intervals) => json("/guards", {
    method: "PUT",
    body: JSON.stringify({ workspace: ws, guards: items.filter(x => x[1]).map(x => x[0]), off: items.filter(x => !x[1]).map(x => x[0]), order: items.map(x => x[0]), intervals }),
  });

  /** Apply a change: on / off / remove / add a node (added last); returns the new guards state. */
  function change(ws, g, what, name) {
    let items = list(g);
    if (what === "remove" && g.intervals?.[name]) { // its interval goes with it
      const { [name]: _, ...intervals } = g.intervals;
      return save(ws, items.filter(x => x[0] !== name), intervals);
    }
    if (what === "remove") items = items.filter(x => x[0] !== name);
    else if (what === "add") items = [...items.filter(x => x[0] !== name), [name, true]];
    else items = items.map(x => x[0] === name ? [name, what === "on"] : x);
    return save(ws, items);
  }

  /** Save a new order (names, from sortable) keeping each rule's on / off. */
  function reorder(ws, g, names) {
    const on = new Set(g.guards);
    return save(ws, names.map(n => [n, on.has(n)])).catch(e => { ui.alert(e.message, "保存失败"); return null; });
  }

  /** Handle a click or change inside rows(); resolves with the new state, or null when nothing changed. */
  async function handle(e, ws, g) {
    const r = e.target.closest("[data-g]");
    if (!r) return null;
    const n = r.dataset.g;
    try {
      if (e.type === "change" && e.target.matches("[data-gt]")) return await change(ws, g, e.target.checked ? "on" : "off", n);
      if (e.type === "change" && e.target.matches("[data-gi]")) {
        const intervals = { ...(g.intervals || {}) };
        if (e.target.value) intervals[n] = Number(e.target.value); else delete intervals[n];
        return await json("/guards", { method: "PUT", body: JSON.stringify({ workspace: ws, intervals }) });
      }
      if (e.type === "click" && e.target.closest("[data-gx]")) {
        if (!nodeOf(g, n)?.candidate && !await ui.confirm(`${n} 不是候选规则（节点里没有 "guard_candidate": true），移出后网页上加不回来，只能在教学时让 MaaLow 加。`,
          { title: `移出 ${n}？`, ok: "移出", danger: true })) return null;
        return await change(ws, g, "remove", n);
      }
      if (e.type === "click" && e.target.closest("[data-ga]")) return await change(ws, g, "add", n);
    } catch (err) {
      ui.alert(err.message, "保存失败");
    }
    return null;
  }

  /** The editor: the workspace's guards with switches, and the other nodes to add. */
  async function edit(ws) {
    let g;
    try { g = await json("/guards?workspace=" + enc(ws)); } catch (e) { ui.alert(e.message, "读取守护规则失败"); return; }
    const body = () => {
      const used = new Set([...g.guards, ...g.off]);
      const rest = g.nodes.filter(x => x.candidate && !used.has(x.name));
      return `<div class="dim" style="font-size:13px">守护规则在游戏在前台、没有任务运行时巡检，只放随时可能冒出来的画面（空闲幻灯片、掉线重连）；只在某个流程里出现的弹窗（登录后的商城、领奖）交给流程里的 [JumpBack]。规则从上往下检查，命中一条就执行；拖动把手调整顺序，右边选多久查一次。</div>
        <div id="gd-cur">${rows(g, true)}</div>
        <div style="font-weight:800;margin-top:6px">候选规则</div>
        ${rest.length ? `<div class="rows" style="max-height:260px;overflow-y:auto;flex:none">${rest.map(x => `<div class="row" data-g="${esc(x.name)}">
            <div class="k"><b>${esc(x.name)}</b><small>${esc(x.desc || "没有说明")} · <span class="mono">${esc(x.file)}</span></small></div>
            <button class="btn sm" data-ga>${svg("plus", "sm")}添加</button></div>`).join("")}</div>`
          : `<div class="none">没有别的候选。节点在 pipeline 里写上 <span class="mono">"guard_candidate": true</span> 才会出现在这里；教学时告诉 MaaLow “这个画面随时会出现，做成守护候选”即可。</div>`}`;
    };
    await ui.dialog({
      title: `${svg("shield")}${esc(ws)} 的守护规则`, wide: true, body: `<div id="gd">${body()}</div>`,
      actions: [{ label: "完成", value: true, kind: "primary" }],
      init: box => {
        const el = box.querySelector("#gd");
        const on = async e => {
          const next = await handle(e, ws, g);
          if (!next) return;
          g = next;
          el.innerHTML = body();
          wsStore.refresh().catch(() => {});
          overview.refresh();
        };
        el.addEventListener("change", on);
        el.addEventListener("click", on);
        sortable(el, "#gd-cur .row", async rs => {
          const next = await reorder(ws, g, rs.map(r => r.dataset.g));
          if (next) { g = next; el.innerHTML = body(); overview.refresh(); }
        });
      },
    });
  }

  return { names, rows, handle, reorder, edit };
})();
