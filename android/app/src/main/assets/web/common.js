// Shared by both teaching modes: API access and the screen annotations (drawing and shapes).
"use strict";

const TOKEN = new URLSearchParams(location.search).get("token") || localStorage.getItem("maalow-token") || "";
if (TOKEN) localStorage.setItem("maalow-token", TOKEN);
const API = "/api/v1";
const api = (path, opts = {}) =>
  fetch(API + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + TOKEN } });
async function errorText(r) {
  const t = await r.text();
  try { return JSON.parse(t).error || t; } catch (e) { return t || ("HTTP " + r.status); }
}
const json = async (path, opts) => { const r = await api(path, opts); if (!r.ok) throw new Error(await errorText(r)); return r.json(); };
const post = (path, body) => json(path, { method: "POST", body: JSON.stringify(body || {}) });
const withToken = url => url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

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
