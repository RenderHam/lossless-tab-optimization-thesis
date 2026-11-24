# lossless-tab-optimization

A deterministic systems engineering web extension prototype developed as an undergraduate thesis at the College of Computing and Information Sciences, University of Antique.

## Abstract & Overview

Modern web browsers operate as heavy execution runtimes. With desktop web page payloads averaging over 2.6 megabytes[cite: 9] and process-isolation architectures assigning an independent operating system process to every domain (consuming a baseline of ~50 MB per empty tab)[cite: 9], multi-tab browsing causes severe resource contention and memory bloat.

Native memory-saving features (such as Chrome Memory Saver or Firefox Tab Unloading) mitigate this by destroying the user's active session state—wiping the DOM, JavaScript heap, and unsubmitted form data[cite: 11]. This project introduces a deterministic **three-stage pipeline** that achieves a **90% reduction in memory footprint per frozen tab** and an **80% total reduction across 50 open tabs**[cite: 13] while maintaining absolute **lossless state preservation**[cite: 13].

---

## Core Architecture: The Three-Stage Pipeline

1. **State Capture Module:** Programmatically traverses the DOM in a Breadth-First Search (BFS) pattern into a flat node descriptor array, captures unsubmitted form inputs (`<input>`, `<textarea>`, `<select>`), and records exact window scroll coordinates.
2. **Lossless Compression Stage:** Offloads serialized raw bytes via zero-copy `TransferableObjects` to a background Web Worker running a deterministic WebAssembly (Wasm) compilation of `zstd`, storing compressed binary chunks in IndexedDB.
3. **Lazy Restoration Module:** Recalls frozen tabs on demand via chunked stream deserialization and batched `requestIdleCallback` DOM hydration (max 100 elements per execution frame) to eliminate main-thread UI jank, paired with ES6 `Proxy` objects for deferred heap reinitialization.

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
loading, debugging, testing, and troubleshooting guide.

Quick start:

```sh
npm install
npm run build     # typecheck + Vite build → dist/
npm test          # contract tests
```

Load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.
Rebuild and click Reload after every source change.

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
PHASE.md         continuity log (verified state, known issues, next steps)
```

## Memory Measurement

Memory footprint is measured externally with Linux tools such as `smem`
(PSS/RSS per Chrome process) and cgroups v2 via `systemd-run --user --scope`
(whole-browser total). The extension itself does not collect memory metrics.

## 14-Week Development Roadmap

- Weeks 1–3 (State Capture Engine): Content script injection, BFS DOM flat serialization, and form input extraction.
- Weeks 4–6 (Lossless Compression Stage): Wasm zstd bindings, Web Worker bridge setup, and IndexedDB caching.
- Weeks 7–10 (Lazy Restoration Module): Chunked stream decoder, viewport filter, and batched requestIdleCallback DOM hydration.
- Weeks 11–12 (Heap Proxy & Integration): ES6 Proxy lazy state evaluation layer and process teardown hooks.
- Weeks 13–14 (Profiling, Benchmarking & Writing): Automated performance logging (RSS delta, main-thread blocking duration, and state fidelity checks).
