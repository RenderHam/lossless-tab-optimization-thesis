/**
 * Automated benchmark protocol — deterministic, fixed sequence per tab:
 *
 *   sample renderer RSS → freeze → sample RSS → restore → sample RSS
 *
 * It records exact measurements only: Chrome-reported private memory,
 * compression byte counts, wall-clock timings, byte-exact state fidelity via
 * stableStringify, and hydration batch statistics. No estimates, no learning.
 */

import type { FreezeOutcome, RestoreOutcome } from "../background/background";
import { stableStringify } from "../shared/codec";
import { LONG_TASK_BUDGET_MS } from "../shared/types";
import type { HydrationStats } from "../restoration/restoration";
import { isMemoryApiAvailable, sampleTabRenderer, type MemorySample } from "./memory";

export const BENCH_RESULT_KEY = "lto-bench-latest";

export interface BenchmarkHooks {
  freezeTab(tabId: number, knownTab?: chrome.tabs.Tab): Promise<FreezeOutcome>;
  restoreTab(tabId: number): Promise<RestoreOutcome>;
}

export interface BenchmarkTrial {
  tabId: number;
  url: string;
  title: string;
  beforeMemory: MemorySample | null;
  frozenMemory: MemorySample | null;
  afterRestoreMemory: MemorySample | null;
  savedBytes: number | null;
  savedPercent: number | null;
  rawBytes: number;
  compressedBytes: number;
  compressionPercent: number;
  fidelity: boolean;
  timings: {
    captureMs: number;
    compressMs: number;
    storeMs: number;
    freezeTotalMs: number;
    decompressMs: number;
    restoreTotalMs: number;
  };
  hydration: HydrationStats | null;
  overBudget: boolean;
  error?: string;
}

export interface BenchmarkSummary {
  trialCount: number;
  failures: number;
  fidelityPassed: number;
  fidelityFailed: number;
  meanSavedPercentPerTab: number | null;
  totalBeforeBytes: number;
  totalSavedBytes: number;
  totalSavedPercent: number | null;
  meanCompressionPercent: number;
  maxBatchMs: number;
  overBudgetTrials: number;
}

export interface BenchmarkRun {
  timestamp: number;
  memoryApiAvailable: boolean;
  trials: BenchmarkTrial[];
  summary: BenchmarkSummary;
}

