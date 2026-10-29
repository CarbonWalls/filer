// Filer plugin engine.
// - Discovers plugins from one or more directories (plugins/, examples/).
// - Each plugin is a folder containing plugin.json + index.mjs (ESM).
// - Hot reload: watches plugin dirs; on change it reloads only what changed
//   and emits a "changed" event so the UI can refresh live.
// - Operations, views and commands are registries. When several plugins
//   register the same operation, the one with the highest priority wins;
//   a handler can call `next()` to delegate to the runner-up (so plugins can
//   wrap or override defaults cooperatively). Ties resolve newest-first.
// - Plugins can be enabled/disabled/re-prioritized via a persisted config.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fingerprint(mainFile, extraFiles) {
  let total = 0;
  for (const f of [mainFile, ...extraFiles]) {
    try {
      const st = fs.statSync(f);
      total += st.mtimeMs;
    } catch {
      total += 0;
    }
  }
  return total;
}

export class PluginRegistry extends EventEmitter {
  #dirs;
  #configPath;
  #config;
  #modules = new Map();   // id -> module record
  #handlers = new Map();  // op -> [{id, prio, seq, fn}]
  #commands = [];          // [{id, plugin, label, run}]
  #views = [];             // [{id, prio, seq, test, spec}]
  #serves = new Map();     // id -> Map(route, handler)
  #seq = 0;
  #watchers = [];
  #timer = null;

