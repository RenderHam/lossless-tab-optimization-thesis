# PHASE.md — Project Memory & Continuity Log

> Read this file at the start of every session. It records where the build
> stands, how to verify it, and what comes next. Update it whenever a phase
> completes. **Do not start the next phase until the owner says so.**

## Project

Deterministic lossless tab freeze/restore Web Extension (Manifest V3),
undergraduate thesis prototype. **Strictly no ML/AI/heuristics** — pure
deterministic algorithms only.

Pipeline: **Capture → Compress → Terminate → Lazy Restore.**

## Stack

- TypeScript ES2022, Vite + CRXJS, `chrome.*` MV3 APIs
- Compression: vendored Emscripten zstd glue + wasm, fixed level 3
- Concurrency: classic Worker in an offscreen document + zero-copy
  `TransferableObjects`
- Storage: IndexedDB via `idb-keyval`
- Key constants: 64 KiB chunks (`CHUNK_SIZE_BYTES`), 100 nodes/frame
  (`HYDRATION_BATCH_SIZE`), 50 ms long-task budget

## File Map

| Path | Role |
|---|---|
| `src/shared/types.ts` | `SerializedTabState`, `FlatNodeDescriptor`, constants, key/message helpers |
| `src/shared/codec.ts` | `stableStringify`, UTF-8, base64 bridge helpers, chunk/join |
| `src/content/content.ts` | BFS DOM capture, form extraction, message bridge |
| `src/workers/compression.bridge.ts` | Background-side offscreen client |
| `public/offscreen.html`, `public/offscreen.js` | Hidden host for the zstd worker |
| `public/compression-worker.js` | Classic Worker running zstd `cwrap` calls |
| `public/zstd/` | Vendored Emscripten glue + wasm |
| `src/storage/indexeddb.ts` | Chunked snapshot store (`tab-<id>/meta`, `tab-<id>/chunk-<n>`) |
| `src/background/background.ts` | Orchestrator: freeze, discard, restore, auto-restore, idle sweep |
| `src/restoration/restoration.ts` | Batched hydration, form restore, lazy `Proxy` heap |
| `src/ui/popup.*` | Dashboard: manual freeze/restore per tab |
| `tests/contracts.test.mjs` | Determinism/batching/protocol contracts |
| `tests/messaging.test.mjs` | Base64 bridge round-trip through offscreen.js |
| `tools/memory-bench/bench.py` | External CPU/memory comparison tool (Linux smem/proc, Windows PowerShell; GPU Linux-only) |

## Verified State (after benchmark removal)

- `npx tsc --noEmit` → clean
- `npx vite build` → succeeds, output in `dist/`
- `node --test tests/*.mjs` → 18/18 pass
- Vendored zstd wasm round-trip verified in a Node VM harness:
  14,500 B → 47 B compressed → byte-exact restoration
- Browser smoke test: the first run exposed `Worker is not defined` in the MV3
  service worker; fixed by moving the worker into an offscreen document.
  Binary data loss across Chrome's JSON-serialized messaging was fixed with
  base64 encoding. Auto-restore on tab activation and form-key fallback added.
- The in-extension benchmark feature was removed at the owner's request;
  memory measurement is now done externally (`smem`, cgroups v2).

## How To Verify

```sh
npm install            # once per machine
npx tsc --noEmit       # typecheck
node --test tests/*.mjs        # contract + messaging tests
npx vite build         # extension bundle → dist/
```

Load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.

## Known Notes

- Imports are extensionless (`../shared/types`, not `../shared/types.ts`).
- MV3 service worker has no `Worker` constructor: compression MUST run in
  the offscreen document. Bridge relays via `chrome.runtime.sendMessage`.
- **Chrome extension messaging is JSON-serialized, not structured clone.**
  Uint8Array payloads arrive as plain objects, so all binary crossing
  `runtime.sendMessage` is base64-encoded (`bytesToBase64`/`base64ToBytes`).
  Only the offscreen→worker hop is zero-copy. Symptom of getting this wrong:
  compression stores an empty payload and restore fails with a JSON parse error.
- `@bokuweb/zstd-wasm` npm web entry is broken (points to nonexistent
  `dist/web/lib/index.js`); the working glue + wasm are vendored in
  `public/zstd/`, driven by the classic worker `public/compression-worker.js`.
  MV3 CSP needs `'wasm-unsafe-eval'` (in `manifest.json`).
- Restore is wired end to end: background reloads discarded tab → waits for
  content script → `LTO_RESTORE_PUSH`. If the reloaded page already has a DOM,
  restore uses **overlay mode** (form values + scroll only) because rebuilding
  `documentElement` duplicates UI on framework-heavy sites (YouTube). Full
  batched `hydrateDOM` is used only when the page is empty.
- Message constants live in `src/shared/types.ts` (background must not import
  `content.ts`, which has top-level listener side effects).
- Reopening a discarded tab (`chrome.tabs.onActivated`) auto-restores its
  snapshot; after a successful restore the snapshot is deleted so stale state
  is never resurrected.
- Form restoration matches by BFS node id (`data-lto-id`) first, then `#id` /
  `[name=...]` / capture index. Values are re-applied a second time on the next
  idle frame so page scripts cannot wipe the user's last input.
- Tab lookups use `chrome.tabs.query({})` via `findTab`, with labelled errors.
- Restore falls back to the most recent snapshot with the same URL when Chrome
  assigns a new tab id after discard; otherwise reports "no snapshot ... freeze it first".
- Icons are generated placeholder PNGs (`src/ui/icons/`), replace before defense.
- `PROMPT.md` citation cleanup was committed together with the skeleton.

## NEXT STEPS

1. Load `dist/` unpacked (reload fully after a `manifest.json` change).
2. Smoke test Freeze → Restore once, including form data and scroll position.
3. Measure with `tools/memory-bench/bench.py` (baseline vs. `--extension dist`)
   and compare with its `compare` command.
4. Use fixed URL fixtures, fresh profiles, repeated trials, and put the
   resulting numbers in the thesis (Weeks 13–14).
