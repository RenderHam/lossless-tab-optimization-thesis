/**
 * Summarize a benchmark JSON exported from the popup.
 * Usage: node benchmarks/report.mjs <path-to-results.json>
 */
import fs from "node:fs";
import { mib, mean, reductionPercent } from "./lib.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node benchmarks/report.mjs <results.json>");
  process.exit(2);
}
const run = JSON.parse(fs.readFileSync(path, "utf8"));
const s = run.summary;

console.log(`Benchmark: ${new Date(run.timestamp).toISOString()}`);
console.log(`Memory API available: ${run.memoryApiAvailable}`);
console.log(`Trials: ${s.trialCount} (failures: ${s.failures})`);
console.log(`Fidelity: ${s.fidelityPassed} passed / ${s.fidelityFailed} failed`);
console.log(`Compression: ${s.meanCompressionPercent.toFixed(2)}% mean bytes saved`);
console.log(`Mean per-tab memory reduction: ${s.meanSavedPercentPerTab?.toFixed(2) ?? "n/a"}%`);
console.log(
  `Renderer memory: ${mib(s.totalBeforeBytes)} MiB before → ` +
    `${mib(s.totalBeforeBytes - s.totalSavedBytes)} MiB frozen ` +
    `(${s.totalSavedPercent?.toFixed(2) ?? "n/a"}% saved)`,
);
console.log(`Max hydration batch: ${s.maxBatchMs.toFixed(2)} ms (over 50 ms: ${s.overBudgetTrials} trials)`);

console.log("\nPer tab:");
for (const t of run.trials) {
  const before = t.beforeMemory?.privateMemoryBytes ?? null;
  // A discarded tab has no renderer process: zero RSS, not "unknown".
  const after = before !== null ? (t.frozenMemory?.privateMemoryBytes ?? 0) : null;
  const saved = before !== null && after !== null ? reductionPercent(before, after) : null;
  console.log(
    `  tab ${t.tabId}  ${t.title.slice(0, 36).padEnd(36)}  ` +
      `RSS ${before === null ? "n/a" : mib(before)} → ${after === null ? "0" : mib(after)} MiB  ` +
      `saved ${saved === null ? "n/a" : `${saved.toFixed(1)}%`}  ` +
      `zstd ${t.compressionPercent.toFixed(1)}%  fidelity ${t.fidelity ? "OK" : "FAIL"}` +
      (t.error ? `  ERROR: ${t.error}` : ""),
  );
}

if (s.failures > 0 || s.fidelityFailed > 0 || s.overBudgetTrials > 0) {
  console.error("\nBenchmark did not meet fidelity/latency checks.");
  process.exit(1);
}