export function reductionPercent(before: number, after: number): number | null {
  if (before <= 0) return null;
  return Math.max(0, ((before - after) / before) * 100);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function summarize(trials: BenchmarkTrial[]): BenchmarkSummary {
  const percents: number[] = [];
  let totalBefore = 0;
  let totalSaved = 0;
  const compressions: number[] = [];
  let fidelityPassed = 0;
  let maxBatch = 0;
  let overBudget = 0;

  for (const t of trials) {
    if (t.error) continue;
    if (t.savedPercent !== null) percents.push(t.savedPercent);
    const before = t.beforeMemory?.privateMemoryBytes ?? 0;
    const after = t.frozenMemory?.privateMemoryBytes ?? 0;
    totalBefore += before;
    totalSaved += Math.max(0, before - after);
    compressions.push(t.compressionPercent);
    if (t.fidelity) fidelityPassed++;
    maxBatch = Math.max(maxBatch, t.hydration?.maxBatchMs ?? 0);
    if (t.overBudget) overBudget++;
  }

  const completed = trials.filter((t) => !t.error).length;
  return {
    trialCount: trials.length,
    failures: trials.length - completed,
    fidelityPassed,
    fidelityFailed: completed - fidelityPassed,
    meanSavedPercentPerTab: percents.length > 0 ? mean(percents) : null,
    totalBeforeBytes: totalBefore,
    totalSavedBytes: totalSaved,
    totalSavedPercent: reductionPercent(totalBefore, totalBefore - totalSaved),
    meanCompressionPercent: mean(compressions),
    maxBatchMs: maxBatch,
    overBudgetTrials: overBudget,
  };
}

/**
 * Fixed-sequence runner. Tab IDs are re-resolved from a fresh tabs.query in
 * the background: IDs sent by the popup can be stale, and Chrome refuses to
 * discard active/pinned/audible tabs, so those are excluded explicitly.
 */
export function createBenchmark(hooks: BenchmarkHooks) {
  return async function runBenchmark(_requestedIds?: number[]): Promise<BenchmarkRun> {
    const trials: BenchmarkTrial[] = [];
    const memoryApiAvailable = isMemoryApiAvailable();

    const isEligible = (t: chrome.tabs.Tab): boolean =>
      t.id !== undefined &&
      !t.discarded &&
      !t.active &&
      !t.pinned &&
      !t.audible &&
      /^https?:\/\//.test(t.url ?? "");

    // Ignore IDs sent by the popup: they may come from a different browser
    // context. Re-query before EVERY trial because tab IDs can churn while
    // the benchmark is freezing/reloading tabs.
    const initialCount = (await chrome.tabs.query({})).filter(isEligible).length;
    const used = new Set<number>();

    for (let i = 0; i < initialCount; i++) {
      let tab: chrome.tabs.Tab | undefined;
      for (let attempt = 0; attempt < 3 && !tab; attempt++) {
        const current = await chrome.tabs.query({});
        tab = current.find((t) => isEligible(t) && t.id !== undefined && !used.has(t.id));
        if (!tab) await new Promise((r) => setTimeout(r, 100));
      }
      if (!tab || tab.id === undefined) break;
      const tabId = tab.id;
      used.add(tabId);
      const trial: BenchmarkTrial = {
        tabId,
        url: tab.url ?? "",
        title: tab.title ?? "",
        beforeMemory: null,
        frozenMemory: null,
        afterRestoreMemory: null,
        savedBytes: null,
        savedPercent: null,
        rawBytes: 0,
        compressedBytes: 0,
        compressionPercent: 0,
        fidelity: false,
        timings: {
          captureMs: 0,
          compressMs: 0,
          storeMs: 0,
          freezeTotalMs: 0,
          decompressMs: 0,
          restoreTotalMs: 0,
        },
        hydration: null,
        overBudget: false,
      };

      try {
        trial.beforeMemory = await sampleTabRenderer(tabId);
        // Pass the already-resolved tab object — no second lookup that could
        // fail if the tab disappears between query and freeze.
        const freeze = await hooks.freezeTab(tabId, tab);
        trial.frozenMemory = await sampleTabRenderer(tabId);
        const restore = await hooks.restoreTab(tabId);
        trial.afterRestoreMemory = await sampleTabRenderer(tabId);

        trial.rawBytes = freeze.rawBytes;
        trial.compressedBytes = freeze.compressedBytes;
        trial.compressionPercent = reductionPercent(freeze.rawBytes, freeze.compressedBytes) ?? 0;
        trial.timings = {
          captureMs: freeze.timings.captureMs,
          compressMs: freeze.timings.compressMs,
          storeMs: freeze.timings.storeMs,
          freezeTotalMs: freeze.timings.totalMs,
          decompressMs: restore.decompressMs,
          restoreTotalMs: restore.totalMs,
        };
        trial.hydration = restore.hydration;
        trial.overBudget = (restore.hydration?.maxBatchMs ?? 0) > LONG_TASK_BUDGET_MS;

        // Byte-exact fidelity: the stable JSON written before compression must
        // equal the stable JSON of the state reconstructed after decompression.
        trial.fidelity = freeze.stateJson === stableStringify(restore.state);

        const before = trial.beforeMemory?.privateMemoryBytes ?? 0;
        const after = trial.frozenMemory?.privateMemoryBytes ?? 0;
        if (before > 0) {
          trial.savedBytes = Math.max(0, before - after);
          trial.savedPercent = reductionPercent(before, after);
        }
      } catch (err) {
        trial.error = String(err);
      }
      trials.push(trial);
    }

    return {
      timestamp: Date.now(),
      memoryApiAvailable,
      trials,
      summary: summarize(trials),
    };
  };
}
