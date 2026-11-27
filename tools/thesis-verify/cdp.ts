/**
 * Minimal Chrome DevTools Protocol client in TypeScript.
 *
 * Chrome 137+ blocks `--load-extension`, so the extension is loaded through
 * `Extensions.loadUnpacked` over CDP. Uses Bun's built-in WebSocket and fetch
 * — no websocket-client package, no Python.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { popenOptions, terminateTree } from "./platform_support.ts";

export class CDPError extends Error {}

export async function http(port: number, path: string, method = "GET"): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new CDPError(`CDP HTTP ${response.status}: ${path}`);
  return response.json();
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Connection {
  private ws: WebSocket | null = null;
  private ready: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private queue: string[] = [];

  constructor(private url: string, private timeoutMs = 30000) {
    this.ready = this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        settled = true;
        for (const message of this.queue) ws.send(message);
        this.queue = [];
        resolve();
      };
      ws.onmessage = (event) => {
        const data = event.data;
        if (typeof data !== "string") return;
        let reply: any;
        try { reply = JSON.parse(data); } catch { return; }
        const entry = reply.id !== undefined ? this.pending.get(Number(reply.id)) : undefined;
        if (!entry) return; // event or unrelated reply
        clearTimeout(entry.timer);
        this.pending.delete(Number(reply.id));
        if (reply.error) entry.reject(new CDPError(reply.error.message ?? "CDP error"));
        else entry.resolve(reply.result ?? {});
      };
      ws.onerror = () => {
        if (!settled) { settled = true; reject(new CDPError(`WebSocket error: ${this.url}`)); }
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new CDPError("WebSocket error"));
        }
        this.pending.clear();
      };
      ws.onclose = () => {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new CDPError("WebSocket closed"));
        }
        this.pending.clear();
      };
    });
  }

  async call(method: string, params: Record<string, any> = {}, timeoutMs?: number): Promise<any> {
    await this.ready;
    const id = ++this.nextId;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CDPError(`timeout waiting for ${method}`));
      }, timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(message);
      else this.queue.push(message);
    });
  }

  close(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}

export class Page {
  constructor(public conn: Connection) {}

  async evaluate(expression: string, awaitPromise = true, timeoutMs = 30000): Promise<any> {
    const result = await this.conn.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new CDPError(`page eval failed: ${desc}`);
    }
    return result.result?.value;
  }

  async waitReady(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate("document.readyState", false, 5000) === "complete") return;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new CDPError("page never reached readyState complete");
  }

  async screenshot(path: string): Promise<void> {
    await this.conn.call("Page.enable");
    const result = await this.conn.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(result.data, "base64"));
  }

  close(): void { this.conn.close(); }
}

export interface SessionOptions {
  port: number;
  profileDir: string;
  chromeBin: string;
  extensionDir?: string | null;
  extraFlags?: string[];
  urls?: string[];
  headlessNew?: boolean;
}

export class ChromeSession {
  proc: ChildProcess | null = null;
  browser: Connection | null = null;
  extensionId: string | null = null;

  constructor(private options: SessionOptions) {}

  async start(timeoutMs = 30000): Promise<void> {
    const o = this.options;
    const cmd = [
      o.chromeBin,
      `--user-data-dir=${o.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${o.port}`,
      "--remote-allow-origins=*",
      "--enable-unsafe-extension-debugging",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=MemorySaverMode,CalculateNativeWinOcclusion",
      "--disable-component-update",
    ];
    if (o.headlessNew) cmd.push("--headless=new");
    cmd.push(...(o.extraFlags ?? []));
    cmd.push(...(o.urls ?? []));
    if (!(o.urls ?? []).length) cmd.push("about:blank");
    this.proc = spawn(cmd[0], cmd.slice(1), popenOptions());

    let lastError: unknown;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const version = await http(o.port, "/json/version");
        this.browser = new Connection(version.webSocketDebuggerUrl);
        await this.browser.call("Browser.getVersion");
        break;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!this.browser) throw new CDPError(`Chrome did not start on port ${o.port}: ${lastError}`);
    if (o.extensionDir) await this.loadExtension(o.extensionDir);
  }

  async loadExtension(path: string): Promise<string> {
    if (!this.browser) throw new CDPError("browser not connected");
    const result = await this.browser.call("Extensions.loadUnpacked", { path }, 20000);
    if (!result.id) throw new CDPError(`Extensions.loadUnpacked returned no id: ${JSON.stringify(result)}`);
    this.extensionId = result.id;
    return result.id;
  }

  stop(): void {
    this.browser?.close();
    terminateTree(this.proc);
    this.proc = null;
  }

  async targets(): Promise<any[]> {
    return http(this.options.port, "/json/list");
  }

  async findTarget(urlPrefix: string, type: string | null = "page"): Promise<any | null> {
    for (const target of await this.targets()) {
      if (String(target.url ?? "").startsWith(urlPrefix) && (!type || target.type === type)) return target;
    }
    return null;
  }

  async newTab(url: string): Promise<any> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        return await http(this.options.port, `/json/new?${encodeURIComponent(url)}`, "PUT");
      } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    throw new CDPError(`could not open tab: ${url}`);
  }

  async closeTab(targetId: string): Promise<void> {
    try { await http(this.options.port, `/json/close/${targetId}`); } catch { /* already closed */ }
  }

  async page(urlPrefix: string, waitMs = 15000): Promise<Page> {
    const deadline = Date.now() + waitMs;
    while (true) {
      const target = await this.findTarget(urlPrefix);
      if (target?.webSocketDebuggerUrl) return new Page(new Connection(target.webSocketDebuggerUrl));
      if (Date.now() > deadline) throw new CDPError(`no target for ${urlPrefix} within ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
