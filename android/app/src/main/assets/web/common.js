// Shared by every page: API access, icons, theme, dialogs and toasts, and the screen annotations (drawing and shapes).
"use strict";

const TOKEN = new URLSearchParams(location.search).get("token") || localStorage.getItem("maalow-token") || "";
if (TOKEN) localStorage.setItem("maalow-token", TOKEN);
// remembered now; keep it out of the address bar (and out of screenshots of the page)
if (location.search.includes("token=")) history.replaceState(null, "", location.pathname + location.hash);
const API = "/api/v1";
const api = (path, opts = {}) =>
  fetch(API + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + TOKEN } });
async function errorText(r) {
  const t = await r.text();
  try { return JSON.parse(t).error || t; } catch (e) { return t || ("HTTP " + r.status); }
}
// The page itself opens without a token; say so once when the API refuses the remembered one (or there is none).
function tokenMissing() {
  if (document.getElementById("tokenbar")) return;
  const d = document.createElement("div");
  d.id = "tokenbar";
  d.textContent = TOKEN ? "Token 不对（可能在 App 里重置过）：请用 App 里的新链接重新打开一次" : "缺少 Token：请用 App 里的链接打开一次，之后浏览器会记住";
  document.body.prepend(d);
}
const json = async (path, opts) => {
  const r = await api(path, opts);
  if (r.status === 401) tokenMissing();
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
};
const post = (path, body) => json(path, { method: "POST", body: JSON.stringify(body || {}) });
const withToken = url => url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const enc = encodeURIComponent;

