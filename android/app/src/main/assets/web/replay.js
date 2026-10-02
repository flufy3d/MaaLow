// The recording stage: record the tablet, find the exact frame, annotate it (labels.json, for the data set), and send
// the recording to the chat with the in-out range as its focus. Frames shown while paused are decoded by the app by
// frame number (never the browser's video seek); the <video> is only for quick playback.
"use strict";
window.replay = (() => {
  const FPS = 30;
  const video = $("scr-video"), screen = $("screen");
  const scrub = $("rp-scrub"), sctx = scrub.getContext("2d"), pop = $("rp-pop");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const timeMs = n => Math.round(n * 1000 / FPS);
  const fmtTime = ms => `${fmtClock(ms)}.${String(ms % 1000).padStart(3, "0")}`;

  let started = false, active = false;
  let ws = "", recs = [], rec = null, total = 0;
  let cur = -1, want = -1, image = null, loading = false, lastDir = 0, frameError = "";
  const bitmaps = new Map(); // "id:n" -> Promise<ImageBitmap>, most recent last
  let labels = { version: 0, frames: {} };
  const dirty = new Set();
  let saving = false, saveTimer = 0, saveError = "";
  let undoStack = [], redoStack = [];
  let recState = { recording: false }, recPolled = 0;
  /** The app's recording limit in minutes (GET /record limit_ms). */
  const limitMin = () => Math.round((recState.limit_ms || 20 * 60000) / 60000);
  let playing = false, videoFrame = 0, hideVideoOnLoad = false;
  let drag = null, hover = null, hold = null, editing = null;
  let inPt = -1, outPt = -1; // the range sent as the attachment's focus (-1: open end)
  let trayItem = null; // the tray item this recording is (edits go back into it)

  const base = () => `/recordings/${enc(ws)}/${enc(rec.id)}`;
  const entry = n => labels.frames[n];
  const marksOf = n => entry(n)?.annotations || [];
  const labeledFrames = () => Object.keys(labels.frames).map(Number).filter(n => entry(n)?.annotations?.length || entry(n)?.note).sort((a, b) => a - b);
  const localSheet = (r, k) => sheetUrl(ws, r, k);
  const here = () => want >= 0 ? want : cur;

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

  /** Show frame n (exact, from the app). Numbers update at once; the image follows (the old one stays meanwhile). */
  function goto(n) {
    if (!rec || !total) return;
    n = clamp(Math.round(n), 0, total - 1);
    if (playing) stopVideo(false);
    lastDir = Math.sign(n - here());
    want = n;
    updatePos();
    pump();
  }

  async function pump() {
    if (loading) return;
    loading = true;
    if (active) stage.busy(true);
    try {
      while (rec && want !== cur) {
        const n = want, id = rec.id;
        let bmp;
        try {
          bmp = await fetchFrame(n);
          frameError = "";
        } catch (e) {
          frameError = "取帧失败：" + e.message;
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
      if (active) stage.busy(false);
      badge();
    }
  }

  function show(n, bmp) {
    const changed = n !== cur;
    cur = n; image = bmp;
    if (hideVideoOnLoad) { hideVideoOnLoad = false; screen.classList.remove("playing"); }
    if (active) {
      stage.show(bmp);
      if (changed) stage.reset(); else stage.render();
      stage.buttons();
    }
    drawScrub(); refreshFrame();
    if (active) history.replaceState(null, "", `#teach/replay/${rec.id}/${cur}`);
  }

  function badge() {
    if (!active) return;
    const n = here();
    stage.badge(rec && n >= 0 ? `#${n} · ${timeMs(n)} ms${loading ? ' <span class="ld">· 加载中</span>' : ""}${frameError ? ` <span class="err">· ${esc(frameError)}</span>` : ""}` : "", "frame");
  }

  function updatePos(n = here()) {
    const has = rec && n >= 0;
    const ms = has ? timeMs(n) : 0;
    if (document.activeElement !== $("rp-n")) $("rp-n").value = has ? n : "";
    $("rp-total").textContent = has ? total - 1 : 0;
    $("rp-time").textContent = has ? fmtTime(ms) : "";
    badge();
    rangeUi();
  }

  // hold ← / → (or a step button) to keep stepping, as fast as frames arrive (at most 30 per second)
  function startHold(d) {
    stopHold();
    goto(here() + d);
    hold = { d, t: setTimeout(function tick() {
      if (!hold) return;
      const at = here();
      if (!loading && at + hold.d >= 0 && at + hold.d < total) goto(at + hold.d);
      hold.t = setTimeout(tick, 33);
    }, 320) };
  }
  function stopHold() { if (hold) { clearTimeout(hold.t); hold = null; } }

  function labeledStep(d) {
    const at = here(), all = labeledFrames();
    const n = d > 0 ? all.find(f => f > at) : all.reverse().find(f => f < at);
    if (n === undefined) toast(d > 0 ? "后面没有已标注的帧了" : "前面没有已标注的帧了", 1500);
    else goto(n);
  }

  // ---- playback (browser video, for browsing only)

  function play() {
    if (!rec || playing) return;
    stopHold();
    stage.reset();
    const src = withToken(`${API}${base()}/video.mp4`);
    if (video.dataset.src !== src) { video.src = src; video.dataset.src = src; }
    let n = here();
    if (n >= total - 1) n = 0;
    videoFrame = n;
    playing = true; hideVideoOnLoad = false;
    screen.classList.add("playing");
    $("rp-play").innerHTML = svg("pause");
    video.currentTime = (n + 0.5) / FPS;
    video.play().catch(e => { toast("无法播放：" + e.message); stopVideo(false); screen.classList.remove("playing"); });
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
    } else screen.classList.remove("playing");
    if (active) stage.render();
  }
  video.onended = () => stopVideo(true);
  const togglePlay = () => playing ? stopVideo(true) : play();

  // ---- annotations: the shared layer edits this frame's labels

  const canDraw = () => rec && cur >= 0 && !playing && cur === want;
  const doc = {
    marks: () => canDraw() ? marksOf(cur) : [],
    editable: canDraw,
    change(fn) { mutate(cur, e => fn(e.annotations)); },
  };

  // ---- label edits, undo (frames and the range), autosave

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
    pushUndo({ n, before, after });
    touched(n);
  }
  function pushUndo(u) {
    undoStack.push(u);
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
    if (active) stage.buttons();
  }
  function touched(n, quiet) {
    dirty.add(n);
    scheduleSave();
    drawScrub(); labCount();
    if (!quiet) { refreshFrame(); if (active) stage.render(); }
  }
  function apply(n, s) {
    const e = ensure(n);
    e.note = s.note;
    e.annotations = s.annotations.map(a => ({ ...a, coords: [...a.coords] }));
    stage.reset();
    touched(n);
  }
  function undo(redo) {
    const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
    const u = from.pop();
    if (!u) return;
    to.push(u);
    if (u.range) { setRange(...(redo ? u.after : u.before), false); toast(`${redo ? "重做" : "撤销"}：范围`, 1200); }
    else {
      if (u.n !== cur) goto(u.n);
      apply(u.n, redo ? u.after : u.before);
      toast(`${redo ? "重做" : "撤销"}：第 ${u.n} 帧`, 1200);
    }
    if (active) stage.buttons();
  }

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
      if (n === cur) { stage.reset(); refreshFrame(); }
      labCount(); drawScrub();
    }
  }

  function saveStatus() {
    if (!active) return;
    if (!rec) stage.status("");
    else if (saving) stage.status("保存中…", "dirty");
    else if (saveError) stage.status("⚠ 保存失败，稍后重试", "bad");
    else if (dirty.size) stage.status("● 未保存", "dirty");
    else stage.status("✓ 标注已保存", "ok");
  }
  window.addEventListener("beforeunload", e => {
    if (dirty.size || saving) { flush(); e.preventDefault(); e.returnValue = ""; }
  });

  // labels changed elsewhere (another page, or `maalow sync`): take them for every frame not being edited here
  async function pollLabels() {
    if (!active || !rec || saving || dirty.size || document.hidden || stage.selected >= 0) return;
    try {
      const id = rec.id;
      const l = await json(`${base()}/labels`);
      if (!rec || rec.id !== id || saving || dirty.size || l.version <= labels.version) return;
      labels = l;
      refreshFrame(); labCount(); stage.render(); drawScrub();
    } catch (e) { /* app restarting */ }
  }
  setInterval(pollLabels, 4000);

  // ---- this frame's note (bottom slot), labeled frames (a menu)

  function refreshFrame() {
    const has = rec && cur >= 0, note = $("rp-note");
    note.disabled = !has;
    if (document.activeElement !== note) note.value = has ? entry(cur)?.note || "" : "";
    labCount();
  }
  const note = $("rp-note");
  let noteSnap = null;
  note.onfocus = () => { noteSnap = snapshot(cur); };
  note.oninput = () => { if (cur < 0) return; ensure(cur).note = note.value; touched(cur, true); };
  note.onblur = () => {
    if (!noteSnap) return;
    const after = snapshot(cur);
    if (!same(noteSnap, after)) pushUndo({ n: cur, before: noteSnap, after });
    noteSnap = null;
  };
  note.onkeydown = e => { if (e.key === "Enter") note.blur(); };

  function labCount() {
    const n = rec ? labeledFrames().length : 0;
    $("rp-labbtn").innerHTML = `已标注 ${n} 帧 ${svg("down", "sm")}`;
    $("rp-labbtn").disabled = !rec;
  }
  const labmenu = $("labmenu");
  function openMenu(menu, anchor, html, up) {
    menu.innerHTML = html;
    menu.classList.add("on");
    const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = clamp(r.left, 8, innerWidth - mw - 8) + "px";
    menu.style.top = (up ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + "px";
  }
  $("rp-labbtn").onclick = e => {
    e.stopPropagation();
    if (labmenu.classList.contains("on")) return labmenu.classList.remove("on");
    const all = labeledFrames();
    openMenu(labmenu, $("rp-labbtn"), `<div class="hd">已标注的帧（点一下跳过去）</div>` + (all.length ? all.map(n => {
      const e = entry(n), k = e.annotations?.length || 0;
      const what = [k ? `${k} 个标注` : "", e.note || e.annotations?.map(a => a.label).filter(Boolean).join("；") || ""].filter(Boolean).join(" · ");
      return `<div class="lf${n === cur ? " cur" : ""}" data-n="${n}"><b>#${n}</b><span class="t">${fmtTime(timeMs(n))}</span><span class="s">${esc(what)}</span></div>`;
    }).join("") : `<div class="none" style="padding:4px 10px">还没有标注。定位到关键帧（预警、出手、闪避）后在画面上标注。</div>`), true);
  };
  labmenu.onclick = e => { const d = e.target.closest(".lf"); if (d) { labmenu.classList.remove("on"); goto(Number(d.dataset.n)); } };

  // ---- the range (in / out points): the attachment's focus

  /** Set the range; record: one undo step. A tray item being edited gets the new focus. */
  function setRange(a, b, record = true) {
    if (a >= 0 && b >= 0 && a > b) [a, b] = [b, a];
    if (a === inPt && b === outPt) return;
    if (record) pushUndo({ range: true, before: [inPt, outPt], after: [a, b] });
    inPt = a; outPt = b;
    rangeUi(); drawScrub();
    if (trayItem) writeBack({ focus: focus() });
  }
  const focus = () => inPt < 0 && outPt < 0 ? null : { from: inPt >= 0 ? inPt : 0, to: outPt >= 0 ? outPt : total - 1 };
  function rangeUi() {
    const n = here(), f = focus();
    $("rp-in").textContent = inPt >= 0 && inPt === n ? "清除入点" : "入点";
    $("rp-out").textContent = outPt >= 0 && outPt === n ? "清除出点" : "出点";
    $("rp-in").disabled = $("rp-out").disabled = !rec;
    $("rp-range").style.display = f ? "" : "none";
    $("rp-range").querySelector(".t").textContent = f ? `范围 ${f.from}–${f.to}` : "";
  }
  function setIn() { if (!rec) return; const n = here(); if (inPt === n) setRange(-1, outPt); else setRange(n, outPt >= 0 && outPt < n ? -1 : outPt); }
  function setOut() { if (!rec) return; const n = here(); if (outPt === n) setRange(inPt, -1); else setRange(inPt >= 0 && inPt > n ? -1 : inPt, n); }
  $("rp-in").onclick = setIn;
  $("rp-out").onclick = setOut;
  $("rp-rangex").onclick = () => setRange(-1, -1);

  // ---- to the chat: the recording goes in the tray (focus: the range); once there, edits here go back into it

  const rpText = $("rp-text");
  let textTimer = 0;
  function writeBack(change) {
    const id = trayItem.id;
    teach.updateTray(id, change).then(it => { if (trayItem?.id === id) trayItem = it; }).catch(e => toast("更新托盘失败：" + e.message));
  }
  rpText.oninput = () => {
    if (!trayItem) return;
    clearTimeout(textTimer);
    textTimer = setTimeout(() => writeBack({ text: rpText.value.trim() }), 500);
  };
  rpText.onkeydown = e => { if (e.key === "Enter") rpText.blur(); };

  async function toAI() {
    if (!rec || playing || trayItem) return;
    await flush(); // the AI reads the saved labels
    try {
      const f = focus(), t = rpText.value.trim();
      trayItem = await teach.addToTray({ type: "recording", rec: rec.id, ...(f ? { focus: f } : {}), ...(t ? { text: t } : {}) });
      teach.renderTray(); sendUi();
      toast(`已放进待发托盘：${focusText(f)}`);
    } catch (e) { toast("放进托盘失败：" + e.message); }
  }
  $("toai").addEventListener("click", () => { if (active) toAI(); });
  function sendUi() {
    if (!active) return;
    const b = $("toai");
    b.disabled = !rec || !!trayItem;
    b.title = trayItem ? "已经在托盘里了：范围和说明的改动会自动写回" : "把这段录像放进待发托盘，范围就是 focus（A）";
    rpText.placeholder = trayItem ? "给 MaaLow 的说明（改动自动写回托盘）" : "给 MaaLow 的说明：这段录像要它看什么";
  }

  /** A recording's edit button in the tray: once it is open here, the range and text are that item's. */
  function editItem(item) {
    const wait = () => {
      if (rec && rec.id === item.rec) {
        trayItem = item;
        inPt = item.focus ? item.focus.from : -1;
        outPt = item.focus ? item.focus.to : -1;
        rpText.value = item.text || "";
        rangeUi(); drawScrub(); sendUi(); teach.renderTray();
      } else if (active) setTimeout(wait, 100);
    };
    wait();
  }
  /** The tray changed: a recording taken out of it is no longer being edited. */
  function trayChanged(items) {
    if (trayItem && !items.some(t => t.id === trayItem.id)) { trayItem = null; rpText.value = ""; sendUi(); }
  }

  /** Right after a recording: offer to put it in the tray. */
  async function offer(r) {
    if (!await ui.confirm("录像会放进待发托盘，写上说明、需要的话先标注几帧，再发给 MaaLow。", { title: `把“${r.name}”发到当前任务的对话吗？`, ok: "放进托盘" })) return;
    try {
      const item = await teach.addToTray({ type: "recording", rec: r.id });
      if (rec && rec.id === r.id) { trayItem = item; sendUi(); teach.renderTray(); }
      toast("已放进待发托盘");
    } catch (e) { toast("放进托盘失败：" + e.message); }
  }

  // ---- scrubber: labeled frames marked (a tap near one goes there), the range and its ends draggable, thumbnails

  const dpr = () => window.devicePixelRatio || 1;
  function sizeScrub() {
    const w = Math.round($("rp-scrubwrap").getBoundingClientRect().width) || 0;
    scrub.width = Math.max(1, w * dpr());
    scrub.height = 34 * dpr();
    drawScrub();
  }
  new ResizeObserver(sizeScrub).observe($("rp-scrubwrap"));
  window.addEventListener("themechange", drawScrub);

  const X = n => { const w = scrub.width / dpr(); return total > 1 ? 6 + n / (total - 1) * (w - 12) : 6; };
  function drawScrub() {
    const W = scrub.width / dpr(), H = 34;
    sctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    sctx.clearRect(0, 0, W, H);
    const accent = cssVar("--orange");
    sctx.fillStyle = cssVar("--panel-2");
    sctx.beginPath(); sctx.roundRect(0, 0, W, H, 9); sctx.fill();
    if (!rec || total < 1) return;
    const at = playing ? videoFrame : here();
    sctx.fillStyle = cssVar("--line-2"); sctx.fillRect(6, 14, W - 12, 6); // track
    sctx.fillStyle = accent; sctx.globalAlpha = .5; sctx.fillRect(6, 14, X(at) - 6, 6); sctx.globalAlpha = 1;
    const f = focus();
    if (f) { // the range, with handles at its ends
      sctx.fillStyle = cssVar("--green"); sctx.globalAlpha = .25; sctx.fillRect(X(f.from), 2, Math.max(2, X(f.to) - X(f.from)), H - 4); sctx.globalAlpha = 1;
      sctx.fillStyle = cssVar("--green");
      if (inPt >= 0) sctx.fillRect(Math.round(X(inPt)) - 2, 2, 4, H - 4);
      if (outPt >= 0) sctx.fillRect(Math.round(X(outPt)) - 2, 2, 4, H - 4);
    }
    sctx.fillStyle = cssVar("--faint"); // a tick every 10 s
    for (let n = 0; n < total; n += FPS * 10) sctx.fillRect(Math.round(X(n)), 22, 1, 6);
    sctx.fillStyle = accent; // labeled frames
    for (const n of labeledFrames()) sctx.fillRect(Math.round(X(n)) - 1.5, 2, 3, 10);
    const g = drag?.kind === "seek" ? drag.n : hover;
    if (g !== null && g !== undefined) { sctx.fillStyle = cssVar("--dim"); sctx.fillRect(Math.round(X(g)), 2, 1, H - 4); }
    sctx.fillStyle = cssVar("--text"); sctx.fillRect(Math.round(X(at)) - 1, 2, 2, H - 4);
    sctx.beginPath(); sctx.arc(X(at), 17, 6.5, 0, 2 * Math.PI); sctx.fillStyle = accent; sctx.fill();
    sctx.lineWidth = 2; sctx.strokeStyle = cssVar("--edge"); sctx.stroke();
  }

  function frameAt(clientX) {
    const r = scrub.getBoundingClientRect();
    return clamp(Math.round((clientX - r.left - 6) / Math.max(1, r.width - 12) * (total - 1)), 0, total - 1);
  }
  const px = clientX => clientX - scrub.getBoundingClientRect().left;

  function showPop(n, clientX) {
    const t = rec.thumbs, img = pop.firstElementChild;
    const s = 1.2, w = (t?.width || 192) * s, h = (t?.height || 128) * s;
    img.style.width = w + "px"; img.style.height = h + "px";
    if (t && t.count) {
      const i = clamp(Math.round(n / t.every), 0, t.count - 1), per = t.cols * t.rows, slot = i % per;
      img.style.backgroundImage = `url("${localSheet(rec, Math.floor(i / per))}")`;
      img.style.backgroundSize = `${t.cols * w}px ${t.rows * h}px`;
      img.style.backgroundPosition = `-${(slot % t.cols) * w}px -${Math.floor(slot / t.cols) * h}px`;
    } else img.style.backgroundImage = "none";
    pop.lastElementChild.textContent = `#${n} · ${fmtTime(timeMs(n))}`;
    const r = scrub.getBoundingClientRect();
    pop.style.display = "block";
    pop.style.left = clamp(clientX, r.left + w / 2 + 4, r.right - w / 2 - 4) + "px";
    pop.style.top = (r.top - pop.offsetHeight - 8) + "px";
  }
  const hidePop = () => { pop.style.display = "none"; };

  scrub.onpointerdown = e => {
    if (!rec || !total) return;
    scrub.setPointerCapture(e.pointerId);
    stopHold();
    if (playing) stopVideo(false);
    const x = px(e.clientX), near = n => n >= 0 && Math.abs(X(n) - x) <= 6;
    if (near(inPt) || near(outPt)) { // drag an end of the range
      drag = { kind: near(inPt) ? "in" : "out", start: [inPt, outPt] };
      scrub.style.cursor = "ew-resize";
      return;
    }
    drag = { kind: "seek", n: frameAt(e.clientX), x0: e.clientX };
    showPop(drag.n, e.clientX); drawScrub();
  };
  scrub.onpointermove = e => {
    if (!rec || !total) return;
    const n = frameAt(e.clientX);
    if (drag?.kind === "in" || drag?.kind === "out") {
      if (drag.kind === "in") inPt = outPt >= 0 ? Math.min(n, outPt) : n; else outPt = inPt >= 0 ? Math.max(n, inPt) : n;
      rangeUi(); drawScrub(); showPop(n, e.clientX);
    } else if (drag) { drag.n = n; showPop(n, e.clientX); drawScrub(); }
    else if (e.pointerType === "mouse") {
      hover = n; showPop(n, e.clientX); drawScrub();
      const x = px(e.clientX);
      scrub.style.cursor = [inPt, outPt].some(k => k >= 0 && Math.abs(X(k) - x) <= 6) ? "ew-resize" : "pointer";
    }
  };
  scrub.onpointerup = e => {
    const d = drag;
    drag = null; hidePop(); scrub.style.cursor = "";
    if (!d) return;
    if (d.kind !== "seek") { // one undo step for the whole drag
      const [a, b] = [inPt, outPt];
      [inPt, outPt] = d.start;
      setRange(a, b);
      return;
    }
    let n = d.n;
    if (Math.abs(e.clientX - d.x0) < 3) { // a tap: a labeled frame close by wins
      const x = px(e.clientX), hit = labeledFrames().find(k => Math.abs(X(k) - x) <= 5);
      if (hit !== undefined) n = hit;
    }
    goto(n);
  };
  scrub.onpointercancel = () => { if (drag && drag.kind !== "seek") [inPt, outPt] = drag.start; drag = null; hidePop(); drawScrub(); rangeUi(); };
  scrub.onpointerleave = () => { hover = null; if (!drag) hidePop(); drawScrub(); };

  // ---- transport buttons: press and hold to keep stepping

  function holdButton(id, d) {
    const b = $(id);
    b.onpointerdown = e => { e.preventDefault(); b.setPointerCapture(e.pointerId); startHold(d); };
    b.onpointerup = b.onpointercancel = b.onlostpointercapture = stopHold;
  }
  holdButton("rp-prev", -1);
  holdButton("rp-next", 1);
  $("rp-back10").onclick = () => goto(here() - 10);
  $("rp-fwd10").onclick = () => goto(here() + 10);
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
          toast(`录制已结束${prev.remaining_ms < 2000 ? `（到达 ${limitMin()} 分钟上限）` : ""}，已保存`);
          const r = recs.find(x => x.state === "ready");
          if (r && active) offer(r);
        }
      }
      if (recState.recording !== prev.recording || !!recState.saving !== !!prev.saving) { renderRecButton(); if (started) { loadList(); placeholder(); } }
    } catch (e) { /* app restarting */ }
    recTimer();
  }
  setInterval(pollRecord, 1000);
  pollRecord();

  // the clock between polls
  function recTimer() {
    const badge = $("recbadge");
    if (recState.recording) {
      const el = Math.min(recState.limit_ms, recState.elapsed_ms + (Date.now() - recPolled));
      badge.textContent = `录制中 ${fmtClock(el)}`;
      badge.classList.add("show");
      if (!recState.stopping) $("rp-rec").innerHTML = `${svg("stop")}<span class="tl">结束 ${fmtClock(el)}</span>`;
    } else badge.classList.remove("show");
  }
  setInterval(recTimer, 250);

  function renderRecButton() {
    const b = $("rp-rec");
    b.classList.toggle("live", !!recState.recording);
    b.innerHTML = recState.recording ? `${svg("stop")}<span class="tl">结束录制</span>` : recState.saving ? `<span class="tl">保存中…</span>` : `${svg("rec")}<span class="tl">开始录制</span>`;
    b.title = recState.recording ? "结束录制并保存" : `录下平板上的真实操作（最长 ${limitMin()} 分钟）`;
    b.disabled = !!recState.saving && !recState.recording;
  }

  $("rp-rec").onclick = async () => {
    const b = $("rp-rec");
    if (b.disabled) return;
    b.disabled = true;
    try {
      if (recState.recording) {
        recState.stopping = true;
        b.innerHTML = `<span class="tl">保存中…</span>`;
        const meta = await post("/record/stop");
        await loadList();
        await open(meta.id, 0);
        toast(`已保存“${meta.name}”：${meta.frames} 帧，${fmtClock(meta.duration_ms)}`);
        offer(meta);
      } else {
        recState = await post("/record/start", { workspace: ws });
        recPolled = Date.now();
        await loadList();
        toast(`开始录制：在平板上正常操作，最长 ${limitMin()} 分钟`, 2500);
      }
    } catch (e) {
      toast((recState.recording ? "结束录制失败：" : "开始录制失败：") + e.message, 5000);
    } finally {
      b.disabled = false;
      await pollRecord();
      renderRecButton(); placeholder();
    }
  };

  // ---- recordings: a picker in the toolbar, the list in a menu (search, refresh, rename, delete)

  const recmenu = $("recmenu");
  let query = "";
  async function loadList() {
    if (!ws) return;
    try {
      recs = await json(`/recordings?workspace=${enc(ws)}`);
    } catch (e) { toast("读取录像列表失败：" + e.message); return; }
    if (rec && !recs.some(r => r.id === rec.id)) close();
    pickLabel();
    if (recmenu.classList.contains("on")) renderList();
    teach.setRecs(recs, ws);
  }
  function pickLabel() {
    $("rp-pick").querySelector(".nm").textContent = rec ? `${rec.name} · ${fmtClock(rec.duration_ms)}` : recs.length ? "选择录像" : "还没有录像";
    $("rp-pick").title = rec ? `${rec.name}：${rec.frames} 帧，点击换一段` : "选择录像";
  }

  function renderList() {
    const q = query.trim().toLowerCase();
    const list = recs.filter(r => !q || (r.name + " " + (r.note || "") + " " + r.id).toLowerCase().includes(q));
    const rows = list.map(r => {
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
    recmenu.querySelector(".list").innerHTML = rows || `<div class="none" style="padding:6px 10px">${recs.length ? "没有匹配的录像" : "还没有录像。点“开始录制”，然后在平板上正常操作。"}</div>`;
  }
  $("rp-pick").onclick = e => {
    e.stopPropagation();
    if (recmenu.classList.contains("on")) { recmenu.classList.remove("on"); return; }
    openMenu(recmenu, $("rp-pick"), `<div class="hd row0"><input class="search" placeholder="搜索录像" value="${esc(query)}">
      <button class="btn icon sm ghost" data-act="refresh" title="刷新列表">${svg("refresh", "sm")}</button></div><div class="list"></div>`);
    renderList();
    loadList();
    recmenu.querySelector(".search").focus();
  };
  recmenu.oninput = e => { if (e.target.classList.contains("search")) { query = e.target.value; renderList(); } };
  recmenu.onclick = async e => {
    e.stopPropagation();
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "refresh") { await loadList(); renderList(); return; }
    const item = e.target.closest(".rec");
    if (!item) return;
    const id = item.dataset.id, r = recs.find(x => x.id === id);
    if (act === "edit") { editing = id; renderList(); recmenu.querySelector(`[data-id="${id}"] input`)?.focus(); return; }
    if (act === "cancel") { editing = null; renderList(); return; }
    if (act === "save") {
      const name = item.querySelector('[data-f="name"]').value.trim(), noteText = item.querySelector('[data-f="note"]').value;
      try {
        const m = await json(`/recordings/${enc(ws)}/${enc(id)}`, { method: "PATCH", body: JSON.stringify({ name: name || r.name, note: noteText }) });
        Object.assign(r, m);
        if (rec && rec.id === id) Object.assign(rec, m);
        editing = null; renderList(); pickLabel(); teach.setRecs(recs, ws);
      } catch (err) { toast("保存失败：" + err.message); }
      return;
    }
    if (act === "del") {
      recmenu.classList.remove("on");
      if (!await ui.confirm("视频、缩略图和标注都会删除，不能恢复；引用它的消息会显示“录像已删除”。", { title: `删除录像“${r.name}”？`, ok: "删除", danger: true })) return;
      try {
        await json(`/recordings/${enc(ws)}/${enc(id)}`, { method: "DELETE" });
        if (rec && rec.id === id) close();
        await loadList();
      } catch (err) { toast("删除失败：" + err.message); }
      return;
    }
    if (editing === id || e.target.closest("input, textarea")) return;
    if (r && r.state === "ready") { recmenu.classList.remove("on"); if (!rec || rec.id !== id) open(id, 0); }
    else if (r) toast("这段录像还在录制或保存中");
  };
  recmenu.onkeydown = e => {
    if (e.key === "Enter" && e.target.tagName === "INPUT" && !e.target.classList.contains("search")) e.target.closest(".rec").querySelector('[data-act="save"]').click();
    if (e.key === "Escape") { e.stopPropagation(); if (editing) { editing = null; renderList(); } else recmenu.classList.remove("on"); }
  };
  document.addEventListener("pointerdown", e => {
    if (!recmenu.contains(e.target) && !$("rp-pick").contains(e.target)) recmenu.classList.remove("on");
    if (!labmenu.contains(e.target) && !$("rp-labbtn").contains(e.target)) labmenu.classList.remove("on");
  });

  async function open(id, frame) {
    await flush();
    let meta = recs.find(r => r.id === id);
    try { if (!meta) meta = await json(`/recordings/${enc(ws)}/${enc(id)}`); } catch (e) { toast("打开录像失败：" + e.message); return; }
    if (meta.state !== "ready") { toast("这段录像还在录制或保存中"); return; }
    stopHold();
    if (playing) stopVideo(false);
    rec = meta; total = meta.frames; cur = -1; want = -1; image = null; frameError = "";
    bitmaps.clear(); undoStack = []; redoStack = []; dirty.clear(); saveError = "";
    inPt = -1; outPt = -1; trayItem = null; rpText.value = "";
    video.removeAttribute("src"); delete video.dataset.src; video.load();
    try { labels = await json(`${base()}/labels`); } catch (e) { labels = { version: 0, frames: {} }; toast("读取标注失败：" + e.message); }
    for (let k = 0; k < (meta.thumbs?.sheets || 0); k++) new Image().src = localSheet(meta, k); // warm the scrubbing previews
    pickLabel(); saveStatus(); sizeScrub(); refreshFrame(); placeholder(); sendUi(); rangeUi();
    if (active) { stage.reset(); stage.buttons(); }
    teach.renderTray();
    goto(clamp(frame || 0, 0, total - 1));
  }

  function close() {
    rec = null; total = 0; cur = -1; want = -1; image = null; labels = { version: 0, frames: {} };
    dirty.clear(); undoStack = []; redoStack = []; inPt = -1; outPt = -1; trayItem = null;
    if (active) { history.replaceState(null, "", "#teach/replay"); stage.show(null); stage.reset(); }
    updatePos(); saveStatus(); refreshFrame(); placeholder(); drawScrub(); pickLabel(); sendUi();
  }

  function placeholder() {
    if (!active) return;
    const say = recState.recording ? "录制中……在平板上正常操作。<br>结束录制后可以逐帧查看和标注。"
      : !ws ? "还没有工作区，先到 <b>工作区</b> 页新建一个。"
      : recs.some(r => r.state === "ready") ? "点工具栏里的录像选择器，打开一段录像。" : `点 <b>开始录制</b> 录一段在平板上的真实操作（最长 ${limitMin()} 分钟）。`;
    stage.over(rec ? "" : `<img src="web/mascot.png" alt=""><div>${say}</div>`);
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
    pickLabel();
    if (started && active && ws) { await loadList(); await openDefault(); }
  }

  // ---- keys (undo, tools, delete and Esc are the stage's)

  window.addEventListener("keydown", e => {
    if (!active || mode !== "teach" || ui.isOpen()) return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const k = e.key;
    if ((k === "ArrowLeft" || k === "ArrowRight") && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (e.repeat) return;
      const d = (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1);
      if (e.shiftKey) goto(here() + d); else startHold(d);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === " ") { e.preventDefault(); togglePlay(); }
    else if (k === "Home") { e.preventDefault(); goto(0); }
    else if (k === "End") { e.preventDefault(); goto(total - 1); }
    else if (k === "[" || k === "PageUp") { e.preventDefault(); labeledStep(-1); }
    else if (k === "]" || k === "PageDown") { e.preventDefault(); labeledStep(1); }
    else if (k === "g" || k === "G") { e.preventDefault(); nInput.focus(); }
    else if (k === "n" || k === "N") { if (rec) { e.preventDefault(); note.focus(); } }
    else if (k === "i" || k === "I") { e.preventDefault(); setIn(); }
    else if (k === "o" || k === "O") { e.preventDefault(); setOut(); }
    else if (k === "a" || k === "A") { e.preventDefault(); toAI(); }
  });
  window.addEventListener("keyup", e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") stopHold(); });
  window.addEventListener("blur", stopHold);

  stage.register("replay", {
    undo: () => undo(false), redo: () => undo(true),
    canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0,
    escape: () => { if (focus()) setRange(-1, -1); },
  });

  // ---- enter / leave the stage

  /** The stage is shown; to: "replay/<id>/<frame>" opens that recording at that frame. */
  async function enter(to = "") {
    active = true;
    stage.use(doc);
    stage.onMove = null;
    stage.show(image);
    stage.busy(loading);
    badge(); saveStatus(); sendUi(); placeholder(); stage.buttons();
    const [, id, f] = to.split("/");
    if (!started) {
      started = true;
      ws = wsStore.current;
      $("rp-play").innerHTML = svg("play");
      updatePos(); renderRecButton(); labCount();
      await loadList();
      await openDefault(to);
    } else {
      requestAnimationFrame(sizeScrub);
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
    screen.classList.remove("playing");
    stage.busy(false);
    recmenu.classList.remove("on"); labmenu.classList.remove("on");
    flush();
  }

  return { enter, leave, flush, setWorkspace, editItem, trayChanged, editing: () => trayItem?.id ?? null };
})();
