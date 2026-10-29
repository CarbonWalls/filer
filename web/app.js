// Filer client. Minimal, dependency-free, keyboard friendly.

// Load-time trace that is ALSO visible on the page (boot strip at top).
function bootMark(msg) {
  console.info("[filer] " + msg);
  if (window.__filerBoot) {
    window.__filerBoot.log.push("[app] " + msg);
    window.__filerBoot.last = msg;
    const el = document.getElementById("boot-status");
    if (el) el.textContent = window.__filerBoot.log.join("\n");
  }
}
bootMark("app.js evaluated");

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  path: null,
  parent: null,
  entries: [],
  sel: new Set(),
  anchorIdx: -1,
  focusIdx: -1,
  filter: "",
  plugins: [],
  commands: [],
  grid: false,
  split: false,
  splitPath: null,
  addrTarget: "main",
  home: "/",
  wide: () => window.matchMedia("(min-width: 721px)").matches,
};

// ---------------------------------------------------------------- utils

// Run a UI callback, surfacing errors to the crash panel instead of letting
// one bad handler freeze the whole interface. (reportError is defined below,
// after showCrashPanel; function hoisting makes it callable from here.)
function safe(fn, label) {
  return (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === "function") {
        r.catch((e) => reportError(label, e));
      }
    } catch (e) {
      reportError(label, e);
    }
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + " " + u[i];
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function icon(name, size = 15) {
  return `<svg class="ic" width="${size}" height="${size}"><use href="#i-${name}"/></svg>`;
}

function iconForEntry(e) {
  if (e.kind === "dir") return "folder";
  if (e.kind === "link") return "link";
  const m = /\.([^.]+)$/.exec(e.name);
  const ext = m ? m[1].toLowerCase() : "";
  if (["png","jpg","jpeg","gif","webp","avif","bmp","svg","ico","tiff","heic"].includes(ext)) return "image";
  if (["mp4","webm","mov","mkv","avi","m4v","ogv"].includes(ext)) return "film";
  if (["mp3","wav","ogg","oga","flac","m4a","aac","opus"].includes(ext)) return "music";
  if (["zip","tar","gz","bz2","xz","7z","rar"].includes(ext)) return "archive";
  if (["js","mjs","cjs","jsx","ts","tsx","json","css","scss","less","html","htm","xml","yml","yaml","sh","py","rb","go","rs","c","cc","cpp","h","java","kt","swift","php","sql","toml","ini","cfg","conf","log","csv","env","proto"].includes(ext)) return "code";
  if (ext === "md" || ext === "markdown") return "type";
  return "file";
}

// ---------------------------------------------------------------- api

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("json")) data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || "Request failed";
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return data;
}

// ---------------------------------------------------------------- toasts

function toast(msg, kind = "info") {
  const el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " error" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .2s"; setTimeout(() => el.remove(), 220); }, 2800);
}

// ---------------------------------------------------------------- modal

function modal({ title, sub, input = false, value = "", okLabel = "OK", danger = false }) {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    root.innerHTML = `
      <div class="modal">
        <div class="modal-title">${esc(title)}</div>
        ${sub ? `<div class="modal-sub">${esc(sub)}</div>` : ""}
        ${input ? `<input id="modal-input" value="${esc(value)}" spellcheck="false">` : ""}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="btn ${danger ? "danger" : "primary"}" id="modal-ok">${esc(okLabel)}</button>
        </div>
      </div>`;
    root.hidden = false;
    const done = (val) => { root.hidden = true; root.innerHTML = ""; resolve(val); };
    const inp = $("#modal-input");
    $("#modal-cancel").onclick = () => done(null);
    $("#modal-ok").onclick = () => done(input ? inp.value : true);
    if (inp) {
      inp.focus();
      inp.select();
      inp.onkeydown = (e) => {
        if (e.key === "Enter") done(inp.value);
        if (e.key === "Escape") done(null);
        e.stopPropagation();
      };
    } else {
      root.onkeydown = (e) => { if (e.key === "Escape") done(null); };
    }
  });
}

// ---------------------------------------------------------------- events (SSE)

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "plugins") {
      try {
        state.plugins = msg.plugins || [];
        renderPluginsDrawer();
        updateRailFoot();
        navigate(state.path, { quiet: true }).catch(() => {});
      } catch (e) {
        console.error("[filer] SSE plugin refresh failed:", e);
      }
    }
    if (msg.type === "hello") {
      state.version = msg.version;
      updateRailFoot();
    }
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

// ---------------------------------------------------------------- navigation

