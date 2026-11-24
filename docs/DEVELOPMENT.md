# Development and Build Guide

This document explains how to set up, build, load, debug, and test the
extension. It is meant for the next maintainer or developer who needs to
continue the thesis work.

---

## 1. Prerequisites

| Requirement | Version / notes |
|---|---|
| Node.js | 20 or newer (verified on Node 26) |
| npm | 10 or newer |
| Chrome / Chromium | 116+ (Manifest V3) |

No Python, native compiler, or Emscripten toolchain is needed. The zstd Wasm
binary is vendored in `public/zstd/`.

---

## 2. Setup

```sh
cd ~/Project/lossless-tab-optimization-thesis
npm install
```

This installs Vite, CRXJS, TypeScript, `idb-keyval`, and `@bokuweb/zstd-wasm`.
The npm package's web entry is broken; we only use it as the source of the
vendored Emscripten glue and wasm in `public/zstd/` — do not try to import it
directly in browser code.

### Available npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server (useful for popup/UI iteration) |
| `npm run build` | `tsc --noEmit` then `vite build` → `dist/` |
| `npm run typecheck` | TypeScript only |
| `npm test` | Runs `tests/*.test.mjs` with `node --test` |

**Always use `npm run build` before loading the extension.** A successful run
prints a clean Vite asset list; `dist/` is a build artifact and is gitignored.

---

## 3. Loading and reloading the extension

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `dist/` directory (not the repo root).
5. Pin the extension so the popup is easy to reach.

**After any source change:** rebuild, then click the **Reload** button on the
extension card. A change to `manifest.json` requires a full reload. The service
worker does not hot-reload reliably.

### Where to open DevTools (four separate contexts)

| Context | How to inspect |
|---|---|
| Popup | Right-click the popup → Inspect |
| Service worker | `chrome://extensions` → the extension card → **Inspect views: service worker** |
| Content script | DevTools on the page itself; messages appear in the page console |
| Offscreen document | `chrome://extensions` → **Inspect views** may list it; otherwise use `chrome.runtime.getContexts()` in the service worker console |

Most pipeline failures show up in either the service worker console or the
offscreen document console. The popup log is only a summary.

---

## 4. Source map

```text
manifest.json                 MV3 manifest (permissions, CSP, content script, popup)
vite.config.ts                Vite + CRXJS config
tsconfig.json                 strict ES2022, DOM + WebWorker libs

src/
  shared/
    types.ts                  SerializedTabState, FlatNodeDescriptor, constants,
                              message-name constants, ID/key helpers
    codec.ts                  stableStringify, UTF-8, base64 bridge helpers,
                              chunkBytes / joinChunks
  content/
    content.ts                BFS DOM capture, form extraction, scroll capture,
                              LTO_PING / LTO_RESTORE_PUSH handlers
  background/
    background.ts             Orchestrates freeze, restore, auto-restore,
                              and the inactivity sweep
  workers/
    compression.bridge.ts     Service-worker client for the offscreen host
  restoration/
    restoration.ts            Batched hydrateDOM, form restoration, lazy Proxy heap
  storage/
    indexeddb.ts              IndexedDB chunk store via idb-keyval
  ui/
    popup.html / popup.ts / popup.css   Dashboard: freeze/restore controls
public/
  offscreen.html / offscreen.js         Hidden host for the zstd worker
  compression-worker.js                 Classic Worker running zstd cwrap calls
  zstd/zstd.js, zstd/zstd.wasm           Vendored Emscripten zstd build
tests/
  contracts.test.mjs          Determinism/batching/protocol contracts
  messaging.test.mjs          Base64 bridge round-trip through offscreen.js
PHASE.md                      Continuity log: verified state, known issues, next steps
```

---

## 5. Architecture: how the pieces talk

There are four isolated JavaScript contexts:

```
popup  ──runtime.sendMessage──►  background service worker
                                   │
                                   ├──tabs.sendMessage──►  content script (per tab)
                                   └──runtime.sendMessage──► offscreen document
                                                                 │
                                                                 └──postMessage (transfer)──► zstd Worker
```

### Critical constraints (do not remove these)

1. **MV3 service workers have no `Worker` constructor.** Compression must run in
   the offscreen document (`public/offscreen.html`). Do not move
   `new Worker(...)` back into `background.ts`.
2. **Chrome extension messages use JSON serialization, not structured clone.**
   A `Uint8Array` sent through `runtime.sendMessage` becomes a plain object.
   All binary crossing that hop must be base64-encoded with
   `bytesToBase64`/`base64ToBytes` from `src/shared/codec.ts`. Only the
   offscreen → Worker hop uses zero-copy `TransferableObjects`.
3. **CSP requires `'wasm-unsafe-eval'`** in `manifest.json` for the zstd Wasm.
4. **Imports are extensionless** (`../shared/types`, not `../shared/types.ts`),
   except `new URL()` strings which keep the `.ts` suffix for Vite.
5. **No ML / AI / heuristic model of any kind.** All algorithms are explicit and
   deterministic: fixed compression level 3, 64 KiB chunks, 100-node batches,
   15-minute inactivity threshold, 50 ms long-task budget.
6. **BFS invariant:** `parentId < id` for every descriptor. Hydration relies on
   this to attach nodes in a single forward pass.

### Message protocol

Defined in `src/shared/types.ts`:

