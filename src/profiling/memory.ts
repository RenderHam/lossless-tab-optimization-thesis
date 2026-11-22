/**
 * Memory sampling via chrome.processes (Chrome-only, Dev-channel API).
 *
 * If the API is unavailable (stable Chrome), the benchmark still runs and
 * records `memoryApiAvailable: false`; memory can then be read manually from
 * Chrome's Task Manager. Nothing here guesses or estimates RSS — a sample is
 * returned only when the browser actually reports it.
 */

export interface LtoProcessInfo {
  id: number;
  type: string;
  privateMemory?: number;
  jsMemoryUsed?: number;
  tasks?: Array<{ tabId?: number; title?: string }>;
}

interface ProcessesApi {
  getProcessIdForTab(tabId: number): Promise<number>;
  getProcessInfo(processIds: number | number[], includeMemory: boolean): Promise<Record<string, LtoProcessInfo> | LtoProcessInfo[]>;
}

export interface MemorySample {
  tabId: number;
  processId: number;
  privateMemoryBytes: number;
  jsMemoryUsedBytes: number;
}

export interface RendererTotal {
  rendererCount: number;
  privateMemoryBytes: number;
}

export function processesApi(): ProcessesApi | undefined {
  return (chrome as unknown as { processes?: ProcessesApi }).processes;
}

export function isMemoryApiAvailable(): boolean {
  return processesApi() !== undefined;
}

function pickInfo(
  infos: Record<string, LtoProcessInfo> | LtoProcessInfo[],
  pid: number,
): LtoProcessInfo | undefined {
  if (Array.isArray(infos)) return infos.find((p) => p.id === pid);
  return infos[String(pid)];
}

/** Exact RSS sample for one tab's renderer, or null if the browser doesn't report it. */
export async function sampleTabRenderer(tabId: number): Promise<MemorySample | null> {
  const api = processesApi();
  if (!api) return null;
  try {
    const pid = await api.getProcessIdForTab(tabId);
    if (!pid) return null; // discarded tabs have no renderer
    const infos = await api.getProcessInfo([pid], true);
    const info = pickInfo(infos, pid);
    if (!info) return null;
    return {
      tabId,
      processId: pid,
      privateMemoryBytes: info.privateMemory ?? 0,
      jsMemoryUsedBytes: info.jsMemoryUsed ?? 0,
    };
  } catch {
    return null;
  }
}

/** Sum of private memory across all renderer processes, reported by Chrome. */
export async function sampleAllRenderers(): Promise<RendererTotal | null> {
  const api = processesApi();
  if (!api) return null;
  try {
    const infos = await api.getProcessInfo([], true);
    const list = Array.isArray(infos) ? infos : Object.values(infos);
    const renderers = list.filter((p) => p.type === "renderer");
    let total = 0;
    for (const p of renderers) total += p.privateMemory ?? 0;
    return { rendererCount: renderers.length, privateMemoryBytes: total };
  } catch {
    return null;
  }
}
