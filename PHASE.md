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
- Compression: `@bokuweb/zstd-wasm` (Emscripten zstd), fixed level 3
- Concurrency: dedicated Worker + zero-copy `TransferableObjects`
- Storage: IndexedDB via `idb-keyval`
- Key constants: 64 KiB chunks (`CHUNK_SIZE_BYTES`), 100 nodes/frame
  (`HYDRATION_BATCH_SIZE`), 50 ms long-task budget

## File Map

| Path | Role |
|---|---|
| `src/shared/types.ts` | `SerializedTabState`, `FlatNodeDescriptor`, constants, key helpers |
| `src/shared/codec.ts` | `stableStringify`, UTF-8 encode/decode, chunk/join |
| `src/content/content.ts` | BFS DOM capture, form extraction, message bridge |
| `src/workers/compression.worker.ts` | zstd engine worker (`compress`/`decompress`/`status`) |
| `src/workers/compression.bridge.ts` | Background-side worker bridge (zero-copy) |
| `src/storage/indexeddb.ts` | Chunked snapshot store (`tab-<id>/meta`, `tab-<id>/chunk-<n>`) |
| `src/background/background.ts` | Orchestrator: freeze, discard, restore, idle sweep (15-min rule) |
| `src/restoration/restoration.ts` | Batched hydration + `Proxy` lazy heap |
| `src/profiling/metrics.ts` | Freeze/restore metric types, ratio, fidelity helpers |
| `src/ui/popup.*` | Dashboard: manual freeze/restore per tab |
| `tests/contracts.test.mjs` | 11 deterministic contract tests (plain node) |
| `benchmarks/run.mjs` | Micro-benchmark: stringify/chunk/batch arithmetic |

## Verified State (post-restore-wiring, working tree uncommitted)

- `npx tsc --noEmit` → clean
- `npx vite build` → succeeds, output in `dist/`
- `node --test tests/*.test.mjs` → 15/15 pass
- `node benchmarks/run.mjs` → 5000 nodes: 557 KB JSON, 9 chunks, 50 batches
- Vendored zstd wasm round-trip verified in a Node VM harness:
  14,500 B → 47 B compressed → byte-exact restoration
- Browser smoke test started: first run failed with
  `ReferenceError: Worker is not defined` — MV3 service workers cannot create
  dedicated Workers. Fixed by moving the zstd worker into an offscreen
  document (`public/offscreen.html` + `public/offscreen.js`); the service
  worker now sends `LTO_OFFSCREEN_*` messages to it. Rebuild done, awaiting
  user retest.

## How To Verify

```sh
npm install            # once per machine
npx tsc --noEmit       # typecheck
node --test tests/*.test.mjs   # contract tests
node benchmarks/run.mjs        # micro-benchmark
npx vite build         # extension bundle → dist/
```

Load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.

## Known Notes

- Imports are extensionless (`../shared/types`, not `../shared/types.ts`).
- `compression.bridge.ts` casts `SharedArrayBuffer` → `ArrayBuffer` on slice.
- MV3 service worker has no `Worker` constructor: compression MUST run in
  the offscreen document. Bridge relays via `chrome.runtime.sendMessage`;
  only the offscreen→worker hop is zero-copy (extension messaging copies).
- `@bokuweb/zstd-wasm` npm web entry is broken (points to nonexistent
  `dist/web/lib/index.js`); the working Emscripten glue + wasm are vendored in
  `public/zstd/`, driven by the classic worker `public/compression-worker.js`.
  MV3 CSP needs `'wasm-unsafe-eval'` (now in `manifest.json`).
- Restore is now wired end to end: background reloads discarded tab → waits for
  content script → `LTO_RESTORE_PUSH` → `hydrateDOM(state, document.documentElement)`
  in 100-node idle batches. `<html>` root maps to live documentElement.
- Message constants live in `src/shared/types.ts` (background must not import
  `content.ts`, which has top-level listener side effects).
- Icons are generated placeholder PNGs (`src/ui/icons/`), replace before defense.
- `PROMPT.md` citation cleanup was committed together with the skeleton.

## NEXT PHASE (planned, NOT started — wait for owner's go-ahead)

**Immediate next step (before the memory phase):** load `dist/` unpacked in
Chrome and smoke test Freeze → Restore end to end; confirm zstd worker loads
under MV3 CSP and that form/scroll state survives. Then the memory phase:

**Memory Measurement Phase:** real-world RSS/footprint validation of the
90%-per-tab / 80%-across-50-tabs thesis targets.

1. Instrument `freezeTab`/`restoreTab` with `performance.now()` timings +
   `chrome.processes`/`chrome.system.memory` readings where permitted.
2. Build a reproducible 50-tab fixture set and record before/after memory.
3. Extend `tests/` + `benchmarks/` with fidelity checks (byte-exact
   stable-stringify comparison of pre-freeze vs post-restore state).
4. Log results to a `results/` directory for the thesis write-up (Weeks 13–14).

Do not implement any of the above until explicitly instructed.
