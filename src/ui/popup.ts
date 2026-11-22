/** Popup dashboard: manual freeze/restore + live metrics. No frameworks. */
const tabsEl = document.getElementById("tabs") as HTMLElement;
const logEl = document.getElementById("log") as HTMLElement;

function log(msg: string): void {
  const p = document.createElement("p");
  p.textContent = msg;
  logEl.prepend(p);
}

async function send<T>(type: string, tabId: number): Promise<T> {
  return (await chrome.runtime.sendMessage({ type, tabId })) as T;
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
      const r = await send<{ ok: boolean; rawBytes?: number; compressedBytes?: number; error?: string }>(
        "LTO_FREEZE_TAB",
        t.id,
      );
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
      }>("LTO_RESTORE_TAB", t.id);
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

void refresh();
