# Architecture

How the Lossless Tab Optimization extension works, end to end — the process,
the memory model, and every source file explained.

> **Governing rule:** strictly deterministic. No ML, no AI, no heuristics, no
> randomness. Every threshold is a named constant, every traversal order is
> fixed, and serialization sorts keys so semantically identical states produce
> byte-identical output.

## The pipeline

```
CAPTURE  →  COMPRESS  →  TERMINATE        (freeze)
                                ... time passes, memory is free ...
        RECALL  →  DECOMPRESS  →  RESTORE  (lazy restore)
```

| Stage | Runs in | Why there |
|---|---|---|
| DOM capture | Content script (page's isolated world) | only place that can read the live DOM |
| Serialize + compress | Offscreen document → classic Worker (zstd wasm) | MV3 service workers have no `Worker` constructor |
| Store | IndexedDB (`lto-db` / `lto-chunks` in the Chrome profile) | survives restarts, binary-safe |
| Kill process | Chrome itself (`chrome.tabs.discard`) | only Chrome can tear down a renderer |
| Restore | background → content script | reverse path |

## When a freeze happens

Two triggers, both in `src/background/background.ts`:

1. **Manual** — "Freeze" in the popup (`src/ui/popup.ts`) sends
   `LTO_FREEZE_TAB` to the background.
2. **Automatic** — an inactivity sweep (`sweepInactiveTabs`) fired by:
   - `chrome.idle` state change to `idle`/`locked`, and
   - a fallback `chrome.alarms` tick every 5 minutes (`CHECK_PERIOD_MIN`).

A tab is eligible only if it is **not active, not pinned, not audible, not
already discarded**, not a `chrome://` page, and its `lastAccessed` is
≥ **15 minutes** old (`INACTIVITY_THRESHOLD_MIN = 15`). All explicit
constants — no prediction.

### Freeze step by step (`freezeTab`)

```
1. ensureBridge()            → create the offscreen document if missing
2. captureTab(tabId)         → ping content script (100 ms poll, 5 s budget);
                               inject via chrome.scripting if missing;
                               send LTO_CAPTURE_REQUEST
3.   content script runs captureDOMTree() + captureFormInputs()
     → SerializedTabState { url, title, scrollPosition, domTree[],
                            formInputs{}, formInputNodeIds{}, ... }
4. stableStringify(state)    → JSON with recursively sorted keys
5. encodeUtf8(json)          → Uint8Array
6. bridge.compress(raw)      → base64 → runtime.sendMessage → offscreen →
                               zero-copy postMessage → Worker → zstd level 3
7. writeCompressedChunks()   → sliced into 64 KiB chunks → IndexedDB
8. chrome.tabs.discard(tabId)→ Chrome KILLS the renderer process
                               (tab remains as a "discarded" stub)
9. record tab id in chrome.storage.local["lto-frozen"]
```

Measured cost: **~18 ms** freeze p95 (T08).

### Restore step by step (`restoreTab`)

Triggered by `chrome.tabs.onActivated` (you click the tab) via
`autoRestoreOnActivation`, or the popup's Restore button:

```
1. Find the snapshot: readMeta(tabId). Chrome replaces the tab id during
   discard (verified: 469897108 → 469897111), so on a direct miss fall
   back to the newest snapshot with the same URL.
2. readAllChunks()           → reassemble 64 KiB chunks in index order
3. bridge.decompress(data)   → same base64/offscreen/worker path, reversed
4. JSON.parse → SerializedTabState
5. tab.discarded? → chrome.tabs.reload(tabId)
   ALWAYS waitForTabComplete (10 s budget) — Chrome flips `discarded`
   to false before this handler runs, so that flag is never trusted
6. waitForContentScript      → 100 ms ping until the content script answers
7. send LTO_RESTORE_PUSH with the state
8. content script picks the mode:
   • body already has children (normal — reload rebuilt the page)
       → overlayRestore(): forms + scroll only
   • body empty              → hydrateDOM(): rebuild the DOM,
                               100 nodes per idle frame
9. deleteTabSnapshot()       → consumed; stale state never resurrected
```

Measured cost: **~152 ms** restore p95 (T08).

## Memory model: regular browsing vs the extension

Without the extension, Chrome gives every site its own renderer process, and
an idle background tab keeps costing memory forever:

```
Regular browsing, 50 open tabs (measured on the test machine):
  tree PSS ≈ 2,700 MiB
    50 renderers × ~45 MiB private each
    + fixed Chrome baseline ≈ 500 MiB
      (browser, GPU, network service, extension)
  All resident as long as the tabs are open.

With the extension (T06, run 20261125-081732):
  before: 2,583 MiB
  after:    504 MiB   →  80.49 % saved
  every frozen tab's renderer fully exited
  (50/50 pids gone, 100 % of their PSS reclaimed)
```

A frozen tab costs ~0 MiB; a live idle tab costs ~45 MiB until closed. The
~500 MiB baseline never shrinks, which caps any tree-level percentage —
that honest boundary (light pages → 47.01 %) is recorded in
`results/verification/20261125-072419/`.

| | Regular browsing | With the extension |
|---|---|---|
| Idle tab after 15 min | keeps ~45 MiB renderer alive | renderer killed, memory returned |
| Click a frozen tab | n/a | reload + state overlay in ~150 ms |
| Half-filled form | survives while tab lives | survives freeze → restore (T02) |
| Scroll position | survives | survives (±2 px verified) |
| In-page JS state (framework store, video time, canvas) | survives | **lost** — the page genuinely reloaded |
| Live connections (WebSocket, audio) | survive | **lost** — sweep skips audible tabs |
| Extension idle overhead | 0 | ratio 0.99–1.01 of baseline (T07) |

## Benefits

1. **Proven memory savings** — 80.49 % across 50 tabs (claim: 80 %),
   100 % of each frozen tab's process PSS reclaimed (claim: 90 % per tab);
   full evidence in `results/verification/SUMMARY.md`.
2. **Lossless where it matters** — HTML, forms, scroll byte-exact (T02),
   no duplicated UI (T04), auto-restore on click (T03).
3. **Invisible latency** — freeze 18 ms / restore 152 ms p95.
4. **Zero idle cost** — loaded but unused: ratio ~1.0 vs baseline (T07).
5. **Fully deterministic** — identical bytes across freezes (T09), no leak
   over 20 cycles (T10).
6. **No cloud, no telemetry** — everything stays in local IndexedDB.
7. **Explicit policy** — every rule is a named constant, easy to defend
   in the thesis.

## Limitations and honest trade-offs

1. **JavaScript heap state is lost.** Freeze = process death; restore
   reloads the page, so framework stores, video position, canvas drawings
   and other in-memory JS state do not come back. Forms and scroll do.
   This is the inherent price of killing the process — and what buys the
   memory.
2. **Needs the network.** Restore reloads the page; offline or a dead
   server means the reload fails (the snapshot itself is local, the page
   is not).
3. **Iframes are not captured** — `all_frames: false` in the manifest;
   only the main frame is serialized.
4. **Skipped tags are placeholders** — `SCRIPT`, `IFRAME`, `OBJECT`,
   `EMBED`, `CANVAS` are stored as an empty `data-lto-skipped="1"` marker
   (no live/unsafe content is serialized; no canvas pixels either).
5. **Text capped at 64 KiB per node** (`MAX_TEXT_PER_NODE`); longer text
   is truncated with an explicit flag. Whitespace-only text nodes and
   comments are dropped to shrink payloads — restoration is lossless below
   the cap; raw HTML equality is asserted after normalization (T02).
6. **Passwords stored in plaintext IndexedDB** — deliberately, for
   losslessness; local disk only, but a real security note.
7. **Stale snapshots possible** — closing a frozen tab manually (instead
   of restoring) leaves its snapshot behind; there is no age-based
   eviction by design ("caller decides teardown").
8. **Automatic freeze may surprise you** — 15 minutes away and the tabs
   are gone until clicked. Pinned/audible/active tabs are excluded.
9. **Chrome-only** — MV3 APIs (`tabs.discard`, `offscreen`, `idle`),
   Chrome 116+. Chrome 160 also blocks `--load-extension`, so test
   harnesses must load it via the DevTools protocol.
10. **Framework-heavy sites get overlay mode only** — rebuilding a live
    YouTube-style DOM caused duplicated UI (real bug, fixed), so live
    pages get forms+scroll only; full DOM rebuild is used only on empty
    pages.

## Source file walkthrough

### `manifest.json` — the contract

Permissions map one-to-one to mechanisms: `tabs` (query/discard/reload),
`scripting` (re-inject the content script), `idle` + `alarms` (sweep
triggers), `offscreen` (host the worker), `storage` (the `lto-frozen`
list). CSP includes `'wasm-unsafe-eval'` or the zstd wasm will not load.
Content script runs at `document_idle`, `all_frames: false`.

### `src/shared/types.ts` — the data model

- **`FlatNodeDescriptor`** — the whole DOM as a flat array:
  `{ id, parentId, tagName, attributes, textContent? }`. `id` is a dense
  BFS number (root = 0) and **`parentId < child id` always holds**. That
  invariant lets restoration process the array strictly in order with one
  map and zero lookahead.
- **`SerializedTabState`** — the snapshot: url, title, timestamp, scroll,
  `domTree[]`, `formInputs{}`, `formInputNodeIds{}` (form key → BFS node
  id), `heapSnapshotRef`.
- **Constants** — `CHUNK_SIZE_BYTES = 64 KiB`, `HYDRATION_BATCH_SIZE = 100`,
  `LONG_TASK_BUDGET_MS = 50`: the three numbers that define streaming and
  hydration.
- **Key helpers** — `tab-<id>/chunk-<000000>`, `tab-<id>/meta`: the
  IndexedDB key scheme.

### `src/shared/codec.ts` — determinism and the wire format

- **`stableStringify`** — recursively sorts object keys before
  serializing. Plain `JSON.stringify` orders keys by insertion, so two
  equal states could differ in bytes; sorting guarantees identical bytes
  → identical zstd output. Mimics `JSON.stringify` edge cases (skips
  `undefined`/functions).
- **`bytesToBase64` / `base64ToBytes`** — needed because **Chrome
  extension messaging is JSON-serialized, not structured clone**: a
  `Uint8Array` would arrive as `{"0":12,...}`. All binary crossing
  `runtime.sendMessage` must be base64. (Symptom of getting this wrong:
  compression stores an empty payload, restore fails with a JSON parse
  error.) The 32 KiB window in `String.fromCharCode` avoids blowing the
  argument limit.
- **`chunkBytes` / `joinChunks`** — fixed-size slicing, deterministic.

### `src/content/content.ts` — the capture module

- **`captureDOMTree(root)`** — BFS queue seeded with
  `{node: root, parentId: -1}`:
  - *Text nodes*: truncated at 64 KiB (flagged in `truncated[]`);
    **whitespace-only text is dropped and its id reclaimed**
    (`nextId--`) so ids stay dense.
  - *Comments*: dropped entirely.
  - *Elements*: attributes read into a record; `SKIP_TAGS`
    (SCRIPT/IFRAME/OBJECT/EMBED/CANVAS) become a
    `data-lto-skipped: "1"` placeholder with **no descent**.
    *Leaf-text fast-path*: an element with exactly one text child stores
    the text inline instead of queueing the child.
  - *Document node*: children queued, but the document itself gets no
    descriptor (`nextId--`).
  - `parentId < child id` holds by construction — a parent is always
    dequeued before its children.
- **`getFormKey(el, index)`** — key priority `#id` → `tag[name=x]` →
  `tag#index`. Radio/checkbox inputs get a `|v=<value>` suffix because
  same-name toggle groups would otherwise collide on the name and lose
  each other's state.
- **`captureFormInputs`** — `querySelectorAll("input, textarea, select")`:
  checkboxes/radios stored as `boolean`, multi-selects as `string[]`,
  everything else as `string`. Also stores `nodeIds[key] = bfsId` so
  restore can match by identity, not by fragile index.
- **`captureTabState`** — assembles `SerializedTabState` with
  `Date.now()` and `heapSnapshotRefFor(tabId)`.
- **Message bridge** — three messages:
  - `LTO_PING` — readiness probe.
  - `LTO_CAPTURE_REQUEST` — run capture, reply with the state.
  - `LTO_RESTORE_PUSH` — checks `hasLiveDom`: body populated →
    `overlayRestore`, empty → `hydrateDOM`. Returns `true` from the
    listener to keep the channel open for the async reply.

### `src/background/background.ts` — the orchestrator

- **Content-script helpers** — `injectContentScript` pulls the script
  path from the built manifest and runs `chrome.scripting.executeScript`;
  `waitForContentScript` polls `LTO_PING` every 100 ms with a fixed 5 s
  budget ("deterministic bounds, no adaptive timing");
  `waitForTabComplete` listens to `tabs.onUpdated` for status `complete`
  with a 10 s timeout.
- **`freezeTab`** — the pipeline above. Guards against already-discarded
  tabs (nothing to capture → returns zeros). Records
  `captureMs/compressMs/storeMs/totalMs` (these feed T08).
- **`restoreTab`** — URL-fallback snapshot lookup (Chrome replaces tab
  ids during discard), chunk reassembly, decompress, reload if discarded,
  **always** `waitForTabComplete` (Chrome flips `discarded=false` before
  this handler runs, so gating on that flag made restore skip — fixed),
  push state, then **delete the snapshot**.
- **`isFrozen(tab)`** — direct meta lookup by id, then URL fallback; the
  same rule restore uses.
- **`sweepInactiveTabs`** — the eligibility filter, then `freezeTab` per
  tab with errors logged, never thrown.
- **`autoRestoreOnActivation`** — re-entrancy guard via a `Set`, skips
  browser-UI URLs, **deliberately not gated on `tab.discarded`**, logs
  start/done/failed.
- **Wiring** — `onActivated` → auto-restore; `onInstalled` → creates the
  5-minute alarm; `onAlarm` → sweep; `idle.onStateChanged` → sweep on
  idle/locked; `onMessage` → dispatches `LTO_FREEZE_TAB` /
  `LTO_RESTORE_TAB` / `LTO_DELETE_SNAPSHOT` (each returns `true` to keep
  the async `sendResponse` channel alive).

### `src/storage/indexeddb.ts` — the chunk store

```
tab-<id>/meta            → { chunkCount, rawBytes, compressedBytes,
                             timestamp, url, scrollX, scrollY, ... }
tab-<id>/chunk-000000    → ArrayBuffer (≤64 KiB slice of the COMPRESSED stream)
tab-<id>/chunk-000001    → ...
```

- `writeCompressedChunks` — **deletes any previous snapshot first** so
  stale chunks never linger; slices the *compressed* bytes into 64 KiB
  chunks; stores each as an `ArrayBuffer` (explicit wire format); writes
  meta last.
- `readAllChunks` — pre-allocates `meta.compressedBytes` and fills
  sequentially: a streaming read in fixed granularity.
- `deleteTabSnapshot` — prefix scan over `keys()`.
- `listSnapshots` — all `/meta` keys sorted by tabId; this is what the
  URL-fallback restore searches.
- Thin wrapper over `idb-keyval`. **No eviction heuristics** — the caller
  decides teardown.

### `src/workers/compression.bridge.ts` — service worker → offscreen

MV3 service workers have **no `Worker` constructor**. `init()` checks
`chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})`,
creates the offscreen document with reason `WORKERS` if absent, then
pings it. `compress`/`decompress` send `LTO_OFFSCREEN_COMPRESS/DECOMPRESS`
with base64 payloads (the JSON-serialization hop) and decode the base64
result back to `Uint8Array`.

### `public/offscreen.js` — the relay

Creates `new Worker("/compression-worker.js")`, keeps a `pending` Map of
`{id → resolve/reject}` promises for multiplexed requests. `callWorker`
copies the bytes into a standalone ArrayBuffer and posts it **zero-copy**
with `[buffer]` as the transfer list — the buffer is *moved*, not cloned.
Replies re-encode to base64 for the JSON-serialized trip back to the
service worker. On worker error, all pending promises reject.

### `public/compression-worker.js` — zstd in wasm

- `importScripts("/zstd/zstd.js")` — classic worker (the npm package's
  web entry is broken, and MV3 CSP blocks bundler `data:` URLs for module
  workers).
- **`COMPRESSION_LEVEL = 3`** — fixed; byte-identical output for equal
  input.
- A `ready` promise resolves on `onRuntimeInitialized` after
  `Zstd.init("/zstd/zstd.wasm")`.
- **`compress`** — `ZSTD_compressBound` → `malloc` both buffers → copy
  into the wasm heap (`HEAP8.set`) → `ZSTD_compress` → `.slice()` out of
  the heap (a copy — the heap will be reused) → `free` in `finally`.
  Errors decoded via `ZSTD_getErrorName`.
- **`decompress`** — reads `ZSTD_getFrameContentSize` for the exact
  output size (4 MiB fallback if unknown) → `ZSTD_decompress`.
- `onmessage` awaits `ready` for every op and replies with
  `{id, ok, result}` plus the transferred buffer.

### `src/restoration/restoration.ts` — the restore engine

- **`nextIdle`** — `requestIdleCallback({timeout: 50})` with
  `setTimeout(0)` fallback; the yield between batches.
- **`createNode`** — text node or `createElement` + replay attributes
  (skipping `data-lto-skipped`, try/catch on invalid names) + sets
  `data-lto-id = desc.id`, the stable identity that makes form restore
  survive index shifts.
- **`hydrateDOM`** — the full-rebuild path:
  - If the snapshot root is `HTML` and we hydrate into `documentElement`,
    the root descriptor **maps onto the existing `<html>`** instead of
    nesting a second one.
  - Clears the host, then loops in 100-node slices: create node, record
    in `built`, append to `built.get(parentId)` (or host as orphan
    fallback — "never throws"), track `maxBatchMs`, `await nextIdle()`
    after every batch. That is the ≤50 ms long-task guarantee T08
    measures.
  - Forms restored, **then restored a second time** after another idle
    frame — page scripts can re-initialize fields after hydration, so the
    user's values are re-applied once more.
  - Returns `HydrationStats { mode, totalNodes, batches, elapsedMs,
    maxBatchMs, formApplied, formMissing }`.
- **`overlayRestore`** — the path actually used in practice: the page
  already reloaded with its own intact DOM/listeners/framework, so only
  forms (×2) + `window.scrollTo` are applied. Rebuilding would duplicate
  UI.
- **`buildLiveIdMap`** — the subtlest function. In overlay mode there are
  **no `data-lto-id` attributes** (the DOM was never rebuilt), so to
  match `formInputNodeIds` to elements it replays capture's traversal
  rules on the *live* DOM — drop comments, drop whitespace-only text,
  don't descend into SKIP_TAGS, don't descend into single-text-child
  elements — producing a live node list. If its **length** matches the
  snapshot's `domTree`, it zips them index-by-index and verifies each tag
  name and parent link; any mismatch → `null` (dynamic page changed
  structure) and callers fall back to id/name/index keys.
- **`restoreFormInputs`** — three-tier matching: (1) BFS node id via
  `data-lto-id` or `buildLiveIdMap`; (2) fallback candidates from
  `formKeysFor` (`#id`, `name`, `|v=`-suffixed toggle keys,
  `tag#index` — mirrors `getFormKey`); (3) unapplied keys reported as
  `missing`. Then `window.scrollTo`.
- **`applyFormValue`** — sets `.checked` for toggles; for text inputs
  sets **both** `.value` and the `value` *attribute* (some frameworks
  read the attribute); textarea sets `.value` + `.textContent`;
  multi-select toggles `opt.selected` per saved value.
- **`createLazyHeap`** — ES6 `Proxy` wrapper: each property is
  unmarshalled by `loader.load(key)` **on first access**, then cached
  (`get` trap), with `has`/`ownKeys`/`getOwnPropertyDescriptor`
  forwarded so `in`, `Object.keys`, and spread still work. Deterministic:
  access order does not affect values. This is the thesis's "deferred
  heap reinitialization" — heavy state can be rebuilt lazily instead of
  all at once.

### `src/ui/popup.ts` — the dashboard

Lists all tabs (❄ prefix if discarded), two buttons per row. Freeze logs
`raw → compressed B in ms`; Restore logs `mode, nodes, fields applied`.
Sends `LTO_FREEZE_TAB` / `LTO_RESTORE_TAB`. Deliberately thin —
everything else is automatic.

## Message protocol

| Message | From → To | Payload | Reply |
|---|---|---|---|
| `LTO_PING` | background → content | — | `{ ok }` |
| `LTO_CAPTURE_REQUEST` | background → content | `tabId` | `{ ok, state }` |
| `LTO_RESTORE_PUSH` | background → content | `state` | `{ ok, stats }` |
| `LTO_OFFSCREEN_PING` | background → offscreen | — | `{ ok }` |
| `LTO_OFFSCREEN_COMPRESS` / `_DECOMPRESS` | background → offscreen | `payloadB64` | `{ ok, resultB64 }` |
| `LTO_FREEZE_TAB` / `LTO_RESTORE_TAB` / `LTO_DELETE_SNAPSHOT` | popup → background | `tabId` | `{ ok, ... }` |

Binary payloads are base64 on every `chrome.runtime` hop (JSON
serialization) and zero-copy `Transferable` only on the offscreen→worker
hop.

## Fixed constants

| Constant | Value | Where |
|---|---|---|
| `CHUNK_SIZE_BYTES` | 64 KiB | `src/shared/types.ts` |
| `HYDRATION_BATCH_SIZE` | 100 nodes/frame | `src/shared/types.ts` |
| `LONG_TASK_BUDGET_MS` | 50 ms | `src/shared/types.ts` |
| `INACTIVITY_THRESHOLD_MIN` | 15 min | `src/background/background.ts` |
| `CHECK_PERIOD_MIN` | 5 min | `src/background/background.ts` |
| `MAX_TEXT_PER_NODE` | 64 KiB | `src/content/content.ts` |
| `COMPRESSION_LEVEL` | 3 (zstd) | `public/compression-worker.js` |
| content-script ping budget | 5 s @ 100 ms | `src/background/background.ts` |
| tab-complete budget | 10 s | `src/background/background.ts` |

## Verification

- **`tests/`** (`node --test`, 22 tests) — source contracts: constants in
  sync, batching math, base64 round-trip through `offscreen.js` in a Node
  VM, **absence of ML/probabilistic code**.
- **`tools/thesis-verify/`** — the recorded T01–T10 suite driving real
  Chrome over CDP; every run (pass or fail) stored under
  `results/verification/<run-id>/` and indexed in
  `results/verification/SUMMARY.md`. Runs on Linux and Windows; the
  OS-specific parts live in `platform_support.py`, and each run records its
  `memory_metric` (PSS on Linux, Working Set on Windows — not comparable).
  See [`tools/thesis-verify/README.md`](../tools/thesis-verify/README.md).
- **`tools/thesis-verify/tests/`** — Python unit tests for the platform layer
  (both OS branches, fakes only, no browser).
- **`tools/memory-bench/bench.py`** — external baseline-vs-extension A/B
  comparison tool (Linux smem/proc, Windows PowerShell/CIM).
- **`.github/workflows/verify.yml`** — CI on Ubuntu and Windows: Node tests,
  build, Python syntax check, platform unit tests.

## Related docs

- [`PHASE.md`](../PHASE.md) — continuity log: verified state, known
  issues, next steps.
- [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) — setup, build, testing,
  troubleshooting.
- [`tools/thesis-verify/README.md`](../tools/thesis-verify/README.md) —
  test matrix, thresholds, metric definitions.
