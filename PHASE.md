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
| `scripts/` | OS launchers (`.sh`, `.ps1`, `.cmd`) + shared Bun task runner `cli.ts` |
| `tools/thesis-verify/verify.ts` | Bun/TypeScript recorded verification harness: T01–T10, thresholds, JSON + `report.md` per run |
| `tools/thesis-verify/platform_support.ts` | Cross-platform layer: Chrome discovery, RAM, process-tree kill, memory sampling, T09 decompress message (Linux + Windows) |
| `tools/thesis-verify/cdp.ts` | Minimal CDP client + `Extensions.loadUnpacked` (Chrome 160 blocks `--load-extension`) |
| `tools/thesis-verify/fixtures/` | Deterministic test pages served via `Bun.serve` on `127.0.0.1:8123` |
| `tools/thesis-verify/tests/` | Bun unit tests for the platform layer (no browser) |
| `.github/workflows/verify.yml` | CI matrix: Bun tests, typecheck + build on Ubuntu and Windows |

## Verified State (verification suite complete)

- `bun run typecheck` → clean (extension and tooling)
- `bun run build` → succeeds, output in `dist/`
- `bun test` → 34/34 pass (22 extension contracts + 12 platform-layer tests)
  covering both Linux and Windows code paths with fakes, no browser
- Vendored zstd wasm round-trip verified in a Node VM harness:
  14,500 B → 47 B compressed → byte-exact restoration
- Browser smoke test: the first run exposed `Worker is not defined` in the MV3
  service worker; fixed by moving the worker into an offscreen document.
  Binary data loss across Chrome's JSON-serialized messaging was fixed with
  base64 encoding. Auto-restore on tab activation and form-key fallback added.
- The in-extension benchmark feature was removed at the owner's request;
  memory measurement now lives in the Bun harness (`/proc/smaps_rollup` on
  Linux, PowerShell/CIM Working Set on Windows).
- **Automated verification suite T01–T10 is built, run, and recorded** under
  `tools/thesis-verify/` (see its README for the matrix and thresholds).
  Every run — pass or fail — is stored as JSON + `report.md` in
  `results/verification/<run-id>/`; index in `results/verification/SUMMARY.md`.
  Final results: T01–T10 all PASS, including the two thesis claims:
  T05 per-tab (100 % of the tab's renderer PSS reclaimed) and T06 aggregate
  **80.49 % across 50 tabs** (claim: 80 %). The Bun/TypeScript port reproduced
  this in run `20261127223949` (T06 80.51 %) with T07 rerun in
  `20261127224909`; all ten latest records are PASS.
- Chrome 160 blocks `--load-extension`; the harness loads the extension via
  CDP `Extensions.loadUnpacked` with `--enable-unsafe-extension-debugging`.
- **The whole development/tooling chain now uses Bun only.** No Node.js, npm,
  Python, venv, `smem` or `zstd` CLI is needed. `scripts/bootstrap.sh` /
  `.ps1` / `.cmd` install Bun only after confirmation, then delegate to
  `scripts/cli.ts`. CI uses `oven-sh/setup-bun@v2` on Ubuntu and Windows.
- **Windows support is implemented and unit-tested, but not yet run on a
  Windows machine.** OS behaviour lives in `platform_support.ts`: Chrome
  discovery (`Program Files`/`App Paths`), RAM and Working Set via
  PowerShell/CIM, process-tree kill via `taskkill /T /F`, and T09 through the
  extension's own zstd worker. Linux records PSS, Windows records Working Set
  (RSS) — not comparable.
- **Run history (nothing deleted):** the 2026-11-25 full run
  `20261125-142656` passed T01–T07, then Chrome was lost before T08–T10 when
  the machine was low on disk and memory (T07's extension session dropped to
  four processes). The affected tests were rerun on a clean system in
  `20261125-143951`: T07–T10 all PASS, including T09 through the extension's
  own decompression worker. `20261125-142323` is an aborted run (server
  restart) with a recorded T01 error. All three runs are kept;
  `results/verification/SUMMARY.md` reports the latest record per test.
- Owner will provide manual-intervention test results separately; those are
  recorded into the same `results/verification/` layout when received.

## How To Verify

```sh
# one time: curl -fsSL https://bun.com/install | bash   (Windows: see README)
bun install            # dependencies
bun test               # 34 tests: contracts + platform layer
bun run typecheck      # extension and tooling
bun run build          # extension bundle → dist/

# full recorded verification suite (T01..T10), ~30–45 min
bun run verify
```

The same commands work in PowerShell. The OS launchers
`./scripts/bootstrap.sh` / `.\scripts\bootstrap.ps1` do the Bun install
(after asking) and then run the same CLI. The suite writes
`results/verification/<run-id>/` (JSON per test + `report.md`). See
`tools/thesis-verify/README.md` for the matrix, thresholds, and metric
definitions. Load `dist/` via `chrome://extensions` → Developer mode → Load
unpacked for manual checks.

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

1. Record the owner's manual-intervention test results into
   `results/verification/` (same JSON + report layout as the automated runs).
2. Run the full T01–T10 suite on a Windows machine and record it — the Windows
   paths are unit-tested but have not executed against a real browser yet.
   Expect `env.json` to say `"os": "Windows"` and
   `"memory_metric": "Working Set (RSS)"`; do not compare those numbers with
   the Linux PSS runs.
3. Replace the placeholder extension icons (`src/ui/icons/`) before defense.
4. Write the thesis numbers from `results/verification/SUMMARY.md`
   (T05 per-tab, T06 80.49 %/50 tabs, T07 overhead, T08 latencies,
   T10 leak slope), including the honest light-page boundary
   (run `20261125-072419`, 47.01 %) as a limitations note.