async function navigate(p, opts = {}) {
  if (p == null) return;
  let target = String(p);
  if (target === "~") target = state.home;
  else if (!target.startsWith("/")) target = state.home.replace(/\/$/, "") + "/" + target;
  try {
    const data = await api("/api/fs/list?path=" + encodeURIComponent(target));
    state.path = data.path;
    state.parent = data.parent;
    state.entries = data.entries;
    state.sel.clear();
    state.anchorIdx = -1;
    state.focusIdx = -1;
    state.filter = "";
    state.splitPath = data.path;
    state.addrTarget = "main";
    renderAll();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ---------------------------------------------------------------- render

function renderAll() {
  renderAddr();
  renderListing();
  renderStatus();
}

function renderCrumbs() {
  const c = $("#crumbs");
  c.innerHTML = "";
  const home = document.createElement("span");
  home.className = "crumb";
  home.innerHTML = icon("home", 14) + (state.path === "/" ? '<span>Root</span>' : "");
  home.title = state.home;
  home.onclick = () => navigate(state.home);
  c.appendChild(home);
  if (state.path === "/") return;
  const parts = state.path.split("/").filter(Boolean);
  let acc = "";
  parts.forEach((part, i) => {
    const sep = document.createElement("span");
    sep.className = "crumb mut";
    sep.innerHTML = icon("chevron-right", 12);
    c.appendChild(sep);
    acc += "/" + part;
    const cr = document.createElement("span");
    cr.className = "crumb";
    cr.textContent = part;
    cr.onclick = () => navigate(acc);
    c.appendChild(cr);
  });
}

function renderAddr() {
  const a = $("#addr");
  if (document.activeElement === a) return;
  // Which pane does the address bar represent? Default: main. In split mode
  // with a file open in the pane, it represents the pane (its path).
  const target = state.addrTarget || "main";
  const shown = target === "split" ? (state.splitPath || state.path) : state.path;
  a.value = shown;
  a.dataset.target = target;
}

function filteredEntries() {
  const f = state.filter.trim().toLowerCase();
  if (!f) return state.entries;
  return state.entries.filter((e) => e.name.toLowerCase().includes(f));
}

// Build the contents of the filter popup: the matched rows + a footer count.
function renderFilterList() {
  const host = $("#filter-list");
  const countEl = $("#filter-count");
  if (!host) return;
  const matches = filteredEntries();
  const total = state.entries.length;
  if (state.filter.trim()) {
    countEl.textContent = matches.length + " of " + total + " match";
  } else {
    countEl.textContent = total + " items";
  }
  if (!matches.length) {
    host.innerHTML = `<div class="filter-empty">No matches.</div>`;
    return;
  }
  // show at most 40, enough for a quick pick
  const rows = matches.slice(0, 40).map((e) => {
    const ic = iconForEntry(e);
    return `<button class="filter-item" data-path="${esc(e.path)}" data-kind="${e.kind}">
      <span class="tile tile-${ic}">${icon(ic, 13)}</span>
      <span class="filter-name" title="${esc(e.path)}">${esc(e.name)}</span>
      ${e.kind === "dir" ? `<span class="filter-kind">dir</span>` : ""}
    </button>`;
  }).join("");
  host.innerHTML = rows;
}

function renderListing() {
  const list = $("#listing");
  const items = filteredEntries();
  const empty = $("#empty");
  if (!items.length) {
    list.innerHTML = "";
    list.hidden = true;
    empty.hidden = false;
    empty.textContent = state.filter ? "No matches." : "Empty folder.";
    return;
  }
  list.hidden = false;
  empty.hidden = true;

  const grid = state.grid;
  list.className = grid ? "as-grid" : "as-list";
  const head = grid ? "" : `
    <div class="cols"><span></span><span>Name</span><span>Size</span><span>Modified</span><span></span></div>`;

  const rows = items.map((e, idx) => {
    const sel = state.sel.has(e.path) ? " selected" : "";
    const hidden = e.hidden ? " hidden-row" : "";
    const ic = iconForEntry(e);
    const sizeCell = e.kind === "dir" ? "" : fmtSize(e.size);
    const actions = `<div class="cell act">
        <button class="btn icon-btn act-rename" title="Rename">${icon("pencil", 13)}</button>
        <button class="btn icon-btn act-del" title="Delete">${icon("trash", 13)}</button>
      </div>`;
    if (grid) {
      return `<div class="row kind-${e.kind}${sel}${hidden}" data-path="${esc(e.path)}" data-kind="${e.kind}" data-idx="${idx}" draggable="true">
        <div class="cell tile-ic"><span class="tile tile-${ic}">${icon(ic, 30)}</span></div>
        <div class="cell name" title="${esc(e.name)}">${esc(e.name)}</div>
        <div class="cell size tile-size">${sizeCell}</div>
      </div>`;
    }
    return `<div class="row kind-${e.kind}${sel}${hidden}" data-path="${esc(e.path)}" data-kind="${e.kind}" data-idx="${idx}" draggable="true">
        <div class="cell"><span class="tile tile-${ic}">${icon(ic, 15)}</span></div>
        <div class="cell name" title="${esc(e.name)}">${esc(e.name)}<span class="row-sub">${fmtDate(e.mtime)}${e.kind !== "dir" ? " · " + fmtSize(e.size) : ""}</span></div>
        <div class="cell size">${sizeCell}</div>
        <div class="cell mtime">${fmtDate(e.mtime)}</div>
        ${actions}
      </div>`;
  }).join("");

  list.innerHTML = head + rows;
}

function renderStatus() {
  const items = filteredEntries().length;
  $("#status-left").textContent =
    `${items} item${items === 1 ? "" : "s"}` +
    (state.sel.size ? ` · ${state.sel.size} selected` : "");
  $("#status-right").textContent = `${state.path} · ${state.plugins.filter((p) => p.active).length}/${state.plugins.length} plugins${state.split ? " · split" : ""}`;
}

function updateRailFoot() {
  $("#rail-foot").textContent = `Filer v${state.version || "?"} · node ${state.node || ""}`.trim();
}

async function renderPlaces() {
  const nav = $("#places");
  nav.innerHTML = "";
  // Home is always listed. Desktop/Documents/Downloads are shown only if
  // they actually exist on this host — one batched probe.
  const labels = ["Desktop", "Documents", "Downloads"];
  const base = state.home.replace(/\/$/, "");
  const probes = await Promise.all(
    labels.map(async (label) => {
      try {
        await api("/api/fs/stat?path=" + encodeURIComponent(base + "/" + label));
        return { id: label.toLowerCase(), label, p: base + "/" + label };
      } catch { return null; }
    })
  );
  const places = [{ id: "home", label: "Home", p: state.home }];
  for (const pl of probes) if (pl) places.push(pl);
  for (const pl of places) {
    const b = document.createElement("button");
    b.className = "nav-item";
    b.innerHTML = icon(pl.id === "home" ? "home" : "folder", 15) + `<span>${esc(pl.label)}</span>`;
    b.onclick = () => navigate(pl.p);
    nav.appendChild(b);
  }
}

// Open the filter popup (reached from the 3-dot menu or Ctrl/Cmd+F).
let openFilterGlobal = null;

// ---------------------------------------------------------------- selection & keyboard

function currentRow(idx) {
  const rows = $$("#listing .row");
  return idx >= 0 && idx < rows.length ? rows[idx] : null;
}

function rowFromEvent(e) {
  return e.target.closest(".row");
}

function onListClick(e) {
  const row = rowFromEvent(e);
  if (!row) return;
  const path = row.dataset.path;
  const rows = $$("#listing .row");
  const idx = Number(row.dataset.idx);
  const meta = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const isTouch = e.pointerType === "touch" || "ontouchstart" in window;

  if (e.target.closest(".act")) return; // handled by action buttons

  if (shift && state.anchorIdx >= 0) {
    const a = state.anchorIdx, b = idx;
    state.sel.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      state.sel.add(rows[i]?.dataset.path);
    }
  } else if (meta) {
    if (state.sel.has(path)) state.sel.delete(path); else state.sel.add(path);
    state.anchorIdx = idx;
  } else {
    state.sel.clear();
    state.sel.add(path);
    state.anchorIdx = idx;
  }
  state.focusIdx = idx;
  renderListing();

  // Touch: a single tap opens; use a short timer so it doesn't fire
  // mid-gesture or before a possible second tap. Native dblclick is
  // kept for pointer (mouse/trackpad) devices.
  if (isTouch) {
    if (onListClick._tap) clearTimeout(onListClick._tap);
    onListClick._tap = setTimeout(() => {
      onListClick._tap = null;
      openEntry(path, row.dataset.kind);
    }, 250);
  } else if (e.detail === 2) {
    openEntry(path, row.dataset.kind);
  }
}

function onListDbl(e) {
  const row = rowFromEvent(e);
  if (row && e.target.closest(".act")) return;
  // cancel any pending touch-tap timer — we already opened via dblclick
  if (onListClick._tap) { clearTimeout(onListClick._tap); onListClick._tap = null; }
  if (row) openEntry(row.dataset.path, row.dataset.kind);
}

function openEntry(path, kind) {
  if (kind === "dir") return navigate(path);
  if (kind === "link") {
    // try to resolve target
    api("/api/fs/stat?path=" + encodeURIComponent(path))
      .then((d) => {
        if (d.kind === "link" && d.target) {
          toast("Broken link", "error");
        } else if (d.kind === "dir") navigate(path);
        else openPreview({ path, name: path.split("/").pop(), kind: "file" });
      })
      .catch(() => toast("Broken link", "error"));
    return;
  }
  openPreview({ path, name: path.split("/").pop(), kind: "file" });
}

function keyHandler(e) {
  const t = e.target;
  const typing = t.matches("input, textarea") || t.isContentEditable;

  if (e.key === "Escape") {
    closeAll();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && t.id === "editor") {
    e.preventDefault();
    saveEditor();
    return;
  }
  if (typing) return;

  const rows = $$("#listing .row");
  const sel = state.sel;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") { e.preventDefault(); navigate(state.path); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); $("#addr").focus(); $("#addr").select(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); openFilterGlobal && openFilterGlobal(); return; }

  const move = (d) => {
    e.preventDefault();
    let idx = state.focusIdx < 0 ? 0 : state.focusIdx + d;
    idx = Math.max(0, Math.min(rows.length - 1, idx));
    state.focusIdx = idx;
    state.sel.clear();
    const row = rows[idx];
    if (row) {
      state.sel.add(row.dataset.path);
      state.anchorIdx = idx;
      row.scrollIntoView({ block: "nearest" });
    }
    renderListing();
  };

  if (e.key === "ArrowDown") return move(1);
  if (e.key === "ArrowUp") return move(-1);
  if (e.key === "Enter") {
    e.preventDefault();
    const row = currentRow(state.focusIdx) || rows.find((r) => sel.has(r.dataset.path));
    if (row) openEntry(row.dataset.path, row.dataset.kind);
    return;
  }
  if (e.key === "Backspace" && !typing) {
    e.preventDefault();
    if (state.parent) navigate(state.parent);
    return;
  }
  if (e.key === "Delete") {
    if (sel.size) { e.preventDefault(); deleteSelected(); }
    return;
  }
  if (e.key === "F2") {
    e.preventDefault();
    const row = currentRow(state.focusIdx) || rows.find((r) => sel.has(r.dataset.path));
    if (row) renameEntry(row.dataset.path, row.dataset.kind);
    return;
  }
  if (e.key === " ") {
    e.preventDefault();
    const row = currentRow(state.focusIdx);
    if (row) { if (sel.has(row.dataset.path)) sel.delete(row.dataset.path); else sel.add(row.dataset.path); renderListing(); }
    return;
  }
}

// ---------------------------------------------------------------- context menu

function openFileCard(row) {
  const card = $("#ctx");
  card.classList.add("file-card");
  const path = row.dataset.path;
  const kind = row.dataset.kind;
  const name = path.split("/").pop();
  const isDir = kind === "dir";
  const ic = iconForEntry({ name, kind });

  let html = `
    <div class="card-head">
      <span class="tile tile-${ic}">${icon(ic, 20)}</span>
      <div class="card-meta">
        <div class="card-name" title="${esc(name)}">${esc(name)}</div>
        <div class="card-path" title="${esc(path)}">${esc(path)}</div>
      </div>
    </div>
    <div class="card-grid">`;

  if (isDir) {
    html += `<button class="card-btn" data-act="open">${icon("folder", 15)} <span>Open</span></button>`;
  } else {
    html += `<button class="card-btn" data-act="open">${icon("eye", 15)} <span>Preview</span></button>`;
    html += `<button class="card-btn" data-act="download">${icon("download", 15)} <span>Download</span></button>`;
  }
  html += `<button class="card-btn" data-act="copy">${icon("copy", 15)} <span>Copy here</span></button>`;
  html += `<button class="card-btn" data-act="move">${icon("move", 15)} <span>Move here</span></button>`;
  html += `<button class="card-btn" data-act="rename">${icon("pencil", 15)} <span>Rename</span></button>`;
  html += `<button class="card-btn" data-act="copypath">${icon("terminal", 15)} <span>Copy path</span></button>`;

  const cmds = state.commands;
  if (cmds.length) {
    for (const c of cmds) {
      html += `<button class="card-btn" data-act="cmd" data-cmd="${esc(c.id)}">${icon(c.icon || "terminal", 15)} <span>${esc(c.label)}</span></button>`;
    }
  }
  html += `<button class="card-btn danger" data-act="del">${icon("trash", 15)} <span>Delete</span></button>`;
  html += `</div>`;

  card.innerHTML = html;
  card.hidden = false;
  positionCard(card, x_from_row(row));

  const close = () => { card.hidden = true; card.innerHTML = ""; document.removeEventListener("mousedown", close, true); };
  setTimeout(() => document.addEventListener("mousedown", close, true), 0);

  card.onclick = async (ev) => {
    const b = ev.target.closest(".card-btn");
    if (!b) return;
    const act = b.dataset.act;
    close();
    if (act === "open") return openEntry(path, kind);
    if (act === "download") return download(path);
    if (act === "rename") return renameEntry(path, kind);
    if (act === "copypath") { try { await navigator.clipboard.writeText(path); toast("Path copied"); } catch { toast("Copy failed", "error"); } return; }
    if (act === "copy") return fileToParent(path, "copy");
    if (act === "move") return fileToParent(path, "move");
    if (act === "del") return delPath(path);
    if (act === "cmd") {
      try {
        const r = await api("/api/commands/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: b.dataset.cmd, path }),
        });
        if (r.message) toast(r.message);
        navigate(state.path, { quiet: true });
      } catch (err) { toast(err.message, "error"); }
    }
  };
}

