/**
 * Cross-platform support for the thesis verification suite.
 *
 * Linux:  PSS from /proc/<pid>/smaps_rollup, process groups + signals.
 * Windows: Working Set (RSS) from PowerShell/CIM, taskkill /T /F.
 *
 * Pure Bun/TypeScript — no Python, smem, zstd CLI or websocket-client needed.
 */

import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const IS_WINDOWS = process.platform === "win32";
export const MEMORY_PSS = "PSS";
export const MEMORY_WORKING_SET = "Working Set (RSS)";
export const CLK_TCK = IS_WINDOWS
  ? 1
  : (Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout?.trim()) || 100);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// --- Chrome discovery --------------------------------------------------------

const CHROME_CANDIDATES = [
  "google-chrome-unstable", "google-chrome", "google-chrome-stable",
  "chromium", "chromium-browser", "microsoft-edge",
];

function windowsChromePaths(): string[] {
  const roots = [
    process.env["PROGRAMFILES"],
    process.env["PROGRAMFILES(X86)"],
    join(homedir(), "AppData", "Local"),
  ].filter(Boolean) as string[];
  const suffixes = [
    join("Google", "Chrome", "Application", "chrome.exe"),
    join("Google", "Chrome SxS", "Application", "chrome.exe"),
    join("Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return roots.flatMap((root) => suffixes.map((s) => join(root, s))).concat([
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]);
}

export function findChrome(
  explicit?: string | null,
  isWindows = IS_WINDOWS,
  which: (name: string) => string | null = (name) => Bun.which(name) ?? null,
): string {
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    const found = which(explicit);
    if (found) return found;
    throw new Error(`Chrome binary not found: ${explicit}`);
  }
  for (const name of CHROME_CANDIDATES) {
    const found = which(name);
    if (found) return found;
  }
  if (isWindows) {
    for (const path of windowsChromePaths()) {
      if (existsSync(path)) return path;
    }
    // App Paths registry key, useful for per-user installs.
    const out = spawnSync("powershell.exe", [
      "-NoProfile", "-Command",
      "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe' -ErrorAction SilentlyContinue).'(default)'",
    ], { encoding: "utf8" });
    const value = out.stdout?.trim();
    if (out.status === 0 && value && existsSync(value)) return value;
  }
  throw new Error("No Chrome/Chromium found. Install Chrome or pass --chrome <path>.");
}

/** Browser version over CDP; `chrome.exe --version` prints nothing on Windows. */
export function chromeVersion(port: number, fallbackBin = ""): string {
  try {
    const res = spawnSync("curl", ["-s", `http://127.0.0.1:${port}/json/version`], {
      encoding: "utf8", timeout: 5000,
    });
    if (res.status === 0 && res.stdout) {
      const browser = JSON.parse(res.stdout).Browser;
      if (browser) return String(browser);
    }
  } catch { /* fall through */ }
  if (fallbackBin) {
    try {
      const res = spawnSync(fallbackBin, ["--version"], { encoding: "utf8", timeout: 10000 });
      const out = res.stdout?.trim();
      if (out) return out;
    } catch { /* fall through */ }
  }
  return "unknown";
}

// --- Machine information -----------------------------------------------------

export function machineMemoryKb(isWindows = IS_WINDOWS): number {
  if (isWindows) {
    const out = spawnSync("powershell.exe", [
      "-NoProfile", "-Command",
      "[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1KB)",
    ], { encoding: "utf8" });
    const value = Number(out.stdout?.trim());
    return Number.isFinite(value) ? value : 0;
  }
  try {
    for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
      if (line.startsWith("MemTotal")) return Number(line.trim().split(/\s+/)[1]) || 0;
    }
  } catch { /* unavailable */ }
  return 0;
}

// --- Process lifecycle -------------------------------------------------------

export function popenOptions(isWindows = IS_WINDOWS): SpawnOptions {
  // Own process group/session so the whole Chrome tree can be killed later
  // without signalling the harness itself (POSIX killpg).
  return { detached: true, stdio: "ignore", windowsHide: true } as SpawnOptions;
}

export function terminateTree(proc: ChildProcess | null | undefined, isWindows = IS_WINDOWS): void {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  const pid = proc.pid;
  if (!pid) return;
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    try { proc.kill(); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* gone */ } }
  const deadline = Date.now() + 10000;
  while (proc.exitCode === null && Date.now() < deadline) {
    // give the group a moment to exit before escalating
    const waited = spawnSync("sleep", ["0.1"]);
    void waited;
  }
  if (proc.exitCode === null) {
    try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

// --- Memory sampling ---------------------------------------------------------

export interface ProcessStat { ppid: number; ticks: number }

export function processTree(rootPid: number): {
  pids: Set<number>; stats: Map<number, ProcessStat>;
} {
  const stats = new Map<number, ProcessStat>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const text = readFileSync(`/proc/${entry}/stat`, "utf8");
      const end = text.lastIndexOf(")");
      if (end < 0) continue;
      const fields = text.slice(end + 2).trim().split(/\s+/);
      stats.set(Number(entry), {
        ppid: Number(fields[1]),
        ticks: Number(fields[11]) + Number(fields[12]),
      });
    } catch { /* process vanished */ }
  }
  const pids = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    if (pids.has(pid) || !stats.has(pid)) continue;
    pids.add(pid);
    for (const [child, stat] of stats) if (stat.ppid === pid) stack.push(child);
  }
  return { pids, stats };
}

