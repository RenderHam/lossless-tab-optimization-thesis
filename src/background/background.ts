/**
 * Background service worker: orchestrates the three-stage pipeline.
 *
 *  CAPTURE   — on inactivity (chrome.idle + alarm fallback), injects or
 *              messages the content script for a BFS snapshot.
 *  COMPRESS  — stable-stringify -> UTF-8 -> zero-copy postMessage to the
 *              zstd-wasm worker -> IndexedDB chunks keyed by tabId.
 *  TERMINATE — chrome.tabs.discard() to reclaim the renderer process.
 *  RESTORE   — on user demand (popup / tab activation of a discarded frozen
 *              tab): read chunks, decompress, re-inject + batched hydrate.
 *
 * All thresholds are explicit constants (no adaptive/ML heuristics).
 */

import { CompressionBridge } from "../workers/compression.bridge";
import { decodeUtf8, encodeUtf8, stableStringify } from "../shared/codec";
import type { HydrationStats } from "../restoration/restoration";
import {
  MSG_CAPTURE_REQUEST,
  MSG_PING,
  MSG_RESTORE_PUSH,
  type SerializedTabState,
} from "../shared/types";
import { deleteTabSnapshot, readAllChunks, readMeta, writeCompressedChunks } from "../storage/indexeddb";
import { BENCH_RESULT_KEY, createBenchmark, type BenchmarkRun } from "../profiling/benchmark";
import { sampleAllRenderers } from "../profiling/memory";

// --- Explicit deterministic policy constants -------------------------------
export const INACTIVITY_THRESHOLD_MIN = 15; // minutes before a tab is eligible
export const CHECK_ALARM_NAME = "lto-sweep";
export const CHECK_PERIOD_MIN = 5;

const bridge = new CompressionBridge();

async function ensureBridge(): Promise<void> {
  if (!bridge.isReady) await bridge.init();
}

// --- Content-script readiness helpers ---------------------------------------

/** Inject the built content script path declared by the (rewritten) manifest. */
async function injectContentScript(tabId: number): Promise<void> {
  const file = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0];
  if (!file) throw new Error("no content script declared in manifest");
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
}

/**
 * Poll the content script with a fixed 100 ms interval until it answers or a
 * fixed 5 s budget expires. Deterministic bounds — no adaptive timing.
 */
async function waitForContentScript(tabId: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, { type: MSG_PING })) as { ok?: boolean } | undefined;
      if (res?.ok) return;
    } catch {
      // Not listening yet — keep polling within the fixed budget.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`content script not ready in tab ${tabId}`);
}

async function waitForTabComplete(tabId: number, timeoutMs = 10000): Promise<void> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`tab ${tabId} did not finish loading`));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// --- Stage 1: capture -------------------------------------------------------

async function captureTab(tabId: number): Promise<SerializedTabState> {
  // Normally the static content script is already present; inject only if the
  // readiness probe fails after the fixed budget.
  if (!(await ping(tabId))) await injectContentScript(tabId);
  await waitForContentScript(tabId);

  const res = (await chrome.tabs.sendMessage(tabId, { type: MSG_CAPTURE_REQUEST, tabId })) as
    | { ok: boolean; state?: SerializedTabState; error?: string }
    | undefined;
  if (!res?.ok || !res.state) throw new Error(res?.error ?? `capture failed for tab ${tabId}`);
  return res.state;
}

async function ping(tabId: number): Promise<boolean> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: MSG_PING })) as { ok?: boolean } | undefined;
    return res?.ok === true;
  } catch {
    return false;
  }
}

// --- Stage 2: compress + store ----------------------------------------------

export interface FreezeOutcome {
  rawBytes: number;
  compressedBytes: number;
  /** Internal: used by the benchmark for fidelity, stripped from popup replies. */
  stateJson: string;
  timings: {
    captureMs: number;
    compressMs: number;
    storeMs: number;
    totalMs: number;
  };
}

export async function freezeTab(tabId: number): Promise<FreezeOutcome> {
  const started = performance.now();
  await ensureBridge();
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded) {
    return {
      rawBytes: 0,
      compressedBytes: 0,
      stateJson: "",
      timings: { captureMs: 0, compressMs: 0, storeMs: 0, totalMs: 0 },
    };
  }

  const captureStart = performance.now();
  const state = await captureTab(tabId);
  const json = stableStringify(state);
  const raw = encodeUtf8(json);
  const captureMs = performance.now() - captureStart;

  const compressStart = performance.now();
  const compressed = await bridge.compress(raw);
  if (compressed.length === 0) throw new Error("zstd compression returned 0 bytes");
  const compressMs = performance.now() - compressStart;

  const storeStart = performance.now();
  await writeCompressedChunks(tabId, compressed, {
    tabId,
    url: state.url,
    title: state.title,
    timestamp: state.timestamp,
    rawBytes: raw.length,
    scrollX: state.scrollPosition.x,
    scrollY: state.scrollPosition.y,
  });
  const storeMs = performance.now() - storeStart;

  // --- Stage 3a: terminate renderer process --------------------------------
  await chrome.tabs.discard(tabId);
  const saved = (await chrome.storage.local.get("lto-frozen")) as { "lto-frozen"?: number[] };
  const frozen = new Set(saved["lto-frozen"] ?? []);
  frozen.add(tabId);
  await chrome.storage.local.set({ "lto-frozen": [...frozen] });

  return {
    rawBytes: raw.length,
    compressedBytes: compressed.length,
    stateJson: json,
    timings: { captureMs, compressMs, storeMs, totalMs: performance.now() - started },
  };
}