// ---- icons: <i data-i="name"></i> in the markup becomes an inline SVG (24x24, stroked)
const ICONS = {
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
  click: '<circle cx="12" cy="12" r="3"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  region: '<rect x="4" y="5" width="16" height="14" rx="1.5" stroke-dasharray="3 3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  first: '<path d="M6 5v14M18 5l-9 7 9 7z"/>',
  last: '<path d="M18 5v14M6 5l9 7-9 7z"/>',
  prev: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10"/>',
  game: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 10v5M4.5 12.5h5M15 11h.01M18 14h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  send: '<path d="M4 12 20 4l-4 16-4-7z"/><path d="m12 13 8-9"/>',
  rec: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6z"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};
const svg = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24">${ICONS[name] || ""}</svg>`;
function hydrateIcons(root = document) {
  root.querySelectorAll("i[data-i]").forEach(el => { el.outerHTML = svg(el.dataset.i, el.className); });
}

// ---- theme: auto (follow the system), light or dark; the choice is remembered
const theme = {
  modes: ["auto", "light", "dark"],
  get: () => localStorage.getItem("maalow-theme") || "auto",
  apply() {
    const m = theme.get(), dark = m === "dark" || (m === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    window.dispatchEvent(new Event("themechange"));
  },
  cycle() {
    const m = theme.modes[(theme.modes.indexOf(theme.get()) + 1) % 3];
    localStorage.setItem("maalow-theme", m);
    theme.apply();
    return m;
  },
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => theme.apply());
theme.apply();
/** A CSS variable of the current theme, for canvas drawing. */
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- toast and dialogs (instead of alert / confirm / prompt)
function toast(msg, ms = 3000) {
  const t = $("toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.style.display = "none", ms);
}

const ui = (() => {
  let close = null;
  /**
   * A modal: {title, body: html, wide, actions: [{label, value, kind}], init(box), check(value, box) -> error text}.
   * An action's value may be a function of the dialog box. Resolves with the chosen value (null when dismissed).
   */
  function dialog({ title, body = "", wide = false, actions = [{ label: "好", value: true, kind: "primary" }], init, check }) {
    close?.(null);
    const d = $("dlg");
    d.innerHTML = `<div class="box${wide ? " wide" : ""}"><div class="hd">${title || ""}</div><div class="bd">${body}<div class="err"></div></div>
      <div class="ft">${actions.map((a, i) => `<button class="btn ${a.kind || ""}" data-a="${i}">${a.label}</button>`).join("")}</div></div>`;
    hydrateIcons(d);
    const box = d.firstElementChild;
    d.classList.add("on");
    return new Promise(resolve => {
      // Esc closes wherever the focus is (clicking a plain part of the dialog moves it to the page)
      const esc = e => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close?.(null); } };
      document.addEventListener("keydown", esc, true);
      close = v => { close = null; document.removeEventListener("keydown", esc, true); d.classList.remove("on"); d.innerHTML = ""; resolve(v); };
      const pick = async a => {
        const v = typeof a.value === "function" ? a.value(box) : a.value;
        if (v !== null && v !== false && check) {
          const err = await check(v, box);
          if (err) { box.querySelector(".err").textContent = err; return; }
        }
        close?.(v);
      };
      box.querySelector(".ft").onclick = e => { const b = e.target.closest("[data-a]"); if (b) pick(actions[b.dataset.a]); };
      d.onpointerdown = e => { if (e.target === d) close?.(null); };
      box.onkeydown = e => {
        if (e.key === "Enter" && e.target.tagName === "INPUT") {
          e.preventDefault();
          const main = actions.findLast(a => /primary|danger/.test(a.kind || ""));
          if (main) pick(main);
        }
      };
      init?.(box);
      (box.querySelector("[autofocus]") || box.querySelector(".ft .btn:last-child"))?.focus();
    });
  }
  const isOpen = () => !!close;
  const text = t => `<div class="msgtext">${esc(t)}</div>`;
  const alert = (t, title = "提示") => dialog({ title, body: text(t) });
  const confirm = (t, { title = "确认", ok = "确定", danger = false } = {}) => dialog({
    title, body: text(t),
    actions: [{ label: "取消", value: false }, { label: ok, value: true, kind: danger ? "danger" : "primary" }],
  }).then(Boolean);
  /** Resolves with the trimmed text, or null. validate(text) -> error text. */
  const prompt = (label, { title = "", value = "", placeholder = "", ok = "确定", validate } = {}) => dialog({
    title,
    body: `<label>${esc(label)}<input id="dlg-in" autofocus value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`,
    actions: [{ label: "取消", value: null }, { label: ok, value: box => box.querySelector("#dlg-in").value.trim(), kind: "primary" }],
    check: t => !t ? "不能为空" : validate?.(t),
    init: box => box.querySelector("#dlg-in").select(),
  });
  return { dialog, alert, confirm, prompt, isOpen };
})();

/** Copy text; the page is plain http on the LAN, where navigator.clipboard is not available. */
async function copyText(text, done = "已复制") {
  try {
    if (navigator.clipboard && isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const t = document.createElement("textarea");
      t.value = text; t.style.cssText = "position:fixed;top:0;opacity:0";
      document.body.appendChild(t); t.select();
      const ok = document.execCommand("copy");
      t.remove();
      if (!ok) throw new Error("浏览器不允许复制");
    }
    toast(done, 1500);
  } catch (e) {
    ui.alert(text, "复制失败，请手动复制");
  }
}

/**
 * Drag to reorder: rows (matching rowSel) of any list inside container move by their [data-drag] handle, with the
 * mouse or a finger. onDrop(rows) gets the list's rows in their new order, only when it changed.
 */
function sortable(container, rowSel, onDrop) {
  container.addEventListener("pointerdown", e => {
    const handle = e.target.closest("[data-drag]"), row = handle?.closest(rowSel);
    if (!row || !container.contains(row) || e.button > 0) return;
    e.preventDefault();
    const list = row.parentElement, rows = () => [...list.children].filter(r => r.matches(rowSel));
    const before = rows();
    row.classList.add("dragging");
    list.setPointerCapture(e.pointerId); // the list: moving the row would drop a capture held by the handle
    const move = ev => {
      const next = rows().find(r => r !== row && ev.clientY < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2);
      if (next !== row.nextElementSibling) list.insertBefore(row, next || null);
    };
    const up = () => {
      list.removeEventListener("pointermove", move);
      list.removeEventListener("pointerup", up);
      list.removeEventListener("pointercancel", up);
      row.classList.remove("dragging");
      const after = rows();
      if (after.some((r, i) => r !== before[i])) onDrop(after);
    };
    list.addEventListener("pointermove", move);
    list.addEventListener("pointerup", up);
    list.addEventListener("pointercancel", up);
  });
}

// ---- workspaces: the device's current one (switched only in this web UI) and the list, with counts
const wsStore = {
  current: "",
  list: [],
  listeners: [],
  info(name) { return this.list.find(w => w.name === name); },
  on(fn) { this.listeners.push(fn); },
  async refresh() {
    const r = await json("/workspaces/info");
    const was = this.current;
    this.list = r.workspaces;
    this.current = r.current || "";
    this.listeners.forEach(fn => fn(was !== this.current));
    return r;
  },
};

// ---- small formatting and markup helpers
const appIconUrl = pkg => withToken(`${API}/apps/${enc(pkg)}/icon.png`);
/** The game's icon, falling back to the workspace's first letter. */
const appIcon = (pkg, name, cls = "") =>
  `<span class="appicon ${cls}">${esc((name || "?").slice(0, 1).toUpperCase())}${pkg ? `<img src="${appIconUrl(pkg)}" alt="" onerror="this.remove()">` : ""}</span>`;
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 ** 3).toFixed(2) + " GB";
}
const pad2 = n => String(n).padStart(2, "0");
function fmtWhen(ms) {
  if (!ms) return "—";
  const d = new Date(ms), day = k => { const x = new Date(); x.setDate(x.getDate() + k); return x.toDateString(); };
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const rel = { [day(0)]: "今天", [day(1)]: "明天", [day(-1)]: "昨天" }[d.toDateString()];
  return `${rel || `${d.getMonth() + 1}月${d.getDate()}日`} ${hm}`;
}
function fmtAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

