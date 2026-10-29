#!/usr/bin/env node
// Filer — ultrafast, lightweight browser file manager.
// Everything is a plugin. Zero runtime dependencies (node:http only).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PluginRegistry } from "./lib/plugins.mjs";
import { mimeFor } from "./lib/mime.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, "web");
const PLUGIN_DIRS = [path.join(ROOT, "plugins"), path.join(ROOT, "examples")];
const CONFIG_PATH = path.join(ROOT, "filer.config.json");
const VERSION = "0.1.0";
const MAX_BODY = 128 * 1024 * 1024;

// ---------------------------------------------------------------- config

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg === "object") return cfg;
  } catch {}
  const def = { plugins: { "fancy-sort": { enabled: false } } };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(def, null, 2)); } catch {}
  return def;
}

// ---------------------------------------------------------------- helpers

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function fail(res, e) {
  const status = e.status || 500;
  json(res, status, { error: e.message || "Internal error" });
}

function normPath(p) {
  const out = path.normalize(String(p || "/")).replace(/\/+$/, "");
  return out || "/";
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const e = new Error("Request body too large");
      e.status = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    const e = new Error("Invalid JSON body");
    e.status = 400;
    throw e;
  }
}

function sendFile(res, file, { download = false, fallback = false, head = false } = {}) {
  fs.lstat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (fallback) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      }
      return fail(res, { status: 404, message: "File not found" });
    }
    const mime = mimeFor(file) || "application/octet-stream";
    const headers = {
      "Content-Type": mime,
      "Content-Length": st.size,
      "Cache-Control": download ? "no-store" : "no-cache",
    };
    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(path.basename(file))}"`;
    }
    res.writeHead(200, headers);
    if (head) return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- registry

const registry = new PluginRegistry({ dirs: PLUGIN_DIRS, configPath: CONFIG_PATH, config: loadConfig() });

// ---------------------------------------------------------------- SSE

const sseClients = new Set();
function broadcast(type, payload) {
  const data = JSON.stringify({ type, ...payload });
  for (const res of sseClients) {
    try { res.write(`event: ${type}\ndata: ${data}\n\n`); } catch {}
  }
}
registry.on("changed", (plugins) => broadcast("plugins", { plugins }));

