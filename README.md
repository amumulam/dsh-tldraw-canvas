# dsh-tldraw-canvas

[![test](https://github.com/amumulam/dsh-tldraw-canvas/actions/workflows/test.yml/badge.svg)](https://github.com/amumulam/dsh-tldraw-canvas/actions/workflows/test.yml)

A DeepSeek Harness plugin that gives every Session its own tldraw canvas in the right sidebar. This build uses the original **MIT-licensed tldraw v1** (2021–2022) instead of the commercially licensed tldraw 5 SDK, so there is no license key, no watermark, and no production gate.

The canvas autosaves into that Session's working directory, so it travels with the workspace instead of living in browser storage.

## Install

```bash
git clone https://github.com/amumulam/dsh-tldraw-canvas.git
```

Install the checked-out directory as a DSH bundle (Plugin Manager → install from
folder, or `install_bundle` with its absolute path). `client.js` is prebuilt, so
the installed copy does not need `node_modules`.

## Use

1. Open the right sidebar for a Session.
2. Add a tab from the guide and choose **Tldraw Canvas** / **Tldraw 画板**.
3. Draw. Changes save automatically after a short pause, and again when the tab closes.

The status bar shows the save state and the workspace-relative file path.

## Reading a canvas (Agent tool)

The Host half now owns the read path instead of leaving it to ad-hoc filesystem
scripts. It registers the `tldrawCanvas` service and exposes it to agents as:

```text
tldraw_read_canvas
```

Arguments:

- `session_id` — optional; defaults to the calling Session
- `include_preview` — default `true`; renders a PNG preview

The tool returns a normalized summary (format, shape/stroke/text counts, point
count, bounds, per-shape details) plus the preview image, so an agent can answer
“what is on my canvas?” without reading the JSON file manually. It accepts both
the new v1 documents and legacy v5 snapshots.

Other Host plugins can inject `tldrawCanvas` and call:

```js
const analysis = await ctx.tldrawCanvas.inspect(sessionId);
const { analysis, png } = await ctx.tldrawCanvas.render(sessionId);
```

`inspect` and `render` are read-only; `configure`/write access stays with the
canvas tab and its autosave.

## Where it saves

```text
<session cwd>/.dsh/tldraw/<session-id>.json
```

The Host resolves the Session's current working directory itself, so the browser cannot choose an arbitrary path. Each canvas is written atomically and survives app restarts and Session switching.

### Legacy v5 drawings

The first release of this plugin used tldraw 5. On the first v1 save of an old file, the Host copies the original next to it:

```text
.dsh/tldraw/<session-id>.v5.json
```

The client detects a v5 snapshot, converts freehand `draw` shapes to v1 points, and shows a **已迁移旧画板 / Legacy canvas migrated** badge. Other v5 shape types are not converted; the badge tooltip reports how many were skipped. The `.v5.json` backup is never deleted by the plugin.

## Implementation

- `index.js` — Host half: registers `GET`/`PUT /api/tldraw`, resolves the Session's cwd, reads/writes atomically, and backs up legacy v5 files.
- `src/client-entry.js` — Client half: registers the tldraw tab type, guide card, theme-aware editor, and debounced autosave.
- `src/migrate.js` — v5 draw-segment decoding and v5 → v1 document conversion.
- `src/canvas-model.js` — format-neutral analysis and the dependency-free PNG preview renderer.
- `client.js` — generated bundle.

## Naming

Public DSH plugins follow a small set of repository/package conventions:

- `dsh-<capability>` — the most common, e.g. `dsh-context`, `dsh-better-sidebar`
- `dsh-plugin-<capability>` — e.g. `dsh-plugin-subscriptions`
- `@author/dsh-<capability>` — when the package is scoped to its author

This project follows the first form: repository `dsh-tldraw-canvas`, package
`dsh-tldraw-canvas`, tab implementation id `dsh-tldraw-canvas/canvas`. The
package keywords use `dsh`, `dsh-plugin`, and `deepseek-harness` so plugin
directories can discover it.

## Why tldraw v1

The current tldraw 5 SDK is source-available but requires a commercial/trial/hobby license key in production. The original tldraw v1 is MIT, but it is no longer maintained (last release 1.29.2, 2022). This plugin intentionally trades modern features and maintenance for a genuinely open-source editor.

## Development

```bash
npm install
npm run build
```

`npm run build` regenerates `client.js` from `src/client-entry.js`.

## Tests

```bash
node --test test/*.test.mjs
```

The tests cover the Host API's read/write contract, invalid and concurrent requests, malformed files, temporary-file cleanup, legacy v5 backup, v5 paint-point decoding, v5 → v1 conversion, the reusable read service, and the agent tool's summary/image envelope.

## Disclaimer

This is an independent community plugin. tldraw is a trademark of tldraw Inc.;
this project is not affiliated with or endorsed by tldraw Inc. The bundled
tldraw v1 code remains under its MIT license (see `THIRD_PARTY_NOTICES.md`).
