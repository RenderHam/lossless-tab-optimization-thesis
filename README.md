# lossless-tab-optimization

A deterministic systems engineering web extension prototype developed as an undergraduate thesis at the College of Computing and Information Sciences, University of Antique.

## Abstract & Overview

Modern web browsers operate as heavy execution runtimes. With desktop web page payloads averaging over 2.6 megabytes[cite: 9] and process-isolation architectures assigning an independent operating system process to every domain (consuming a baseline of ~50 MB per empty tab)[cite: 9], multi-tab browsing causes severe resource contention and memory bloat.

Native memory-saving features (such as Chrome Memory Saver or Firefox Tab Unloading) mitigate this by destroying the user's active session state—wiping the DOM, JavaScript heap, and unsubmitted form data[cite: 11]. This project introduces a deterministic **three-stage pipeline** that achieves a **90% reduction in memory footprint per frozen tab** and an **80% total reduction across 50 open tabs**[cite: 13] while maintaining absolute **lossless state preservation**[cite: 13].

---

## Core Architecture: The Three-Stage Pipeline

1. **State Capture Module:** Programmatically traverses the DOM in a Breadth-First Search (BFS) pattern into a flat node descriptor array, captures unsubmitted form inputs (`<input>`, `<textarea>`, `<select>`), and records exact window scroll coordinates.
2. **Lossless Compression Stage:** Offloads serialized raw bytes via zero-copy `TransferableObjects` to a background Web Worker running a deterministic WebAssembly (Wasm) compilation of `zstd`, storing compressed binary chunks in IndexedDB.
3. **Lazy Restoration Module:** Recalls frozen tabs on demand via chunked stream deserialization. On a reloaded page with an existing DOM it overlays saved form values and scroll (avoiding duplicated UI on framework-heavy sites); for an empty page it uses batched `requestIdleCallback` DOM hydration (max 100 elements per execution frame) to eliminate main-thread UI jank, paired with ES6 `Proxy` objects for deferred heap reinitialization.

---

## Tech Stack

- **Extension Runtime:** Web Extensions API (Manifest V3, Service Workers, Content Scripts)
- **Core Language:** TypeScript / Modern JavaScript (ES2022+)
- **Build Tooling:** Vite with CRXJS plugin
- **Compression Engine:** `zstd` compiled to WebAssembly (Wasm) via Emscripten
- **Concurrency:** Web Workers (`TransferableObjects`)
- **Storage Layer:** IndexedDB (for binary chunk caching)

---

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full setup, build,
loading, debugging, testing, and troubleshooting guide. For how the pipeline
works internally — capture, compression, teardown, restore — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install Bun (one time)

Bun is the only runtime this project needs — no Node.js, npm or Python.

```sh
# macOS / Linux
curl -fsSL https://bun.com/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1|iex"
```

Verify with `bun --version`. You can also start every task through the OS
launchers, which will install Bun for you after asking confirmation:
`./scripts/bootstrap.sh ...` (Linux/macOS) or
`.\scripts\bootstrap.ps1 ...` / `bootstrap.cmd` (Windows).

Quick start:

```sh
bun install       # dependencies (once)
bun run build     # typecheck + Vite build → dist/
bun test          # contract + platform tests
bun run doctor    # check Bun, Chrome/Edge and disk
```

Load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.
Rebuild and click Reload after every source change.

## Verification (T01–T10)

The thesis claims are checked by an automated, fully recorded suite in
[`tools/thesis-verify/`](tools/thesis-verify/README.md). It drives a real
Chrome over CDP and writes one JSON record per test plus an aggregated
`report.md` under `results/verification/<run-id>/` — failures are recorded
too, nothing is deleted. Cross-run index: [`results/verification/SUMMARY.md`](results/verification/SUMMARY.md).

```sh
bun run build     # the suite tests dist/
bun run verify    # full recorded T01–T10 (needs Chrome/Edge installed)
bun run summary   # regenerate the cross-run index
```

The same commands work on Linux and Windows. Linux measures PSS from
`/proc/smaps_rollup`; Windows measures Working Set (RSS) via PowerShell/CIM.
Every run records which metric it used, and the two are not directly
comparable. No `smem`, `zstd` CLI, Python or venv is needed.

```sh
bun test          # extension contracts + platform unit tests
bun run typecheck # extension and tooling
```

Headline results (Linux PSS run; see SUMMARY.md for runs and thresholds):
freeze success 50/50, byte-exact restore, **80.49 % aggregate memory saving
across 50 tabs** (claim: 80 %), 100 % of a frozen tab's renderer PSS reclaimed
(claim: 90 % per tab; the tree-level figure, which includes Chrome's fixed
~500 MiB baseline, is recorded as a conservative secondary metric), idle
overhead ratio 0.99, freeze p95 18 ms / restore p95 152 ms, identical capture
bytes across repeated freezes, and no memory slope over 20 cycles.

## Project Structure

```text
manifest.json / vite.config.ts / tsconfig.json
src/
  shared/        types, codec (stable stringify, base64 helpers, chunking)
  content/       BFS DOM capture, form/scroll extraction, message handlers
  background/    freeze/restore orchestration and auto-restore
  workers/       compression.bridge.ts (offscreen client)
  restoration/   batched hydration, form restore, lazy Proxy heap
  storage/       IndexedDB chunk store (idb-keyval)
  ui/            popup dashboard
public/
  offscreen.html / offscreen.js   hidden host for the zstd worker
  compression-worker.js           classic Worker using vendored zstd
  zstd/                           vendored Emscripten glue + wasm
tests/           contract and messaging tests
scripts/         OS launchers + shared Bun task runner
tools/
  thesis-verify/ recorded verification suite (T01–T10, Linux + Windows, Bun)
PHASE.md         continuity log (verified state, known issues, next steps)
```

## Memory / CPU Measurement

Memory measurement is part of the Bun verification harness. **T07** runs two
identical browsing sessions (plain Chrome vs. Chrome with the unpacked
extension), samples the Chrome process tree, and records the baseline/extension
ratio as `T07-baseline.json` / `T07-extension.json` inside each run directory.

```sh
bun run verify -- --tests T07
```

Linux uses PSS from `/proc/<pid>/smaps_rollup`; Windows uses Working Set (RSS)
via PowerShell/CIM because Windows has no PSS. For whole-browser cgroup totals
on Linux you can still use `systemd-run --user --scope` with `systemd-cgtop`.
The extension itself does not collect metrics.

## 14-Week Development Roadmap

- Weeks 1–3 (State Capture Engine): Content script injection, BFS DOM flat serialization, and form input extraction.
- Weeks 4–6 (Lossless Compression Stage): Wasm zstd bindings, Web Worker bridge setup, and IndexedDB caching.
- Weeks 7–10 (Lazy Restoration Module): Chunked stream decoder, viewport filter, and batched requestIdleCallback DOM hydration.
- Weeks 11–12 (Heap Proxy & Integration): ES6 Proxy lazy state evaluation layer and process teardown hooks.
- Weeks 13–14 (Profiling, Benchmarking & Writing): Automated performance logging (RSS delta, main-thread blocking duration, and state fidelity checks).
