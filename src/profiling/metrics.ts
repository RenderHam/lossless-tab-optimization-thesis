/**
 * Profiling & benchmarking: RSS delta, main-thread blocking, state fidelity.
 *
 * Deterministic: fixed iteration counts, fixed payload fixtures, pure
 * comparisons. Used by `npm run bench` (benchmarks/run.mjs) and the popup
 * dashboard. No sampling heuristics — every metric is an exact measurement
 * over the recorded run.
 */

export interface FreezeMetrics {
  tabId: number;
  rawBytes: number;
  compressedBytes: number;
  ratio: number; // compressed / raw
  captureMs: number;
  compressMs: number;
  storeMs: number;
}

export interface RestoreMetrics {
  tabId: number;
  totalNodes: number;
  batches: number;
  elapsedMs: number;
  maxBatchMs: number;
  longTasks: number; // batches exceeding 50ms
}

export function compressionRatio(rawBytes: number, compressedBytes: number): number {
  if (rawBytes === 0) return 0;
  return compressedBytes / rawBytes;
}

/** Byte-exact fidelity check: stable-stringify both states and compare. */
export function fidelityEqual(a: unknown, b: unknown, stableStringify: (v: unknown) => string): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function summarizeRestores(runs: RestoreMetrics[]): {
  meanElapsedMs: number;
  maxBatchMs: number;
  totalLongTasks: number;
} {
  if (runs.length === 0) return { meanElapsedMs: 0, maxBatchMs: 0, totalLongTasks: 0 };
  let sum = 0;
  let maxB = 0;
  let lt = 0;
  for (const r of runs) {
    sum += r.elapsedMs;
    maxB = Math.max(maxB, r.maxBatchMs);
    lt += r.longTasks;
  }
  return { meanElapsedMs: sum / runs.length, maxBatchMs: maxB, totalLongTasks: lt };
}
