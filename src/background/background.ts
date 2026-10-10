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
import type { SerializedTabState } from "../shared/types";
import { deleteTabSnapshot, readAllChunks, readMeta, writeCompressedChunks } from "../storage/indexeddb";
import { MSG_CAPTURE_REQUEST, MSG_CAPTURE_RESPONSE } from "../content/content";

// --- Explicit deterministic policy constants -------------------------------
export const INACTIVITY_THRESHOLD_MIN = 15; // minutes before a tab is eligible
export const CHECK_ALARM_NAME = "lto-sweep";
export const CHECK_PERIOD_MIN = 5;

const bridge = new CompressionBridge(new URL("../workers/compression.worker", import.meta.url));

async function ensureBridge(): Promise<void> {
  if (!bridge.isReady) await bridge.init();
}

// --- Stage 1: capture -------------------------------------------------------

async function captureTab(tabId: number): Promise<SerializedTabState> {
  const res = (await chrome.tabs.sendMessage(tabId, { type: MSG_CAPTURE_REQUEST, tabId })) as
    | { type: string; ok: boolean; state?: SerializedTabState; error?: string }
    | undefined;
  if (res?.ok && res.state) return res.state;
  // Fallback: programmatic injection (covers pages where the static content
  // script was blocked). Deterministic — same module, same result.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/content"] });
  const retry = (await chrome.tabs.sendMessage(tabId, { type: MSG_CAPTURE_REQUEST, tabId })) as {
    type: string;
    ok: boolean;
    state?: SerializedTabState;
    error?: string;
  };
  if (!retry?.ok || !retry.state) throw new Error(retry?.error ?? `capture failed for tab ${tabId}`);
  void MSG_CAPTURE_RESPONSE;
  return retry.state;
}

// --- Stage 2: compress + store ----------------------------------------------

export async function freezeTab(tabId: number): Promise<{ rawBytes: number; compressedBytes: number }> {
  await ensureBridge();
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded) return { rawBytes: 0, compressedBytes: 0 }; // already frozen
  const state = await captureTab(tabId);
  const json = stableStringify(state);
  const raw = encodeUtf8(json);
  const compressed = await bridge.compress(raw);
  await writeCompressedChunks(tabId, compressed, {
    tabId,
    url: state.url,
    title: state.title,
    timestamp: state.timestamp,
    rawBytes: raw.length,
    scrollX: state.scrollPosition.x,
    scrollY: state.scrollPosition.y,
  });
  // --- Stage 3a: terminate renderer process --------------------------------
  await chrome.tabs.discard(tabId);
  const saved = (await chrome.storage.local.get("lto-frozen")) as { "lto-frozen"?: number[] };
  const frozen = new Set(saved["lto-frozen"] ?? []);
  frozen.add(tabId);
  await chrome.storage.local.set({ "lto-frozen": [...frozen] });
  return { rawBytes: raw.length, compressedBytes: compressed.length };
}

// --- Stage 3b: lazy restore ---------------------------------------------------

export async function restoreTab(tabId: number): Promise<SerializedTabState> {
  await ensureBridge();
  const { data } = await readAllChunks(tabId);
  const raw = await bridge.decompress(data);
  const state = JSON.parse(decodeUtf8(raw)) as SerializedTabState;
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded && tab.url) await chrome.tabs.reload(tabId);
  // Hydration itself runs in the content context after reload; here we hand
  // the state over via a reload + inject sequence handled by the caller.
  // For an already-live tab, push state directly:
  try {
    await chrome.tabs.sendMessage(tabId, { type: "LTO_RESTORE_PUSH", state });
  } catch {
    // Tab not yet listening (mid-reload) — popup will retry on completion.
  }
  return state;
}

export async function isFrozen(tabId: number): Promise<boolean> {
  const meta = await readMeta(tabId).catch(() => undefined);
  return meta !== undefined;
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
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === "LTO_RESTORE_TAB") {
    restoreTab((msg as { tabId: number }).tabId)
      .then((state) => sendResponse({ ok: true, state }))
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

// Re-push state when a frozen tab finishes reloading.
chrome.tabs.onUpdated.addListener((_tabId, info, _tab) => {
  if (info.status === "complete") {
    // Popup-driven restore flow re-sends LTO_RESTORE_TAB itself; hook kept
    // minimal and deterministic.
  }
});
