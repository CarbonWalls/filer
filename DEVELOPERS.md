# Making Filer plugins

A plugin is a folder containing a `plugin.json` manifest and an ESM module.
Drop it into `plugins/` (or `examples/`) and it loads **live** — no restart,
no page refresh. It is listed in the Plugins panel where anyone can toggle
it, re-prioritize it, and reload it.

## Manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Short description shown in the UI.",
  "version": "0.1.0",
  "author": "You",
  "priority": 10,
  "main": "index.mjs"
}
```

- `id` — unique, stable. Used for config and override identity.
- `priority` — default 0. Higher priority wins when several plugins register
  the same operation.
- `main` — default `index.mjs`.
- `demo: true` — optional marker shown in the UI.

## Module

```js
export default {
  async init(ctx) {
    // register operations, views, commands, routes
    return () => { /* optional cleanup */ };
  },
  async dispose(ctx) {
    // optional cleanup on disable/reload/removal
  },
};
```

`init` runs when the plugin loads; `dispose` runs when it is unloaded
(disable, reload, folder removal). Registrations are purged automatically,
so you usually don't need cleanup.

## The plugin context `ctx`

| API | Purpose |
| --- | --- |
| `ctx.handle(op, fn)` | Register an operation handler |
| `ctx.command({id, label, icon, run})` | Add a command to the context menu |
| `ctx.view(test, spec)` | Claim a file type for preview |
| `ctx.serve(route, handler)` | Serve custom routes under `/api/plugin/<id>/` |
| `ctx.call(op, input)` | Invoke an operation (respects overrides) |
| `ctx.log(...)` | Log with plugin prefix |

## Operations

Operations are the filesystem capability surface. The core plugin provides:

`fs.list`, `fs.stat`, `fs.read`, `fs.write`, `fs.mkdir`, `fs.rename`,
`fs.remove`.

A handler signature is `fn(input, next)` where `next` calls the next
registered handler (lower priority, or the previous override). This is how
you **wrap** defaults:

```js
ctx.handle("fs.list", async (input, next) => {
  const base = await next(input);          // default implementation
  base.entries.sort((a, b) => (b.size || 0) - (a.size || 0));
  return base;
});
```

To fully replace an operation, just don't call `next`. To win over the
default or another plugin, use a higher `priority`.

## Commands

Commands appear in the right-click menu on files/folders:

```js
ctx.command({
  id: "my.duplicate",
  label: "Duplicate",
  icon: "copy",                // one of the built-in SVG icon ids
  async run(entry) {
    await ctx.call("fs.write", {
      path: entry.path + ".copy",
      content: (await ctx.call("fs.read", { path: entry.path })).content,
    });
    return "Duplicated";
  },
});
```

Return a string to show it as a toast.

## Views

Claim a file type for the preview panel:

```js
ctx.view(/\.(csv|tsv)$/i, { type: "text", title: "Data" });
```

Types the client knows how to render: `text`, `markdown`, `image`, `video`,
`audio`, `pdf`, `binary`.

For a fully custom UI (no limits), provide a view with `iframe: true`:

```js
ctx.view(/\.mylang$/i, { type: "custom", title: "MyLang", iframe: true });
ctx.serve("/view", async ({ query }) => ({
  html: `<!doctype html><h1>Custom viewer for ${query.path}</h1>`,
}));
```

The client embeds `/api/plugin/<plugin-id>/view?path=...` in an iframe, with
your full page inside. `ctx.serve` handlers receive `{query, path, params}`
and may return `{html}`, `{status, headers, body}`, or JSON.

## Fault tolerance

- A plugin whose import fails or whose `init` throws is reported with a
  `error` in the Plugins panel and the rest of the system keeps running.
- Reloading a broken plugin keeps the previous working copy active.
- Watchers are debounced; directories are scanned by fingerprint so only
  changed plugins re-initialize.
