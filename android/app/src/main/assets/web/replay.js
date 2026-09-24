// Replay teaching: record the tablet, find the exact frame, annotate it. Frames shown while paused are decoded by the
// app by frame number (never the browser's video seek); the <video> is only for quick playback.
"use strict";
window.replay = (() => {
  const FPS = 30;
  const cv = $("rp-cv"), ctx = cv.getContext("2d"), box = $("rp-box"), video = $("rp-video");
  const scrub = $("rp-scrub"), sctx = scrub.getContext("2d"), pop = $("rp-pop");
  const enc = encodeURIComponent;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const timeMs = n => Math.round(n * 1000 / FPS);
  const fmtClock = ms => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const fmtTime = ms => `${fmtClock(ms)}.${String(ms % 1000).padStart(3, "0")}`;

  let started = false, active = false;
  let ws = "", recs = [], rec = null, total = 0;
  let cur = -1, want = -1, image = null, loading = false, lastDir = 0;
  const bitmaps = new Map(); // "id:n" -> Promise<ImageBitmap>, most recent last
  let labels = { version: 0, frames: {} };
  const dirty = new Set();
  let saving = false, saveTimer = 0, saveError = "";
  let undoStack = [], redoStack = [];
  let tool = "rect", start = null, draft = null, selected = -1;
  let recState = { recording: false }, recPolled = 0;
  let playing = false, videoFrame = 0, hideVideoOnLoad = false;
  let drag = null, hover = null, hold = null, editing = null;

  const base = () => `/recordings/${enc(ws)}/${enc(rec.id)}`;
  const entry = n => labels.frames[n];
  const marksOf = n => entry(n)?.annotations || [];
  const labeledFrames = () => Object.keys(labels.frames).map(Number).sort((a, b) => a - b);
  const sheetUrl = (r, k) => withToken(`${API}/recordings/${enc(ws)}/${enc(r.id)}/thumbs/${k}`);

  // ---- frames

  function fetchFrame(n) {
    const key = rec.id + ":" + n;
    let p = bitmaps.get(key);
    if (p) { bitmaps.delete(key); bitmaps.set(key, p); return p; }
    p = api(`${base()}/frame?n=${n}&q=90`).then(async r => {
      if (!r.ok) throw new Error(await errorText(r));
      return createImageBitmap(await r.blob());
    });
    p.catch(() => bitmaps.delete(key));
    bitmaps.set(key, p);
    while (bitmaps.size > 120) bitmaps.delete(bitmaps.keys().next().value);
    return p;
  }

  /** Show frame n (exact, from the app). Numbers update at once; the image follows. */
  function goto(n) {
    if (!rec || !total) return;
    n = clamp(Math.round(n), 0, total - 1);
    if (playing) stopVideo(false);
    const from = want >= 0 ? want : cur;
    lastDir = Math.sign(n - from);
    want = n;
    updatePos();
    pump();
  }

  async function pump() {
    if (loading) return;
    loading = true;
    $("rp-badge").classList.add("loading");
    try {
      while (rec && want !== cur) {
        const n = want, id = rec.id;
        let bmp;
        try {
          bmp = await fetchFrame(n);
        } catch (e) {
          toast("取帧失败：" + e.message);
          want = cur; updatePos();
          break;
        }
        if (!rec || rec.id !== id) break;
        if (want !== n && hold) continue; // stepping on: skip straight to the newest target
        show(n, bmp);
        const next = n + lastDir;
        if (lastDir && want === n && next >= 0 && next < total) fetchFrame(next).catch(() => {}); // stepping: fetch ahead
      }
    } finally {
      loading = false;
      $("rp-badge").classList.remove("loading");
    }
  }

  function show(n, bmp) {
    const changed = n !== cur;
    cur = n; image = bmp;
    if (changed) { selected = -1; start = null; draft = null; }
    if (hideVideoOnLoad) { hideVideoOnLoad = false; box.classList.remove("playing"); }
    render(); drawScrub(); refreshFrame(); refreshLabeled();
    history.replaceState(null, "", `#replay/${rec.id}/${cur}`);
  }

  function updatePos(n = want >= 0 ? want : cur) {
    const has = rec && n >= 0;
    const ms = has ? timeMs(n) : 0;
    if (document.activeElement !== $("rp-n")) $("rp-n").value = has ? n : "";
    $("rp-total").textContent = has ? total - 1 : 0;
    $("rp-time").textContent = has ? `${fmtTime(ms)} · ${ms} ms` : "";
    $("rp-badgetext").textContent = has ? `#${n} · ${ms} ms` : "—";
    $("rp-framehead").textContent = has ? `第 ${n} 帧 · ${ms} ms` : "当前帧";
  }

  // hold ← / → (or a step button) to keep stepping, as fast as frames arrive (at most 30 per second)
  function startHold(d) {
    stopHold();
    goto((want >= 0 ? want : cur) + d);
    hold = { d, t: setTimeout(function tick() {
      if (!hold) return;
      const at = want >= 0 ? want : cur;
      if (!loading && at + hold.d >= 0 && at + hold.d < total) goto(at + hold.d);
      hold.t = setTimeout(tick, 33);
    }, 320) };
  }
  function stopHold() { if (hold) { clearTimeout(hold.t); hold = null; } }

  function labeledStep(d) {
    const at = want >= 0 ? want : cur, all = labeledFrames();
    const n = d > 0 ? all.find(f => f > at) : all.reverse().find(f => f < at);
    if (n === undefined) toast(d > 0 ? "后面没有已标注的帧了" : "前面没有已标注的帧了", 1500);
    else goto(n);
  }

  // ---- playback (browser video, for browsing only)

  function play() {
    if (!rec || playing) return;
    stopHold();
    const src = withToken(`${API}${base()}/video.mp4`);
    if (video.dataset.src !== src) { video.src = src; video.dataset.src = src; }
    let n = want >= 0 ? want : cur;
    if (n >= total - 1) n = 0;
    videoFrame = n;
    playing = true; hideVideoOnLoad = false;
    box.classList.add("playing");
    $("rp-play").textContent = "⏸";
    video.currentTime = (n + 0.5) / FPS;
    video.play().catch(e => { toast("无法播放：" + e.message); stopVideo(false); box.classList.remove("playing"); });
    track();
  }

  function track() {
    if (!playing) return;
    const step = t => {
      if (!playing) return;
      videoFrame = clamp(Math.round(t * FPS), 0, total - 1);
      want = videoFrame; updatePos(); drawScrub();
      track();
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback((now, md) => step(md.mediaTime));
    else requestAnimationFrame(() => step(video.currentTime));
  }

  /** Pause; load: then show the exact frame the video stopped at (the video stays up until it arrives). */
  function stopVideo(load) {
    if (!playing) return;
    playing = false;
    video.pause();
    $("rp-play").textContent = "▶";
    if (load) {
      hideVideoOnLoad = true;
      const n = videoFrame;
      cur = -1; // force a fresh show even if it is the frame shown before playing
      goto(n);
    } else box.classList.remove("playing");
  }
  video.onended = () => stopVideo(true);
  const togglePlay = () => playing ? stopVideo(true) : play();

  // ---- drawing

  let frameReq = 0;
  function render() {
    frameReq = 0;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (image) ctx.drawImage(image, 0, 0, cv.width, cv.height);
    if (cur >= 0) marksOf(cur).forEach((m, i) => drawMark(ctx, m, i + 1, i === selected));
    if (draft) drawMark(ctx, draft, 0);
    const ph = $("rp-placeholder");
    ph.style.display = rec ? "none" : "block";
    box.style.visibility = rec ? "visible" : "hidden";
    ph.innerHTML = recState.recording ? "录制中……在平板上正常操作。<br>结束录制后可以逐帧查看和标注。"
      : "选择右侧的录像，或点“开始录制”录一段在平板上的真实操作（最长 3 分钟）。";
  }
  const requestRender = () => { if (!frameReq) frameReq = requestAnimationFrame(render); };

  function setTool(t) {
    tool = t;
    document.querySelectorAll("[data-rtool]").forEach(b => b.classList.toggle("on", b.dataset.rtool === t));
  }
  document.querySelectorAll("[data-rtool]").forEach(b => b.onclick = () => setTool(b.dataset.rtool));
  setTool("rect");

  const canDraw = () => rec && cur >= 0 && !playing && cur === want;
  cv.onpointerdown = e => {
    if (!canDraw() || e.button > 0) return;
    cv.setPointerCapture(e.pointerId);
    start = canvasPos(cv, e);
    if (tool === "click") { addMark(toMark("click", start, start), e.pointerType); start = null; }
  };
  cv.onpointermove = e => {
    if (!start) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    draft = toMark(tool, start, canvasPos(cv, evs.length ? evs[evs.length - 1] : e));
    requestRender();
  };
  cv.onpointerup = e => {
    if (!start) return;
    const m = toMark(tool, start, canvasPos(cv, e));
    start = null; draft = null;
    if (!tinyMark(m)) addMark(m, e.pointerType); else render();
  };
  cv.onpointercancel = () => { start = null; draft = null; render(); };

  function addMark(m, pointer) {
    const n = cur;
    mutate(n, e => e.annotations.push({ ...m, label: "" }));
    selected = marksOf(n).length - 1;
    refreshFrame(); render();
    if (pointer === "mouse") $("rp-marks").querySelector(`.mk[data-i="${selected}"] input`)?.focus(); // type its note right away
  }

  // ---- label edits, undo, autosave

  const snapshot = n => {
    const e = entry(n);
    return { note: e?.note || "", annotations: (e?.annotations || []).map(a => ({ kind: a.kind, coords: [...a.coords], label: a.label || "" })) };
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function ensure(n) { return labels.frames[n] || (labels.frames[n] = { rev: 0, note: "", annotations: [] }); }

  function mutate(n, fn) {
    const before = snapshot(n);
    fn(ensure(n));
    const after = snapshot(n);
    if (same(before, after)) return;
    pushUndo(n, before, after);
    touched(n);
  }
  function pushUndo(n, before, after) {
    undoStack.push({ n, before, after });
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
    undoButtons();
  }
  function touched(n, quiet) {
    dirty.add(n);
    scheduleSave();
    drawScrub(); refreshLabeled();
    if (!quiet) { refreshFrame(); render(); }
  }
  function apply(n, s) {
    const e = ensure(n);
    e.note = s.note;
    e.annotations = s.annotations.map(a => ({ ...a, coords: [...a.coords] }));
    selected = -1;
    touched(n);
  }
  function undo(redo) {
    const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
    const u = from.pop();
    if (!u) return;
    to.push(u);
    if (u.n !== cur) goto(u.n);
    apply(u.n, redo ? u.after : u.before);
    undoButtons();
    toast(`${redo ? "重做" : "撤销"}：第 ${u.n} 帧`, 1200);
  }
  function undoButtons() {
    $("rp-undo").disabled = !undoStack.length;
    $("rp-redo").disabled = !redoStack.length;
  }
  $("rp-undo").onclick = () => undo(false);
  $("rp-redo").onclick = () => undo(true);

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 700);
    saveStatus();
  }

  async function flush() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (saving) { saveTimer = setTimeout(flush, 300); return; }
    if (!dirty.size || !rec) { saveStatus(); return; }
    saving = true; saveStatus();
    const id = rec.id, w = ws;
    try {
      for (const n of [...dirty]) {
        dirty.delete(n);
        const e = entry(n) || { rev: 0, note: "", annotations: [] };
        const body = { rev: e.rev || 0, note: e.note || "", annotations: e.annotations.map(a => ({ kind: a.kind, coords: a.coords, label: a.label || "" })) };
        let out;
        try {
          out = await putFrame(w, id, n, body);
        } catch (err) {
          dirty.add(n);
          throw err;
        }
        if (!rec || rec.id !== id) return;
        if (out.conflict) await conflict(w, id, n, out.body, body);
        else saved(n, out.body);
      }
      saveError = "";
    } catch (err) {
      saveError = err.message;
      if (rec && rec.id === id) saveTimer = setTimeout(flush, 3000);
    } finally {
      saving = false;
      saveStatus();
    }
  }

  async function putFrame(w, id, n, body) {
    const r = await api(`/recordings/${enc(w)}/${enc(id)}/labels/${n}`, { method: "PUT", body: JSON.stringify(body) });
    if (r.status === 409) return { conflict: true, body: await r.json() };
    if (!r.ok) throw new Error(await errorText(r));
    return { body: await r.json() };
  }

  function saved(n, out) {
    labels.version = Math.max(labels.version, out.version);
    const rev = out.current?.rev || 0;
    if (dirty.has(n)) { if (entry(n)) entry(n).rev = rev; } // edited again meanwhile: keep the edits, on the new revision
    else if (!rev) delete labels.frames[n];
    else labels.frames[n] = out.current;
  }

  async function conflict(w, id, n, out, mine) {
    const overwrite = confirm(`第 ${n} 帧的标注已被另一个页面修改。\n\n确定：用这个页面的标注覆盖\n取消：放弃这里的修改，载入另一个页面的`);
    if (overwrite) {
      const r = await putFrame(w, id, n, { ...mine, force: true });
      saved(n, r.body);
    } else {
      labels.version = Math.max(labels.version, out.version);
      if (out.current?.rev) labels.frames[n] = out.current; else delete labels.frames[n];
      if (n === cur) { selected = -1; refreshFrame(); render(); }
      refreshLabeled(); drawScrub();
    }
  }

  function saveStatus() {
    const s = $("rp-save");
    if (!rec) { s.textContent = ""; s.className = ""; return; }
    if (saving) { s.textContent = "保存中…"; s.className = "dirty"; }
    else if (saveError) { s.textContent = "⚠ 保存失败，稍后重试"; s.title = saveError; s.className = "bad"; }
    else if (dirty.size) { s.textContent = "● 未保存"; s.className = "dirty"; }
    else { s.textContent = "✓ 已保存"; s.title = ""; s.className = "ok"; }
  }
  window.addEventListener("beforeunload", e => {
    if (dirty.size || saving) { flush(); e.preventDefault(); e.returnValue = ""; }
  });

  // labels changed elsewhere (another page, or `maalow sync`): take them for every frame not being edited here
  async function pollLabels() {
    if (!active || !rec || saving || dirty.size || document.hidden) return;
    try {
      const id = rec.id;
      const l = await json(`${base()}/labels`);
      if (!rec || rec.id !== id || saving || dirty.size || l.version <= labels.version) return;
      labels = l;
      if (selected >= marksOf(cur).length) selected = -1;
      refreshFrame(); refreshLabeled(); render(); drawScrub();
    } catch (e) { /* app restarting */ }
  }
  setInterval(pollLabels, 4000);

  // ---- side panel: this frame's note and marks, labeled frames

  function refreshFrame() {
    const has = rec && cur >= 0;
    const note = $("rp-note");
    note.disabled = !has;
    if (document.activeElement !== note) note.value = has ? entry(cur)?.note || "" : "";
    const el = $("rp-marks");
    if (!has) { el.innerHTML = ""; return; }
    const ms = marksOf(cur);
    el.innerHTML = ms.length ? ms.map((m, i) => `
      <div class="mk${i === selected ? " sel" : ""}" data-i="${i}">
        <span class="chip" style="background:${COLORS[m.kind]}" title="选中">${i + 1} ${NAMES[m.kind]}</span>
        <input value="${esc(m.label)}" placeholder="说明：这是什么 / 为什么">
        <button class="btn" data-del title="删除（Delete）">✕</button>
      </div>`).join("")
      : `<div class="none">在画面上拖动画框、圈、箭头、区域，或点一下标点击点；每个标注都可以写说明。</div>`;
  }

  function select(i) {
    selected = i;
    $("rp-marks").querySelectorAll(".mk").forEach(d => d.classList.toggle("sel", Number(d.dataset.i) === i));
    render();
  }

  // typing edits the label in place (no re-render, focus stays); one undo step per focus
  let focusSnap = null;
  const marksEl = $("rp-marks");
  marksEl.addEventListener("click", e => {
    const row = e.target.closest(".mk");
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest("[data-del]")) { deleteMark(i); return; }
    select(i);
  });
  marksEl.addEventListener("focusin", e => {
    const row = e.target.closest(".mk");
    if (row && e.target.tagName === "INPUT") { select(Number(row.dataset.i)); focusSnap = snapshot(cur); }
  });
  marksEl.addEventListener("input", e => {
    const row = e.target.closest(".mk");
    const m = row && marksOf(cur)[Number(row.dataset.i)];
    if (!m) return;
    m.label = e.target.value;
    touched(cur, true);
  });
  marksEl.addEventListener("focusout", e => {
    if (focusSnap && e.target.tagName === "INPUT") {
      const after = snapshot(cur);
      if (!same(focusSnap, after)) pushUndo(cur, focusSnap, after);
      focusSnap = null;
    }
  });
  marksEl.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") e.target.blur();
  });

  const note = $("rp-note");
  let noteSnap = null;
  note.onfocus = () => { noteSnap = snapshot(cur); };
  note.oninput = () => { if (cur < 0) return; ensure(cur).note = note.value; touched(cur, true); };
  note.onblur = () => {
    if (!noteSnap) return;
    const after = snapshot(cur);
    if (!same(noteSnap, after)) pushUndo(cur, noteSnap, after);
    noteSnap = null;
  };

  function deleteMark(i) {
    if (i < 0 || i >= marksOf(cur).length) return;
    mutate(cur, e => e.annotations.splice(i, 1));
    selected = -1;
    refreshFrame(); render();
  }

  function refreshLabeled() {
    const all = labeledFrames();
    $("rp-labcount").textContent = rec ? `${all.length} 帧` : "";
    $("rp-labeled").innerHTML = !rec ? "" : all.length ? all.map(n => {
      const e = entry(n), k = e.annotations?.length || 0;
      const what = [k ? `${k} 个标注` : "", e.note || e.annotations?.map(a => a.label).filter(Boolean).join("；") || ""].filter(Boolean).join(" · ");
      return `<div class="lf${n === cur ? " cur" : ""}" data-n="${n}"><b>#${n}</b><span class="t">${fmtTime(timeMs(n))}</span><span class="s">${esc(what)}</span></div>`;
    }).join("") : `<div class="none" style="padding:0 6px">还没有标注。定位到关键帧（预警、出手、闪避）后在画面上标注。</div>`;
  }
  $("rp-labeled").onclick = e => { const d = e.target.closest(".lf"); if (d) goto(Number(d.dataset.n)); };

  // ---- scrubber: as wide as the frame, labeled frames marked, thumbnails while dragging

  // the frame fits the stage keeping its aspect ratio; the scrubber below follows its width
  function layout() {
    const r = $("rp-stage").getBoundingClientRect(), ar = cv.width / cv.height;
    if (!r.width || !r.height) return;
    let w = r.width, h = w / ar;
    if (h > r.height) { h = r.height; w = h * ar; }
    cv.style.width = Math.floor(w) + "px";
    cv.style.height = Math.floor(h) + "px";
  }
  new ResizeObserver(layout).observe($("rp-stage"));

  const dpr = () => window.devicePixelRatio || 1;
  function sizeScrub() {
    const w = Math.round(cv.getBoundingClientRect().width) || 0;
    $("rp-scrubwrap").style.width = w + "px";
    scrub.width = Math.max(1, w * dpr());
    scrub.height = 40 * dpr();
    drawScrub();
  }
  new ResizeObserver(sizeScrub).observe(cv);

  function drawScrub() {
    const W = scrub.width / dpr(), H = 40;
    sctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.fillStyle = "#262a32";
    sctx.beginPath(); sctx.roundRect(0, 0, W, H, 6); sctx.fill();
    if (!rec || total < 1) return;
    const x = n => total > 1 ? 6 + n / (total - 1) * (W - 12) : 6;
    const at = playing ? videoFrame : want >= 0 ? want : cur;
    sctx.fillStyle = "#3a3f4a"; sctx.fillRect(6, 17, W - 12, 6); // track
    sctx.fillStyle = "rgba(224,179,74,.45)"; sctx.fillRect(6, 17, x(at) - 6, 6);
    sctx.fillStyle = "#555b66"; // a tick every 10 s
    for (let f = 0; f < total; f += FPS * 10) sctx.fillRect(Math.round(x(f)), 25, 1, 6);
    sctx.fillStyle = "#e0b34a"; // labeled frames
    for (const n of labeledFrames()) sctx.fillRect(Math.round(x(n)) - 1, 3, 3, 11);
    const g = drag ?? hover;
    if (g !== null) { sctx.fillStyle = "rgba(255,255,255,.5)"; sctx.fillRect(Math.round(x(g)), 2, 1, H - 4); }
    sctx.fillStyle = "#fff"; sctx.fillRect(Math.round(x(at)) - 1, 2, 2, H - 4);
    sctx.beginPath(); sctx.arc(x(at), 20, 7, 0, 2 * Math.PI); sctx.fillStyle = "#e0b34a"; sctx.fill();
  }

  function frameAt(clientX) {
    const r = scrub.getBoundingClientRect();
    return clamp(Math.round((clientX - r.left - 6) / Math.max(1, r.width - 12) * (total - 1)), 0, total - 1);
  }

  function showPop(n, clientX) {
    const t = rec.thumbs, img = pop.firstElementChild, W = scrub.getBoundingClientRect().width;
    const s = 1.3, w = (t?.width || 192) * s, h = (t?.height || 128) * s;
    img.style.width = w + "px"; img.style.height = h + "px";
    if (t && t.count) {
      const i = clamp(Math.round(n / t.every), 0, t.count - 1), per = t.cols * t.rows, slot = i % per;
      img.style.backgroundImage = `url("${sheetUrl(rec, Math.floor(i / per))}")`;
      img.style.backgroundSize = `${t.cols * w}px ${t.rows * h}px`;
      img.style.backgroundPosition = `-${(slot % t.cols) * w}px -${Math.floor(slot / t.cols) * h}px`;
    } else img.style.backgroundImage = "none";
    pop.lastElementChild.textContent = `#${n} · ${fmtTime(timeMs(n))}`;
    const x = clientX - scrub.getBoundingClientRect().left;
    pop.style.left = clamp(x, w / 2 + 4, W - w / 2 - 4) + "px";
    pop.style.display = "block";
  }
  const hidePop = () => { pop.style.display = "none"; };

  scrub.onpointerdown = e => {
    if (!rec || !total) return;
    scrub.setPointerCapture(e.pointerId);
    stopHold();
    if (playing) stopVideo(false);
    drag = frameAt(e.clientX);
    showPop(drag, e.clientX); drawScrub();
  };
  scrub.onpointermove = e => {
    if (!rec || !total) return;
    const n = frameAt(e.clientX);
    if (drag !== null) { drag = n; showPop(n, e.clientX); drawScrub(); }
    else if (e.pointerType === "mouse") { hover = n; showPop(n, e.clientX); drawScrub(); }
  };
  scrub.onpointerup = () => {
    if (drag === null) return;
    const n = drag;
    drag = null; hidePop();
    goto(n);
  };
  scrub.onpointercancel = () => { drag = null; hidePop(); drawScrub(); };
  scrub.onpointerleave = () => { hover = null; if (drag === null) hidePop(); drawScrub(); };

  // ---- transport buttons: press and hold to keep stepping

  function holdButton(id, d) {
    const b = $(id);
    b.onpointerdown = e => { e.preventDefault(); b.setPointerCapture(e.pointerId); startHold(d); };
    b.onpointerup = b.onpointercancel = b.onlostpointercapture = stopHold;
  }
  holdButton("rp-prev", -1);
  holdButton("rp-next", 1);
  $("rp-back10").onclick = () => goto((want >= 0 ? want : cur) - 10);
  $("rp-fwd10").onclick = () => goto((want >= 0 ? want : cur) + 10);
  $("rp-prevlab").onclick = () => labeledStep(-1);
  $("rp-nextlab").onclick = () => labeledStep(1);
  $("rp-play").onclick = togglePlay;
  const nInput = $("rp-n");
  nInput.onkeydown = e => {
    if (e.key === "Enter") {
      const n = parseInt(nInput.value, 10);
      if (Number.isFinite(n)) goto(n);
      nInput.blur();
    }
  };
  nInput.onblur = () => updatePos();
  nInput.onfocus = () => nInput.select();

  // ---- recording

  async function pollRecord() {
    try {
      const prev = recState;
      recState = await json("/record");
      recPolled = Date.now();
      const ended = (prev.recording || prev.saving) && !recState.recording && !recState.saving;
      if (ended && started) {
        await loadList();
        if (!prev.stopping) toast(`录制已结束${prev.remaining_ms < 2000 ? "（到达 3 分钟上限）" : ""}，已保存`);
      }
      if (recState.recording !== prev.recording || !!recState.saving !== !!prev.saving) { renderRecButton(); if (started) { loadList(); render(); } }
    } catch (e) { /* app restarting */ }
    recTimer();
  }
  setInterval(pollRecord, 1000);
  pollRecord();

  // the clock between polls
  function recTimer() {
    const badge = $("recbadge"), t = $("rp-rectime");
    if (recState.recording) {
      const el = Math.min(recState.limit_ms, recState.elapsed_ms + (Date.now() - recPolled));
      const left = Math.max(0, recState.limit_ms - el);
      badge.textContent = `录制中 ${fmtClock(el)}`;
      badge.classList.add("show");
      t.textContent = `${fmtClock(el)} / ${fmtClock(recState.limit_ms)} · 剩余 ${fmtClock(left)}`;
      t.className = "live";
    } else {
      badge.classList.remove("show");
      t.textContent = recState.saving ? "保存中…" : "";
      t.className = "";
    }
  }
  setInterval(recTimer, 250);

  function renderRecButton() {
    const b = $("rp-rec");
    b.classList.toggle("live", !!recState.recording);
    b.textContent = recState.recording ? "■ 结束录制" : recState.saving ? "保存中…" : "● 开始录制";
    b.disabled = !!recState.saving && !recState.recording;
  }

  $("rp-rec").onclick = async () => {
    const b = $("rp-rec");
    if (b.disabled) return;
    b.disabled = true;
    try {
      if (recState.recording) {
        recState.stopping = true;
        b.textContent = "保存中…";
        const meta = await post("/record/stop");
        await loadList();
        await open(meta.id, 0);
        toast(`已保存“${meta.name}”：${meta.frames} 帧，${fmtClock(meta.duration_ms)}`);
      } else {
        recState = await post("/record/start", { workspace: ws });
        recPolled = Date.now();
        await loadList();
        toast("开始录制：在平板上正常操作，最长 3 分钟", 2500);
      }
    } catch (e) {
      toast((recState.recording ? "结束录制失败：" : "开始录制失败：") + e.message, 5000);
    } finally {
      b.disabled = false;
      await pollRecord();
      renderRecButton(); render();
    }
  };

  // ---- recordings list

  async function loadList() {
    if (!ws) return;
    try {
      recs = await json(`/recordings?workspace=${enc(ws)}`);
    } catch (e) { toast("读取录像列表失败：" + e.message); return; }
    if (rec && !recs.some(r => r.id === rec.id)) close();
    renderList();
  }

  function thumbStyle(r, w) {
    const t = r.thumbs;
    if (!t || !t.count) return "";
    const s = w / t.width, h = t.height * s, i = Math.min(t.count - 1, Math.floor(t.count * 0.1)), per = t.cols * t.rows, slot = i % per;
    return `background-image:url('${sheetUrl(r, Math.floor(i / per))}');background-size:${t.cols * w}px ${t.rows * h}px;` +
      `background-position:-${(slot % t.cols) * w}px -${Math.floor(slot / t.cols) * h}px`;
  }

  function renderList() {
    const el = $("rp-recs");
    if (!recs.length) {
      el.innerHTML = `<div class="none" style="padding:4px 6px">还没有录像。点“开始录制”，然后在平板上正常操作。</div>`;
      return;
    }
    el.innerHTML = recs.map(r => {
      const live = r.state === "recording" || r.state === "saving";
      const sub = live ? (r.state === "recording" ? `● 录制中 ${fmtClock(r.duration_ms || 0)}` : "保存中…")
        : `${fmtClock(r.duration_ms || 0)} · ${r.frames} 帧 · ${(r.started_at || "").slice(5, 16)}${r.stopped_by === "recovered" ? " · 已修复" : ""}${r.stopped_by === "limit" ? " · 到达上限" : ""}`;
      const body = editing === r.id
        ? `<input data-f="name" value="${esc(r.name)}" placeholder="名称"><textarea data-f="note" placeholder="备注">${esc(r.note)}</textarea>
           <button class="btn" data-act="save">保存</button> <button class="btn" data-act="cancel">取消</button>`
        : `<div class="nm">${esc(r.name)}</div><div class="sub">${sub}</div>${r.note ? `<div class="nt" title="${esc(r.note)}">${esc(r.note)}</div>` : ""}`;
      return `<div class="rec${rec && rec.id === r.id ? " cur" : ""}${live ? " live" : ""}" data-id="${esc(r.id)}">
        <div class="th" style="${thumbStyle(r, 96)}"></div>
        <div class="bd">${body}</div>
        ${editing === r.id || live ? "" : `<div class="acts"><button class="btn" data-act="edit">改名</button><button class="btn" data-act="del">删除</button></div>`}
      </div>`;
    }).join("");
  }

  $("rp-recs").onclick = async e => {
    const item = e.target.closest(".rec");
    if (!item) return;
    const id = item.dataset.id, r = recs.find(x => x.id === id), act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "edit") { editing = id; renderList(); $("rp-recs").querySelector(`[data-id="${id}"] input`)?.focus(); return; }
    if (act === "cancel") { editing = null; renderList(); return; }
    if (act === "save") {
      const name = item.querySelector('[data-f="name"]').value.trim(), noteText = item.querySelector('[data-f="note"]').value;
      try {
        const m = await json(`/recordings/${enc(ws)}/${enc(id)}`, { method: "PATCH", body: JSON.stringify({ name: name || r.name, note: noteText }) });
        Object.assign(r, m);
        if (rec && rec.id === id) Object.assign(rec, m);
        editing = null; renderList();
      } catch (err) { toast("保存失败：" + err.message); }
      return;
    }
    if (act === "del") {
      if (!confirm(`删除录像“${r.name}”？视频、缩略图和标注都会删除，不能恢复。`)) return;
      try {
        await json(`/recordings/${enc(ws)}/${enc(id)}`, { method: "DELETE" });
        if (rec && rec.id === id) close();
        await loadList();
      } catch (err) { toast("删除失败：" + err.message); }
      return;
    }
    if (editing === id || e.target.closest("input, textarea")) return;
    if (r && r.state === "ready" && (!rec || rec.id !== id)) open(id, 0);
    else if (r && r.state !== "ready") toast("这段录像还在录制或保存中");
  };
  $("rp-recs").onkeydown = e => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") e.target.closest(".rec").querySelector('[data-act="save"]').click();
    if (e.key === "Escape") { editing = null; renderList(); }
  };
  $("rp-refresh").onclick = loadList;

  async function open(id, frame) {
    await flush();
    let meta = recs.find(r => r.id === id);
    try { if (!meta) meta = await json(`/recordings/${enc(ws)}/${enc(id)}`); } catch (e) { toast("打开录像失败：" + e.message); return; }
    if (meta.state !== "ready") { toast("这段录像还在录制或保存中"); return; }
    stopHold();
    if (playing) stopVideo(false);
    rec = meta; total = meta.frames; cur = -1; want = -1; image = null; selected = -1;
    bitmaps.clear(); undoStack = []; redoStack = []; dirty.clear(); saveError = "";
    video.removeAttribute("src"); delete video.dataset.src; video.load();
    cv.width = meta.width; cv.height = meta.height;
    layout();
    try { labels = await json(`${base()}/labels`); } catch (e) { labels = { version: 0, frames: {} }; toast("读取标注失败：" + e.message); }
    for (let k = 0; k < (meta.thumbs?.sheets || 0); k++) new Image().src = sheetUrl(meta, k); // warm the scrubbing previews
    renderList(); undoButtons(); saveStatus(); sizeScrub(); refreshFrame(); refreshLabeled(); render();
    goto(clamp(frame || 0, 0, total - 1));
  }

  function close() {
    rec = null; total = 0; cur = -1; want = -1; image = null; labels = { version: 0, frames: {} };
    dirty.clear(); undoStack = []; redoStack = [];
    history.replaceState(null, "", "#replay");
    updatePos(); undoButtons(); saveStatus(); refreshFrame(); refreshLabeled(); render(); drawScrub();
  }

  // ---- workspace

  async function loadWorkspaces() {
    const [list, st] = await Promise.all([json("/workspaces"), json("/status")]);
    ws = ws || st.workspace || list[0] || "";
    $("rp-ws").innerHTML = list.map(w => `<option${w === ws ? " selected" : ""}>${esc(w)}</option>`).join("");
  }
  $("rp-ws").onchange = async () => {
    await flush();
    close();
    ws = $("rp-ws").value;
    await loadList();
  };

  // ---- keys

  const typing = t => t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
  window.addEventListener("keydown", e => {
    if (mode !== "replay" || $("help").classList.contains("on")) return;
    if (typing(e.target)) { if (e.key === "Escape") e.target.blur(); return; }
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if ((k === "ArrowLeft" || k === "ArrowRight") && !ctrl) {
      e.preventDefault();
      if (e.repeat) return;
      const d = (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1);
      if (e.shiftKey) goto((want >= 0 ? want : cur) + d); else startHold(d);
      return;
    }
    if (ctrl && (k === "z" || k === "Z")) { e.preventDefault(); undo(e.shiftKey); return; }
    if (ctrl && (k === "y" || k === "Y")) { e.preventDefault(); undo(true); return; }
    if (ctrl || e.altKey) return;
    if (k === " ") { e.preventDefault(); togglePlay(); }
    else if (k === "Home") { e.preventDefault(); goto(0); }
    else if (k === "End") { e.preventDefault(); goto(total - 1); }
    else if (k === "[" || k === "PageUp") { e.preventDefault(); labeledStep(-1); }
    else if (k === "]" || k === "PageDown") { e.preventDefault(); labeledStep(1); }
    else if (k === "g" || k === "G") { e.preventDefault(); nInput.focus(); }
    else if (k === "n" || k === "N") { if (rec) { e.preventDefault(); note.focus(); } }
    else if (k === "Delete" || k === "Backspace") { if (selected >= 0) { e.preventDefault(); deleteMark(selected); } }
    else if (k === "Escape") { start = null; draft = null; select(-1); }
    else if (TOOLS[Number(k) - 1]) setTool(TOOLS[Number(k) - 1]);
  });
  window.addEventListener("keyup", e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") stopHold(); });
  window.addEventListener("blur", stopHold);

  // ---- enter / leave the mode

  async function enter() {
    active = true;
    if (!started) {
      started = true;
      render(); updatePos(); undoButtons(); renderRecButton();
      try { await loadWorkspaces(); } catch (e) { toast("连接 App 失败：" + e.message); return; }
      await loadList();
      const [, id, f] = location.hash.split("/");
      const pick = recs.find(r => r.id === id && r.state === "ready") || recs.find(r => r.state === "ready");
      if (pick) await open(pick.id, pick.id === id ? Number(f) || 0 : 0);
    } else {
      requestAnimationFrame(() => { layout(); sizeScrub(); });
      if (rec) history.replaceState(null, "", `#replay/${rec.id}/${Math.max(cur, 0)}`); else history.replaceState(null, "", "#replay");
      loadList();
    }
  }

  function leave() {
    active = false;
    stopHold();
    if (playing) stopVideo(false);
    flush();
  }

  return { enter, leave };
})();