// ---- screen annotations

const TOOLS = ["rect", "circle", "arrow", "click", "region"];
const COLORS = { rect: "#ff4d4f", circle: "#40a9ff", arrow: "#52c41a", click: "#faad14", region: "#b37feb" };
const NAMES = { rect: "框选", circle: "圈", arrow: "箭头", click: "点击点", region: "区域" };

/** Canvas pixel position of a pointer event. */
function canvasPos(cv, e) {
  const r = cv.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left) * cv.width / r.width), y = Math.round((e.clientY - r.top) * cv.height / r.height);
  return [Math.max(0, Math.min(cv.width - 1, x)), Math.max(0, Math.min(cv.height - 1, y))];
}

// coords follow maalow.teaching.Annotation: rect/region/circle [x,y,w,h], arrow [x1,y1,x2,y2], click [x,y]
function toMark(kind, a, b) {
  if (kind === "click") return { kind, coords: b };
  if (kind === "arrow") return { kind, coords: [a[0], a[1], b[0], b[1]] };
  return { kind, coords: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])] };
}

/** A drag too short to mean a shape. */
function tinyMark(m) {
  if (m.kind === "click") return false;
  if (m.kind === "arrow") return Math.hypot(m.coords[2] - m.coords[0], m.coords[3] - m.coords[1]) < 5;
  return m.coords[2] < 4 || m.coords[3] < 4;
}

/** Draw an annotation; n: its number (0: none); selected: emphasized. */
function drawMark(ctx, m, n, selected) {
  const c = COLORS[m.kind], [x, y, w, h] = m.coords;
  const path = () => {
    ctx.beginPath();
    if (m.kind === "rect" || m.kind === "region") ctx.rect(x, y, w, h);
    else if (m.kind === "circle") ctx.ellipse(x + w / 2, y + h / 2, Math.max(w / 2, 1), Math.max(h / 2, 1), 0, 0, 2 * Math.PI);
    else if (m.kind === "arrow") { ctx.moveTo(x, y); ctx.lineTo(w, h); }
    else if (m.kind === "click") { ctx.arc(x, y, 10, 0, 2 * Math.PI); ctx.moveTo(x - 16, y); ctx.lineTo(x + 16, y); ctx.moveTo(x, y - 16); ctx.lineTo(x, y + 16); }
  };
  ctx.save();
  if (selected) { // white halo under the shape
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 7; ctx.setLineDash([]); path(); ctx.stroke();
  }
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = selected ? 4 : 3;
  ctx.setLineDash(m.kind === "region" ? [8, 6] : []);
  path(); ctx.stroke();
  ctx.setLineDash([]);
  let lx = x, ly = y;
  if (m.kind === "arrow") {
    const [x2, y2] = [w, h], ang = Math.atan2(y2 - y, x2 - x);
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 16 * Math.cos(ang - 0.4), y2 - 16 * Math.sin(ang - 0.4));
    ctx.lineTo(x2 - 16 * Math.cos(ang + 0.4), y2 - 16 * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
  } else if (m.kind === "click") { lx = x + 12; ly = y - 12; }
  if (n) {
    ctx.font = "bold 16px sans-serif";
    const t = String(n), tw = ctx.measureText(t).width + 8;
    ly = Math.max(ly, 20);
    ctx.fillRect(lx, ly - 20, tw, 20);
    ctx.fillStyle = "#000"; ctx.fillText(t, lx + 4, ly - 4);
  }
  ctx.restore();
}