function x_from_row(row) {
  const r = row.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + 8 };
}

// Place a fixed-position card near a screen point, clamped to the viewport.
function positionCard(card, origin) {
  const w = card.offsetWidth || 260;
  const h = card.offsetHeight || 200;
  let left = Math.round(origin.x - w / 2);
  let top = Math.round(origin.y + 12);
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  if (top + h > window.innerHeight - 8) top = Math.max(8, origin.y - h - 12);
  card.style.left = left + "px";
  card.style.top = top + "px";
}

// Copy / move a file (or folder) into the current directory — used both by
// the file card and by drag-and-drop between the two split panes.
async function fileToParent(path, mode) {
  const name = path.split("/").pop();
  const dest = state.path.replace(/\/$/, "") + "/" + name;
  if (dest === path) { toast("Already in this folder"); return; }
  try {
    if (mode === "move") {
      await api("/api/fs/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: path, to: dest }) });
      toast("Moved to " + state.path);
    } else {
      await duplicateInto(path, state.path);
      toast("Copied to " + state.path);
    }
    navigate(state.path, { quiet: true });
  } catch (e) {
    toast(e.message, "error");
  }
}

// Duplicate a file or folder into a target directory using the server's
// fs.copy operation (recursive for directories).
async function duplicateInto(src, targetDir) {
  const t = targetDir.replace(/\/$/, "");
  const dest = t + "/" + src.split("/").pop();
  await api("/api/fs/copy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: src, to: dest }) });
}

function download(path) {
  window.location = "/api/fs/raw?path=" + encodeURIComponent(path) + "&download=1";
}

// ---------------------------------------------------------------- actions

async function deleteSelected(paths) {
  const targets = paths || [...state.sel];
  if (!targets.length) return;
  const ok = await modal({
    title: "Delete",
    sub: `Permanently delete ${targets.length} item${targets.length > 1 ? "s" : ""}?`,
    okLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  let failed = 0;
  for (const p of targets) {
    try { await api("/api/fs/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) }); }
    catch { failed++; }
  }
  if (failed) toast(`${failed} item${failed > 1 ? "s" : ""} failed`, "error");
  else toast("Deleted");
  navigate(state.path, { quiet: true });
}

function delPath(p) { deleteSelected([p]); }

async function renameEntry(path, kind) {
  const name = path.split("/").pop();
  const nn = await modal({ title: "Rename", sub: path, input: true, value: name, okLabel: "Rename" });
  if (!nn || nn === name) return;
  const to = path.slice(0, path.lastIndexOf("/") + 1) + nn;
  try {
    await api("/api/fs/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: path, to }) });
    navigate(state.path, { quiet: true });
  } catch (e) { toast(e.message, "error"); }
}

async function newFolder() {
  const name = await modal({ title: "New Folder", sub: state.path, input: true, okLabel: "Create" });
  if (!name) return;
  try {
    await api("/api/fs/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: state.path.replace(/\/$/, "") + "/" + name }) });
    navigate(state.path, { quiet: true });
  } catch (e) { toast(e.message, "error"); }
}

async function newFile() {
  const name = await modal({ title: "New File", sub: state.path, input: true, okLabel: "Create" });
  if (!name) return;
  try {
    await api("/api/fs/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: state.path.replace(/\/$/, "") + "/" + name, content: "" }) });
    navigate(state.path, { quiet: true });
  } catch (e) { toast(e.message, "error"); }
}

function uploadFiles(files) {
  if (!files || !files.length) return;
  let done = 0;
  const total = files.length;
  for (const f of files) {
    fetch("/api/fs/upload?dir=" + encodeURIComponent(state.path) + "&name=" + encodeURIComponent(f.name), {
      method: "PUT",
      body: f,
    }).then((r) => {
      done++;
      if (!r.ok) toast(`Upload failed: ${f.name}`, "error");
      if (done === total) { toast("Upload complete"); navigate(state.path, { quiet: true }); }
    }).catch(() => {
      done++;
      if (done === total) { toast("Upload complete"); navigate(state.path, { quiet: true }); }
    });
  }
}

// ---------------------------------------------------------------- preview

let editorDirty = false;
let previewEntry = null;

// Set the preview pane's class/state from the user's split toggle without
// ever re-triggering openPreview's toggle-close logic.
function applyPreviewMode() {
  const pv = $("#preview");
  const body = document.body;
  if (state.split) {
    body.classList.add("preview-split");
    pv.classList.add("split");
    pv.classList.remove("open");
  } else {
    body.classList.remove("preview-split");
    pv.classList.remove("split");
    pv.classList.add("open");
  }
}

function openPreview(entry) {
  const pv = $("#preview");
  // Tapping the same file again toggles the preview closed (so a touch user
  // in a forced overlay is never trapped).
  if (previewEntry && previewEntry.path === entry.path &&
      (pv.classList.contains("open") || pv.classList.contains("split"))) {
    closePreview();
    return;
  }
  previewEntry = entry;
  // In split view, remember which directory the *other* pane is showing so a
  // file dragged onto it can be moved/copied there.
  state.otherPath = entry.path;
  state.splitPath = entry.path;
  if (state.split) state.addrTarget = "split";
  // The split toggle is authoritative: on = side pane, off = full overlay.
  applyPreviewMode();
  $("#pv-name").textContent = entry.name;
  $("#pv-sub").textContent = entry.path;
  $("#pv-save").hidden = true;
  $("#pv-dirty").hidden = true;
  editorDirty = false;
  const body = $("#pv-body");
  body.innerHTML = "";

  loadPreviewBody(entry, body);
}

async function loadPreviewBody(entry, body) {
  try {
    const { view } = await api("/api/views?path=" + encodeURIComponent(entry.path));
    renderView(body, entry, view);
  } catch (e) {
    showErrorBody(body, e.message);
  }
}

function renderView(body, entry, view) {
  const type = view?.type || "binary";
  const raw = "/api/fs/raw?path=" + encodeURIComponent(entry.path);

  if (type === "image") {
    body.innerHTML = `<img src="${raw}" alt="">`;
    return;
  }
  if (type === "video") {
    body.innerHTML = `<video controls autoplay src="${raw}"></video>`;
    return;
  }
  if (type === "audio") {
    body.innerHTML = `<audio controls autoplay src="${raw}"></audio>`;
    return;
  }
  if (type === "pdf") {
    body.innerHTML = `<iframe src="${raw}"></iframe>`;
    return;
  }
  if (view?.iframe) {
    body.innerHTML = `<iframe src="/api/plugin/${encodeURIComponent(view.plugin)}/view?path=${encodeURIComponent(entry.path)}"></iframe>`;
    return;
  }
  if (type === "text" || type === "markdown") {
    api("/api/fs/read?path=" + encodeURIComponent(entry.path)).then((r) => {
      if (r.raw) { showHexBody(body, entry, r.mime); return; }
      if (type === "markdown") {
        body.innerHTML = `<div class="mdpad"><div class="md">${mdToHtml(r.content)}</div></div>`;
        const tb = document.createElement("div");
        tb.style.cssText = "display:flex;gap:8px;padding:8px 14px;border-bottom:1px solid var(--line);align-items:center";
        const editBtn = document.createElement("button");
        editBtn.className = "btn";
        editBtn.textContent = "Edit";
        const wrap = body.querySelector(".mdpad");
        editBtn.onclick = () => {
          if (wrap.hidden) {
            wrap.hidden = false;
            editBtn.textContent = "Edit";
          } else {
            wrap.hidden = true;
            editBtn.textContent = "Preview";
            showEditor(body, entry, undefined);
          }
        };
        body.prepend(tb);
        tb.appendChild(editBtn);
      } else {
        showEditor(body, entry, r.content);
      }
    }).catch((e) => showErrorBody(body, e.message));
    return;
  }
  showHexBody(body, entry, "application/octet-stream");
}

function showEditor(body, entry, content) {
  body.innerHTML = `<div class="editor-wrap"><textarea id="editor" class="editor" spellcheck="false"></textarea></div>`;
  const ta = $("#editor");
  ta.value = content;
  $("#pv-save").hidden = false;
  ta.addEventListener("input", () => {
    editorDirty = true;
    $("#pv-dirty").hidden = false;
    $("#pv-dirty").textContent = "Unsaved";
  });
  ta.focus();
}

async function saveEditor() {
  const ta = $("#editor");
  if (!ta || !previewEntry) return;
  const full = previewEntry.path;
  try {
    await api("/api/fs/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: full, content: ta.value }) });
    editorDirty = false;
    $("#pv-dirty").hidden = true;
    toast("Saved");
  } catch (e) { toast(e.message, "error"); }
}

async function showHexBody(body, entry, mime) {
  body.innerHTML = `<div class="hex">Loading…</div>`;
  try {
    const res = await fetch("/api/fs/raw?path=" + encodeURIComponent(entry.path));
    if (!res.ok) throw new Error("Read failed");
    const buf = new Uint8Array(await res.arrayBuffer());
    const limit = Math.min(buf.length, 65536);
    let s = mime + " · " + buf.length + " bytes\n\n";
    for (let off = 0; off < limit; off += 16) {
      const hex = [], asc = [];
      for (let i = 0; i < 16; i++) {
        const j = off + i;
        if (j < limit) {
          const b = buf[j];
          hex.push(b.toString(16).padStart(2, "0"));
          asc.push(b >= 32 && b < 127 ? String.fromCharCode(b) : ".");
        } else { hex.push("  "); asc.push(" "); }
      }
      s += off.toString(16).padStart(8, "0") + "  " + hex.join(" ") + "  |" + asc.join("") + "|\n";
    }
    if (buf.length > limit) s += "\n… truncated (" + buf.length + " bytes total)\n";
    body.querySelector(".hex").textContent = s;
  } catch (e) {
    body.innerHTML = `<div class="bin-hint">${esc(e.message)}</div>`;
  }
}

function showErrorBody(body, msg) {
  body.innerHTML = `<div class="bin-hint">${esc(msg)}</div>`;
}

function mdToHtml(src) {
  let out = esc(src);
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (m, l, c) => `<pre><code>${c.replace(/\n$/, "")}</code></pre>`);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  out = out.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  out = out.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  out = out.replace(/^---+$/gm, "<hr>");
  out = out.replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>");
  out = out.replace(/^- (.*)$/gm, "<li>$1</li>");
  out = out.replace(/^\d+\. (.*)$/gm, "<li>$1</li>");
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.split(/\n{2,}/).map((b) => `<p>${b.replace(/\n/g, "<br>")}</p>`).join("");
  return out;
}

// ---------------------------------------------------------------- plugins drawer

function renderPluginsDrawer() {
  const list = $("#dr-list");
  list.innerHTML = "";
  if (!state.plugins.length) {
    list.innerHTML = `<div class="mut" style="padding:12px;font-size:12.5px">No plugins found.</div>`;
    return;
  }
  for (const p of state.plugins) {
    const card = document.createElement("div");
    card.className = "plugin-card";
    const badge = p.demo ? `<span class="plugin-ver">demo</span>` : "";
    card.innerHTML = `
      <div class="plugin-head">
        <span class="plugin-name" title="${esc(p.id)}">${esc(p.name)}</span>
        ${badge}
        <span class="plugin-ver">v${esc(p.version)}</span>
      </div>
      <div class="plugin-desc">${esc(p.description)}</div>
      ${p.error ? `<div class="plugin-error">⚠ ${esc(p.error)}</div>` : ""}
      <div class="plugin-actions">
        <button class="switch ${p.enabled ? "on" : ""}" data-id="${esc(p.id)}" title="${p.enabled ? "Enabled" : "Disabled"}"></button>
        <span class="mut" style="font-size:11px">${p.enabled ? "Enabled" : "Disabled"}</span>
        <span class="plugin-prio" title="Priority: when several plugins register the same operation, the higher-priority one runs first (tied → newest first)">
        <button data-id="${esc(p.id)}" data-prio="-1" title="Lower priority">−</button>
        <span class="prio-val" title="Current priority">${p.priority}</span>
        <button data-id="${esc(p.id)}" data-prio="1" title="Higher priority">+</button>
      </span>
        <button class="btn icon-btn" data-id="${esc(p.id)}" data-reload="1" title="Reload plugin" style="margin-left:auto">${icon("refresh", 13)}</button>
      </div>`;
    list.appendChild(card);
  }
}

function pluginActions(e) {
  const t = e.target.closest("[data-id]");
  if (!t) return;
  const id = t.dataset.id;
  if (t.classList.contains("switch")) {
    const p = state.plugins.find((x) => x.id === id);
    const on = !p.enabled;
    api("/api/plugins/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: on }),
    }).then(() => toast(on ? `${p.name} enabled` : `${p.name} disabled`))
      .catch((err) => toast(err.message, "error"));
    return;
  }
  if (t.dataset.prio) {
    const p = state.plugins.find((x) => x.id === id);
    const next = p.priority + Number(t.dataset.prio);
    api("/api/plugins/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: next }),
    }).then(() => {
      // reflect the change in the card immediately; SSE re-lists plugins too.
      const val = t.parentElement.querySelector(".prio-val");
      if (val) val.textContent = String(next);
    }).catch((err) => toast(err.message, "error"));
    return;
  }
  if (t.dataset.reload) {
    api("/api/plugins/" + encodeURIComponent(id) + "/reload", { method: "POST" })
      .then(() => toast("Reloaded"))
      .catch((err) => toast(err.message, "error"));
  }
}

// ---------------------------------------------------------------- drag & drop

let dragPaths = [];

function setupDnD() {
  const list = $("#listing");
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    dragPaths = state.sel.has(row.dataset.path) ? [...state.sel] : [row.dataset.path];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", row.dataset.path);
  });
  list.addEventListener("dragover", (e) => {
    const row = e.target.closest(".row");
    e.preventDefault();
    for (const r of $$("#listing .row")) r.classList.remove("droptarget");
    if (row && row.dataset.kind === "dir") row.classList.add("droptarget");
  });
  list.addEventListener("dragleave", (e) => {
    const row = e.target.closest(".row");
    if (row) row.classList.remove("droptarget");
  });
  list.addEventListener("drop", async (e) => {
    e.preventDefault();
    for (const r of $$("#listing .row")) r.classList.remove("droptarget");
    const row = e.target.closest(".row");
    if (!row || row.dataset.kind !== "dir" || !dragPaths.length) return;
    const dest = row.dataset.path;
    let failed = 0;
    for (const src of dragPaths) {
      if (src === dest) continue;
      const name = src.split("/").pop();
      const to = dest.replace(/\/$/, "") + "/" + name;
      try { await api("/api/fs/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: src, to }) }); }
      catch { failed++; }
    }
    dragPaths = [];
    if (failed) toast(`${failed} item${failed > 1 ? "s" : ""} failed`, "error");
    navigate(state.path, { quiet: true });
  });
}

// ---------------------------------------------------------------- misc ui

function closeAll() {
  const pv = $("#preview");
  if (pv.classList.contains("open") || pv.classList.contains("split")) {
    if (editorDirty) {
      modal({ title: "Discard changes?", okLabel: "Discard", danger: true }).then((ok) => {
        if (ok) { closePreview(); editorDirty = false; }
      });
      return;
    }
    closePreview();
    return;
  }
  hideCtx();
  hideDrawer();
  hideAddrmenu();
}

function closePreview() {
  const pv = $("#preview");
  pv.classList.remove("open");
  pv.classList.remove("split");
  $("#pv-body").innerHTML = "";
  previewEntry = null;
  state.addrTarget = "main";
  document.body.classList.remove("preview-split");
  // keep state.split (the user's toggle choice); just close the pane
}

function hideCtx() { const m = $("#ctx"); m.hidden = true; m.innerHTML = ""; }

function closeMore() { const m = $("#moremenu"); m.hidden = true; $("#btn-more").classList.remove("active"); }

function populateMoreMenu() {
  const host = $("#mm-places");
  if (!host) return;
  host.innerHTML = "";
  if (!populateMoreMenu._cache) populateMoreMenu._cache = new Map();
  const base = state.home.replace(/\/$/, "");
  const labels = ["Desktop", "Documents", "Downloads"];
  for (const label of labels) {
    const p = base + "/" + label;
    const known = populateMoreMenu._cache.get(label);
    if (known === true) {
      const b = document.createElement("button");
      b.className = "menu-item";
      b.dataset.path = p;
      b.innerHTML = `<span class="mm-ic">${icon("folder", 14)}</span> ${esc(label)}`;
      host.appendChild(b);
    } else if (known === undefined) {
      // probe once, remember the result, and re-render on completion
      let settled = false;
      api("/api/fs/stat?path=" + encodeURIComponent(p))
        .then(() => { if (!settled) { populateMoreMenu._cache.set(label, true); settled = true; populateMoreMenu(); } })
        .catch(() => { if (!settled) { populateMoreMenu._cache.set(label, false); settled = true; } });
    }
  }
}
populateMoreMenu._cache = null;

function toggleSplit() {
  state.split = !state.split;
  $("#btn-split").classList.toggle("active", state.split);
  $("#btn-close-split").hidden = !state.split;
  $("#mm-split").classList.toggle("active", state.split);
  document.body.classList.toggle("preview-split", state.split);
  // If a preview is open, just convert it in place (never close it); if
  // nothing is open yet, leave the pane hidden until a file is opened.
  if (previewEntry) {
    applyPreviewMode();
  } else {
    const pv = $("#preview");
    pv.classList.remove("split");
    pv.classList.remove("open");
  }
}
function hideDrawer() { $("#drawer").classList.remove("open"); $("#btn-plugins").classList.remove("active"); state.drawerOpen = false; }
function hideAddrmenu() { $("#addrmenu").hidden = true; $("#btn-new").classList.remove("active"); }

function toggleDrawer() {
  state.drawerOpen = !state.drawerOpen;
  $("#drawer").classList.toggle("open", state.drawerOpen);
  $("#btn-plugins").classList.toggle("active", state.drawerOpen);
  if (state.drawerOpen) renderPluginsDrawer();
}

// ---------------------------------------------------------------- init

async function init() {
  bootMark("init() started");
  // keyboard
  document.addEventListener("keydown", safe(keyHandler, "keyboard"));

  // listing interactions
  const list = $("#listing");
  list.addEventListener("click", safe(onListClick, "list click"));
  list.addEventListener("focusin", () => { state.addrTarget = "main"; });
  list.addEventListener("dblclick", safe(onListDbl, "list double-click"));
  list.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    e.preventDefault();
    state.sel.clear();
    state.sel.add(row.dataset.path);
    state.anchorIdx = Number(row.dataset.idx);
    renderListing();
    openFileCard(row);
  });

  // Touch: long-press a row to open the context menu (no right-click on touch)
  let lpTimer = null;
  list.addEventListener("touchstart", (e) => {
    const row = rowFromEvent(e);
    if (!row || e.target.closest(".act")) return;
    lpTimer = setTimeout(() => {
      const rect = row.getBoundingClientRect();
      state.sel.clear();
      state.sel.add(row.dataset.path);
      state.anchorIdx = Number(row.dataset.idx);
      renderListing();
      openFileCard(row);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 500);
  }, { passive: true });
  list.addEventListener("touchmove", () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }, { passive: true });
  list.addEventListener("touchend", () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }, { passive: true });

  // Also let the native contextmenu event (used by some Android browsers and
  // Chromebooks) open the plugin context menu on rows.
  list.addEventListener("contextmenu", (e) => {
    const row = rowFromEvent(e);
    if (!row) return;
    e.preventDefault();
    state.sel.clear();
    state.sel.add(row.dataset.path);
    state.anchorIdx = Number(row.dataset.idx);
    renderListing();
    openFileCard(row);
  });

  // toolbar
  $("#btn-new").onclick = (e) => {
    const m = $("#addrmenu");
    m.hidden = !m.hidden;
    $("#btn-new").classList.toggle("active", !m.hidden);
    const r = e.currentTarget.getBoundingClientRect();
    m.style.left = Math.min(r.left, window.innerWidth - 180) + "px";
    m.style.top = (r.bottom + 4) + "px";
    e.stopPropagation();
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#addrmenu") && !e.target.closest("#btn-new")) hideAddrmenu();
  });
  $("#addrmenu").onclick = (e) => {
    const b = e.target.closest(".menu-item");
    if (!b) return;
    hideAddrmenu();
    if (b.dataset.act === "mkdir") newFolder();
    if (b.dataset.act === "newfile") newFile();
  };
  if ($("#btn-upload")) $("#btn-upload").onclick = () => $("#file-input").click();
  $("#file-input").onchange = (e) => { uploadFiles(e.target.files); e.target.value = ""; };
  $("#btn-refresh").onclick = () => navigate(state.path);
  $("#btn-grid").onclick = () => {
    state.grid = !state.grid;
    $("#btn-grid").classList.toggle("active", state.grid);
    $("#btn-grid").innerHTML = icon(state.grid ? "list" : "grid", 16);
    renderListing();
  };
  $("#btn-plugins").onclick = toggleDrawer;
  $("#dr-close").onclick = hideDrawer;
  $("#dr-list").addEventListener("click", pluginActions);
  $("#nav-plugins").onclick = toggleDrawer;

  // split view toggle
  $("#btn-split").onclick = () => toggleSplit();
  $("#btn-close-split").onclick = () => toggleSplit();
  $("#mm-split").onclick = (e) => { toggleSplit(); closeMore(e); };

  // 3-dot "more" menu (hotbar) — the small-screen entry point
  $("#btn-more").onclick = (e) => {
    $("#filtermenu").hidden = true;
    const m = $("#moremenu");
    const open = m.hidden;
    populateMoreMenu();
    m.hidden = !open;
    $("#btn-more").classList.toggle("active", open);
    if (open) {
      const r = e.currentTarget.getBoundingClientRect();
      m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
      m.style.top = (r.bottom + 4) + "px";
      if (r.bottom + m.offsetHeight + 8 > window.innerHeight) {
        m.style.top = Math.max(8, r.top - m.offsetHeight - 4) + "px";
      }
    }
    e.stopPropagation();
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#moremenu") && !e.target.closest("#btn-more")) closeMore();
  });
  $("#mm-home").onclick = (e) => { closeMore(); navigate(state.home); };
  $("#mm-plugins").onclick = (e) => { closeMore(); toggleDrawer(); };
  $("#mm-refresh").onclick = () => { closeMore(); navigate(state.path, { quiet: true }); };
  $("#mm-filter").onclick = (e) => { e.stopPropagation(); closeMore(); openFilter(); };
  $("#mm-places").addEventListener("click", (e) => {
    const b = e.target.closest(".menu-item");
    if (!b) return;
    closeMore();
    navigate(b.dataset.path);
  });

  // Filter panel (the popup reached from the 3-dot menu): spinner, then the
  // matching list + a count of how many entries the filter has narrowed to.
  const filterMenu = $("#filtermenu");
  function openFilter() {
    filterMenu.hidden = false;
    // position below the 3-dot button if it is on screen, else top-right
    const more = $("#btn-more");
    const r = more ? more.getBoundingClientRect() : null;
    let left, top;
    if (r && r.right > 0 && r.top < window.innerHeight) {
      left = Math.max(8, Math.min(r.left - 256, window.innerWidth - 280));
      top = Math.max(8, r.bottom + 4);
      if (top + 300 > window.innerHeight) top = Math.max(8, r.top - 300);
    } else {
      left = Math.max(8, window.innerWidth - 288);
      top = 8;
    }
    filterMenu.style.left = left + "px";
    filterMenu.style.top = top + "px";
    $("#filter-input").value = state.filter;
    $("#filter-list").innerHTML = "";
    $("#filter-spinner").hidden = false;
    // brief visible loading animation, then the filtered results
    setTimeout(() => {
      $("#filter-spinner").hidden = true;
      renderFilterList();
    }, 180);
    $("#filter-input").focus();
  }
  $("#filter-input").addEventListener("input", () => {
    state.filter = $("#filter-input").value;
    renderFilterList();
    renderListing();
    renderStatus();
  });
  $("#filter-input").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { filterMenu.hidden = true; }
    e.stopPropagation();
  });
  $("#filter-clear").onclick = () => {
    state.filter = "";
    $("#filter-input").value = "";
    renderFilterList();
    renderListing();
    renderStatus();
  };
  $("#filter-list").addEventListener("click", (e) => {
    const b = e.target.closest(".filter-item");
    if (!b) return;
    filterMenu.hidden = true;
    openEntry(b.dataset.path, b.dataset.kind);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#filtermenu") && !e.target.closest("#btn-more") && !e.target.closest("#mm-filter")) {
      filterMenu.hidden = true;
    }
  });
  openFilterGlobal = openFilter;

  // address: type to edit the path, Enter to go. In split mode the field
  // shows the active pane's path and Enter navigates that pane.
  $("#addr").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = $("#addr").value;
      const target = $("#addr").dataset.target || "main";
      const cur = target === "split" ? state.splitPath : state.path;
      if (v && v !== cur) navigate(v);
      $("#addr").blur();
    }
    e.stopPropagation();
  });
  $("#btn-up").onclick = () => { if (state.parent) navigate(state.parent); };

  // preview bar
  $("#pv-close").onclick = () => { closeAll(); };
  $("#pv-save").onclick = saveEditor;

  // In split view the right pane is a live drop target: drag a file/folder
  // from the left listing onto it to move (or copy with Shift) it into the
  // directory the right pane is showing.
  const pane = $("#preview");
  pane.addEventListener("focusin", () => { if (state.split) state.addrTarget = "split"; });
  pane.addEventListener("click", () => { if (state.split) state.addrTarget = "split"; });
  pane.addEventListener("dragover", (e) => {
    if (!pane.classList.contains("split")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.shiftKey ? "copy" : "move";
    pane.classList.add("drop-pane");
  });
  pane.addEventListener("dragleave", () => pane.classList.remove("drop-pane"));
  pane.addEventListener("drop", async (e) => {
    pane.classList.remove("drop-pane");
    if (!pane.classList.contains("split") || !state.otherPath) return;
    e.preventDefault();
    const src = e.dataTransfer.getData("text/plain");
    if (!src) return;
    const copy = e.shiftKey;
    const dest = state.otherPath.replace(/\/$/, "") + "/" + src.split("/").pop();
    try {
      if (copy) {
        await duplicateInto(src, state.otherPath);
        toast("Copied to " + state.otherPath);
      } else {
        if (dest === src) { toast("Already there"); return; }
        await api("/api/fs/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: src, to: dest }) });
        toast("Moved to " + state.otherPath);
      }
      navigate(state.path, { quiet: true });
      // refresh the other pane too
      openPreview({ path: state.otherPath, name: state.otherPath.split("/").pop() });
    } catch (err) {
      toast(err.message, "error");
    }
  });
  // Allow dropping onto the main listing area in split view too, so a user can
  // drag a file from the right pane back onto the left listing (and vice
  // versa) regardless of which side they started on.
  const mainPane = $("#listing");
  mainPane.addEventListener("dragover", (e) => {
    if (!pane.classList.contains("split")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.shiftKey ? "copy" : "move";
  });
  mainPane.addEventListener("drop", async (e) => {
    if (!pane.classList.contains("split")) return;
    e.preventDefault();
    const src = e.dataTransfer.getData("text/plain");
    if (!src) return;
    const dest = state.path.replace(/\/$/, "") + "/" + src.split("/").pop();
    try {
      if (e.shiftKey) {
        await duplicateInto(src, state.path);
        toast("Copied to " + state.path);
      } else {
        if (dest === src) { toast("Already there"); return; }
        await api("/api/fs/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: src, to: dest }) });
        toast("Moved to " + state.path);
      }
      navigate(state.path, { quiet: true });
    } catch (err) { toast(err.message, "error"); }
  });

  // Core bootstrap: the directory listing MUST always render on load,
  // even if any secondary lookup fails.
  bootMark("fetching /api/info");
  try {
    const info = await api("/api/info");
    state.home = info.home;
    state.node = info.node;
    bootMark("server ok; loading listing");
    await navigate(info.home);
    bootMark("initial listing rendered");
  } catch (e) {
    console.error("[filer] /api/info failed:", e);
    toast("Failed to connect to server: " + e.message, "error");
    return;
  }

  // Secondary metadata: plugins, commands, places, live events.
  bootMark("loading plugins/commands/events");
  const [pl, cm] = await Promise.allSettled([api("/api/plugins"), api("/api/commands")]);
  if (pl.status === "fulfilled") state.plugins = pl.value.plugins;
  if (cm.status === "fulfilled") state.commands = cm.value.commands;
  renderPlaces().catch((e) => console.warn("[filer] renderPlaces failed:", e));
  renderPluginsDrawer();
  updateRailFoot();
  connectEvents();
  bootMark("init() complete - UI interactive");
  if (window.__filerBoot) window.__filerBoot.ready = true;
  // remove the diagnostic strip after a beat
  setTimeout(() => {
    const el = document.getElementById ? document.getElementById("boot-status") : document.querySelector("#boot-status");
    if (el) el.remove();
  }, 1200);

  // Re-render when crossing the narrow/wide boundary so the layout mode
  // (list vs forced-grid) follows the viewport.
  if (typeof window.matchMedia === "function") {
    let lastWide = state.wide();
    window.addEventListener("resize", () => {
      const w = state.wide();
      if (w !== lastWide) { lastWide = w; renderListing(); }
    });
  }

  setupDnD();
}

function showCrashPanel(title, detail) {
  console.error("[filer] CRASH:", title, detail);
  if (window.__filerBoot) window.__filerBoot.log.push("[crash] " + title);
  let panel = document.getElementById("crash-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "crash-panel";
    panel.style.cssText = "position:fixed;inset:auto 14px 14px auto;z-index:999;max-width:380px;" +
      "background:#c22f2f;color:#fff;padding:12px 14px;border-radius:8px;font-size:12.5px;" +
      "box-shadow:0 8px 28px rgba(16,24,40,.35);font-family:var(--sans,system-ui);";
    document.body.appendChild(panel);
  }
  panel.innerHTML = `<strong style="display:block;margin-bottom:4px">${title}</strong>` +
    `<div style="font-family:var(--mono,monospace);font-size:11px;opacity:.9;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto">${detail || ""}</div>` +
    `<button style="margin-top:8px;border:0;background:rgba(255,255,255,.25);color:#fff;border-radius:5px;padding:4px 10px;font-size:12px" onclick="location.reload()">Reload</button>`;
}

function reportError(where, e) {
  const msg = (e && e.message) || String(e);
  const stack = (e && e.stack) || "";
  console.error(`[filer] ${where}:`, e);
  try {
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "error", msg: where + ": " + msg, stack }),
    }).catch(() => {});
  } catch {}
  showCrashPanel(where + " failed.", stack || msg);
}

// Global safety net: surface uncaught module errors on the page instead of
// leaving a frozen screen.
window.addEventListener("error", (e) => {
  reportError("uncaught error", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  reportError("unhandled rejection", e.reason);
});

init().catch((e) => {
  console.error("[filer] init() threw:", e);
  showCrashPanel("Startup failed — the interface cannot load.", (e && e.stack) || e.message || String(e));
});
