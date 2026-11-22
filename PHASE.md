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
- `node --test tests/*.test.mjs` → 25/25 pass
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
node --test tests/*.mjs        # contract + benchmark tests
node benchmarks/run.mjs        # micro-benchmark
node benchmarks/report.mjs results.json   # summarize exported run
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

## AUTOMATED BENCHMARK (implemented)

Files: `src/profiling/memory.ts`, `src/profiling/benchmark.ts`,
`benchmarks/lib.mjs`, `benchmarks/report.mjs`, `tests/benchmark.test.mjs`.

- Popup → **Benchmark all tabs**: samples each eligible tab's renderer RSS
  (`chrome.processes.getProcessIdForTab` + `getProcessInfo(pid, true)`,
  `privateMemory`), freezes, samples again, restores, samples again.
- Records exact byte counts, phase timings, hydration stats, and byte-exact
  fidelity (`stableStringify` of original state vs reconstructed state).
- Results saved to `chrome.storage.local["lto-bench-latest"]`; popup shows a
  summary and **Download JSON** exports the full run.
- `node benchmarks/report.mjs <results.json>` prints a per-tab table and fails
  if fidelity drops or any hydration batch exceeds 50 ms.
- `chrome.processes` is a Chrome **Dev-channel** API: if unavailable, runs
  still record compression/fidelity/timings and flag `memoryApiAvailable: false`;
  use Chrome Task Manager manually for RSS in that case.

## NEXT STEPS

1. Load `dist/` unpacked (manifest changed — full reload required).
2. Smoke test Freeze → Restore once.
3. Open ~50 real http(s) tabs, click **Benchmark all tabs**, download JSON,
   run `benchmarks/report.mjs`, and put the numbers in the thesis (Weeks 13–14).
4. Commit benchmark results under `results/` once verified.

Memory-phase code is implemented; the actual measurement still needs a real
Chrome run.