  constructor({ dirs, configPath, config }) {
    super();
    this.#dirs = dirs;
    this.#configPath = configPath;
    this.#config = config || { plugins: {} };
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    await this.scan();
    for (const dir of this.#dirs) this.#watch(dir);
  }

  stop() {
    for (const w of this.#watchers) {
      try { w.close(); } catch {}
    }
    this.#watchers = [];
    if (this.#timer) clearTimeout(this.#timer);
  }

  async saveConfig() {
    const tmp = this.#configPath + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(this.#config, null, 2));
    await fs.promises.rename(tmp, this.#configPath);
  }

  // ---------------------------------------------------------------- discovery

  async scan(onlyIds) {
    for (const dir of this.#dirs) {
      let items = [];
      try { items = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch { continue; }
      for (const it of items) {
        if (!it.isDirectory()) continue;
        const p = path.join(dir, it.name);
        const mp = path.join(p, "plugin.json");
        if (!fs.existsSync(mp)) continue;
        try { await this.#loadCandidate(p, onlyIds); } catch (e) { console.error("[plugins] scan error", p, e); }
      }
      // Drop modules whose folder disappeared while enabled.
      for (const [id, m] of [...this.#modules]) {
        if (onlyIds) continue;
        const cfg = this.#config.plugins?.[id];
        if (cfg?.enabled === false) continue; // keep disabled entries listed
        if (!fs.existsSync(m.dir)) await this.#unload(m.manifest.id, false);
      }
    }
    this.emit("changed", this.list());
  }

  async #loadCandidate(dir, onlyIds) {
    const mp = path.join(dir, "plugin.json");
    let manifest;
    try { manifest = JSON.parse(await fs.promises.readFile(mp, "utf8")); }
    catch { return null; }
    if (!manifest.id || !manifest.name) return null;
    if (onlyIds && !onlyIds.includes(manifest.id)) return null;

    const mainFile = path.join(dir, manifest.main || "index.mjs");
    if (!fs.existsSync(mainFile)) return null;
    const fp = fingerprint(mainFile, [mp]);
    const cur = this.#modules.get(manifest.id);
    if (cur && cur.dir === dir && cur.fp === fp && cur.loaded) return cur;

    // Try to import the new module BEFORE touching the current one, so a
    // broken plugin never takes down a working version.
    const fresh = await this.#importModule(manifest, mainFile);
    if (fresh.error && cur) {
      cur.error = fresh.error; // keep old copy running, report error
      return cur;
    }
    if (cur) await this.#unload(manifest.id, true);

    const m = {
      dir, fp, manifest, loaded: !fresh.error,
      mod: fresh.mod || null, error: fresh.error || null,
      active: false, ctx: null,
    };
    this.#modules.set(manifest.id, m);
    const cfg = this.#config.plugins?.[manifest.id];
    if (m.loaded && cfg?.enabled !== false) await this.#activate(m);
    return m;
  }

  async #importModule(manifest, mainFile) {
    try {
      const url = pathToFileURL(mainFile).href + "?v=" + Date.now();
      const ns = await import(url);
      const mod = ns.default ?? ns;
      if (typeof mod !== "object" || !mod) return { error: "plugin export must be an object" };
      if (typeof mod.init !== "function") return { error: "plugin must export init(ctx)" };
      return { mod };
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  }

  // ---------------------------------------------------------------- activate / deactivate

  async #activate(m) {
    const ctx = this.#makeCtx(m);
    m.ctx = ctx;
    try {
      const ret = await m.mod.init(ctx);
      if (typeof ret === "function") ctx.onDispose(ret);
      m.active = true;
      m.error = null;
    } catch (e) {
      m.active = false;
      m.error = (e && e.message) || String(e);
    }
  }

  async #unload(id, keepEntry) {
    const m = this.#modules.get(id);
    if (!m) return;
    if (m.active) {
      try {
        if (m.mod?.dispose) await m.mod.dispose(m.ctx);
        if (m.ctx?.disposers) for (const d of m.ctx.disposers) { try { await d(); } catch {} }
      } catch {}
      m.active = false;
    }
    // purge registrations
    for (const [op, arr] of this.#handlers) {
      const next = arr.filter((r) => r.id !== id);
      if (next.length) this.#handlers.set(op, next); else this.#handlers.delete(op);
    }
    this.#commands = this.#commands.filter((c) => c.plugin !== id);
    this.#views = this.#views.filter((v) => v.id !== id);
    this.#serves.delete(id);
    if (!keepEntry) this.#modules.delete(id);
  }

  async setEnabled(id, enabled) {
    const cfg = (this.#config.plugins ||= {});
    if (!cfg[id]) cfg[id] = {};
    cfg[id].enabled = !!enabled;
    await this.saveConfig();
    const m = this.#modules.get(id);
    if (m && m.loaded) {
      if (enabled && !m.active) await this.#activate(m);
      if (!enabled && m.active) await this.#unload(id, true);
    }
    this.emit("changed", this.list());
  }

  async setPriority(id, priority) {
    const cfg = (this.#config.plugins ||= {});
    if (!cfg[id]) cfg[id] = {};
    cfg[id].priority = Number(priority) || 0;
    await this.saveConfig();
    this.emit("changed", this.list());
  }

  async reload(id) {
    const m = this.#modules.get(id);
    if (!m) return null;
    await this.#unload(id, true);
    await this.scan([id]);
    return this.#modules.get(id) || null;
  }

  effectivePriority(manifest) {
    const cfg = this.#config.plugins?.[manifest.id];
    if (cfg && typeof cfg.priority === "number") return cfg.priority;
    return manifest.priority || 0;
  }

  // ---------------------------------------------------------------- registry API (ctx)

  #makeCtx(m) {
    const self = this;
    const manifest = m.manifest;
    const prio = () => self.effectivePriority(manifest);
    const ctx = {
      id: manifest.id,
      manifest,
      disposers: [],
      log(...a) { console.log(`[plugin:${manifest.id}]`, ...a); },
      onDispose(fn) { this.disposers.push(fn); },
      handle(op, fn) {
        const rec = { id: manifest.id, prio: prio(), seq: self.#seq++, fn };
        const arr = self.#handlers.get(op) || [];
        arr.push(rec);
        self.#handlers.set(op, arr);
        return () => {
          const cur = self.#handlers.get(op) || [];
          self.#handlers.set(op, cur.filter((r) => r !== rec));
        };
      },
      command(def) {
        const c = {
          id: def.id,
          plugin: manifest.id,
          label: def.label || def.id,
          icon: def.icon || "",
          run: def.run,
        };
        self.#commands.push(c);
        return () => { self.#commands = self.#commands.filter((x) => x !== c); };
      },
      view(test, spec) {
        const v = { id: manifest.id, prio: prio(), seq: self.#seq++, test, spec };
        self.#views.push(v);
        return () => { self.#views = self.#views.filter((x) => x !== v); };
      },
      serve(route, handler) {
        if (!self.#serves.has(manifest.id)) self.#serves.set(manifest.id, new Map());
        self.#serves.get(manifest.id).set(route, handler);
        return () => { self.#serves.get(manifest.id)?.delete(route); };
      },
      call(op, input) { return self.call(op, input); },
    };
    return ctx;
  }

  // ---------------------------------------------------------------- invocation

  async call(op, input) {
    const recs = (this.#handlers.get(op) || [])
      .slice()
      .sort((a, b) => (b.prio - a.prio) || (b.seq - a.seq));
    let i = 0;
    const next = async () => {
      if (i >= recs.length) {
        const err = new Error(`No handler registered for operation "${op}"`);
        err.status = 404;
        throw err;
      }
      const rec = recs[i++];
      return rec.fn(input, next);
    };
    return next();
  }

  // ---------------------------------------------------------------- lookup helpers

  list() {
    return [...this.#modules.values()]
      .map((m) => {
        const cfg = this.#config.plugins?.[m.manifest.id];
        return {
          id: m.manifest.id,
          name: m.manifest.name,
          description: m.manifest.description || "",
          version: m.manifest.version || "0.0.0",
          author: m.manifest.author || "",
          demo: !!m.manifest.demo,
          enabled: cfg?.enabled !== false,
          priority: cfg && typeof cfg.priority === "number" ? cfg.priority : (m.manifest.priority || 0),
          active: m.active,
          error: m.error || null,
          source: m.manifest.source || "plugins",
        };
      })
      .sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id));
  }

  get(id) { return this.#modules.get(id) || null; }

  commands() {
    return this.#commands.map((c) => ({ id: c.id, plugin: c.plugin, label: c.label, icon: c.icon }));
  }

  async runCommand(id, entry) {
    const c = this.#commands.find((x) => x.id === id);
    if (!c) {
      const err = new Error(`Unknown command "${id}"`);
      err.status = 404;
      throw err;
    }
    return c.run(entry);
  }

  viewFor(entry) {
    // Same priority: earlier registration wins (specific before fallback);
    // higher priority always wins.
    for (const v of [...this.#views].sort((a, b) => (b.prio - a.prio) || (a.seq - b.seq))) {
      if (typeof v.test === "function" ? v.test(entry) : v.test.test(entry.name)) {
        return { ...v.spec, plugin: v.id };
      }
    }
    return null;
  }

  async pluginServe(id, route, input) {
    const map = this.#serves.get(id);
    const handler = map?.get(route);
    if (!handler) {
      const err = new Error(`No plugin route ${route}`);
      err.status = 404;
      throw err;
    }
    return handler(input);
  }

  // ---------------------------------------------------------------- hot reload watcher

  #watch(dir) {
    let w = null;
    try {
      w = fs.watch(dir, { recursive: true }, () => this.#scheduleScan());
      this.#watchers.push(w);
    } catch {
      // recursive watch unsupported (e.g. some Linux setups): poll instead
      const t = setInterval(() => this.#scheduleScan(), 1200);
      t.unref?.();
      this.#watchers.push({ close: () => clearInterval(t) });
    }
  }

  #scheduleScan() {
    if (this.#timer) return;
    this.#timer = setTimeout(async () => {
      this.#timer = null;
      try { await this.scan(); } catch (e) { console.error("[plugins] rescan failed", e); }
    }, 250);
  }
}
