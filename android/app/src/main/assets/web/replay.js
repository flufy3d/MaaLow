// The recording stage: record the tablet, find the exact frame, annotate it, send the recording (with a focus on some
// frames) to the chat. Frames shown while paused are decoded by the app by frame number (never the browser's video
// seek); the <video> is only for quick playback.
"use strict";
window.replay = (() => {
  const FPS = 30;
  const cv = $("rp-cv"), ctx = cv.getContext("2d"), box = $("rp-box"), video = $("rp-video");
  const scrub = $("rp-scrub"), sctx = scrub.getContext("2d"), pop = $("rp-pop");
  const enc = encodeURIComponent;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const timeMs = n => Math.round(n * 1000 / FPS);
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
  let inPt = -1, outPt = -1, trayItem = null; // the range to send, and the tray item being changed (from its edit button)

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
    if (active) history.replaceState(null, "", `#teach/replay/${rec.id}/${cur}`);
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
    $("rp-play").innerHTML = svg("pause");
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
    $("rp-play").innerHTML = svg("play");
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
    ph.style.display = rec ? "none" : "flex";
    box.style.visibility = rec ? "visible" : "hidden";
    const say = recState.recording ? "录制中……在平板上正常操作。<br>结束录制后可以逐帧查看和标注。"
      : ws ? "选择右侧的录像，或点 <b>开始录制</b> 录一段在平板上的真实操作（最长 3 分钟）。" : "还没有工作区，先到 <b>工作区</b> 页新建一个。";
    if (!rec && ph.dataset.say !== say) { ph.dataset.say = say; ph.innerHTML = `<img src="web/mascot.png" alt=""><div>${say}</div>`; }
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
    const overwrite = await ui.dialog({
      title: `第 ${n} 帧的标注已被另一个页面修改`,
      body: "用这个页面的标注覆盖，还是放弃这里的修改、载入另一个页面的？",
      actions: [{ label: "载入另一个页面的", value: false }, { label: "用这里的覆盖", value: true, kind: "primary" }],
    });
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
        <button class="btn icon sm ghost" data-del title="删除（Delete）">${svg("x", "sm")}</button>
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
  window.addEventListener("themechange", drawScrub);

  function drawScrub() {
    const W = scrub.width / dpr(), H = 40;
    sctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    sctx.clearRect(0, 0, W, H);
    const accent = cssVar("--orange");
    sctx.fillStyle = cssVar("--panel-2");
    sctx.beginPath(); sctx.roundRect(0, 0, W, H, 10); sctx.fill();
    if (!rec || total < 1) return;
    const x = n => total > 1 ? 6 + n / (total - 1) * (W - 12) : 6;
    const at = playing ? videoFrame : want >= 0 ? want : cur;
    sctx.fillStyle = cssVar("--line-2"); sctx.fillRect(6, 17, W - 12, 6); // track
    sctx.fillStyle = accent; sctx.globalAlpha = .5; sctx.fillRect(6, 17, x(at) - 6, 6); sctx.globalAlpha = 1;
    if (inPt >= 0 || outPt >= 0) { // the range to send to the AI
      const a = inPt >= 0 ? inPt : 0, b = outPt >= 0 ? outPt : total - 1;
      sctx.fillStyle = cssVar("--green"); sctx.globalAlpha = .28; sctx.fillRect(x(a), 2, Math.max(2, x(b) - x(a)), H - 4); sctx.globalAlpha = 1;
    }
    sctx.fillStyle = cssVar("--faint"); // a tick every 10 s
    for (let f = 0; f < total; f += FPS * 10) sctx.fillRect(Math.round(x(f)), 25, 1, 6);
    sctx.fillStyle = accent; // labeled frames
    for (const n of labeledFrames()) sctx.fillRect(Math.round(x(n)) - 1, 3, 3, 11);
    const g = drag ?? hover;
    if (g !== null) { sctx.fillStyle = cssVar("--dim"); sctx.fillRect(Math.round(x(g)), 2, 1, H - 4); }
    sctx.fillStyle = cssVar("--text"); sctx.fillRect(Math.round(x(at)) - 1, 2, 2, H - 4);
    sctx.beginPath(); sctx.arc(x(at), 20, 7, 0, 2 * Math.PI); sctx.fillStyle = accent; sctx.fill();
    sctx.lineWidth = 2; sctx.strokeStyle = cssVar("--edge"); sctx.stroke();
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
        if (!prev.stopping) {
          toast(`录制已结束${prev.remaining_ms < 2000 ? "（到达 3 分钟上限）" : ""}，已保存`);
          const r = recs.find(x => x.state === "ready");
          if (r && active) offer(r);
        }
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
    b.innerHTML = recState.recording ? `${svg("stop")}结束录制` : recState.saving ? "保存中…" : `${svg("rec")}开始录制`;
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
        offer(meta);
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
    teach.setRecs(recs, ws);
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
           <button class="btn sm primary" data-act="save">保存</button> <button class="btn sm" data-act="cancel">取消</button>`
        : `<div class="nm">${esc(r.name)}</div><div class="sub">${sub}</div>${r.note ? `<div class="nt" title="${esc(r.note)}">${esc(r.note)}</div>` : ""}`;
      return `<div class="rec${rec && rec.id === r.id ? " cur" : ""}${live ? " live" : ""}" data-id="${esc(r.id)}">
        <div class="th" style="${thumbStyle(ws, r, 96)}"></div>
        <div class="bd">${body}</div>
        ${editing === r.id || live ? "" : `<div class="acts"><button class="btn sm" data-act="edit">改名</button><button class="btn sm danger" data-act="del">删除</button></div>`}
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
      if (!await ui.confirm("视频、缩略图和标注都会删除，不能恢复。", { title: `删除录像“${r.name}”？`, ok: "删除", danger: true })) return;
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
    inPt = -1; outPt = -1; trayItem = null; rangeText();
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
    inPt = -1; outPt = -1; trayItem = null; rangeText();
    if (active) history.replaceState(null, "", "#teach/replay");
    updatePos(); undoButtons(); saveStatus(); refreshFrame(); refreshLabeled(); render(); drawScrub();
  }

  // ---- workspace: always the current one (switched in the top bar)

  /** Open the recording asked for ("replay/<id>/<frame>"), else the newest ready one. */
  async function openDefault(hash) {
    const [, id, f] = (hash || "").split("/");
    const pick = recs.find(r => r.id === id && r.state === "ready") || recs.find(r => r.state === "ready");
    if (pick) await open(pick.id, pick.id === id ? Number(f) || 0 : 0);
  }

  async function setWorkspace(w) {
    if (w === ws) return;
    await flush();
    close();
    ws = w || "";
    recs = [];
    renderList();
    if (started && active && ws) { await loadList(); await openDefault(); }
  }

  // ---- keys

  const typing = t => t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
  // a freshly drawn mark focuses its empty label input; Ctrl+Z there has nothing to undo natively, so undo the mark
  const focusValue = new WeakMap();
  window.addEventListener("focusin", e => { if (typing(e.target)) focusValue.set(e.target, e.target.value); });
  window.addEventListener("keydown", e => {
    if (mode !== "teach" || teach.stage !== "replay" || ui.isOpen()) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (typing(e.target)) {
      if (k === "Escape") { e.target.blur(); return; }
      if (!(ctrl && "zZyY".includes(k)) || e.target.value !== focusValue.get(e.target)) return;
      e.target.blur();
    }
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
    else if (k === "i" || k === "I") { e.preventDefault(); setIn(); }
    else if (k === "o" || k === "O") { e.preventDefault(); setOut(); }
    else if (k === "a" || k === "A") { e.preventDefault(); toAI(); }
    else if (k === "n" || k === "N") { if (rec) { e.preventDefault(); note.focus(); } }
    else if (k === "Delete" || k === "Backspace") { if (selected >= 0) { e.preventDefault(); deleteMark(selected); } }
    else if (k === "Escape") { start = null; draft = null; select(-1); }
    else if (TOOLS[Number(k) - 1]) setTool(TOOLS[Number(k) - 1]);
  });
  window.addEventListener("keyup", e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") stopHold(); });
  window.addEventListener("blur", stopHold);

  // ---- enter / leave the mode

  /** The stage is shown; to: "replay/<id>/<frame>" opens that recording at that frame. */
  async function enter(to = "") {
    active = true;
    const [, id, f] = to.split("/");
    if (!started) {
      started = true;
      ws = wsStore.current;
      $("rp-play").innerHTML = svg("play");
      render(); updatePos(); undoButtons(); renderRecButton();
      await loadList();
      await openDefault(to);
    } else {
      requestAnimationFrame(() => { layout(); sizeScrub(); });
      if (rec) history.replaceState(null, "", `#teach/replay/${rec.id}/${Math.max(cur, 0)}`); else history.replaceState(null, "", "#teach/replay");
      await loadList();
      if (id && rec && rec.id === id) goto(Number(f) || 0);
      else if (id || !rec) await openDefault(to); // e.g. the workspace was switched while away
    }
  }

  function leave() {
    active = false;
    stopHold();
    if (playing) stopVideo(false);
    flush();
  }

  // ---- to the chat: the recording goes in the tray, with a focus (this frame, the in-out range) or none

  function rangeText() {
    $("rp-range").textContent = inPt >= 0 || outPt >= 0 ? `范围 ${inPt >= 0 ? inPt : "开头"}–${outPt >= 0 ? outPt : "结尾"}` : "";
    $("rp-toai").querySelector("span").textContent = trayItem ? "更新托盘" : "发给 AI";
    drawScrub();
  }
  const here = () => want >= 0 ? want : cur;
  function setIn() { if (!rec) return; const n = here(); inPt = inPt === n ? -1 : n; if (outPt >= 0 && outPt < inPt) outPt = -1; rangeText(); }
  function setOut() { if (!rec) return; const n = here(); outPt = outPt === n ? -1 : n; if (outPt >= 0 && inPt > outPt) inPt = -1; rangeText(); }
  $("rp-in").onclick = setIn;
  $("rp-out").onclick = setOut;

  async function toAI() {
    if (!rec || playing) return;
    await flush(); // the AI reads the saved labels
    const at = here(), hasRange = inPt >= 0 || outPt >= 0;
    const a = inPt >= 0 ? inPt : 0, b = outPt >= 0 ? outPt : total - 1;
    const v = await ui.dialog({
      title: trayItem ? `更新托盘里的“${esc(rec.name)}”` : `把“${esc(rec.name)}”放进待发托盘`,
      body: `<div class="msgtext">MaaLow 会看到这段录像的逐帧标注。focus 告诉它你说的是哪几帧（别的帧它也能自己看）。</div>`,
      actions: [
        { label: "取消", value: null },
        { label: "不指定", value: "none" },
        ...(hasRange ? [{ label: `入点到出点（${a}–${b}）`, value: "range" }] : []),
        { label: `当前帧（#${at}）`, value: "cur", kind: "primary" },
      ],
    });
    if (!v) return;
    const focus = v === "cur" ? { from: at, to: at } : v === "range" ? { from: a, to: b } : null;
    try {
      if (trayItem && trayItem.rec === rec.id) await teach.updateTray(trayItem.id, { focus });
      else await teach.addToTray({ type: "recording", rec: rec.id, ...(focus ? { focus } : {}) });
      trayItem = null; rangeText();
      toast(`已放进待发托盘：${focusText(focus)}`);
    } catch (e) { toast("放进托盘失败：" + e.message); }
  }
  $("rp-toai").onclick = toAI;

  /** A recording's edit button in the tray: once it is open here, sending updates that item instead of adding one. */
  function editItem(item) {
    const wait = () => {
      if (rec && rec.id === item.rec) {
        trayItem = item;
        if (item.focus && item.focus.to > item.focus.from) { inPt = item.focus.from; outPt = item.focus.to; }
        rangeText();
      } else if (active) setTimeout(wait, 100);
    };
    wait();
  }

  /** Right after a recording: offer to put it in the tray. */
  async function offer(r) {
    if (await ui.confirm("录像会放进待发托盘，写上说明、需要的话先标注几帧，再发给 MaaLow。", { title: `把“${r.name}”发到当前任务的对话吗？`, ok: "放进托盘" })) {
      try { await teach.addToTray({ type: "recording", rec: r.id }); toast("已放进待发托盘"); } catch (e) { toast("放进托盘失败：" + e.message); }
    }
  }

  return { enter, leave, flush, setWorkspace, editItem };
})();
