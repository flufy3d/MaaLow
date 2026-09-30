// The live stage: take screenshots into the tray and draw numbered marks on them. The canvas edits one tray screenshot
// at a time; with none picked it shows the latest screen (what MaaLow saw last), and drawing on that puts it in the tray.
"use strict";
window.live = (() => {
  const cv = $("cv"), ctx = cv.getContext("2d");
  let tool = "rect", marks = [], draft = null, img = new Image(), file = "", editing = null, latest = "";
  let dirty = false, saveTimer = 0, saving = null;

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
    $("empty").style.display = file ? "none" : "flex";
    cv.style.visibility = file ? "visible" : "hidden";
    const n = teach.tray.findIndex(t => t.id === editing);
    $("shotbadge").textContent = !file ? "" : editing ? `托盘里的第 ${n + 1} 张` : "最新画面 · 在上面画就放进托盘";
    $("shotbadge").className = file ? (editing ? "on" : "latest") : "";
  }

  // pointer events: mouse, pen and touch (the page may be opened on the tablet itself)
  let start = null;
  cv.onpointerdown = e => {
    if (!file) return;
    cv.setPointerCapture(e.pointerId);
    start = canvasPos(cv, e);
    if (tool === "click") { add(toMark("click", start, start)); start = null; }
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
    if (!tinyMark(m)) add(m); else render();
  };
  cv.onpointercancel = () => { start = null; draft = null; render(); };
  $("undo").onclick = () => { if (marks.length) { marks.pop(); changed(); } };
  $("clear").onclick = () => { if (marks.length) { marks = []; changed(); } };

  function add(m) { marks.push(m); changed(); }

  // marks are saved to the tray item shortly after each change (numbered labels, as the teacher sees them)
  const labeled = () => marks.map((m, i) => ({ kind: m.kind, coords: m.coords, label: `${i + 1}号${NAMES[m.kind]}` }));
  function changed() {
    dirty = true;
    render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }
  /** Save pending marks: into the tray item being edited, or put the latest screen in the tray with them. */
  async function flush() {
    clearTimeout(saveTimer);
    if (saving) await saving;
    if (!dirty || !file) return;
    dirty = false;
    const body = labeled();
    saving = (async () => {
      try {
        if (editing) await teach.updateTray(editing, { annotations: body });
        else {
          const item = await teach.addToTray({ type: "shot", file, annotations: body });
          editing = item.id;
          teach.renderTray();
        }
      } catch (e) {
        dirty = true;
        toast("保存标注失败：" + e.message);
      }
    })();
    await saving;
    saving = null;
    render();
  }

  // A screenshot is a saved workspace file; marks are drawn on it.
  function show(path) {
    if (path === file && img.complete) { render(); return; }
    file = path;
    const next = new Image();
    next.onload = () => { if (file !== path) return; img = next; cv.width = next.naturalWidth; cv.height = next.naturalHeight; render(); };
    next.src = teach.fileUrl(path);
    render();
  }

  /** Edit a tray screenshot. */
  async function edit(item) {
    if (item.id === editing) return;
    await flush();
    editing = item.id;
    marks = item.annotations.map(a => ({ kind: a.kind, coords: [...a.coords] }));
    show(item.file);
    teach.renderTray();
  }

  /** The tray changed (sent, an item removed, another page edited): drop what is gone, take others' marks. */
  function trayChanged(items) {
    if (editing == null) return;
    const it = items.find(t => t.id === editing);
    if (!it) { editing = null; marks = []; dirty = false; clearTimeout(saveTimer); show(latest); }
    else if (!dirty && !saving && !start) { marks = it.annotations.map(a => ({ kind: a.kind, coords: [...a.coords] })); render(); }
  }

  /** The latest screenshot (MaaLow acted): shown while no tray screenshot is being edited. */
  function follow(path) {
    if (!path || path === latest) return;
    latest = path;
    if (editing == null && !marks.length && !start) show(path);
  }

  function reset() { editing = null; marks = []; dirty = false; latest = ""; file = ""; clearTimeout(saveTimer); render(); }

  let shooting = false;
  async function takeShot() {
    if (shooting) return;
    shooting = true;
    const label = $("shot").querySelector("span");
    label.textContent = "截图中…";
    try {
      await teach.takeShot();
    } catch (e) {
      ui.alert(e.message, "截图失败");
    } finally {
      shooting = false;
      label.textContent = "截一张";
    }
  }
  $("shot").onclick = takeShot;

  window.addEventListener("keydown", e => {
    if (mode !== "teach" || teach.stage !== "live" || ui.isOpen()) return;
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    const t = TOOLS[Number(e.key) - 1];
    if (t) setTool(t);
    if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey) takeShot();
    if (e.key === "z" && e.ctrlKey && marks.length) { marks.pop(); changed(); }
    if (e.key === "Escape") { start = null; draft = null; render(); }
  });

  function enter() { render(); }

  render();
  return { enter, edit, flush, follow, trayChanged, reset, editing: () => editing };
})();