/** One process's RSS/PSS in bytes from /proc/<pid>/smaps_rollup. */
export function smapsFor(pid: number): { rss: number; pss: number } {
  let rss = 0, pss = 0;
  try {
    for (const line of readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").split("\n")) {
      if (line.startsWith("Rss:")) rss += (Number(line.trim().split(/\s+/)[1]) || 0) * 1024;
      else if (line.startsWith("Pss:")) pss += (Number(line.trim().split(/\s+/)[1]) || 0) * 1024;
    }
  } catch { /* process vanished */ }
  return { rss, pss };
}

/** RSS and PSS in bytes over the tree (no smem install needed). */
export function memoryFor(pids: Set<number>): { rss: number; pss: number } {
  let rss = 0, pss = 0;
  for (const pid of pids) {
    const value = smapsFor(pid);
    rss += value.rss;
    pss += value.pss;
  }
  return { rss, pss };
}

export interface WinSnapshot {
  [pid: number]: { rss_bytes: number; cpu_seconds: number };
}

export type PowerShellRunner = (script: string) => { status: number | null; stdout?: string };

const defaultPowerShellRunner: PowerShellRunner = (script) =>
  spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });

export function windowsSnapshot(profile: string, run: PowerShellRunner = defaultPowerShellRunner): WinSnapshot {
  const target = profile.replaceAll("'", "''");
  const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine
$roots = $all | Where-Object { $_.CommandLine -like '*${target}*' }
$queue = New-Object System.Collections.Generic.Queue[int]
foreach ($r in $roots) { $queue.Enqueue([int]$r.ProcessId) }
$seen = @{}
while ($queue.Count -gt 0) {
  $currentPid = $queue.Dequeue()
  if ($seen.ContainsKey($currentPid)) { continue }
  $seen[$currentPid] = $true
  foreach ($p in $all) {
    if ([int]$p.ParentProcessId -eq $currentPid) { $queue.Enqueue([int]$p.ProcessId) }
  }
}
$procs = Get-Process -Id $seen.Keys -ErrorAction SilentlyContinue
foreach ($p in $procs) { "$($p.Id),$($p.WorkingSet64),$($p.CPU)" }
`;
  const out = run(script);
  const snapshot: WinSnapshot = {};
  for (const line of (out.stdout ?? "").split("\n")) {
    const parts = line.trim().split(",");
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const rssBytes = Number(parts[1]);
    const cpuSeconds = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(rssBytes) || !Number.isFinite(cpuSeconds)) continue;
    snapshot[pid] = { rss_bytes: rssBytes, cpu_seconds: cpuSeconds };
  }
  return snapshot;
}

export interface MemorySample {
  pids: Set<number>;
  rss: number;
  pss: number;
  pidPss: Map<number, number>;
  ticks: Map<number, number>;
  metric: string;
}

export function sampleMemory(
  rootPid: number,
  profileDir?: string,
  isWindows = IS_WINDOWS,
  runner: PowerShellRunner = defaultPowerShellRunner,
): MemorySample {
  if (isWindows) {
    const snap = profileDir ? windowsSnapshot(profileDir, runner) : {};
    const pids = new Set(Object.keys(snap).map(Number));
    const rss = Object.values(snap).reduce((sum, v) => sum + v.rss_bytes, 0);
    const ticks = new Map<number, number>();
    const pidPss = new Map<number, number>();
    for (const [pidStr, v] of Object.entries(snap)) {
      const pid = Number(pidStr);
      ticks.set(pid, Math.round(v.cpu_seconds * (isWindows ? 1 : CLK_TCK)));
      pidPss.set(pid, v.rss_bytes);
    }
    return { pids, rss, pss: rss, pidPss, ticks, metric: MEMORY_WORKING_SET };
  }
  const { pids, stats } = processTree(rootPid);
  const pidPss = new Map<number, number>();
  const ticks = new Map<number, number>();
  let rss = 0, pss = 0;
  for (const pid of pids) {
    const value = smapsFor(pid);
    rss += value.rss;
    pss += value.pss;
    pidPss.set(pid, value.pss);
    ticks.set(pid, stats.get(pid)?.ticks ?? 0);
  }
  return { pids, rss, pss, pidPss, ticks, metric: MEMORY_PSS };
}

/** Bench JSON -> {mean bytes, metric}. Windows PSS is null; use Working Set. */
export function sampledMemoryMean(result: any): { mean: number | null; metric: string } {
  const stats = result?.stats ?? {};
  const pss = stats.pss_bytes?.mean ?? null;
  if (pss !== null && pss !== undefined) return { mean: pss, metric: MEMORY_PSS };
  return { mean: stats.rss_bytes?.mean ?? null, metric: MEMORY_WORKING_SET };
}

export function decompressRequestJs(payloadB64: string): string {
  return (
    "(async()=>{const r=await chrome.runtime.sendMessage({type:'LTO_OFFSCREEN_DECOMPRESS'," +
    "payloadB64:" + JSON.stringify(payloadB64) + "});" +
    "if(!r||!r.ok)throw new Error((r&&r.error)||'decompress failed');" +
    "return r.resultB64})()"
  );
}
