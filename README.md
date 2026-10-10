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

## Project Structure

```text
lossless-tab-optimization/
├── manifest.json            # Extension configuration (Manifest V3)
├── package.json             # Dependencies and build scripts
├── tsconfig.json            # TypeScript compiler options
├── vite.config.ts           # Vite build configuration
src/
├── background/
│   └── background.ts        # Service worker orchestrating tab lifecycle & injection
├── content/
│   └── content.ts           # BFS DOM traversal and form state extractor
├── workers/
│   └── compression.worker.ts # Wasm zstd compression/decompression bridge
├── storage/
│   └── indexeddb.ts         # Binary chunk manager for tab payloads
└── ui/
    ├── popup.html           # Extension dashboard UI
    └── popup.ts             # Real-time metrics and manual tab controls

```

## 14-Week Development Roadmap

- Weeks 1–3 (State Capture Engine): Content script injection, BFS DOM flat serialization, and form input extraction.
- Weeks 4–6 (Lossless Compression Stage): Wasm zstd bindings, Web Worker bridge setup, and IndexedDB caching.
- Weeks 7–10 (Lazy Restoration Module): Chunked stream decoder, viewport filter, and batched requestIdleCallback DOM hydration.
- Weeks 11–12 (Heap Proxy & Integration): ES6 Proxy lazy state evaluation layer and process teardown hooks.
- Weeks 13–14 (Profiling, Benchmarking & Writing): Automated performance logging (RSS delta, main-thread blocking duration, and state fidelity checks).
