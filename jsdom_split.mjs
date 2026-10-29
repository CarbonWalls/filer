// Real-browser simulation: jsdom (full DOM + fetch + EventSource) running
// the EXACT served app.js against the EXACT served index.html.
// Exits non-zero on any error, prints milestones and final listing contents.

import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const BASE = "http://127.0.0.1:41233";
const html = fs.readFileSync("/root/filer/web/index.html", "utf8");
const appJs = fs.readFileSync("/root/filer/web/app.js", "utf8");

// Capture console output from the simulated page
const pageConsole = [];
const vc = new VirtualConsole();
["log", "info", "warn", "error", "debug"].forEach((lvl) => {
  vc.on(lvl, (...args) => pageConsole.push(`[page:${lvl}] ${args.map(String).join(" ")}`));
});

const dom = new JSDOM(html, {
  url: BASE + "/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;

// Provide what app.js expects
window.addEventListener("error", (e) => pageConsole.push("[page:error-event] " + e.message));

// Stub EventSource if missing (jsdom 22+ has it; older doesn't)
if (!window.EventSource) {
  window.EventSource = class {
    constructor(url) { this.url = url; this.close = () => {}; }
  };
}

// fetch: mirror the browser against the live server
window.fetch = (path, opts) =>
  fetch(new URL(String(path), BASE).href, {
    ...opts,
    // jsdom fetch needs absolute URLs; keep headers/body as-is
  });
window.location = { reload: () => {}, href: BASE + "/" };

// Now execute the page's inline boot script, then app.js (both from served bytes)
const inline = window.document.querySelector("script:not([src])");
try {
  if (inline) window.eval(inline.textContent);
} catch (e) {
  pageConsole.push("[page:INLINE-SCRIPT-THREW] " + e.stack);
}

let appThrew = null;
try {
  window.eval(appJs);
} catch (e) {
  appThrew = e;
}

setTimeout(() => {
  console.log("===== PAGE CONSOLE =====");
  pageConsole.forEach((l) => console.log(l));
  if (appThrew) {
    console.log("===== APP.JS THREW =====");
    console.log(appThrew.stack);
  }
  const doc = window.document;
  const rows = doc.querySelectorAll("#listing .row");
  const listingHtml = doc.querySelector("#listing").innerHTML;
  console.log("===== DOM RESULT =====");
  console.log("listing .row count:", rows.length);
  console.log("listing html length:", listingHtml.length);
  console.log("status-left text:", doc.querySelector("#status-left").textContent);
  console.log("status-right text:", doc.querySelector("#status-right").textContent);
  const boot = window.__filerBoot;
  if (boot) {
    console.log("boot strip log:");
    boot.log.forEach((l) => console.log("   ", l));
    console.log("boot.ready:", boot.ready);
  } else {
    console.log("__filerBoot: MISSING (inline script never ran?)");
  }
  // Emulate "what element sits at the screen center" by scanning for visible
  // position:fixed overlays that are not the app itself. If #modal-root or any
  // other overlay is visible + has a non-none background while hidden, that is
  // the pointer-swallowing bug.
  const style = window.getComputedStyle;
  const overlays = ["modal-root","preview","drawer","ctx","moremenu","filtermenu","addrmenu"];
  const visible = [];
  for (const id of overlays) {
    const el = window.document.getElementById(id);
    if (!el) continue;
    const cs = style.call(window.document, el);
    if (cs.display !== "none" && (cs.position === "fixed" || el.closest("#app"))) {
      visible.push(id + "(display=" + cs.display + ",pos=" + cs.position + ")");
    }
  }
  // Simulate split toggling: open a file (overlay), toggle split -> pane,
  // toggle back -> overlay.
  let splitOk = true;
  try {
    window.openPreview({ path: "/root/filer/README.md", name: "README.md", kind: "file" });
    const pv = window.document.getElementById("preview");
    const hasOpen = pv.classList.contains("open");
    const hasSplit = pv.classList.contains("split");
    if (!hasOpen || hasSplit) {
      console.log("SPLIT FAIL: after openPreview, open=" + hasOpen + " split=" + hasSplit);
      splitOk = false;
    }
    window.toggleSplit();
    const hasOpen2 = pv.classList.contains("open");
    const hasSplit2 = pv.classList.contains("split");
    const bodySplit = window.document.body.classList.contains("preview-split");
    if (hasOpen2 || !hasSplit2 || !bodySplit) {
      console.log("SPLIT FAIL: after toggleSplit, open=" + hasOpen2 + " split=" + hasSplit2 + " bodySplit=" + bodySplit);
      splitOk = false;
    }
    window.toggleSplit();
    const hasOpen3 = pv.classList.contains("open");
    const hasSplit3 = pv.classList.contains("split");
    if (!hasOpen3 || hasSplit3) {
      console.log("SPLIT FAIL: after second toggleSplit, open=" + hasOpen3 + " split=" + hasSplit3);
      splitOk = false;
    }
    if (splitOk) console.log("SPLIT PASS: overlay -> split -> overlay transitions correct");
  } catch (e) {
    console.log("SPLIT FAIL: threw " + e.message);
    splitOk = false;
  }

  const ok = rows.length > 0 && !appThrew && visible.length === 0 && splitOk;
  console.log("visible overlays at load:", visible.length ? visible.join(", ") : "(none)");
  console.log(ok ? "RESULT: PASS — listing rendered, no overlay swallowing input, split toggles" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}, 3000);
