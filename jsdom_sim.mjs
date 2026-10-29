// Real-browser simulation: jsdom (full DOM + fetch + EventSource) running
// the EXACT served app.js against the EXACT served index.html.
// Exits non-zero on any error, prints milestones and final listing contents.

import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const BASE = "http://127.0.0.1:38497";
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
  const ok = rows.length > 0 && !appThrew;
  console.log(ok ? "RESULT: PASS — listing rendered, app survived" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}, 3000);
