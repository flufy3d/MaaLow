// Workspaces page: create (pick the game from the tablet's apps), switch, rename, copy, change the game, export,
// import and delete to the trash (kept 7 days). Only the web UI manages workspaces; the app shows the current one.
"use strict";
window.wsPage = (() => {
  const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
  let active = false, trash = [], apps = null;

  const badName = (n, except) => !NAME.test(n) ? "只能用英文字母、数字和 _ . -，且不能以 . 或 - 开头"
    : n !== except && wsStore.list.some(w => w.name === n) ? `已经有工作区 ${n} 了` : "";
  /** A workspace name from a package: com.netease.yysls -> yysls. */
  const fromPackage = pkg => (pkg.split(".").pop() || "").replace(/[^A-Za-z0-9_.-]/g, "").replace(/^[.-]+/, "");

  function card(w) {
    const cur = w.name === wsStore.current;
    const stat = (n, label, kind) => kind ? `<button class="chip link" data-act="browse" data-kind="${kind}" title="查看">${label} ${n}</button>`
      : `<span class="chip">${label} ${n}</span>`;
    return `<div class="card wscard${cur ? " cur" : ""}" data-ws="${esc(w.name)}">
      <div class="top">${appIcon(w.package, w.name)}
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(w.name)}${cur ? `<span class="chip accent">当前</span>` : ""}${w.busy ? `<span class="chip bad">${esc(w.busy)}</span>` : ""}</div>
          <div class="sub">${esc(w.app || (w.package ? "未安装" : "未设置游戏"))}${w.package ? ` · <span class="mono">${esc(w.package)}</span>` : ""}</div>
        </div></div>
      <div class="stats">${stat(w.tasks, "任务")}${stat(w.recordings, "录像")}${stat(w.pipelines, "规则文件", "pipelines")}${stat(w.templates, "模板", "templates")}${stat(w.skills, "技能", "skills")}<button class="chip link" data-act="guards" title="查看、启用或停用">守护规则 ${w.guards}</button></div>
      <div class="dim" style="font-size:12px">${fmtSize(w.size)} · 最近修改 ${fmtWhen(w.mtime)}</div>
      <div class="acts">
        ${cur ? "" : `<button class="btn sm primary" data-act="use">${svg("check", "sm")}设为当前</button>`}
        <button class="btn sm" data-act="rename">${svg("edit", "sm")}重命名</button>
        <button class="btn sm" data-act="copy">${svg("dup", "sm")}复制</button>
        <button class="btn sm" data-act="game">${svg("game", "sm")}换游戏</button>
        <button class="btn sm" data-act="export">${svg("download", "sm")}导出</button>
        <button class="btn sm danger" data-act="delete"${cur ? ` disabled title="当前工作区不能删除，先切换到别的"` : ""}>${svg("trash", "sm")}删除</button>
      </div></div>`;
  }

  function trashCard() {
    const days = t => Math.min(7, Math.max(0, Math.ceil((t.expires - Date.now()) / 86400000))); // the tablet's clock may differ a little
    return `<h2>${svg("trash")}回收站<span class="grow"></span><span class="dim" style="font-size:12.5px">删除的工作区保留 7 天</span></h2>
      ${trash.length ? `<div class="rows">${trash.map(t => `<div class="row trashrow" data-id="${esc(t.id)}">${appIcon(t.package, t.name)}
          <div class="k"><b>${esc(t.name)}</b><small>删除于 ${fmtWhen(t.deleted)} · ${fmtSize(t.size)} · ${days(t)} 天后彻底清除</small></div>
          <button class="btn sm" data-act="restore">${svg("restore", "sm")}恢复</button>
          <button class="btn sm danger" data-act="purge">彻底删除</button></div>`).join("")}</div>`
        : `<div class="none">回收站是空的。</div>`}`;
  }

  function render() {
    if (!active) return;
    $("ws-grid").innerHTML = wsStore.list.length ? wsStore.list.map(card).join("")
      : `<div class="card"><div class="empty"><img src="web/mascot.png" alt=""><div>还没有工作区。新建一个，选好游戏就能开始指导。</div>
          <button class="btn primary" data-act="new">${svg("plus")}新建工作区</button></div></div>`;
    $("ws-trash").innerHTML = trashCard();
  }

  async function loadTrash() {
    try { trash = await json("/trash"); } catch (e) { trash = []; }
  }

  async function reload() {
    await Promise.all([wsStore.refresh(), loadTrash()]);
    render();
  }

  // ---- app picker (launchable apps on the tablet)

  const pickerHtml = `<label>游戏<input id="pk-q" placeholder="搜索应用名或包名"></label><div class="picker" id="pk-list"><div class="none" style="padding:8px">读取应用列表…</div></div>`;

  /** Fill the picker in box; the chosen package is kept in box.dataset.pkg. onPick(pkg, label) on every choice. */
  async function initPicker(box, selected, onPick) {
    box.dataset.pkg = selected || "";
    const list = box.querySelector("#pk-list"), q = box.querySelector("#pk-q");
    try { apps ??= await json("/apps"); } catch (e) { list.innerHTML = `<div class="err" style="padding:8px">${esc(e.message)}</div>`; return; }
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const hits = apps.filter(a => !t || a.label.toLowerCase().includes(t) || a.package.toLowerCase().includes(t));
      list.innerHTML = [`<div class="it${!box.dataset.pkg ? " sel" : ""}" data-pkg=""><span class="appicon">—</span><div class="bd"><div>暂不指定</div><div class="sub">以后再选</div></div></div>`]
        .concat(hits.map(a => `<div class="it${a.package === box.dataset.pkg ? " sel" : ""}" data-pkg="${esc(a.package)}">${appIcon(a.package, a.label)}
          <div class="bd"><div>${esc(a.label)}${a.system ? ` <span class="chip">系统</span>` : ""}</div><div class="sub mono">${esc(a.package)}</div></div></div>`)).join("");
    };
    q.oninput = draw;
    list.onclick = e => {
      const it = e.target.closest(".it");
      if (!it) return;
      box.dataset.pkg = it.dataset.pkg;
      list.querySelectorAll(".it").forEach(x => x.classList.toggle("sel", x === it));
      onPick?.(it.dataset.pkg, apps.find(a => a.package === it.dataset.pkg)?.label);
    };
    draw();
    list.querySelector(".it.sel")?.scrollIntoView({ block: "nearest" });
  }

  // ---- actions

  async function create() {
    let auto = true; // the name follows the picked game until typed in
    const r = await ui.dialog({
      title: "新建工作区", wide: true,
      body: `<label>名称（英文，也是文件夹名）<input id="nw-name" autofocus placeholder="例如 WhereWindsMeet"></label>${pickerHtml}`,
      actions: [{ label: "取消", value: null }, { label: "创建", kind: "primary", value: box => ({ name: box.querySelector("#nw-name").value.trim(), pkg: box.dataset.pkg }) }],
      check: v => !v.name ? "请填写名称" : badName(v.name),
      init: box => {
        const name = box.querySelector("#nw-name");
        name.oninput = () => { auto = !name.value; };
        initPicker(box, "", pkg => { if (auto) name.value = fromPackage(pkg); });
      },
    });
    if (!r) return;
    try {
      await post("/workspaces", { name: r.name, package: r.pkg });
      await reload();
      if (await ui.confirm(`工作区 ${r.name} 已创建。现在切换过去吗？`, { title: "已创建", ok: "切换过去" })) await useWorkspace(r.name);
    } catch (e) { ui.alert(e.message, "创建失败"); }
  }

  async function act(a, name) {
    const w = wsStore.info(name);
    try {
      if (a === "use") await useWorkspace(name);
      if (a === "guards") { await guardsUi.edit(name); return; }
      if (a === "rename") {
        const to = await ui.prompt("新名称", { title: `重命名 ${name}`, value: name, ok: "重命名", validate: t => t === name ? "和原来一样" : badName(t) });
        if (!to) return;
        await replay.flush();
        await post(`/workspaces/${enc(name)}/rename`, { name: to });
        toast(`已改名为 ${to}`);
      }
      if (a === "copy") {
        const to = await ui.prompt("副本名称", { title: `复制 ${name}`, value: name + "_copy", ok: "复制", validate: t => badName(t) });
        if (!to) return;
        toast("复制中…", 10000);
        await post(`/workspaces/${enc(name)}/copy`, { name: to });
        toast(`已复制为 ${to}（副本里的定时任务已停用，免得重复运行）`, 4000);
      }
      if (a === "game") {
        const pkg = await ui.dialog({
          title: `${name} 的游戏`, wide: true, body: pickerHtml,
          actions: [{ label: "取消", value: null }, { label: "保存", kind: "primary", value: box => box.dataset.pkg }],
          init: box => initPicker(box, w?.package),
        });
        if (pkg === null || pkg === undefined) return;
        await json(`/workspaces/${enc(name)}`, { method: "PATCH", body: JSON.stringify({ package: pkg }) });
      }
      if (a === "export") {
        const link = document.createElement("a");
        link.href = withToken(`${API}/workspaces/${enc(name)}/export.zip`);
        link.download = name + ".zip";
        link.click();
        return;
      }
      if (a === "delete") {
        if (!await ui.confirm(`规则、模板、技能、指导记录和录像会一起移到回收站，7 天内可以恢复。`, { title: `删除工作区 ${name}？`, ok: "移到回收站", danger: true })) return;
        await json(`/workspaces/${enc(name)}`, { method: "DELETE" });
        toast(`${name} 已移到回收站`);
      }
    } catch (e) {
      ui.alert(e.message, "操作失败");
    }
    await reload();
  }

  async function trashAct(a, id) {
    const t = trash.find(x => x.id === id);
    try {
      if (a === "restore") {
        let name = t.name;
        if (wsStore.list.some(w => w.name === name)) {
          name = await ui.prompt("已经有同名工作区，恢复成另一个名字", { title: `恢复 ${t.name}`, value: t.name + "_restored", ok: "恢复", validate: x => badName(x) });
          if (!name) return;
        }
        await post(`/trash/${enc(id)}/restore`, name !== t.name ? { name } : {});
        toast(`已恢复 ${name}`);
      }
      if (a === "purge") {
        if (!await ui.confirm("彻底删除后不能恢复。", { title: `彻底删除 ${t.name}？`, ok: "彻底删除", danger: true })) return;
        await json(`/trash/${enc(id)}`, { method: "DELETE" });
      }
    } catch (e) {
      ui.alert(e.message, "操作失败");
    }
    await reload();
  }

  async function importZip() {
    const r = await ui.dialog({
      title: "导入工作区",
      body: `<label>zip 文件（maalow ws export 或这里“导出”得到的）<input type="file" id="im-file" accept=".zip,application/zip"></label>
        <label>导入为<input id="im-name" placeholder="工作区名称"></label>
        <div id="im-mode" style="display:none;white-space:normal">
          <div class="dim" style="font-size:13px;margin-bottom:4px">已有同名工作区：</div>
          <label style="flex-direction:row;align-items:center;gap:6px;color:var(--text)"><input type="radio" name="im-mode" value="merge" checked style="min-height:0">合并：加入新文件、覆盖同名文件</label>
          <label style="flex-direction:row;align-items:center;gap:6px;color:var(--text)"><input type="radio" name="im-mode" value="replace" style="min-height:0">替换：工作区变成和 zip 完全一样</label>
        </div>`,
      actions: [{ label: "取消", value: null }, {
        label: "导入", kind: "primary",
        value: box => ({ file: box.querySelector("#im-file").files[0], name: box.querySelector("#im-name").value.trim(), mode: box.querySelector("input[name=im-mode]:checked").value }),
      }],
      check: v => !v.file ? "请选择 zip 文件" : !v.name ? "请填写名称" : !NAME.test(v.name) ? badName(v.name) : "",
      init: box => {
        const name = box.querySelector("#im-name"), mode = box.querySelector("#im-mode");
        const exists = () => { mode.style.display = wsStore.list.some(w => w.name === name.value.trim()) ? "block" : "none"; };
        box.querySelector("#im-file").onchange = e => {
          const f = e.target.files[0];
          if (f && !name.value) name.value = f.name.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[.-]+/, "");
          exists();
        };
        name.oninput = exists;
      },
    });
    if (!r) return;
    const existed = wsStore.list.some(w => w.name === r.name);
    try {
      toast("导入中…", 20000);
      const res = await api(`/workspaces/${enc(r.name)}/import?mode=${existed ? r.mode : "merge"}`, { method: "POST", body: r.file });
      if (!res.ok) throw new Error(await errorText(res));
      const out = await res.json();
      toast(`已导入 ${r.name}：${out.files} 个文件`);
    } catch (e) { ui.alert(e.message, "导入失败"); }
    await reload();
  }

  $("ws-new").onclick = create;
  $("ws-import").onclick = importZip;
  $("ws-grid").onclick = e => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    if (b.dataset.act === "new") return create();
    if (b.dataset.act === "browse") return browseUi.open(b.closest("[data-ws]").dataset.ws, b.dataset.kind);
    act(b.dataset.act, b.closest("[data-ws]").dataset.ws);
  };
  $("ws-trash").onclick = e => {
    const b = e.target.closest("[data-act]");
    if (b) trashAct(b.dataset.act, b.closest("[data-id]").dataset.id);
  };
  wsStore.on(render);

  function enter() { active = true; render(); reload(); }
  function leave() { active = false; }
  return { enter, leave, create };
})();
