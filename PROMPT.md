# Project Kickoff & Architecture Prompt: Lossless State Compression and Lazy Restoration Algorithm for Browser Tab Memory Optimization

You are an expert systems programming agent and computer science research assistant. We are building a deterministic, production-ready systems prototype for a bachelor's thesis focusing on browser memory optimization and runtime state management[cite: 1, 13]. 

**CRITICAL CONSTRAINT:** This project is a **strictly deterministic computer science systems engineering project**. There must be **NO Machine Learning, NO Artificial Intelligence, NO Deep Learning, NO Large Language Models (LLMs), and NO probabilistic heuristic models** of any kind. All state serialization, compression, and restoration logic must rely entirely on deterministic algorithms, data structures, and explicit programmatic rules.

---

## 1. Project Summary & Pipeline
A three-stage deterministic pipeline built as a Web Extension (Manifest V3) that targets a **90% reduction in memory footprint per frozen tab** and an **80% total reduction across 50 open tabs**[cite: 13]:
1. **Captures** an inactive tab's DOM tree (as a flat node descriptor array via injected content scripts), V8 JavaScript heap state, form inputs, and scroll offsets.
2. **Compresses** the serialized payload losslessly using a WebAssembly (Wasm) compilation of `zstd` running inside a dedicated background Web Worker via zero-copy `TransferableObjects`.
3. **Terminates** the heavy OS renderer process to reclaim memory (~50MB baseline per tab[cite: 9]), and **lazily restores** the tab on demand using chunked streaming and batched DOM hydration to prevent main-thread UI jank.

---

## 2. Technical Stack & Build Environment
* **Extension Runtime:** Web Extensions API (Manifest V3, Service Workers, Content Scripts, Offscreen Documents)
* **Core Language:** TypeScript / Modern JavaScript (ES2022+)
* **Build Tooling:** Vite with CRXJS plugin (or standard Webpack configuration for extension bundling)
* **Compression Engine:** `zstd` compiled to WebAssembly (Wasm) via Emscripten
* **Concurrency:** Web Workers (`TransferableObjects`, `SharedArrayBuffer`)
* **Storage Layer:** IndexedDB (via `idb-keyval` or native IndexedDB wrapper for binary chunks)

---

## 3. Core Modules & Architecture Specifications

### A. State Capture Module (`content.ts` & `background.ts`)
* Must inject a content script via `chrome.scripting.executeScript` when an inactivity threshold is reached.
* Programmatically traverses the DOM in a Breadth-First Search (BFS) pattern into a flat array of `FlatNodeDescriptor` objects.
* Captures and serializes current values of `<input>`, `<textarea>`, and `<select>` elements, alongside window scroll offsets (`window.scrollX`, `window.scrollY`).
* *Edge Case Handling:* Must serialize attributes, text nodes, and gracefully handle nested element structures (excluding live network sockets or active `setInterval` closures).

### B. Lossless Compression Stage (`worker.ts`)
* Receives raw JSON/binary payload from the content script.
* Sends payload via zero-copy `postMessage` to the Wasm `zstd` worker.
* Compresses data blocks into a deterministic byte array and writes them to IndexedDB, keyed by `tabId`.
* Triggers process termination (closing/discarding the tab reference or freeing renderer resources).

### C. Lazy Restoration Module (`restoration.ts`)
* **Chunked Stream Deserialization:** Reads compressed binary chunks from IndexedDB in fixed 64KB increments.
* **Batched DOM Hydration (`requestIdleCallback`):** Reconstructs nodes in strict deterministic batches of max **100 elements per execution frame** to guarantee zero long tasks (>50ms) on the main thread.
* **Proxy-Based Heap Reinitialization:** Implements an ES6 `Proxy` wrapper with custom `get` traps to lazily unmarshal state slices on-demand.

---

## 4. Data Model Schema (TypeScript Interfaces)
```typescript
interface SerializedTabState {
    tabId: number;
    url: string;
    title: string;
    timestamp: number;
    scrollPosition: { x: number; y: number };
    domTree: FlatNodeDescriptor[];
    formInputs: Record<string, string | boolean | string[]>;
    heapSnapshotRef: string; // IndexedDB chunk key
}

interface FlatNodeDescriptor {
    id: number;
    parentId: number;
    tagName: string;
    attributes: Record<string, string>;
    textContent?: string;
}
