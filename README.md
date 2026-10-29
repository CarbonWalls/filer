# Filer

Ultrafast, lightweight **browser file manager**. Everything is a plugin —
file operations, previews, commands, custom UIs — and plugins hot-reload
while the server is running.

- Zero runtime dependencies (Node built-ins only, `node:http`).
- One small server process; UI is a single static page with no framework.
- Plugins are folders with a `plugin.json` manifest and an ESM file.
  New plugins drop in and load live; edits reload live; removal unloads live.
- Plugins are managed from the web UI (enable / disable / priority / reload).
- Minimal UI: system fonts, inline SVG icons, no emoji, keyboard-first,
  light and dark mode.

## Quickstart

```bash
cd filer
node server.mjs            # picks a free port; prints the URL
node server.mjs --port 3000
```

Open the printed URL. The server binds to `127.0.0.1` by default
(`--host 0.0.0.0` to expose on the network — do this only on a trusted
network; there is no authentication).

A `filer.config.json` file is created next to the server to persist plugin
settings (enabled flags, priorities).

## Layout

```
filer/
  server.mjs            HTTP server: static UI + REST/SSE API
  lib/plugins.mjs       plugin engine: registry, hot reload, watcher
  lib/mime.mjs          tiny MIME/text helper
  plugins/              built-in plugins (core-fs, core-views)
  examples/             example plugins — drop-ins to copy
  web/                  the browser UI (index.html, app.css, app.js)
  DEVELOPERS.md         how to write plugins
```

## Making a plugin

See [DEVELOPERS.md](DEVELOPERS.md). In short:

```
plugins/my-plugin/
  plugin.json     { "id", "name", "description", "version", "priority", "main" }
  index.mjs       export default { async init(ctx) { ... } }
```

Everything is overridable: a plugin may register `fs.list`, `fs.read`, etc.
with a higher priority than the core, or wrap the default via `next()`.

## API overview

| Endpoint | Purpose |
| --- | --- |
| `GET /api/info` | Server/OS/home info |
| `GET /api/plugins` | Installed plugins (manifest + status) |
| `PUT /api/plugins/:id` | `{enabled, priority}` management |
| `POST /api/plugins/:id/reload` | Reload one plugin |
| `GET /api/commands` | Available plugin commands |
| `POST /api/commands/run` | Run a command `{command, path}` |
| `GET /api/views?path=` | Which view a plugin claims for a file |
| `GET /api/fs/list?path=` | Directory listing (pluggable) |
| `GET /api/fs/read?path=` | Read text/tiny files (pluggable) |
| `GET /api/fs/stat?path=` | Stat (pluggable) |
| `GET /api/fs/raw?path=` | Raw byte stream (also `&download=1`) |
| `POST /api/fs/write` | Write `{path, content}` |
| `POST /api/fs/mkdir` | `{path}` |
| `POST /api/fs/rename` | `{from, to}` |
| `POST /api/fs/delete` | `{path}` (recursive) |
| `PUT /api/fs/upload?dir=&name=` | Streamed upload (multipart-free) |
| `GET /api/plugin/:id/*` | Routes served by plugins (custom UIs/APIs) |
| `GET /api/events` | SSE: live `plugins` events (hot reload notifications) |

The API is transport-friendly for future desktop/mobile clients — same
HTTP + SSE contract works from any language.

## Keyboard

| Key | Action |
| --- | --- |
| `↑`/`↓` | Move selection |
| `Enter` / double-click | Open |
| `Backspace` | Up one level |
| `Delete` | Delete selection |
| `F2` | Rename |
| `Ctrl/Cmd+R` | Refresh |
| `Ctrl/Cmd+L` | Focus path bar |
| `Ctrl/Cmd+F` | Focus filter |
| `Ctrl/Cmd+S` | Save editor |
| `Esc` | Close overlays |

## Notes

- Files are streamed; text reads are capped at 8 MB (larger files open as
  hex/binary preview).
- Symlinks are listed with a distinct icon and resolved on open.
- The UI ships no emoji, no icon fonts — all icons are inline SVG.
