// The live screenshot stage: screenshots go into the tray, to be marked up and described. It edits one tray screenshot
// at a time; with none picked it shows the latest screen (what MaaLow saw last), and drawing on that, or describing it,
// puts a copy of it in the tray (the app keeps a file of its own for each tray item).
"use strict";
window.live = (() => {
  let file = "", editing = null, latest = "", marks = [], text = "", active = false;
  let dirty = false, saveTimer = 0, saving = null, undoStack = [], redoStack = [], error = "";

  const copyMarks = ms => ms.map(m => ({ kind: m.kind, coords: [...m.coords], label: m.label || "" }));
  const snap = () => ({ marks: copyMarks(marks), text });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const doc = {
    marks: () => marks,
    editable: () => !!file,
    change(fn) {
      const before = snap();
      fn(marks);
      const after = snap();
      if (same(before, after)) return;
      undoStack.push({ before, after });
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
      changed();
    },
  };

  function restore(s) {
    marks = copyMarks(s.marks); text = s.text;
    $("lv-text").value = text;
    stage.reset();
    changed();
  }
  const ops = {
    undo() { const u = undoStack.pop(); if (u) { redoStack.push(u); restore(u.before); } },
    redo() { const u = redoStack.pop(); if (u) { undoStack.push(u); restore(u.after); } },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  };
  stage.register("live", ops);

  function changed() {
    dirty = true;
    if (active) { stage.render(); stage.buttons(); }
    refresh();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }

  /** Save pending edits into the tray item; from the latest screen, a copy of it goes in the tray first. */
  async function flush() {
    clearTimeout(saveTimer);
    while (saving) await saving;
    if (!dirty || !file) return;
    dirty = false;
    const body = { annotations: copyMarks(marks), text };
    saving = (async () => {
      try {
        if (editing) await teach.updateTray(editing, body);
        else {
          const item = await teach.addToTray({ type: "shot", file, copy: true, ...body });
          editing = item.id;
          if (item.file !== file) { file = item.file; if (active) stage.load(teach.fileUrl(file)); }
          teach.renderTray();
        }
        error = "";
      } catch (e) {
        dirty = true;
        error = e.message;
        toast("保存标注失败：" + e.message);
      }
    })();
    await saving;
    saving = null;
    refresh();
  }

  function refresh() {
    if (!active) return;
    const n = teach.tray.findIndex(t => t.id === editing);
    stage.badge(!file ? "" : editing ? `托盘第 ${n + 1} 张` : "最新画面 · 在上面画、写说明就放进托盘", editing ? "tray" : "latest");
    $("lv-where").textContent = !file ? "还没有画面" : editing ? `正在编辑托盘第 ${n + 1} 张 · 改动自动保存` : "MaaLow 最后看到的画面";
    stage.status(error ? "⚠ 保存失败" : dirty || saving ? "保存中…" : editing ? "✓ 已存进托盘" : "", error ? "bad" : dirty || saving ? "dirty" : "ok");
    const b = $("toai");
    b.disabled = !file || !!editing;
    b.title = editing ? "已经在托盘里了" : "把这张画面放进待发托盘（A）";
    stage.over(file ? "" : `<img src="web/mascot.png" alt=""><div>点 <b>截一张</b> 获取平板当前画面，<br>画框、圈、箭头并写上说明，截图会放进右边的待发托盘。</div>`);
    stage.buttons();
  }

  function show(path) {
    file = path;
    if (active && path) stage.load(teach.fileUrl(path));
    refresh();
  }
  function reset() {
    editing = null; marks = []; text = ""; dirty = false; clearTimeout(saveTimer);
    undoStack = []; redoStack = [];
    $("lv-text").value = "";
    if (active) stage.reset();
  }

  /** Edit a tray screenshot: its picture, marks and text come back here, changes go back into it. */
  async function edit(item) {
    if (item.id === editing) return;
    await flush();
    reset();
    editing = item.id;
    marks = copyMarks(item.annotations);
    text = item.text || "";
    $("lv-text").value = text;
    show(item.file);
    if (active) stage.render();
    teach.renderTray();
  }

  /** The tray changed (sent, an item removed, another page edited): drop what is gone, take others' edits. */
  function trayChanged(items) {
    if (editing == null) return;
    const it = items.find(t => t.id === editing);
    if (!it) { reset(); show(latest); }
    else if (!dirty && !saving && document.activeElement !== $("lv-text") && stage.selected < 0) {
      marks = copyMarks(it.annotations); text = it.text || "";
      $("lv-text").value = text;
      if (active) stage.render();
      refresh();
    }
  }

  /** The latest screenshot (MaaLow acted): shown while nothing is being edited here. */
  function follow(path) {
    if (!path || path === latest) return;
    latest = path;
    if (editing == null && !marks.length && !text) show(path);
  }

  // the screenshot's own text: saved like the marks, one undo step per edit
  const ta = $("lv-text");
  let textSnap = null;
  ta.onfocus = () => { textSnap = snap(); };
  ta.oninput = () => { if (!file) return; text = ta.value; changed(); };
  ta.onblur = () => {
    if (!textSnap) return;
    const after = snap();
    if (!same(textSnap, after)) { undoStack.push({ before: textSnap, after }); redoStack = []; stage.buttons(); }
    textSnap = null;
  };

  let shooting = false;
  async function takeShot() {
    if (shooting) return;
    shooting = true;
    const label = $("shot").querySelector(".tl");
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
  $("toai").addEventListener("click", () => { if (active && file && !editing) { dirty = true; flush(); } });

  window.addEventListener("keydown", e => {
    if (!active || mode !== "teach" || ui.isOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === "s" || e.key === "S") takeShot();
    if ((e.key === "a" || e.key === "A") && file && !editing) { dirty = true; flush(); }
  });

  function enter() {
    active = true;
    stage.use(doc);
    stage.onMove = p => { $("lv-info").textContent = p ? `(${p[0]}, ${p[1]}) · 1080×720` : "1080×720"; };
    $("lv-info").textContent = "1080×720";
    if (file) stage.load(teach.fileUrl(file)); else stage.show(null);
    refresh();
  }
  function leave() { active = false; flush(); }

  return { enter, leave, edit, flush, follow, trayChanged, reset: () => { reset(); file = ""; latest = ""; refresh(); }, editing: () => editing };
})();