// ---------------------------------------------------------------- routes

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method;

  // ---------------- static web assets
  if (method === "GET" || method === "HEAD") {
    const head = method === "HEAD";
    if (p === "/" || p === "/index.html") return sendFile(res, path.join(WEB, "index.html"), { head });
    if (p.startsWith("/app.")) return sendFile(res, path.join(WEB, p.slice(1)), { head });
    if (p === "/favicon.svg") return sendFile(res, path.join(WEB, "favicon.svg"), { head });
  }

  // ---------------- info
  if (method === "GET" && p === "/api/info") {
    return json(res, 200, {
      app: "filer",
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      home: os.homedir(),
      pluginsDir: PLUGIN_DIRS,
    });
  }

  // ---------------- plugins
  if (method === "GET" && p === "/api/plugins") {
    return json(res, 200, { plugins: registry.list() });
  }
  let m = p.match(/^\/api\/plugins\/([^/]+)$/);
  if (m && method === "PUT") {
    try {
      const body = await readJsonBody(req);
      const id = decodeURIComponent(m[1]);
      if (typeof body.enabled === "boolean") await registry.setEnabled(id, body.enabled);
      if (typeof body.priority === "number") await registry.setPriority(id, body.priority);
      return json(res, 200, { ok: true, plugin: registry.list().find((x) => x.id === id) || null });
    } catch (e) { return fail(res, e); }
  }
  if (m && method === "POST") {
    try {
      const id = decodeURIComponent(m[1]);
      const mod = await registry.reload(id);
      if (!mod) return json(res, 404, { error: "Unknown plugin" });
      return json(res, 200, { ok: true, plugin: registry.list().find((x) => x.id === id) });
    } catch (e) { return fail(res, e); }
  }

  // ---------------- commands
  if (method === "GET" && p === "/api/commands") {
    return json(res, 200, { commands: registry.commands() });
  }
  if (method === "POST" && p === "/api/commands/run") {
    try {
      const body = await readJsonBody(req);
      let entry = { path: body.path || null, name: null, kind: "file" };
      if (body.path) {
        try { entry = await registry.call("fs.stat", { path: body.path }); } catch {}
      }
      const result = await registry.runCommand(body.command, entry);
      return json(res, 200, { ok: true, message: typeof result === "string" ? result : undefined });
    } catch (e) { return fail(res, e); }
  }

  // ---------------- views backend
  if (method === "GET" && p === "/api/views") {
    try {
      const entry = await registry.call("fs.stat", { path: q.get("path") });
      return json(res, 200, { view: registry.viewFor(entry), entry });
    } catch (e) { return fail(res, e); }
  }

  // ---------------- filesystem ops (all pluggable)
  if (method === "GET" && p === "/api/fs/list") {
    try { return json(res, 200, await registry.call("fs.list", { path: q.get("path") || "/" })); }
    catch (e) { return fail(res, e); }
  }
  if (method === "GET" && p === "/api/fs/read") {
    try { return json(res, 200, await registry.call("fs.read", { path: q.get("path") })); }
    catch (e) { return fail(res, e); }
  }
  if (method === "GET" && p === "/api/fs/stat") {
    try { return json(res, 200, await registry.call("fs.stat", { path: q.get("path") })); }
    catch (e) { return fail(res, e); }
  }
  if ((method === "GET" || method === "HEAD") && p === "/api/fs/raw") {
    const file = normPath(q.get("path") || "");
    return sendFile(res, file, { download: q.get("download") === "1", head: method === "HEAD" });
  }
  if (method === "POST" && p === "/api/fs/write") {
    try {
      const body = await readJsonBody(req);
      return json(res, 200, await registry.call("fs.write", { path: body.path, content: body.content }));
    } catch (e) { return fail(res, e); }
  }
  if (method === "POST" && p === "/api/fs/mkdir") {
    try {
      const body = await readJsonBody(req);
      return json(res, 200, await registry.call("fs.mkdir", { path: body.path }));
    } catch (e) { return fail(res, e); }
  }
  if (method === "POST" && p === "/api/fs/rename") {
    try {
      const body = await readJsonBody(req);
      return json(res, 200, await registry.call("fs.rename", { from: body.from, to: body.to }));
    } catch (e) { return fail(res, e); }
  }
  if (method === "POST" && p === "/api/fs/delete") {
    try {
      const body = await readJsonBody(req);
      return json(res, 200, await registry.call("fs.remove", { path: body.path }));
    } catch (e) { return fail(res, e); }
  }
  if (method === "POST" && p === "/api/fs/copy") {
    try {
      const body = await readJsonBody(req);
      return json(res, 200, await registry.call("fs.copy", { from: body.from, to: body.to }));
    } catch (e) { return fail(res, e); }
  }

  // ---------------- upload (streamed to temp, then renamed)
  if (method === "PUT" && p === "/api/fs/upload") {
    const dir = normPath(q.get("dir") || "/");
    const name = q.get("name") || "";
    if (!name || name.includes("/") || name.includes("..")) return json(res, 400, { error: "Invalid file name" });
    const target = path.join(dir, name);
    const tmp = target + ".part";
    try {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.createWriteStream(tmp);
      await new Promise((resolve, reject) => {
        req.pipe(w);
        req.on("error", reject);
        w.on("error", reject);
        w.on("finish", resolve);
      });
      await fs.promises.rename(tmp, target);
      return json(res, 200, { ok: true, path: target });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      return fail(res, e);
    }
  }

  // ---------------- client log reporting
  if (method === "POST" && p === "/api/log") {
    try {
      const body = await readJsonBody(req);
      console.error("[client]", body.level || "error", "-", body.msg || "", body.stack ? "\n" + body.stack : "");
      return json(res, 200, { ok: true });
    } catch (e) { return fail(res, e); }
  }

  // ---------------- plugin-provided routes (custom UI, custom APIs)
  m = p.match(/^\/api\/plugin\/([^/]+)\/(.*)$/);
  if (m && method === "GET") {
    const id = decodeURIComponent(m[1]);
    const rest = decodeURIComponent(m[2] || "");
    if (rest.includes("..")) return json(res, 400, { error: "Bad route" });
    try {
      const input = {
        query: Object.fromEntries(q),
        path: q.get("path") || null,
        params: { path: rest },
      };
      const out = await registry.pluginServe(id, "/" + rest, input);
      if (out && typeof out === "object" && !Buffer.isBuffer(out)) {
        if (out.html !== undefined) {
          const html = String(out.html);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
          return res.end(html);
        }
        if (out.status || out.headers || out.body !== undefined) {
          res.writeHead(out.status || 200, { "Content-Type": "text/plain; charset=utf-8", ...(out.headers || {}) });
          return res.end(out.body ?? "");
        }
        return json(res, 200, out);
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      if (Buffer.isBuffer(out)) return res.end(out);
      return res.end(out ?? "");
    } catch (e) { return fail(res, e); }
  }

  // ---------------- SSE events
  if (method === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ app: "filer", version: VERSION })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { clearInterval(ping); }
    }, 25000);
    req.on("close", () => clearInterval(ping));
    return;
  }

  json(res, 404, { error: `No route: ${method} ${p}` });
}

// ---------------------------------------------------------------- main

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { port: 0, host: "127.0.0.1" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") out.port = parseInt(args[i + 1], 10) || 0;
    if (args[i] === "--host") out.host = args[i + 1];
    if (args[i] === "--plugins") out.pluginsDir = args[i + 1];
  }
  return out;
}

const args = parseArgs();
if (args.pluginsDir) PLUGIN_DIRS.unshift(args.pluginsDir);

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => fail(res, e));
});

await registry.start();

server.listen(args.port, args.host, () => {
  const addr = server.address();
  const url = `http://${addr.address}:${addr.port}`;
  console.log("");
  console.log("  Filer v" + VERSION + " — plugins: " + registry.list().length + " loaded");
  console.log("  " + url);
  console.log("  (Ctrl+C to stop)");
  console.log("");
});

const shutdown = () => {
  registry.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
