/** Popup dashboard: manual freeze/restore, memory snapshot, benchmark controls. */
import type { BenchmarkRun } from "../profiling/benchmark";

const tabsEl = document.getElementById("tabs") as HTMLElement;
const logEl = document.getElementById("log") as HTMLElement;
const summaryEl = document.getElementById("summary") as HTMLElement;

function log(msg: string): void {
  const p = document.createElement("p");
  p.textContent = msg;
  logEl.prepend(p);
}

async function send<T>(message: Record<string, unknown>): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

function fmtMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderSummary(run: BenchmarkRun | null): void {
  if (!run) {
    summaryEl.textContent = "No benchmark run yet.";
    return;
  }
  const s = run.summary;
  summaryEl.textContent = run.memoryApiAvailable
    ? `${s.trialCount} tabs · saved ${fmtMib(s.totalSavedBytes)} of ${fmtMib(s.totalBeforeBytes)} ` +
      `(${s.totalSavedPercent?.toFixed(1) ?? "n/a"}%) · fidelity ${s.fidelityPassed}/${s.trialCount}`
    : `${s.trialCount} tabs · compression ${s.meanCompressionPercent.toFixed(1)}% · ` +
      `fidelity ${s.fidelityPassed}/${s.trialCount} · memory API unavailable (use Task Manager)`;
}

async function refresh(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.textContent = `${t.discarded ? "❄ " : ""}${t.title ?? t.url ?? t.id}`;
    label.title = t.url ?? "";
    const freeze = document.createElement("button");
    freeze.textContent = "Freeze";
    freeze.onclick = async () => {
      if (t.id === undefined) return;
      const r = await send<{ ok: boolean; rawBytes?: number; compressedBytes?: number; error?: string }>({
        type: "LTO_FREEZE_TAB",
        tabId: t.id,
      });
      log(r.ok ? `froze tab ${t.id}: ${r.rawBytes} → ${r.compressedBytes} B` : `freeze failed: ${r.error}`);
      await refresh();
    };
    const restore = document.createElement("button");
    restore.textContent = "Restore";
    restore.onclick = async () => {
      if (t.id === undefined) return;
      const r = await send<{
        ok: boolean;
        hydration?: { totalNodes: number; batches: number; maxBatchMs: number } | null;
        error?: string;
      }>({ type: "LTO_RESTORE_TAB", tabId: t.id });
      log(
        r.ok
          ? `restored tab ${t.id}: ${r.hydration?.totalNodes ?? 0} nodes in ${r.hydration?.batches ?? 0} batches`
          : `restore failed: ${r.error}`,
      );
      await refresh();
    };
    row.append(label, freeze, restore);
    tabsEl.append(row);
  }
}

async function runBenchmark(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const tabIds = tabs
    .filter((t) => t.id !== undefined && !t.discarded && /^https?:\/\//.test(t.url ?? ""))
    .map((t) => t.id as number);
  if (tabIds.length === 0) {
    log("benchmark: no eligible tabs (open some http(s) pages first)");
    return;
  }
  log(`benchmark: measuring ${tabIds.length} tabs…`);
  const r = await send<{ ok: boolean; run?: BenchmarkRun; error?: string }>({
    type: "LTO_BENCH_RUN",
    tabIds,
  });
  if (!r.ok || !r.run) {
    log(`benchmark failed: ${r.error}`);
    return;
  }
  renderSummary(r.run);
  log(`benchmark done: ${r.run.summary.failures} failures, fidelity ${r.run.summary.fidelityPassed}/${r.run.summary.trialCount}`);
  for (const t of r.run.trials.filter((trial) => trial.error).slice(0, 5)) {
    log(`tab ${t.tabId}: ${t.error}`);
  }
  await refresh();
}

async function downloadResults(): Promise<void> {
  const r = await send<{ ok: boolean; run?: BenchmarkRun; error?: string }>({ type: "LTO_BENCH_LATEST" });
  if (!r.ok || !r.run) {
    log(`no results to download: ${r.error ?? "run a benchmark first"}`);
    return;
  }
  const blob = new Blob([JSON.stringify(r.run, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lto-benchmark-${r.run.timestamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("bench")?.addEventListener("click", () => void runBenchmark());
document.getElementById("download")?.addEventListener("click", () => void downloadResults());

void (async () => {
  await refresh();
  const latest = await send<{ ok: boolean; run?: BenchmarkRun | null }>({ type: "LTO_BENCH_LATEST" });
  renderSummary(latest.run ?? null);
})();
