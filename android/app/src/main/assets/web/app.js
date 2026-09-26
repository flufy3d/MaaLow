// The page shell: tabs (kept in the URL hash: #overview, #live, #replay/<recording>/<frame>, #workspaces), the
// workspace switcher, theme and help. Loaded last.
"use strict";

let mode = "";
const PAGES = { overview: window.overview, replay: window.replay, workspaces: window.wsPage };
function setMode(m) {
  if (!["overview", "live", "replay", "workspaces"].includes(m)) m = "overview";
  if (m === mode) return;
  const prev = mode;
  mode = m;
  document.querySelectorAll("#tabs .tab").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  document.querySelectorAll(".mode").forEach(d => d.classList.toggle("on", d.id === m));
  PAGES[prev]?.leave();
  PAGES[m]?.enter();
  if (m !== "replay") history.replaceState(null, "", "#" + m);
}
document.querySelectorAll("#tabs .tab").forEach(b => b.onclick = () => setMode(b.dataset.mode));

// ---- workspace switcher

function renderSwitcher() {
  const name = wsStore.current, w = wsStore.info(name);
  $("wsbtn").innerHTML = `${appIcon(w?.package, name || "?")}<span class="txt"><span class="lbl">当前工作区</span>
    <span class="nm">${esc(name || "没有工作区")}</span></span>${svg("down", "sm")}`;
  $("wsbtn").title = name ? `当前工作区：${name}${w?.app ? `（${w.app}）` : ""}，点击切换` : "新建一个工作区";
}

/** Make name the device's current workspace; the app, live and replay teaching all follow. */
async function useWorkspace(name) {
  if (name === wsStore.current) return true;
  try {
    await replay.flush(); // unsaved labels belong to the old workspace
    await post(`/workspaces/${enc(name)}/use`);
    await wsStore.refresh();
    toast(`已切换到 ${name}`);
    return true;
  } catch (e) {
    ui.alert(e.message, "无法切换工作区");
    return false;
  }
}

const menu = $("wsmenu");
function openMenu() {
  const r = $("wsbtn").getBoundingClientRect();
  menu.style.left = Math.max(8, r.left) + "px";
  menu.style.top = r.bottom + 6 + "px";
  menu.innerHTML = `<div class="hd">切换工作区</div>
    ${wsStore.list.map(w => `<div class="it${w.name === wsStore.current ? " cur" : ""}" data-ws="${esc(w.name)}">${appIcon(w.package, w.name)}
      <div class="bd"><div class="nm">${esc(w.name)}</div><div class="sub">${esc(w.app || w.package || "未设置游戏")}${w.busy ? " · " + esc(w.busy) : ""}</div></div>
      ${w.name === wsStore.current ? svg("check") : ""}</div>`).join("") || `<div class="none" style="padding:6px 10px">还没有工作区</div>`}
    <div class="ft">
      <div class="it" data-go="new">${svg("plus")}<div class="bd">新建工作区…</div></div>
      <div class="it" data-go="manage">${svg("layers")}<div class="bd">管理工作区</div></div>
    </div>`;
  menu.classList.add("on");
}
const closeMenu = () => menu.classList.remove("on");
$("wsbtn").onclick = async e => {
  e.stopPropagation();
  if (menu.classList.contains("on")) return closeMenu();
  openMenu();
  wsStore.refresh().then(() => { if (menu.classList.contains("on")) openMenu(); }).catch(() => {});
};
menu.onclick = async e => {
  const it = e.target.closest(".it");
  if (!it) return;
  closeMenu();
  if (it.dataset.go === "new") { setMode("workspaces"); wsPage.create(); }
  else if (it.dataset.go === "manage") setMode("workspaces");
  else if (it.dataset.ws) useWorkspace(it.dataset.ws);
};
document.addEventListener("pointerdown", e => { if (!menu.contains(e.target) && !$("wsbtn").contains(e.target)) closeMenu(); });
window.addEventListener("resize", closeMenu);

wsStore.on(changed => {
  renderSwitcher();
  if (changed) { replay.setWorkspace(wsStore.current); overview.refresh(); }
  if (mode === "overview") overview.refresh();
});

// the current workspace may change elsewhere (another browser, the AI switching tasks): follow it
setInterval(async () => {
  if (document.hidden) return;
  try {
    const s = await json("/status");
    if ((s.workspace || "") !== wsStore.current) await wsStore.refresh();
  } catch (e) { /* app restarting */ }
}, 3000);

// ---- theme and help

const THEMES = { auto: ["auto", "主题：跟随系统"], light: ["sun", "主题：浅色"], dark: ["moon", "主题：深色"] };
function renderTheme() {
  const [icon, tip] = THEMES[theme.get()];
  $("themebtn").innerHTML = svg(icon);
  $("themebtn").title = tip + "（点击切换）";
}
$("themebtn").onclick = () => { theme.cycle(); renderTheme(); toast(THEMES[theme.get()][1], 1200); };

const help = () => ui.isOpen() ? null : ui.dialog({ title: "快捷键", wide: true, body: $("helptpl").innerHTML });
$("helpbtn").onclick = help;
window.addEventListener("keydown", e => {
  if (e.key !== "?" || ui.isOpen() || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  help();
});

// ---- start

hydrateIcons();
renderTheme();
renderSwitcher();
wsStore.refresh().catch(e => toast("连接 App 失败：" + e.message)).finally(() => {
  setMode((location.hash.slice(1).split("/")[0]) || (wsStore.current ? "live" : "overview"));
});
