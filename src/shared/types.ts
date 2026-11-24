/**
 * Shared deterministic data model.
 *
 * STRICTLY DETERMINISTIC: plain interfaces + pure functions only.
 * No ML, no heuristics, no randomness. Field ordering for serialization
 * is fixed by `stableStringify` in ./codec.ts.
 */

export interface ScrollPosition {
  x: number;
  y: number;
}

export interface FlatNodeDescriptor {
  /** Dense BFS id, assigned in visitation order. Root (documentElement) is 0. */
  id: number;
  /** Parent BFS id, or -1 for the root. */
  parentId: number;
  /** Upper-case tag name, or "#text" / "#comment" / "#document". */
  tagName: string;
  attributes: Record<string, string>;
  textContent?: string;
}

export type FormValue = string | boolean | string[];

export interface SerializedTabState {
  tabId: number;
  url: string;
  title: string;
  timestamp: number;
  scrollPosition: ScrollPosition;
  domTree: FlatNodeDescriptor[];
  formInputs: Record<string, FormValue>;
  /** Maps each form key to its BFS node id, for stable restoration. */
  formInputNodeIds?: Record<string, number>;
  /** IndexedDB key prefix under which compressed chunks are stored. */
  heapSnapshotRef: string;
}

/** Fixed protocol constants — must stay in sync with restoration.ts */
export const CHUNK_SIZE_BYTES = 64 * 1024; // 64 KiB chunked streaming
export const HYDRATION_BATCH_SIZE = 100; // max elements per idle frame
export const LONG_TASK_BUDGET_MS = 50;

/** Message protocol shared by background, content, and popup contexts. */
export const MSG_CAPTURE_REQUEST = "LTO_CAPTURE_REQUEST";
export const MSG_CAPTURE_RESPONSE = "LTO_CAPTURE_RESPONSE";
export const MSG_RESTORE_PUSH = "LTO_RESTORE_PUSH";
export const MSG_PING = "LTO_PING";

export function heapSnapshotRefFor(tabId: number): string {
  return `tab-${tabId}`;
}

export function chunkKeyFor(tabId: number, index: number): string {
  return `tab-${tabId}/chunk-${String(index).padStart(6, "0")}`;
}

export function metaKeyFor(tabId: number): string {
  return `tab-${tabId}/meta`;
}
