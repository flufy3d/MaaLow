// The screen frame the stages share: one 3:2 box showing 1080x720 content, the largest that fits, keeping its place and
// size across modes (only resizing the page or the splitter moves it). On it: the picture (the old one stays until the
// next is drawn), the annotation layer (draw, select, write a label next to a mark) and floating badges. Around it the
// toolbar and the bottom slot, both of fixed height; beside it the splitter to the chat.
"use strict";
window.stage = (() => {
  const W = 1080, H = 720;
  const screen = $("screen"), wrap = $("screenwrap");
  const img = $("scr-img"), ictx = img.getContext("2d"), cv = $("scr-cv"), ctx = cv.getContext("2d");
  const labelIn = $("scr-label");
  const modes = {};
  const active = () => modes[teach.stage];
  const on = () => mode === "teach" && !!active();

  // ---- the frame: the largest 3:2 box the area holds
  function fit() {
    const r = wrap.getBoundingClientRect(), pad = 10;
    let w = r.width - 2 * pad, h = w * H / W;
    if (h > r.height - 2 * pad) { h = r.height - 2 * pad; w = h * W / H; }
    screen.style.width = Math.max(0, Math.floor(w)) + "px";
    screen.style.height = Math.max(0, Math.floor(h)) + "px";
    placeLabel();
  }
  new ResizeObserver(fit).observe(wrap);

  // ---- the picture
  let seq = 0;
  const paint = src => { ictx.fillStyle = "#000"; ictx.fillRect(0, 0, W, H); if (src) ictx.drawImage(src, 0, 0, W, H); };
  /** Show an image or bitmap now (null: black). */
  function show(src) { seq++; paint(src); }
  /** Load an image by URL and show it once it has arrived (a later show or load wins); resolves whether it was shown. */
  function load(url) {
    const n = ++seq;
    return new Promise(res => {
      const i = new Image();
      i.onload = () => { if (n === seq) { paint(i); res(true); } else res(false); };
      i.onerror = () => res(false);
      i.src = url;
    });
  }
  function badge(text, cls = "") { const b = $("scr-badge"); b.innerHTML = text || ""; b.className = text ? cls : ""; }
  /** A message over the picture (empty state, error); "" hides it. */
  function over(html) { const o = $("scr-over"); o.innerHTML = html || ""; o.style.display = html ? "flex" : "none"; }
  function busy(b) { screen.classList.toggle("loading", !!b); }

  // ---- annotations: the mode gives a doc {marks(), change(fn), editable()}; change records undo and saves
  let doc = null, tool = "rect", start = null, draft = null, selected = -1, labelFor = -1;
  function use(d) { closeLabel(false); doc = d; selected = -1; start = null; draft = null; render(); buttons(); }
  function render() {
    ctx.clearRect(0, 0, W, H);
    const ms = doc?.marks() || [];
    ms.forEach((m, i) => drawMark(ctx, m, i + 1, i === selected));
    if (draft) drawMark(ctx, draft, 0);
    cv.style.cursor = doc?.editable() ? "crosshair" : "default";
  }
  function setTool(t) {
    tool = t;
    document.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
  }
  document.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => setTool(b.dataset.tool));
  setTool("rect");

  /** The mark under a point, topmost first; -1: none. */
  function hit(p) {
    const ms = doc?.marks() || [], [px, py] = p;
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i], [x, y, w, h] = m.coords;
      if (m.kind === "click") { if (Math.hypot(px - x, py - y) < 22) return i; }
      else if (m.kind === "arrow") {
        const dx = w - x, dy = h - y, t = Math.max(0, Math.min(1, ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(px - (x + t * dx), py - (y + t * dy)) < 12) return i;
      } else if (px >= x - 8 && px <= x + w + 8 && py >= y - 8 && py <= y + h + 8) return i;
    }
    return -1;
  }
  let onMove = null;
  cv.onpointerdown = e => {
    if (!doc?.editable() || e.button > 0) return;
    closeLabel(true);
    cv.setPointerCapture(e.pointerId);
    start = canvasPos(cv, e);
  };
  cv.onpointermove = e => {
    const p = canvasPos(cv, e);
    onMove?.(p);
    if (!start) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    draft = tool === "click" ? null : toMark(tool, start, evs.length ? canvasPos(cv, evs[evs.length - 1]) : p);
    render();
  };
  cv.onpointerup = e => {
    if (!start) return;
    const p = canvasPos(cv, e), a = start;
    start = null; draft = null;
    const m = toMark(tool, a, p);
    if (tool !== "click" && !tinyMark(m)) { add(m); return; }
    const i = hit(p); // a tap: pick a mark (to write its label), or put a click point
    if (i >= 0) select(i, true);
    else if (tool === "click") add(toMark("click", p, p));
    else select(-1);
  };
  cv.onpointercancel = () => { start = null; draft = null; render(); };
  cv.onpointerleave = () => onMove?.(null);

  function add(m) {
    doc.change(ms => ms.push({ ...m, label: "" }));
    select(doc.marks().length - 1, true);
  }
  function select(i, edit) {
    selected = i;
    render();
    if (edit && i >= 0) openLabel(i); else closeLabel(true);
  }
  function remove(i) {
    if (i < 0 || !doc?.editable()) return;
    closeLabel(false);
    doc.change(ms => ms.splice(i, 1));
    selected = -1;
    render();
  }

  // the label box: under the mark (above it near the bottom edge), in the frame's CSS pixels
  function placeLabel() {
    if (labelFor < 0 || !doc) return;
    const m = doc.marks()[labelFor];
    if (!m) { closeLabel(false); return; }
    const [x, y, w, h] = m.coords, k = screen.clientWidth / W;
    const bottom = m.kind === "click" ? y + 24 : m.kind === "arrow" ? Math.max(y, h) + 8 : y + h + 8;
    const left = m.kind === "arrow" ? Math.min(x, w) : m.kind === "click" ? x - 20 : x;
    const bw = Math.min(260, screen.clientWidth - 8);
    labelIn.style.width = bw + "px";
    labelIn.style.left = Math.max(4, Math.min(screen.clientWidth - bw - 4, left * k)) + "px";
    let top = bottom * k;
    if (top > screen.clientHeight - 40) top = Math.max(4, (m.kind === "click" ? y - 50 : y - 8) * k - 34);
    labelIn.style.top = top + "px";
  }
  function openLabel(i) {
    labelFor = i;
    labelIn.value = doc.marks()[i]?.label || "";
    labelIn.placeholder = `${i + 1} 号${NAMES[doc.marks()[i].kind]}的说明（回车跳过）`;
    labelIn.style.display = "block";
    placeLabel();
    requestAnimationFrame(() => labelIn.focus());
  }
  function closeLabel(commit) {
    if (labelFor < 0) return;
    const i = labelFor, v = labelIn.value.trim();
    labelFor = -1;
    labelIn.style.display = "none";
    if (commit && doc && doc.marks()[i] && (doc.marks()[i].label || "") !== v) doc.change(ms => { ms[i].label = v; });
    render();
  }
  labelIn.onkeydown = e => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); closeLabel(true); }
    else if (e.key === "Escape") { e.preventDefault(); closeLabel(false); }
  };
  labelIn.onblur = () => closeLabel(true);

  // ---- toolbar: undo / redo / clear go to the mode shown
  function buttons() {
    const m = on() ? active() : null;
    $("undo").disabled = !m?.canUndo?.();
    $("redo").disabled = !m?.canRedo?.();
    $("clear").disabled = !doc?.editable() || !(doc?.marks().length);
  }
  $("undo").onclick = () => { closeLabel(true); active()?.undo(); };
  $("redo").onclick = () => { closeLabel(true); active()?.redo(); };
  $("clear").onclick = () => { if (doc?.editable() && doc.marks().length) { closeLabel(false); doc.change(ms => { ms.length = 0; }); selected = -1; render(); } };
  /** The save state and the send button's look, for the mode shown. */
  function status(text, cls = "") { const s = $("savestate"); s.textContent = text || ""; s.className = cls; }

  // ---- keys shared by the stages
  const typing = t => t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
  window.addEventListener("keydown", e => {
    if (!on() || ui.isOpen()) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (typing(e.target)) { if (k === "Escape") e.target.blur(); return; }
    if (ctrl && (k === "z" || k === "Z")) { e.preventDefault(); e.shiftKey ? active().redo() : active().undo(); return; }
    if (ctrl && (k === "y" || k === "Y")) { e.preventDefault(); active().redo(); return; }
    if (ctrl || e.altKey) return;
    if (k === "Delete" || k === "Backspace") { if (selected >= 0) { e.preventDefault(); remove(selected); } return; }
    if (k === "Escape") {
      if (start || draft || selected >= 0) { start = null; draft = null; select(-1); }
      else active().escape?.();
      return;
    }
    const t = TOOLS[Number(k) - 1];
    if (t) setTool(t);
  });

  // ---- the splitter between stage and chat: dragged, remembered, folds a side below its minimum
  const teachEl = $("teach"), chat = $("chat"), split = $("split");
  const KEY = "maalow-split", DEF = 0.3, CHAT_MIN = 280, STAGE_MIN = 480;
  let frac = parseFloat(localStorage.getItem(KEY));
  if (!(frac >= 0 && frac <= 1)) frac = DEF; // chat width / page width; 0: chat folded, 1: stage folded
  function applySplit() {
    const w = teachEl.clientWidth;
    teachEl.classList.toggle("chat-folded", frac === 0);
    teachEl.classList.toggle("stage-folded", frac === 1);
    if (!w || frac === 0 || frac === 1) { chat.style.width = ""; return; }
    chat.style.width = Math.round(Math.min(Math.max(frac * w, CHAT_MIN), Math.max(CHAT_MIN, w - STAGE_MIN))) + "px";
  }
  split.onpointerdown = e => {
    if (e.button > 0) return;
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    split.classList.add("drag");
    const r = teachEl.getBoundingClientRect();
    split.onpointermove = ev => {
      const cw = r.right - ev.clientX;
      frac = cw < CHAT_MIN - 60 ? 0 : r.width - cw < STAGE_MIN - 60 ? 1 : cw / r.width;
      applySplit();
    };
    split.onpointerup = split.onpointercancel = () => {
      split.onpointermove = split.onpointerup = split.onpointercancel = null;
      split.classList.remove("drag");
      localStorage.setItem(KEY, String(frac));
    };
  };
  split.ondblclick = () => { frac = DEF; applySplit(); localStorage.setItem(KEY, String(frac)); };
  new ResizeObserver(applySplit).observe(teachEl); // also when the page is first shown (hidden, it has no width)

  // narrow screens (a tablet held upright): the chat is a drawer
  $("chattoggle").onclick = () => chat.classList.toggle("open");
  document.addEventListener("pointerdown", e => {
    if (chat.classList.contains("open") && !chat.contains(e.target) && !$("chattoggle").contains(e.target) && !$("dlg").contains(e.target)) chat.classList.remove("open");
  });

  return {
    register: (name, m) => { modes[name] = m; },
    use, render, show, load, badge, over, busy, buttons, status, fit,
    set onMove(f) { onMove = f; },
    get selected() { return selected; },
    reset() { closeLabel(false); selected = -1; start = null; draft = null; render(); },
    screen,
  };
})();