| Name | Direction | Purpose |
|---|---|---|
| `LTO_PING` | background → content | Readiness probe (fixed 100 ms polling, 5 s budget) |
| `LTO_CAPTURE_REQUEST` | background → content | Capture DOM/form/scroll into `SerializedTabState` |
| `LTO_RESTORE_PUSH` | background → content | Deliver decompressed state for hydration |
| `LTO_OFFSCREEN_PING` | background → offscreen | Verify compression host is alive |
| `LTO_OFFSCREEN_COMPRESS` | background → offscreen | Compress base64 payload |
| `LTO_OFFSCREEN_DECOMPRESS` | background → offscreen | Decompress base64 payload |

Popup-facing messages: `LTO_FREEZE_TAB`, `LTO_RESTORE_TAB`,
`LTO_DELETE_SNAPSHOT`.

---

## 6. Freeze flow (what actually happens)

1. Popup sends `LTO_FREEZE_TAB`.
2. Background creates/verifies the offscreen document and initializes the zstd
   worker (`op: "status"` waits for `onRuntimeInitialized`).
3. Background pings the content script; if absent, injects the built path from
   `chrome.runtime.getManifest().content_scripts[0].js[0]` and polls.
4. Content script performs BFS over `document.documentElement`, skips
   whitespace text/comment nodes, records attributes and inline text, extracts
   form values, and returns `SerializedTabState`.
5. `stableStringify(state)` → UTF-8 → zstd (level 3) → compressed bytes.
6. `writeCompressedChunks()` deletes old chunks, stores 64 KiB slices under
   `tab-<id>/chunk-000000`, and writes a `meta` record.
7. `chrome.tabs.discard(tabId)` kills the renderer process. The tab ID/URL
   remain; the process is gone.

## 7. Restore flow

1. Popup **Restore** or `chrome.tabs.onActivated` on a discarded frozen tab.
2. Background reads chunks in order, joins, decompresses, parses state.
3. If the tab is discarded, reload it and wait for `status: "complete"` and a
   content-script ping.
4. `LTO_RESTORE_PUSH` delivers the state; content script calls
   `hydrateDOM(state, document.documentElement)`:
   - `<html>` root maps to the live `documentElement` (no nested `<html>`);
   - nodes are built and attached in batches of 100 with `requestIdleCallback`
     yielding between batches;
   - form values are reapplied by `#id` / `[name=...]` first, capture index last;
   - scroll position is restored.
5. The snapshot is deleted from IndexedDB so stale state cannot reappear.

---

## 8. Storage layout (IndexedDB: `lto-db` / `lto-chunks`)

| Key | Value |
|---|---|
| `tab-<id>/meta` | `TabMeta`: counts, URL, title, timestamp, scroll, raw/compressed bytes |
| `tab-<id>/chunk-000000` | `ArrayBuffer` slice of the compressed stream |

Only the compressed stream is chunked at 64 KiB. The uncompressed payload is
held in memory only during freeze/restore.

---

## 9. Testing

```sh
npm test                       # contract tests (Node test runner)
npx tsc --noEmit               # typecheck
```

Tests are source-contract checks plus real VM simulations of `offscreen.js`.
They verify constants, batching math, base64 round-trip, and the absence of
ML/probabilistic code. They do **not** replace a browser smoke test — always
load `dist/` and try Freeze/Restore manually after changes.

---

## 10. Memory / CPU / GPU measurement (external tool)

The extension does not collect metrics. Use `tools/memory-bench/bench.py`
(Python 3.10+ standard library) — see
[`tools/memory-bench/README.md`](../tools/memory-bench/README.md) for details.

```sh
# 1. baseline session
python3 tools/memory-bench/bench.py run --name baseline --fresh \
  --url-file tools/memory-bench/urls.txt \
  --out tools/memory-bench/results/baseline.json

# 2. session with the extension loaded from dist/
python3 tools/memory-bench/bench.py run --name extension --extension dist --fresh \
  --url-file tools/memory-bench/urls.txt \
  --out tools/memory-bench/results/extension.json

# 3. comparison report
python3 tools/memory-bench/bench.py compare \
  tools/memory-bench/results/baseline.json tools/memory-bench/results/extension.json \
  --out tools/memory-bench/results/comparison.md
```

The tool samples RSS/PSS from `/proc`, CPU from process tick deltas, and GPU
via `nvidia-smi` when available. Use the same URL file, fresh profiles, equal
settle time, and repeat 3–5 runs for the thesis numbers.

For whole-browser cgroup totals, `systemd-run --user --scope` plus
`systemd-cgtop --user` is also available.

---

## 11. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `ReferenceError: Worker is not defined` | Service worker tried to create a Worker — keep compression in the offscreen document |
| `SyntaxError: Unexpected end of JSON input` | Binary crossed `runtime.sendMessage` unencoded — use base64 helpers |
| `No tab with id: ...` | Stale tab ID — `findTab` uses `tabs.query`; reload the extension and retry |
| `content script not ready in tab ...` | Injection failed/timeout — check page type; `chrome://` pages cannot be injected |
| Empty/cleared form fields after restore | Key mismatch — restoration tries id/name before index; check `#id`/`name` attributes |
| `wasm` / CSP errors | `content_security_policy` must include `'wasm-unsafe-eval'`; rebuild manifest |
| `data:video/mp2t...` in bundle | Vite inlined a worker as a data URL — the literal worker pattern must stay in `public/` |

---

## 12. Contribution conventions

- Keep commits small and plain-language (e.g. "Fix binary data loss across
  extension messages").
- Update `PHASE.md` with verified state, known issues, and next steps whenever a
  phase changes.
- Do not commit `dist/`; it is a build artifact.
- Keep all logic deterministic; no randomness, sampling heuristics, or ML.
- Run typecheck, tests, and build before committing.