// --- Stage 3b: lazy restore ---------------------------------------------------

export interface RestoreOutcome {
  state: SerializedTabState;
  hydration: HydrationStats | null;
  decompressMs: number;
  totalMs: number;
}

export async function restoreTab(tabId: number): Promise<RestoreOutcome> {
  const started = performance.now();
  await ensureBridge();

  // 1. Read 64 KiB chunks from IndexedDB in order and decompress in the worker.
  const { meta, data } = await readAllChunks(tabId);
  const decompressStart = performance.now();
  const raw = await bridge.decompress(data);
  if (raw.length === 0) {
    throw new Error(
      `empty decompression: ${data.length} bytes in ${meta.chunkCount} chunks (stored ${meta.compressedBytes})`,
    );
  }
  const decompressMs = performance.now() - decompressStart;
  const state = JSON.parse(decodeUtf8(raw)) as SerializedTabState;

  // 2. A discarded tab has no renderer — reload it so the content script runs.
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded) {
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
  }
  await waitForContentScript(tabId);

  // 3. Push the state to the content script, which hydrates it in batches.
  const res = (await chrome.tabs.sendMessage(tabId, { type: MSG_RESTORE_PUSH, state })) as
    | { ok: boolean; stats?: HydrationStats; error?: string }
    | undefined;
  if (!res?.ok) throw new Error(res?.error ?? "hydration failed in content script");
  return { state, hydration: res.stats ?? null, decompressMs, totalMs: performance.now() - started };
}

export async function isFrozen(tabId: number): Promise<boolean> {
  const meta = await readMeta(tabId).catch(() => undefined);
  return meta !== undefined;
}

/** Benchmark runner, created once with the real freeze/restore implementations. */
const runBenchmark = createBenchmark({ freezeTab, restoreTab });

export async function getLatestBenchmark(): Promise<BenchmarkRun | null> {
  const stored = (await chrome.storage.local.get(BENCH_RESULT_KEY)) as Record<string, BenchmarkRun>;
  return stored[BENCH_RESULT_KEY] ?? null;
}

// --- Inactivity sweep (explicit rule, no prediction) --------------------------

async function sweepInactiveTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id === undefined || t.active || t.pinned || t.audible || t.discarded) continue;
    if (t.url?.startsWith("chrome://") || t.url?.startsWith("chrome-extension://")) continue;
    const last = t.lastAccessed ?? 0;
    const idleMs = Date.now() - last;
    if (idleMs >= INACTIVITY_THRESHOLD_MIN * 60_000) {
      try {
        await freezeTab(t.id);
      } catch (err) {
        console.warn(`[lto] freeze failed for tab ${t.id}:`, err);
      }
    }
  }
}

// --- Wiring -------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(CHECK_ALARM_NAME, { periodInMinutes: CHECK_PERIOD_MIN });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM_NAME) void sweepInactiveTabs();
});

chrome.idle.onStateChanged.addListener((s) => {
  if (s === "idle" || s === "locked") void sweepInactiveTabs();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = (msg as { type?: string }).type;
  if (type === "LTO_FREEZE_TAB") {
    freezeTab((msg as { tabId: number }).tabId)
      .then((r) =>
        sendResponse({
          ok: true,
          rawBytes: r.rawBytes,
          compressedBytes: r.compressedBytes,
          timings: r.timings,
        }),
      )
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "LTO_RESTORE_TAB") {
    restoreTab((msg as { tabId: number }).tabId)
      .then((outcome) => sendResponse({ ok: true, hydration: outcome.hydration, totalMs: outcome.totalMs }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "LTO_MEMORY_SNAPSHOT") {
    sampleAllRenderers()
      .then((sample) => sendResponse({ ok: true, sample }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "LTO_BENCH_RUN") {
    const tabIds = (msg as { tabIds?: number[] }).tabIds ?? [];
    runBenchmark(tabIds)
      .then(async (run) => {
        await chrome.storage.local.set({ [BENCH_RESULT_KEY]: run });
        sendResponse({ ok: true, run });
      })
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "LTO_BENCH_LATEST") {
    getLatestBenchmark()
      .then((run) => sendResponse({ ok: true, run }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "LTO_DELETE_SNAPSHOT") {
    deleteTabSnapshot((msg as { tabId: number }).tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});
