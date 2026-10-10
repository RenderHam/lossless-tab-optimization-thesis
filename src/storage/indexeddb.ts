/**
 * IndexedDB binary chunk manager.
 *
 * Layout per tab:
 *   `tab-<id>/meta`            -> { chunkCount, rawBytes, compressedBytes, timestamp, url }
 *   `tab-<id>/chunk-<000000>`  -> ArrayBuffer (compressed slice, <= 64 KiB logical chunk of RAW input;
 *                                 stored compressed pieces may differ in size — chunking is applied
 *                                 to the COMPRESSED byte stream for fixed 64 KiB streaming reads)
 *
 * Uses `idb-keyval` for a small deterministic wrapper. All operations are
 * explicit and ordered; no eviction heuristics — caller decides teardown.
 */
import { createStore, get, set, del, keys } from "idb-keyval";
import { CHUNK_SIZE_BYTES, chunkKeyFor, metaKeyFor } from "../shared/types";

export interface TabMeta {
  tabId: number;
  url: string;
  title: string;
  timestamp: number;
  chunkCount: number;
  compressedBytes: number;
  rawBytes: number;
  scrollX: number;
  scrollY: number;
}

const store = createStore("lto-db", "lto-chunks");

export async function writeCompressedChunks(
  tabId: number,
  compressed: Uint8Array,
  meta: Omit<TabMeta, "chunkCount" | "compressedBytes">,
): Promise<TabMeta> {
  // Delete any previous snapshot first so stale chunks never linger.
  await deleteTabSnapshot(tabId);
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < compressed.length; off += CHUNK_SIZE_BYTES) {
    chunks.push(compressed.slice(off, off + CHUNK_SIZE_BYTES));
  }
  if (compressed.length === 0) chunks.push(new Uint8Array(0));
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as Uint8Array;
    // Store a copy as ArrayBuffer (structured clone of Uint8Array works too,
    // but ArrayBuffer keeps the wire format explicit).
    const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    await set(chunkKeyFor(tabId, i), buf, store);
  }
  const full: TabMeta = {
    ...meta,
    chunkCount: chunks.length,
    compressedBytes: compressed.length,
  };
  await set(metaKeyFor(tabId), full, store);
  return full;
}

/** Read chunk `index` as Uint8Array. Fixed 64 KiB streaming granularity. */
export async function readChunk(tabId: number, index: number): Promise<Uint8Array> {
  const buf = await get<ArrayBuffer>(chunkKeyFor(tabId, index), store);
  if (!buf) throw new Error(`missing chunk ${index} for tab ${tabId}`);
  return new Uint8Array(buf);
}

export async function readMeta(tabId: number): Promise<TabMeta | undefined> {
  return get<TabMeta>(metaKeyFor(tabId), store);
}

/** Ordered read of all chunks (used by restore path with streaming). */
export async function readAllChunks(tabId: number): Promise<{ meta: TabMeta; data: Uint8Array }> {
  const meta = await readMeta(tabId);
  if (!meta) throw new Error(`no snapshot for tab ${tabId}`);
  const out = new Uint8Array(meta.compressedBytes);
  let off = 0;
  for (let i = 0; i < meta.chunkCount; i++) {
    const c = await readChunk(tabId, i);
    out.set(c, off);
    off += c.length;
  }
  return { meta, data: out };
}

export async function deleteTabSnapshot(tabId: number): Promise<void> {
  const all = await keys(store);
  const prefix = `tab-${tabId}/`;
  for (const k of all) {
    if (typeof k === "string" && k.startsWith(prefix)) await del(k, store);
  }
}

export async function listSnapshots(): Promise<TabMeta[]> {
  const all = await keys(store);
  const out: TabMeta[] = [];
  for (const k of all) {
    if (typeof k === "string" && k.endsWith("/meta")) {
      const m = await get<TabMeta>(k, store);
      if (m) out.push(m);
    }
  }
  out.sort((a, b) => a.tabId - b.tabId);
  return out;
}
