// Read-only browsers of a workspace: pipeline files and their nodes, templates (and which nodes use them), skills.
"use strict";
window.browseUi = (() => {
  const fileUrl = (ws, path) => withToken(`${API}/files/${enc(ws)}/${path.split("/").map(enc).join("/")}`);
  const text = async (ws, path) => {
    const r = await api(`/files/${enc(ws)}/${path.split("/").map(enc).join("/")}`);
    if (!r.ok) throw new Error(await errorText(r));
    return r.text();
  };
  const tree = ws => json(`/files/${enc(ws)}/`);

  /** Rows that expand to the file's text, loaded on first open. */
  function expandable(box, ws) {
    box.addEventListener("click", async e => {
      const head = e.target.closest("[data-open]");
      if (!head) return;
      const pre = head.parentElement.querySelector("pre");
      if (pre.dataset.loaded) { pre.hidden = !pre.hidden; return; }
      pre.hidden = false;
      pre.textContent = "读取中…";
      try { pre.textContent = await text(ws, head.dataset.open); pre.dataset.loaded = "1"; }
      catch (err) { pre.textContent = "读取失败：" + err.message; }
    });
  }

  async function pipelines(ws) {
    const g = await json("/guards?workspace=" + enc(ws));
    const on = new Set(g.guards), off = new Set(g.off);
    const files = [...new Set(g.nodes.map(x => x.file))];
    const body = files.length ? files.map(f => `<div class="bitem">
        <div class="bhead" data-open="pipeline/${esc(f)}">${svg("file", "sm")}<b class="mono">${esc(f)}</b>
          <span class="dim">${g.nodes.filter(x => x.file === f).length} 个节点</span><span class="grow"></span><span class="dim sm">${svg("code", "sm")}看 JSON</span></div>
        <div class="rows">${g.nodes.filter(x => x.file === f).map(x => `<div class="row"><div class="k"><b>${esc(x.name)}
            ${on.has(x.name) ? `<span class="chip ok">守护中</span>` : off.has(x.name) ? `<span class="chip">守护已停用</span>` : ""}</b>
            <small>${esc(x.desc || "没有说明")}</small></div></div>`).join("")}</div>
        <pre class="code" hidden></pre></div>`).join("")
      : `<div class="none">还没有规则文件（pipeline/*.json）。在指导页让 MaaLow 把教的内容写成规则。</div>`;
    ui.dialog({ title: `${svg("file")}${esc(ws)} 的规则文件`, wide: true, body, init: box => expandable(box, ws) });
  }

  async function templates(ws) {
    const [files, g] = await Promise.all([tree(ws), json("/guards?workspace=" + enc(ws))]);
    const pngs = files.filter(f => f.path.startsWith("templates/") && f.path.endsWith(".png"));
    // which nodes name each template (MaaFramework template paths are relative to templates/)
    const users = {};
    await Promise.all([...new Set(g.nodes.map(x => x.file))].map(async f => {
      try {
        const obj = JSON.parse(await text(ws, "pipeline/" + f));
        for (const [node, v] of Object.entries(obj)) {
          for (const t of [v?.template].flat().filter(x => typeof x === "string")) (users[t] ??= []).push(node);
        }
      } catch (e) { /* a file that does not parse: no usage shown */ }
    }));
    const body = pngs.length ? `<div class="tgrid">${pngs.map(f => {
        const rel = f.path.slice("templates/".length), used = users[rel] || [];
        return `<a class="titem" href="${fileUrl(ws, f.path)}" target="_blank" title="打开原图">
          <span class="timg"><img src="${fileUrl(ws, f.path)}" alt="" loading="lazy"></span>
          <b class="mono">${esc(rel)}</b>
          <small>${fmtSize(f.size)} · ${used.length ? "用于 " + used.map(esc).join("、") : `<span style="color:var(--yellow)">没有节点用到</span>`}</small></a>`;
      }).join("")}</div>`
      : `<div class="none">还没有模板图（templates/*.png）。</div>`;
    ui.dialog({ title: `${svg("image")}${esc(ws)} 的模板`, wide: true, body });
  }

  async function skills(ws) {
    const list = await json("/skills?workspace=" + enc(ws));
    const body = list.length ? list.map(s => `<div class="bitem">
        <div class="bhead" data-open="${esc(s.path)}">${svg("code", "sm")}<b class="mono">${esc(s.name)}</b>
          ${s.error ? `<span class="chip bad">加载出错</span>` : s.recognition ? `<span class="chip">自定义识别</span>` : ""}
          <span class="grow"></span><span class="dim sm">${svg("code", "sm")}看源码</span></div>
        <div class="dim" style="font-size:13px;padding:0 2px 6px">${esc(s.error ? `${s.error.message || s.error}${s.error.line ? `（第 ${s.error.line} 行）` : ""}` : s.description || "没有说明")}
          ${s.timeout ? ` · 超时 ${Math.round(s.timeout / 1000)} 秒` : ""} · 修改于 ${fmtWhen(s.mtime)}</div>
        <pre class="code" hidden></pre></div>`).join("")
      : `<div class="none">还没有技能（skills/*.js）。</div>`;
    ui.dialog({ title: `${svg("code")}${esc(ws)} 的技能`, wide: true, body, init: box => expandable(box, ws) });
  }

  const kinds = { pipelines, templates, skills };
  async function open(ws, kind) {
    try { await kinds[kind](ws); } catch (e) { ui.alert(e.message, "读取失败"); }
  }
  return { open };
})();
