import path from "node:path";
import { promises as fsp } from "node:fs";
import { mimeFor, isTextName, MAX_TEXT } from "../../lib/mime.mjs";

function norm(p) {
  p = String(p || "/");
  const out = path.normalize(p).replace(/\/+$/, "");
  return out || "/";
}

function hidden(name) {
  return name.startsWith(".");
}

async function entryFrom(full, name, isDir) {
  const base = {
    name,
    path: full,
    kind: isDir ? "dir" : "file",
    size: isDir ? null : 0,
    mtime: null,
    mode: null,
    hidden: hidden(name),
    target: null,
  };
  try {
    const st = await fsp.lstat(full);
    base.mtime = st.mtime.toISOString();
    base.mode = (st.mode & 0o777).toString(8);
    if (st.isSymbolicLink()) {
      base.kind = "link";
      try {
        const t = await fsp.stat(full);
        base.target = t.isDirectory() ? "dir" : "file";
      } catch {
        base.target = "broken";
      }
    } else if (st.isDirectory()) {
      base.kind = "dir";
    } else {
      base.kind = "file";
      base.size = st.size;
    }
  } catch {
    // entry can still be listed even if lstat races/fails
  }
  return base;
}

export default {
  async init(ctx) {
    // list -----------------------------------------------------------------
    ctx.handle("fs.list", async ({ path: p }) => {
      const dir = norm(p);
      const st = await fsp.lstat(dir);
      if (!st.isDirectory()) {
        const e = new Error("Not a directory");
        e.status = 400;
        throw e;
      }
      const names = await fsp.readdir(dir);
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
      const entries = [];
      for (const name of names) {
        try { entries.push(await entryFrom(path.join(dir, name), name, false)); } catch {}
      }
      const dirs = entries.filter((e) => e.kind === "dir");
      const links = entries.filter((e) => e.kind === "link");
      const files = entries.filter((e) => e.kind !== "dir" && e.kind !== "link");
      return {
        path: dir,
        parent: dir === "/" ? null : path.dirname(dir),
        entries: [...dirs, ...links, ...files],
      };
    });

    // stat -----------------------------------------------------------------
    ctx.handle("fs.stat", async ({ path: p }) => {
      const full = norm(p);
      const st = await fsp.lstat(full);
      return entryFrom(full, path.basename(full), st.isDirectory());
    });

    // read -----------------------------------------------------------------
    ctx.handle("fs.read", async ({ path: p }) => {
      const full = norm(p);
      const st = await fsp.lstat(full);
      if (st.isDirectory()) {
        const e = new Error("Is a directory");
        e.status = 400;
        throw e;
      }
      const mime = mimeFor(full) || "application/octet-stream";
      const textish = isTextName(full) || mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || mime.includes("svg");
      if (!textish || st.size > MAX_TEXT) {
        return { raw: true, mime, size: st.size, content: null };
      }
      const content = await fsp.readFile(full, "utf8");
      return { raw: false, mime, size: st.size, content };
    });

    // write ----------------------------------------------------------------
    ctx.handle("fs.write", async ({ path: p, content }) => {
      const full = norm(p);
      if (typeof content !== "string") {
        const e = new Error("content must be a string");
        e.status = 400;
        throw e;
      }
      await fsp.writeFile(full, content, "utf8");
      const st = await fsp.stat(full);
      return { ok: true, path: full, size: st.size };
    });

    // mkdir ----------------------------------------------------------------
    ctx.handle("fs.mkdir", async ({ path: p }) => {
      const full = norm(p);
      await fsp.mkdir(full, { recursive: true });
      return { ok: true, path: full };
    });

    // rename ---------------------------------------------------------------
    ctx.handle("fs.rename", async ({ from, to }) => {
      if (!from || !to) {
        const e = new Error("from and to are required");
        e.status = 400;
        throw e;
      }
      const a = norm(from);
      const b = norm(to);
      await fsp.rename(a, b);
      return { ok: true, from: a, to: b };
    });

    // copy ---------------------------------------------------------------
    ctx.handle("fs.copy", async ({ from, to }) => {
      if (!from || !to) {
        const e = new Error("from and to are required");
        e.status = 400;
        throw e;
      }
      const a = norm(from);
      const b = norm(to);
      if (a === b) return { ok: true, copied: b, moved: false };
      const st = await fsp.lstat(a);
      if (st.isDirectory()) {
        await fsp.cp(a, b, { recursive: true, dereference: false });
      } else {
        await fsp.mkdir(path.dirname(b), { recursive: true });
        await fsp.copyFile(a, b);
      }
      return { ok: true, copied: b, moved: false };
    });

    // delete ---------------------------------------------------------------
    ctx.handle("fs.remove", async ({ path: p }) => {
      const full = norm(p);
      await fsp.rm(full, { recursive: true, force: true });
      return { ok: true, removed: full };
    });
  },
};
