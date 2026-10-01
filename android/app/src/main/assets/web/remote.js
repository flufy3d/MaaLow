// The remote stage: the tablet's screen live and, after taking control, the mouse or a finger on it acting as touches
// on the tablet. Not teaching: nothing of it goes into the chat. Video is H.264 over the WebSocket /api/v1/remote,
// decoded with WebCodecs, which browsers only offer on HTTPS pages (see README: TailSocks). The connection is open only
// while this stage is shown and the tab is visible; closing it gives control back at once. The lock screen's password
// pad is black in the stream (a secure window): the app sends its controls instead, drawn over the picture.
"use strict";
window.remote = (() => {
  const W = 1080, H = 720, HEADER = 10, MOVE_MS = 16, PING_MS = 2000, WHEEL_ID = 9;
  const cv = $("scr-remote"), ctx = cv.getContext("2d"), padCtx = $("scr-pad").getContext("2d");
  let active = false, ws = null, conn = "off", retryTimer = 0, pingTimer = 0, statsTimer = 0; // conn: off | connecting | open | closed
  let decoder = null, cfg = null, waitKey = true, fails = 0, shown = false, st = {}, settings = null, lastOver = null;
  let pad = [], typed = 0, pressed = null, unpress = 0; // the password pad's controls (frame coordinates), digits tapped, the id of the key held
  const stats = { frames: 0, bytes: 0, since: 0, fps: 0, mbps: 0, rtt: null };

  const supported = () => window.isSecureContext && "VideoDecoder" in window;
  const controlling = () => st.control === "me";
  const send = m => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

  // ---- the connection

  function connect() {
    clearTimeout(retryTimer);
    if (ws || !active || document.hidden || !supported()) return;
    conn = "connecting";
    const s = ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API}/remote`);
    s.binaryType = "arraybuffer";
    s.onopen = () => {
      if (ws !== s) return;
      s.send(JSON.stringify({ t: "hello", token: TOKEN })); // the token goes in the first message, not the URL
      conn = "open";
      ping();
      pingTimer = setInterval(ping, PING_MS);
      render();
    };
    s.onmessage = e => { if (ws === s) typeof e.data === "string" ? onText(JSON.parse(e.data)) : onVideo(e.data); };
    s.onclose = () => {
      if (ws !== s) return;
      ws = null;
      cleanup();
      conn = "closed";
      render();
      if (active && !document.hidden) retryTimer = setTimeout(connect, 2000);
    };
    render();
  }
  function disconnect() {
    clearTimeout(retryTimer);
    const s = ws;
    ws = null;
    s?.close();
    cleanup();
    conn = "off";
  }
  function cleanup() {
    clearInterval(pingTimer);
    touches.clear();
    closeDecoder();
    cfg = null;
    st = {};
    pad = [];
    drawPad();
  }
  const ping = () => send({ t: "ping", ts: performance.now() });

  function onText(m) {
    if (m.t === "config") configure(m);
    else if (m.t === "state") {
      const was = st.control;
      st = m;
      if (m.control !== "me") touches.clear(); // the app lifted them
      if (m.control === "me" && was !== "me") toast("已接管：正在跑的已停下，AI 的操作会被拒绝", 3000);
      render();
    } else if (m.t === "layout") {
      const had = pad.length > 0;
      pad = m.nodes;
      typed = m.typed;
      drawPad();
      if (had !== pad.length > 0) render(); // only the badge depends on it: taps leave the toolbar alone
    } else if (m.t === "pong") stats.rtt = performance.now() - m.ts;
    else if (m.t === "error" || m.t === "notice") toast(m.message, 4000);
  }

  // ---- decoding: key frames carry SPS/PPS (Annex-B), so any key frame is a fresh start

  function configure(c) {
    closeDecoder();
    cfg = c;
    waitKey = true;
    decoder = new VideoDecoder({
      output: f => {
        ctx.drawImage(f, 0, 0, W, H);
        f.close();
        stats.frames++;
        fails = 0;
        if (!shown) { shown = true; render(); }
      },
      error: e => { console.warn("remote decoder", e); restart(); },
    });
    try {
      decoder.configure({ codec: c.codec, optimizeForLatency: true });
    } catch (e) {
      console.warn("remote decoder config", e);
      restart();
    }
  }
  /** The decoder broke: a new one, from the next key frame (asked for); gives up after a few in a row. */
  function restart() {
    const c = cfg;
    if (!c || ++fails > 5) { closeDecoder(); render(); return; }
    setTimeout(() => { if (cfg === c && ws) { configure(c); send({ t: "keyframe" }); } }, 200 * fails);
  }
  function closeDecoder() {
    try { if (decoder && decoder.state !== "closed") decoder.close(); } catch (e) { /* already closed */ }
    decoder = null;
  }
  function onVideo(buf) {
    stats.bytes += buf.byteLength;
    if (!decoder || decoder.state !== "configured") return;
    const v = new DataView(buf), key = (v.getUint8(1) & 1) === 1;
    if (waitKey && !key) return;
    waitKey = false;
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: Number(v.getBigInt64(2)), data: new Uint8Array(buf, HEADER) }));
    } catch (e) {
      restart();
    }
  }

  function tickStats() {
    const now = performance.now(), s = (now - stats.since) / 1000 || 1;
    stats.fps = stats.frames / s;
    stats.mbps = stats.bytes * 8 / s / 1e6;
    stats.frames = 0; stats.bytes = 0; stats.since = now;
    if (!active) return;
    stage.status(conn === "open" ? `${Math.round(stats.fps)} fps · ${stats.mbps.toFixed(1)} Mbps · 往返 ${stats.rtt == null ? "—" : Math.round(stats.rtt) + " ms"}` : "");
  }

  // on its own layer over the picture, redrawn whole when the pad, the count or the pressed key changes
  function drawPad() {
    const ctx = padCtx;
    ctx.clearRect(0, 0, W, H);
    for (const n of pad) {
      const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
      ctx.save();
      if (n.kind === "tap") {
        ctx.beginPath();
        ctx.roundRect(n.x + 3, n.y + 3, n.w - 6, n.h - 6, 10);
        ctx.fillStyle = n.id === pressed ? "rgba(255,255,255,.45)" : "rgba(255,255,255,.1)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,.5)";
        ctx.stroke();
      } else if (n.kind === "field") {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(255,255,255,.4)";
        ctx.strokeRect(n.x, n.y, n.w, n.h);
      }
      ctx.fillStyle = n.kind === "tap" ? "#fff" : "rgba(255,255,255,.7)";
      ctx.font = `${Math.round(Math.max(12, Math.min(n.h * (n.kind === "tap" ? .45 : .6), 30)))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (n.kind !== "field") ctx.fillText(n.label, cx, cy, n.w);
      else if (!typed) ctx.fillText("还没输入", cx, cy);
      else for (let i = 0; i < typed; i++) { // counted by the app: the pad does not show them
        ctx.beginPath();
        ctx.arc(cx + (i - (typed - 1) / 2) * 22, cy, 6, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.restore();
    }
  }
  // lit while held and a little after, like a key; by id, since every count or read brings new node objects
  function press([x, y]) {
    const n = pad.find(n => n.kind === "tap" && x >= n.x && x < n.x + n.w && y >= n.y && y < n.y + n.h);
    if (!n) return;
    clearTimeout(unpress);
    pressed = n.id;
    drawPad();
  }
  function release() {
    if (pressed == null) return;
    clearTimeout(unpress);
    unpress = setTimeout(() => { pressed = null; drawPad(); }, 100);
  }

  // ---- input: only while this page has control (the app drops anything else)

  const touches = new Map(); // pointerId -> {id, p, at, timer}
  const touch = (a, id, [x, y]) => send({ t: "touch", a, id, x, y });
  const key = code => { if (controlling()) send({ t: "key", code }); };

  cv.addEventListener("pointerdown", e => {
    if (!active || !controlling()) return;
    e.preventDefault();
    if (e.button === 2) { key("back"); return; }
    if (e.button > 0) return;
    const used = new Set([...touches.values()].map(t => t.id));
    const id = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(i => !used.has(i));
    if (id == null) return;
    cv.setPointerCapture(e.pointerId);
    const t = { id, p: canvasPos(cv, e), at: performance.now(), timer: 0 };
    touches.set(e.pointerId, t);
    touch("down", id, t.p);
    press(t.p);
  });
  cv.addEventListener("pointermove", e => { // about 60 a second: the latest position when the next one is due
    const t = touches.get(e.pointerId);
    if (!t) return;
    t.p = canvasPos(cv, e);
    const wait = MOVE_MS - (performance.now() - t.at);
    const go = () => { t.timer = 0; if (touches.get(e.pointerId) === t) { t.at = performance.now(); touch("move", t.id, t.p); } };
    if (wait <= 0) go();
    else if (!t.timer) t.timer = setTimeout(go, wait);
  });
  const lift = e => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    clearTimeout(t.timer);
    touches.delete(e.pointerId);
    touch("up", t.id, t.p);
    release();
  };
  cv.addEventListener("pointerup", lift);
  cv.addEventListener("pointercancel", lift);
  cv.addEventListener("contextmenu", e => { if (active) e.preventDefault(); });

  // the wheel: one short swipe per notch (wheel down = content moves up, like a finger pushing it)
  let wheeling = false;
  cv.addEventListener("wheel", e => {
    if (!active || !controlling()) return;
    e.preventDefault();
    if (wheeling || touches.size) return;
    wheeling = true;
    const [x, y] = canvasPos(cv, e), dy = (e.deltaY > 0 ? -1 : 1) * 160, steps = 6;
    let i = 0;
    touch("down", WHEEL_ID, [x, y]);
    const iv = setInterval(() => {
      const p = [x, Math.max(0, Math.min(H - 1, Math.round(y + dy * ++i / steps)))];
      if (i < steps) return touch("move", WHEEL_ID, p);
      touch("up", WHEEL_ID, p);
      clearInterval(iv);
      setTimeout(() => { wheeling = false; }, 120);
    }, MOVE_MS);
  }, { passive: false });

  document.querySelectorAll("#rm-keys [data-key]").forEach(b => b.onclick = () => key(b.dataset.key));

  $("rm-take").onclick = async () => {
    if (controlling()) return send({ t: "release" });
    if (st.control === "other") {
      if (!await ui.confirm("另一个网页正在操控。抢过来以后，对方只能观看。", { title: "抢过控制权？", ok: "抢过来" })) return;
      return send({ t: "take", force: true });
    }
    send({ t: "take" });
  };

  // a full-quality screenshot (not the compressed stream) into the tray; stays on this stage
  let shooting = false;
  async function shot() {
    if (shooting) return;
    shooting = true;
    try { await teach.takeShot(false); toast("截图已放进托盘", 1500); }
    catch (e) { ui.alert(e.message, "截图失败"); }
    finally { shooting = false; }
  }
  $("rm-shot").onclick = shot;

  window.addEventListener("keydown", e => {
    if (!active || mode !== "teach" || ui.isOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === "s" || e.key === "S") shot();
  });

  // Esc (with nothing else to cancel) is the back key; there is nothing to undo here
  stage.register("remote", {
    undo() {}, redo() {}, canUndo: () => false, canRedo: () => false,
    escape: () => key("back"),
  });

  // ---- what the stage shows

  const BUSY = { "task:": "规则", "skill:": "技能", "teach:": "MaaLow", "guard:": "守护规则" };
  const busyText = b => { const k = Object.keys(BUSY).find(p => b.startsWith(p)); return k ? `${BUSY[k]} ${b.slice(k.length)}` : b; };

  function httpsCard() {
    const url = settings?.https_url || "";
    const body = window.isSecureContext
      ? `<p>这个浏览器不支持 WebCodecs 视频解码，请换新版的 Chrome、Edge 或 Safari。</p>`
      : `<p>浏览器只在 HTTPS 页面提供低延迟视频解码（WebCodecs），这个页面是 http，所以看不了实时画面。</p>
        <p>在平板上另装 <b>TailSocks</b>：官方 Tailscale 只负责组网，TailSocks 只用来拿 <span class="mono">ts.net</span> 证书，把 MaaLow 发布成 HTTPS，两个共存。部署步骤见 README 的“远程操控”。</p>
        ${url ? `<p><button class="btn primary" data-rm="open">${svg("link")}打开 HTTPS 版</button> <span class="mono dim">${esc(url)}</span></p>` : ""}
        <div class="row"><input id="rm-https" placeholder="HTTPS 地址，如 https://maalow-pad.tailea818a.ts.net" value="${esc(url)}">
          <button class="btn" data-rm="save">保存</button></div>`;
    return `<div class="rm-card"><h3>${svg("alert")}远程画面需要 HTTPS</h3>${body}</div>`;
  }
  $("scr-over").addEventListener("click", async e => {
    const a = e.target.closest("[data-rm]")?.dataset.rm;
    if (!a || !active) return;
    if (a === "open") location.href = `${settings.https_url}/?token=${enc(TOKEN)}#teach/remote`;
    if (a === "save") {
      try {
        settings = await json("/settings", { method: "PUT", body: JSON.stringify({ https_url: $("rm-https").value.trim() }) });
        toast("已保存", 1500);
        lastOver = null;
        render();
      } catch (err) { ui.alert(err.message, "保存失败"); }
    }
  });

  function overlay() {
    if (!supported()) return httpsCard();
    const say = (t, sub = "") => `<div><b>${t}</b>${sub ? `<br><span class="dim">${sub}</span>` : ""}</div>`;
    if (conn !== "open") return say(conn === "closed" ? "连接断开，正在重连…" : "正在连接…");
    if (!st.t) return say("正在连接…");
    if (st.blocked) return say(esc(st.blocked), "条件满足后会自动开始");
    if (st.screen_on === false) return say("屏幕已关闭", controlling() ? "点工具栏里的“唤醒”点亮屏幕" : "接管后可以用“唤醒”点亮屏幕");
    if (cfg && fails > 5) return say("画面解码失败", "换个浏览器试试，或者刷新页面");
    if (!shown) return say("等待画面…");
    return "";
  }

  function render() {
    if (!active) return;
    const me = controlling(), other = st.control === "other", open = conn === "open" && !!st.t;
    stage.screen.classList.toggle("ctl", me);
    const b = $("rm-take");
    b.className = `btn solid ${me ? "red" : "orange"} for-remote`;
    b.disabled = !open || (!me && !other && !st.can_take);
    b.innerHTML = `${svg(me ? "x" : "hand")}<span class="st">${me ? "操控中" : other ? "他人操控中" : "观看中"}</span><span class="tl">▸ ${me ? "释放" : other ? "抢过来" : "接管"}</span>`;
    b.title = me ? "释放控制权，回到观看" : other ? "另一个网页在操控，确认后抢过来" : "接管：先停下正在跑的，再拿设备锁；接管期间 AI 的操作会被拒绝";
    document.querySelectorAll("#rm-keys .btn").forEach(k => { k.disabled = !me; });
    $("rm-shot").disabled = !open;

    const html = overlay();
    if (html !== lastOver) { lastOver = html; stage.over(html, !supported()); }
    const lock = pad.length ? "锁屏密码界面看不到画面，按读出的位置画了按键" : st.locked ? "平板锁着" : "";
    stage.badge(!open || !shown ? "" : [me ? "操控中" : "观看中", lock, !me && st.locked ? "接管后可以解锁" : ""].filter(Boolean).join(" · "), me ? "tray" : "latest");

    const dot = $("rm-dot");
    dot.className = "dot " + (open ? "ok" : conn === "off" ? "" : "warn pulse");
    $("rm-conn").textContent = !supported() ? "需要 HTTPS" : open ? `已连接 · ${st.viewers} 个网页在看${st.bitrate ? ` · 码率上限 ${(st.bitrate / 1e6).toFixed(1)} Mbps` : ""}`
      : conn === "off" ? "未连接" : "连接中…";
    $("rm-who").textContent = !open ? "" : me ? `你在操控 · ${Math.round(st.idle_release_ms / 60000)} 分钟没有操作自动释放`
      : other ? "另一个网页在操控，你只能看"
      : st.engine !== "running" ? "引擎没有运行，不能接管"
      : st.busy ? `设备正在用：${busyText(st.busy)}（接管时会先停下）` : "没人在操控";
  }

  async function loadSettings() {
    try {
      settings = await json("/settings");
      // opened over HTTPS: that is the address to offer from plain http pages and in the app
      if (location.protocol === "https:" && !settings.https_url) {
        settings = await json("/settings", { method: "PUT", body: JSON.stringify({ https_url: location.origin }) });
      }
    } catch (e) { /* app restarting */ }
    lastOver = null;
    render();
  }

  document.addEventListener("visibilitychange", () => {
    if (!active) return;
    if (document.hidden) { disconnect(); shown = false; } else connect(); // hidden: let go of the picture and control
    render();
  });

  function enter() {
    active = true;
    stage.use(null);
    stage.onMove = null;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    shown = false;
    lastOver = null;
    stats.since = performance.now();
    statsTimer = setInterval(tickStats, 1000);
    loadSettings();
    connect();
    render();
  }
  function leave() {
    active = false;
    disconnect();
    clearInterval(statsTimer);
    stage.screen.classList.remove("ctl");
    stage.over("");
    stage.badge("");
    stage.status("");
  }

  return { enter, leave };
})();
