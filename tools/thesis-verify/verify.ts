#!/usr/bin/env bun
/**
 * Thesis verification harness (TypeScript, Bun-only).
 *
 * Runs the recorded matrix T01..T10 against the built extension in a real
 * Chrome, driving freeze/restore through the extension's own message
 * protocol. Every run — including failures and aborted runs — is recorded as
 * JSON + report.md under results/verification/<run-id>/. Nothing is deleted.
 *
 *   bun tools/thesis-verify/verify.ts run --tests all
 *   bun tools/thesis-verify/verify.ts report --run <run-id>
 *   bun tools/thesis-verify/verify.ts summary
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CDPError, ChromeSession, Page } from "./cdp.ts";
import {
  CLK_TCK, IS_WINDOWS, MEMORY_PSS, MEMORY_WORKING_SET,
  chromeVersion, decompressRequestJs, findChrome, machineMemoryKb,
  sampleMemory, sampledMemoryMean, sleep,
} from "./platform_support.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const RESULTS = join(ROOT, "results", "verification");
const PROFILES = join(HERE, "profiles");
const DIST = join(ROOT, "dist");
const FIXTURE_PORT = 8123;
const CDP_PORT = 9226;

const THRESHOLDS: Record<string, number> = {
  T01_freeze_success_rate: 0.95,
  T04_element_ratio_max: 1.10,
  T05_per_tab_mean_pct: 70.0,
  T05_per_tab_p10_pct: 60.0,
  T06_aggregate_pct: 50.0,
  T07_overhead_ratio_max: 1.10,
  T08_freeze_p95_ms: 2000.0,
  T08_restore_p95_ms: 5000.0,
  T08_max_batch_ms: 50.0,
  T10_slope_pct_per_cycle: 1.0,
};

const TEST_NAMES: Record<string, string> = {
  T01: "freeze success rate",
  T02: "byte-exact fidelity after freeze/restore",
  T03: "restore mode correctness (+ auto-restore)",
  T04: "no duplicated UI after restore",
  T05: "per-tab memory saving",
  T06: "aggregate memory saving across 50 tabs",
  T07: "extension idle memory overhead",
  T08: "freeze/restore latency and spikes",
  T09: "determinism of capture+compression",
  T10: "stress: 20 freeze/restore cycles, leak check",
};

// --- Small helpers -----------------------------------------------------------

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));
const mean = (values: number[]): number => values.length
  ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const floorMean = (values: number[]): number => Math.floor(mean(values));

function percentile(values: (number | null | undefined)[], percent: number): number | null {
  const clean = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  // nearest rank, deterministic (same as the Python harness)
  return clean[Math.max(0, Math.ceil(clean.length * percent / 100) - 1)];
}
const p95 = (values: (number | null | undefined)[]) => percentile(values, 95);
const p10 = (values: (number | null | undefined)[]) => percentile(values, 10);
const nowIso = (): string => new Date().toISOString();

function firstDiff(a: string, b: string): string {
  if (a === b) return "";
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const lo = Math.max(0, i - 60);
  return `at char ${i}: ...${JSON.stringify(a.slice(lo, i + 60))} vs ...${JSON.stringify(b.slice(lo, i + 60))}` +
    ` (len ${a.length} vs ${b.length})`;
}

function compareSnapshots(a: any, b: any, scrollTol = 2): Record<string, any> {
  const htmlOk = a.html === b.html;
  const formsOk = JSON.stringify(a.forms) === JSON.stringify(b.forms);
  const scrollDelta = Math.max(Math.abs(a.scroll[0] - b.scroll[0]), Math.abs(a.scroll[1] - b.scroll[1]));
  return {
    html_equal: htmlOk,
    forms_equal: formsOk,
    scroll_ok: scrollDelta <= scrollTol,
    scroll_before: a.scroll,
    scroll_after: b.scroll,
    elements_before: a.elements,
    elements_after: b.elements,
    html_diff: htmlOk ? "" : firstDiff(a.html, b.html),
    forms_before: a.forms,
    forms_after: b.forms,
  };
}

// --- Page-side JS ------------------------------------------------------------

const SNAPSHOT_JS = `(() => {
  const root = document.documentElement.cloneNode(true);
  root.querySelectorAll('[data-lto-id]').forEach(e => e.removeAttribute('data-lto-id'));
  root.querySelectorAll('input').forEach(e => e.removeAttribute('value'));
  root.querySelectorAll('textarea').forEach(e => { e.textContent = ''; });
  root.querySelectorAll('option[selected]').forEach(e => e.removeAttribute('selected'));
  const forms = [...document.querySelectorAll('input, textarea, select')].map((el, i) => {
    const tag = el.tagName;
    let v;
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) v = el.checked;
    else if (tag === 'SELECT') v = el.multiple ? [...el.selectedOptions].map(o => o.value) : el.value;
    else v = el.value;
    return { i, tag, type: el.type || '', id: el.id || '', name: el.name || '', v };
  });
  return {
    url: location.href, title: document.title, html: root.outerHTML, forms,
    scroll: [Math.round(window.scrollX), Math.round(window.scrollY)],
    elements: document.querySelectorAll('*').length,
    bodyChildren: document.body ? document.body.children.length : -1,
    ready: document.readyState,
  };
})()`;

const TYPING_JS = `(() => {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('f-name', 'typed-name-42');
  set('f-nick', 'typed-nick-7');
  set('f-pw', 'typed-secret');
  const agree = document.getElementById('f-agree');
  if (agree) agree.checked = false;
  const radios = document.querySelectorAll('input[name="plan"]');
  if (radios[0]) radios[0].checked = true;
  set('f-bio', 'typed bio line one\\nline two');
  set('f-country', 'br');
  const langs = document.getElementById('f-langs');
  if (langs) [...langs.options].forEach(o => { o.selected = (o.value === 'pt' || o.value === 'de'); });
  window.scrollTo(0, 1200);
  return true;
})()`;

const IDB_LIST_JS = `(async()=>{
  const db = await new Promise((res,rej)=>{
    const r=indexedDB.open('lto-db');
    r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('lto-chunks'))
      r.result.createObjectStore('lto-chunks')};
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
  const st = db.transaction('lto-chunks','readonly').objectStore('lto-chunks');
  const keys = await new Promise((res,rej)=>{const r=st.getAllKeys();
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
  const metas=[];
  for (const k of keys){
    if (typeof k==='string' && k.endsWith('/meta')){
      metas.push(await new Promise((res,rej)=>{const r=st.get(k);
        r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))}));
    }
  }
  db.close();
  return metas;
})()`;

function chunksJs(tabId: number): string {
  return `(async()=>{
    const db = await new Promise((res,rej)=>{
      const r=indexedDB.open('lto-db');
      r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('lto-chunks'))
        r.result.createObjectStore('lto-chunks')};
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
    const st = db.transaction('lto-chunks','readonly').objectStore('lto-chunks');
    const keys = await new Promise((res,rej)=>{const r=st.getAllKeys();
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
    const prefix = 'tab-${tabId}/chunk-';
    const idxs = keys.filter(k=>typeof k==='string'&&k.startsWith(prefix))
      .map(k=>parseInt(k.slice(prefix.length),10)).sort((a,b)=>a-b);
    const parts=[];
    let total=0;
    for (const i of idxs){
      const buf = await new Promise((res,rej)=>{const r=st.get(prefix+String(i).padStart(6,'0'));
        r.onsuccess=()=>res(r.result); r.onerror=()=>rej(String(r.error))});
      const u8 = new Uint8Array(buf);
      parts.push(u8); total+=u8.length;
    }
    db.close();
    const all = new Uint8Array(total);
    let off=0; for (const p of parts){all.set(p,off); off+=p.length;}
    let bin='';
    const CH=0x8000;
    for (let i=0;i<all.length;i+=CH){
      bin += String.fromCharCode.apply(null, all.subarray(i,i+CH));
    }
    return btoa(bin);
  })()`;
}

// --- Fixture server (Bun.serve, no Python http.server) ------------------------

class FixtureServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  async start(): Promise<void> {
    if (this.server) return;
    this.server = Bun.serve({
      port: FIXTURE_PORT,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const pathname = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
        const file = join(FIXTURES, pathname || "index.html");
        if (!file.startsWith(FIXTURES) || !existsSync(file)) {
          return new Response("not found", { status: 404 });
        }
        const body = readFileSync(file);
        const type = file.endsWith(".html") ? "text/html; charset=utf-8"
          : file.endsWith(".js") ? "text/javascript; charset=utf-8"
          : "application/octet-stream";
        return new Response(body, { headers: { "content-type": type } });
      },
    });
    // Wait until it actually accepts connections. Use async fetch — a
    // synchronous curl would block Bun's event loop and starve the server.
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${FIXTURE_PORT}/empty.html`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) return;
      } catch { /* retry */ }
      await sleep(100);
    }
    throw new Error("fixture server did not come up");
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }
}

// --- Sampler ---------------------------------------------------------------

class Sampler {
  readonly memoryMetric = IS_WINDOWS ? MEMORY_WORKING_SET : MEMORY_PSS;
  samples: any[] = [];
  private stopFlag = false;
  private captureDone: Promise<void> | null = null;

  constructor(private rootPid: number, private profileDir?: string, private intervalMs = 500) {}

  snapshot(): Record<string, any> {
    const sample = sampleMemory(this.rootPid, this.profileDir);
    let ticks = 0;
    for (const value of sample.ticks.values()) ticks += value;
    return {
      t: Date.now() / 1000,
      processes: sample.pids.size,
      rss: sample.rss,
      pss: sample.pss,
      pidPss: sample.pidPss,
      ticks,
      metric: sample.metric,
    };
  }

  async average(n = 3, gapMs = 400): Promise<Record<string, any>> {
    const snaps: any[] = [];
    for (let i = 0; i < n; i++) {
      snaps.push(this.snapshot());
      if (i < n - 1) await sleep(gapMs);
    }
    return {
      pss: floorMean(snaps.map((s) => s.pss)),
      rss: floorMean(snaps.map((s) => s.rss)),
      processes: snaps[snaps.length - 1].processes,
      pidPss: snaps[snaps.length - 1].pidPss,
      snapshots: n,
    };
  }

  async waitStable(timeoutMs = 15000, tolerance = 0.02, minReads = 3,
                   gapMs = 500, minWaitMs = 0): Promise<number> {
    const reads: number[] = [];
    const start = Date.now();
    const deadline = start + timeoutMs;
    while (Date.now() < deadline) {
      reads.push(this.snapshot().pss);
      if (Date.now() - start >= minWaitMs && reads.length >= minReads) {
        const window = reads.slice(-minReads);
        const spread = Math.max(...window) - Math.min(...window);
        if (spread <= Math.max(...window) * tolerance) return window[window.length - 1];
      }
      await sleep(gapMs);
    }
    return reads.length ? reads[reads.length - 1] : 0;
  }

  startCapture(): void {
    this.samples = [];
    this.stopFlag = false;
    this.captureDone = (async () => {
      let prev: any = null;
      while (!this.stopFlag) {
        const s = this.snapshot();
        let cpu: number | null = null;
        if (prev) {
          const dt = s.t - prev.t;
          if (dt > 0) cpu = (s.ticks - prev.ticks) / CLK_TCK / dt * 100;
        }
        s.cpu = cpu;
        this.samples.push(s);
        prev = s;
        await sleep(this.intervalMs);
      }
    })();
  }

  async stopCapture(): Promise<Record<string, any>> {
    this.stopFlag = true;
    if (this.captureDone) await this.captureDone;
    const cpus = this.samples.map((s) => s.cpu).filter((v): v is number => typeof v === "number");
    return {
      samples: this.samples.length,
      peak_pss: this.samples.length ? Math.max(...this.samples.map((s) => s.pss)) : null,
      peak_rss: this.samples.length ? Math.max(...this.samples.map((s) => s.rss)) : null,
      peak_cpu_pct: cpus.length ? Math.max(...cpus) : null,
      series: this.samples.map((s) => ({ t: round(s.t, 2), pss: s.pss, cpu: s.cpu })),
    };
  }
}

// --- Extension driver -------------------------------------------------------

class Ext {
  private pageCache: Page | null = null;
  constructor(private session: ChromeSession) {}

  get popupUrl(): string {
    if (!this.session.extensionId) throw new Error("extension not loaded");
    return `chrome-extension://${this.session.extensionId}/src/ui/popup.html`;
  }

  async page(): Promise<Page> {
    if (!this.pageCache) {
      if (!await this.session.findTarget(this.popupUrl)) await this.session.newTab(this.popupUrl);
      const page = await this.session.page(this.popupUrl, 20000);
      await page.waitReady(15000);
      this.pageCache = page;
    }
    return this.pageCache;
  }

  async eval(expr: string, timeoutMs = 60000): Promise<any> {
    try {
      return await (await this.page()).evaluate(expr, true, timeoutMs);
    } catch (error) {
      if (!(error instanceof CDPError)) throw error;
      this.pageCache = null;
      return (await this.page()).evaluate(expr, true, timeoutMs);
    }
  }

  async tabs(): Promise<any[]> {
    return await this.eval(
      `(async()=>{const t=await chrome.tabs.query({});return t.map(x=>({id:x.id,url:x.url,active:x.active,discarded:x.discarded,title:x.title||''}))})()`,
    ) ?? [];
  }

  async tabIdFor(url: string): Promise<number | null> {
    for (const tab of await this.tabs()) if (tab.url === url) return tab.id;
    return null;
  }

  async activate(tabId: number): Promise<void> {
    await this.eval(`(async()=>{await chrome.tabs.update(${tabId},{active:true});return true})()`);
  }

  async activateControl(): Promise<void> {
    const tabs = await this.tabs();
    if (tabs.some((t) => String(t.url ?? "").startsWith("chrome-extension://") && t.active)) return;
    for (const tab of tabs) {
      if (tab.url === this.popupUrl) { await this.activate(tab.id); return; }
    }
  }

  async freeze(tabId: number, timeoutMs = 90000): Promise<any> {
    return this.eval(`(async()=>await chrome.runtime.sendMessage({type:'LTO_FREEZE_TAB',tabId:${tabId}}))()`, timeoutMs);
  }

  async restore(tabId: number, timeoutMs = 120000): Promise<any> {
    return this.eval(`(async()=>await chrome.runtime.sendMessage({type:'LTO_RESTORE_TAB',tabId:${tabId}}))()`, timeoutMs);
  }

  async deleteSnapshot(tabId: number): Promise<any> {
    return this.eval(`(async()=>await chrome.runtime.sendMessage({type:'LTO_DELETE_SNAPSHOT',tabId:${tabId}}))()`);
  }

  async snapshots(): Promise<any[]> {
    return await this.eval(IDB_LIST_JS) ?? [];
  }

  async chunksB64(tabId: number): Promise<string> {
    return this.eval(chunksJs(tabId), 60000);
  }

  async decompressB64(payloadB64: string, timeoutMs = 60000): Promise<string> {
    return this.eval(decompressRequestJs(payloadB64), timeoutMs);
  }

  async cleanupSnapshots(): Promise<number> {
    let metas: any[];
    try { metas = await this.snapshots(); }
    catch (error) { console.log(`  warning: could not list snapshots: ${error}`); return 0; }
    for (const meta of metas) {
      try { await this.deleteSnapshot(meta.tabId); } catch { /* ignore */ }
    }
    return metas.length;
  }
}

// --- Harness ---------------------------------------------------------------

interface Args {
  tests: string; run?: string; tabs: number; smallTabs: number;
  benchTabs: number; cycles: number; keepProfile: boolean; chrome?: string;
}

class Harness {
  readonly runId: string;
  readonly runDir: string;
  readonly profileDir: string;
  readonly server = new FixtureServer();
  session: ChromeSession | null = null;
  ext: Ext | null = null;
  sampler: Sampler | null = null;
  chromeBin: string;
  private hostSeq = 0;

  constructor(readonly args: Args) {
    this.runId = args.run ?? new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    this.runDir = join(RESULTS, this.runId);
    this.profileDir = join(PROFILES, this.runId);
    mkdirSync(this.runDir, { recursive: true });
    this.chromeBin = findChrome(args.chrome ?? null);
  }

  async start(): Promise<void> {
    await this.server.start();
    rmSync(this.profileDir, { recursive: true, force: true });
    mkdirSync(this.profileDir, { recursive: true });
    this.session = new ChromeSession({
      port: CDP_PORT,
      profileDir: this.profileDir,
      chromeBin: this.chromeBin,
      extensionDir: DIST,
      extraFlags: ["--host-resolver-rules=MAP *.lto.test 127.0.0.1"],
    });
    await this.session.start();
    if (!this.session.extensionId) throw new Error("extension did not load");
    this.ext = new Ext(this.session);
    this.sampler = new Sampler(this.session.proc!.pid!, this.profileDir);
    this.writeEnv();
  }

  stop(): void {
    this.session?.stop();
    this.server.stop();
    if (!this.args.keepProfile) rmSync(this.profileDir, { recursive: true, force: true });
  }

  async openFixture(name: string): Promise<string> {
    const host = `x${String(++this.hostSeq).padStart(3, "0")}.lto.test`;
    const url = `http://${host}:${FIXTURE_PORT}/${name}`;
    await this.session!.newTab(url);
    const page = await this.session!.page(url, 20000);
    await page.waitReady(20000);
    await sleep(400);
    return url;
  }

  pageFor(url: string, waitMs = 10000): Promise<Page> {
    return this.session!.page(url, waitMs);
  }

  async tabId(url: string): Promise<number> {
    const id = await this.ext!.tabIdFor(url);
    if (id === null) throw new Error(`no chrome tab for ${url}`);
    return id;
  }

  async freezeUrl(url: string): Promise<[number, any]> {
    await this.ext!.activateControl();
    const id = await this.tabId(url);
    return [id, await this.ext!.freeze(id)];
  }

  async restoreUrl(url: string): Promise<[number, any]> {
    const id = await this.tabId(url);
    return [id, await this.ext!.restore(id)];
  }

  async closeUrls(urls: string[]): Promise<void> {
    for (const url of urls) {
      const target = await this.session!.findTarget(url);
      if (target) await this.session!.closeTab(target.id);
    }
  }

  async warmupExtension(): Promise<void> {
    const url = await this.openFixture("light.html");
    await this.freezeUrl(url);
    await this.restoreUrl(url);
    await this.closeUrls([url]);
  }

  writeEnv(): void {
    const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    const osName = platform() === "win32" ? "Windows" : platform() === "darwin" ? "macOS" : "Linux";
    const env = {
      run: this.runId,
      timestamp: nowIso(),
      chrome: chromeVersion(CDP_PORT, this.chromeBin),
      git_rev: git.status === 0 ? git.stdout?.trim() : "unknown",
      extension_id: this.session?.extensionId ?? null,
      extension_dir: DIST,
      bun: Bun.version,
      os: osName,
      machine: { cpu_count: navigator.hardwareConcurrency ?? null, mem_total_kb: machineMemoryKb() },
      memory_metric: this.sampler?.memoryMetric ?? "unknown",
      memory_backend: IS_WINDOWS ? "windows-cim-working-set" : "linux-proc-smaps",
      thresholds: THRESHOLDS,
    };
    writeFileSync(join(this.runDir, "env.json"), JSON.stringify(env, null, 2));
  }

  record(test: string, result: string, metrics: any, extra: Record<string, any> = {}): void {
    let path = join(this.runDir, `${test}.json`);
    let n = 2;
    while (existsSync(path)) path = join(this.runDir, `${test}-${n++}.json`);
    const doc: Record<string, any> = {
      test, name: TEST_NAMES[test] ?? test, run: this.runId,
      started: extra.started ?? nowIso(), finished: nowIso(),
      threshold: extra.threshold ?? "", result, metrics,
      notes: extra.notes ?? [], artifacts: extra.artifacts ?? [], config: extra.config ?? {},
    };
    if (extra.error) doc.error = extra.error;
    writeFileSync(path, JSON.stringify(doc, null, 2));
    console.log(`[${test}] ${result.toUpperCase()}${extra.error ? ` — ${extra.error}` : ""}`);
  }
}

// --- T01–T10 ---------------------------------------------------------------

async function t01(ctx: Harness): Promise<void> {
  const n = ctx.args.tabs;
  const started = nowIso();
  const urls: string[] = [];
  const rows: any[] = [];
  try {
    for (let i = 0; i < n; i++) urls.push(await ctx.openFixture("light.html"));
    await ctx.ext!.activateControl();
    await sleep(2000);
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const [tid, resp] = await ctx.freezeUrl(url);
        const meta = (await ctx.ext!.snapshots()).find((m) => m.tabId === tid);
        rows.push({
          url, ok: !!resp?.ok, rawBytes: resp?.rawBytes, compressedBytes: resp?.compressedBytes,
          timings: resp?.timings, meta_present: !!meta, error: resp?.error,
        });
      } catch (error) {
        rows.push({ url, ok: false, error: String(error) });
      }
      console.log(`  T01 ${i + 1}/${n}: ${rows[rows.length - 1].ok ? "ok" : rows[rows.length - 1].error}`);
    }
    const excluded = rows.filter((r) => r.rawBytes === 0 && r.ok);
    const failed = rows.filter((r) => !r.ok && !excluded.includes(r));
    const successes = rows.filter((r) => r.ok && (r.rawBytes ?? 0) > 0 && r.meta_present);
    const eligible = rows.length - excluded.length;
    const rate = eligible ? successes.length / eligible : 0;
    const result = eligible && rate >= THRESHOLDS.T01_freeze_success_rate ? "pass" : "fail";
    ctx.record("T01", result, {
      attempted: rows.length, eligible, succeeded: successes.length,
      excluded_auto_discarded: excluded.length, failed: failed.length,
      success_rate: round(rate, 4),
      freeze_total_ms: successes.map((r) => r.timings?.totalMs).filter((v) => v !== undefined),
      rows,
    }, {
      threshold: `success rate >= ${Math.round(THRESHOLDS.T01_freeze_success_rate * 100)}% of eligible tabs`,
      config: { tabs: n, fixture: "light.html" }, started,
      notes: [failed.length ? `${failed.length} freeze(s) failed` : "all eligible tabs froze"],
    });
  } catch (error) {
    ctx.record("T01", "error", { rows }, { error: String(error), started, config: { tabs: n, fixture: "light.html" } });
  } finally {
    await ctx.closeUrls(urls);
    if (ctx.ext) await ctx.ext.cleanupSnapshots();
  }
}

async function t02(ctx: Harness): Promise<void> {
  const started = nowIso();
  const urls: string[] = [];
  try {
    const uForm = await ctx.openFixture("form.html");
    const uDyn = await ctx.openFixture("dynamic.html");
    urls.push(uForm, uDyn);
    await (await ctx.pageFor(uForm)).evaluate(TYPING_JS);
    await (await ctx.pageFor(uDyn)).evaluate("window.scrollTo(0, 800); true");
    await sleep(300);

    const before: Record<string, any> = {}, after: Record<string, any> = {};
    for (const url of urls) {
      before[url] = await (await ctx.pageFor(url)).evaluate(SNAPSHOT_JS, true, 30000);
      try { await (await ctx.pageFor(url)).screenshot(join(ctx.runDir, `T02-before-${url.split("/")[2].split(".")[0]}.png`)); } catch { /* optional */ }
    }
    for (const url of urls) await ctx.freezeUrl(url);
    const restores: Record<string, any> = {};
    for (const url of urls) restores[url] = (await ctx.restoreUrl(url))[1];
    await sleep(500);
    for (const url of urls) {
      after[url] = await (await ctx.pageFor(url)).evaluate(SNAPSHOT_JS, true, 30000);
      try { await (await ctx.pageFor(url)).screenshot(join(ctx.runDir, `T02-after-${url.split("/")[2].split(".")[0]}.png`)); } catch { /* optional */ }
    }
    const comparisons: Record<string, any> = {};
    for (const url of urls) comparisons[url] = compareSnapshots(before[url], after[url]);
    const allOk = Object.values(comparisons).every((c) => c.html_equal && c.forms_equal && c.scroll_ok);
    const restoreOk = Object.values(restores).every((r) => r?.ok);
    const notes: string[] = [];
    for (const [url, c] of Object.entries(comparisons)) {
      if (!(c.html_equal && c.forms_equal && c.scroll_ok)) notes.push(`${url}: ${c.html_diff || "forms/scroll mismatch"}`);
    }
    ctx.record("T02", allOk && restoreOk ? "pass" : "fail", {
      tabs: urls, comparisons, restore_responses: restores,
    }, {
      threshold: "html == AND form values == AND scroll ±2px for every tab",
      config: { fixture: ["form.html", "dynamic.html"] }, started, notes,
      artifacts: readdirSync(ctx.runDir).filter((f) => f.startsWith("T02-") && f.endsWith(".png")).sort(),
    });
  } catch (error) {
    ctx.record("T02", "error", {}, { error: String(error), started });
  } finally {
    await ctx.closeUrls(urls);
    if (ctx.ext) await ctx.ext.cleanupSnapshots();
  }
}

async function t03(ctx: Harness): Promise<void> {
  const started = nowIso();
  const urls: string[] = [];
  try {
    const uForm = await ctx.openFixture("form.html");
    const uEmpty = await ctx.openFixture("empty.html");
    urls.push(uForm, uEmpty);
    await (await ctx.pageFor(uForm)).evaluate(TYPING_JS);
    const modes: Record<string, any> = {};
    for (const url of urls) {
      await ctx.freezeUrl(url);
      const resp = (await ctx.restoreUrl(url))[1] ?? {};
      modes[url] = {
        ok: resp.ok, mode: resp.hydration?.mode, totalNodes: resp.hydration?.totalNodes,
        formApplied: resp.hydration?.formApplied, error: resp.error,
      };
    }
    await ctx.freezeUrl(uForm);
    const tid = await ctx.tabId(uForm);
    await ctx.ext!.activate(tid);
    let autoOk = false, autoDetail = "";
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const tabs = await ctx.ext!.tabs();
        const tab = tabs.find((t) => t.id === tid);
        if (tab && !tab.discarded) {
          const snap = await (await ctx.pageFor(uForm)).evaluate(SNAPSHOT_JS, true, 10000);
          const vals: Record<string, any> = {};
          for (const f of snap.forms) if (f.id) vals[f.id] = f.v;
          if (vals["f-name"] === "typed-name-42") { autoOk = true; break; }
          autoDetail = `tab live but values not restored: ${JSON.stringify(vals["f-name"])}`;
        }
      } catch (error) { autoDetail = String(error); }
      await sleep(500);
    }
    const expectOverlay = modes[uForm]?.mode === "overlay";
    const expectFull = modes[uEmpty]?.mode === "full";
    const notes: string[] = [];
    if (!expectOverlay) notes.push(`form.html mode=${modes[uForm]?.mode}, expected overlay`);
    if (!expectFull) notes.push(`empty.html mode=${modes[uEmpty]?.mode}, expected full`);
    if (!autoOk) notes.push(`auto-restore on activation failed: ${autoDetail}`);
    ctx.record("T03", expectOverlay && expectFull && autoOk ? "pass" : "fail", {
      modes, auto_restore_ok: autoOk,
    }, {
      threshold: "form page => overlay; empty page => full; activation auto-restores typed value",
      config: { fixture: ["form.html", "empty.html"] }, started, notes,
    });
  } catch (error) {
    ctx.record("T03", "error", {}, { error: String(error), started });
  } finally {
    await ctx.closeUrls(urls);
    if (ctx.ext) await ctx.ext.cleanupSnapshots();
  }
}

async function t04(ctx: Harness): Promise<void> {
  const started = nowIso();
  const urls: string[] = [];
  try {
    for (const name of ["form.html", "dynamic.html", "heavy.html"]) urls.push(await ctx.openFixture(name));
    await ctx.ext!.activateControl();
    const before: Record<string, any> = {}, after: Record<string, any> = {};
    const artifacts: string[] = [];
    for (const url of urls) {
      before[url] = await (await ctx.pageFor(url)).evaluate(SNAPSHOT_JS, true, 30000);
      try {
        const name = `T04-before-${url.split("/")[2].split(".")[0]}.png`;
        await (await ctx.pageFor(url)).screenshot(join(ctx.runDir, name));
        artifacts.push(name);
      } catch { /* optional */ }
    }
    for (const url of urls) await ctx.freezeUrl(url);
    for (const url of urls) await ctx.restoreUrl(url);
    await sleep(500);
    for (const url of urls) {
      after[url] = await (await ctx.pageFor(url)).evaluate(SNAPSHOT_JS, true, 30000);
      try {
        const name = `T04-after-${url.split("/")[2].split(".")[0]}.png`;
        await (await ctx.pageFor(url)).screenshot(join(ctx.runDir, name));
        artifacts.push(name);
      } catch { /* optional */ }
    }
    const ratios: Record<string, number | null> = {}, perTab: Record<string, any> = {};
    for (const url of urls) {
      const b = before[url].elements, a = after[url].elements;
      const ratio = b ? a / b : null;
      ratios[url] = ratio;
      const htmlEqual = before[url].html === after[url].html;
      perTab[url] = {
        elements_before: b, elements_after: a, ratio: ratio === null ? null : round(ratio, 4),
        html_equal: htmlEqual, diff: htmlEqual ? "" : firstDiff(before[url].html, after[url].html),
      };
    }
    const valid = Object.values(ratios).filter((r): r is number => r !== null);
    const maxRatio = valid.length ? Math.max(...valid) : 0;
    ctx.record("T04", maxRatio <= THRESHOLDS.T04_element_ratio_max ? "pass" : "fail", {
      per_tab: perTab, max_ratio: round(maxRatio, 4),
    }, {
      threshold: `max element-count ratio <= ${THRESHOLDS.T04_element_ratio_max}`,
      config: { fixture: ["form.html", "dynamic.html", "heavy.html"] }, started,
      notes: Object.entries(perTab).filter(([, d]) => !d.html_equal).map(([u]) => u),
      artifacts,
    });
  } catch (error) {
    ctx.record("T04", "error", {}, { error: String(error), started });
  } finally {
    await ctx.closeUrls(urls);
    if (ctx.ext) await ctx.ext.cleanupSnapshots();
  }
}

async function t05(ctx: Harness): Promise<void> {
  const n = ctx.args.smallTabs;
  const started = nowIso();
  const urls: string[] = [];
  try {
    await ctx.warmupExtension();
    for (let i = 0; i < n; i++) urls.push(await ctx.openFixture("heavy.html"));
    await ctx.ext!.activateControl();
    await ctx.sampler!.waitStable(20000);
    console.log("  T05 tree settled, starting measured freezes");
    const rows: any[] = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      await ctx.ext!.activateControl();
      await ctx.sampler!.waitStable(10000);
      const before = await ctx.sampler!.average(5, 500);
      const t0 = Date.now();
      const [, resp] = await ctx.freezeUrl(url);
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const tabs = (await ctx.ext!.tabs()).filter((t) => t.url === url);
        if (tabs.length && tabs[0].discarded) break;
        await sleep(300);
      }
      await ctx.sampler!.waitStable(15000);
      const after = await ctx.sampler!.average(5, 500);

      let droppedPid: number | null = null, droppedPss = 0;
      for (const [pidStr, pss] of before.pidPss as Map<number, number>) {
        const nowPss = after.pidPss.get(pidStr) ?? 0;
        if (pss > 0 && nowPss < pss * 0.4 && pss > droppedPss) {
          droppedPid = pidStr; droppedPss = pss;
        }
      }
      const afterPidPss = droppedPid !== null ? (after.pidPss.get(droppedPid) ?? 0) : null;
      const exited = droppedPid !== null && afterPidPss === 0;
      const treeSaved = before.pss - after.pss;
      const processPct = droppedPss ? (droppedPss - (afterPidPss ?? 0)) / droppedPss * 100 : 0;
      const treePct = droppedPss ? treeSaved / droppedPss * 100 : 0;
      rows.push({
        url, ok: !!resp?.ok, error: resp?.error,
        renderer_pid: droppedPid, renderer_exited: exited,
        tab_pss_bytes: droppedPss, tab_pss_after_bytes: afterPidPss,
        tree_pss_before: before.pss, tree_pss_after: after.pss,
        tree_saved_bytes: treeSaved,
        process_saved_pct: round(processPct), tree_saved_pct: round(treePct),
        wall_ms: round(Date.now() - t0, 1), timings: resp?.timings, attributed: droppedPid !== null,
      });
      console.log(`  T05 ${i + 1}/${n}: process ${rows[rows.length - 1].process_saved_pct}%, tree ${rows[rows.length - 1].tree_saved_pct}%${droppedPid === null ? " (no pid attribution)" : ""}`);
    }
    const good = rows.filter((r) => r.ok && r.attributed);
    const pcts = good.map((r) => r.process_saved_pct);
    const treePcts = good.map((r) => r.tree_saved_pct);
    const meanPct = pcts.length ? mean(pcts) : 0;
    const p10Pct = p10(pcts) ?? 0;
    const result = pcts.length && meanPct >= THRESHOLDS.T05_per_tab_mean_pct && p10Pct >= THRESHOLDS.T05_per_tab_p10_pct ? "pass" : "fail";
    ctx.record("T05", result, {
      tabs_attempted: urls.length, tabs_attributed: good.length,
      mean_saved_pct: round(meanPct), p10_saved_pct: round(p10Pct),
      mean_tree_saved_pct: round(treePcts.length ? mean(treePcts) : 0),
      renderers_exited: good.filter((r) => r.renderer_exited).length,
      memory_metric: ctx.sampler!.memoryMetric, rows,
    }, {
      threshold: `mean >= ${THRESHOLDS.T05_per_tab_mean_pct}% and p10 >= ${THRESHOLDS.T05_per_tab_p10_pct}% (claim: 90%)`,
      config: { tabs: n, fixture: "heavy.html", attribution: `per-renderer ${ctx.sampler!.memoryMetric}` },
      started, notes: [`${rows.length - good.length} tab(s) unattributed or failed`],
    });
  } catch (error) {
    ctx.record("T05", "error", {}, { error: String(error), started, config: { tabs: n, fixture: "heavy.html" } });
  } finally {
    await ctx.closeUrls(urls);
    if (ctx.ext) await ctx.ext.cleanupSnapshots();
  }
}

async function t06(ctx: Harness): Promise<void> {
  const n = ctx.args.tabs;
  const started = nowIso();
  const urls: string[] = [];
  try {
    await ctx.warmupExtension();
    for (let i = 0; i < n; i++) urls.push(await ctx.openFixture("heavy.html"));
    await ctx.ext!.activateControl();
    console.log(`  T06 settling ${n} tabs...`);
    await sleep(8000);
    await ctx.sampler!.waitStable(30000, 0.01, 4);
    const before = await ctx.sampler!.average(4, 600);
    const freezeRows: any[] = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const [, resp] = await ctx.freezeUrl(urls[i]);
        freezeRows.push({
          url: urls[i], ok: !!resp?.ok, compressedBytes: resp?.compressedBytes,
          error: resp?.error, totalMs: resp?.timings?.totalMs,
        });
      } catch (error) { freezeRows.push({ url: urls[i], ok: false, error: String(error) }); }
      if ((i + 1) % 10 === 0) console.log(`  T06 froze ${i + 1}/${n}`);
    }
    const transient = ctx.sampler!.snapshot();
    console.log("  T06 waiting for extension workers to quiesce...");
    await ctx.sampler!.waitStable(120000, 0.01, 5, 1000, 40000);
    const after = await ctx.sampler!.average(4, 600);

    const saved = before.pss - after.pss;
    const pct = before.pss ? saved / before.pss * 100 : 0;
    const transientPct = before.pss ? (before.pss - transient.pss) / before.pss * 100 : 0;
    const exited = [...(before.pidPss as Map<number, number>).keys()].filter((p) => (after.pidPss.get(p) ?? 0) === 0);
    const held = exited.reduce((sum, p) => sum + (before.pidPss.get(p) ?? 0), 0);
    const residual = exited.reduce((sum, p) => sum + (after.pidPss.get(p) ?? 0), 0);
    const reclaimedPct = held ? (held - residual) / held * 100 : 0;
    const okCount = freezeRows.filter((r) => r.ok && r.compressedBytes).length;
    ctx.record("T06", pct >= THRESHOLDS.T06_aggregate_pct ? "pass" : "fail", {
      tabs: n, freeze_ok: okCount,
      pss_before: before.pss, pss_after: after.pss, pss_after_transient: transient.pss,
      saved_bytes: saved, saved_pct: round(pct), transient_saved_pct: round(transientPct),
      tabs_exited: exited.length, tabs_held_bytes: held,
      tab_reclaimed_pct: round(reclaimedPct),
      avg_tab_mib: n ? round(held / n / 2 ** 20, 1) : 0,
      baseline_after_mib: round(after.pss / 2 ** 20, 1),
      memory_metric: ctx.sampler!.memoryMetric,
      processes_before: before.processes, processes_after: after.processes,
      freeze_total_ms_p95: p95(freezeRows.map((r) => r.totalMs)), rows: freezeRows,
    }, {
      threshold: `aggregate saving >= ${THRESHOLDS.T06_aggregate_pct}% (claim: 80%)`,
      config: { tabs: n, fixture: "heavy.html (+24 MiB deterministic heap)", sites: "distinct subdomains of lto.test" },
      started,
      notes: [
        okCount < n ? `${n - okCount} freeze(s) failed` : "all tabs froze",
        `steady ${pct.toFixed(1)}% vs transient ${transientPct.toFixed(1)}%; avg tab ${round(held / n / 2 ** 20, 0)} MiB, baseline ${round(after.pss / 2 ** 20, 0)} MiB`,
      ],
    });
  } catch (error) {
    ctx.record("T06", "error", {}, { error: String(error), started, config: { tabs: n, fixture: "heavy.html" } });
  } finally {
    await ctx.closeUrls(urls);
    if (ctx.ext) await ctx.ext.cleanupSnapshots();
  }
}

interface BenchResult {
  name: string; timestamp: string; chrome: string; extension: string | null;
  urls: string[]; config: Record<string, any>; stats: Record<string, any>; samples: any[];
}

/** One A/B session for T07 — replaces the old Python bench.py subprocess. */
async function runBenchSession(ctx: Harness, name: string, profile: string,
                               extensionDir: string | null, urls: string[], port: number): Promise<BenchResult> {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  console.log(`[${name}] launching: ${ctx.chromeBin}`);
  if (extensionDir) console.log(`[${name}] extension: ${extensionDir}`);
  console.log(`[${name}] warming up for 15s with ${urls.length} tabs...`);
  const session = new ChromeSession({
    port, profileDir: profile, chromeBin: ctx.chromeBin,
    extensionDir, urls, extraFlags: ["--new-window"],
  });
  await session.start();
  if (extensionDir) console.log(`[${name}] extension loaded: ${session.extensionId}`);
  const sampler = new Sampler(session.proc!.pid!, profile);
  await sleep(15000);
  console.log(`[${name}] sampling 30 times every 2.0s...`);
  const samples: any[] = [];
  let prevCpu: number | null = null, prevTime: number | null = null;
  try {
    for (let i = 0; i < 30; i++) {
      const snap = sampler.snapshot();
      const now = Date.now() / 1000;
      const cpuSeconds = Number(snap.ticks) / CLK_TCK;
      const cpu = prevCpu !== null && prevTime !== null && now > prevTime
        ? (cpuSeconds - prevCpu) / (now - prevTime) * 100 : null;
      samples.push({
        index: i, time: now, processes: snap.processes,
        rss_bytes: snap.rss, pss_bytes: IS_WINDOWS ? null : snap.pss,
        cpu_percent: cpu, gpu_util_percent: null, gpu_memory_mib: null,
      });
      prevCpu = cpuSeconds; prevTime = now;
      if (i < 29) await sleep(2000);
    }
  } finally {
    session.stop();
  }
  const metric = IS_WINDOWS ? MEMORY_WORKING_SET : MEMORY_PSS;
  return {
    name, timestamp: nowIso(), chrome: ctx.chromeBin, extension: extensionDir, urls,
    config: {
      memory_source: IS_WINDOWS ? "powershell" : "proc",
      memory_metric: metric, warmup_seconds: 15,
      sample_interval_seconds: 2.0, sample_count: 30,
    },
    stats: {
      rss_bytes: { mean: floorMean(samples.map((s) => s.rss_bytes)) },
      pss_bytes: { mean: IS_WINDOWS ? null : floorMean(samples.map((s) => s.pss_bytes ?? 0)) },
      cpu_percent: { mean: mean(samples.map((s) => s.cpu_percent).filter((v): v is number => typeof v === "number")) },
      processes: { mean: mean(samples.map((s) => s.processes)) },
      gpu_util_percent: { mean: null }, gpu_memory_mib: { mean: null },
    },
    samples,
  };
}

async function t07(ctx: Harness): Promise<void> {
  const started = nowIso();
  try {
    const urlsFile = join(ctx.runDir, "T07-urls.txt");
    const urls = Array.from({ length: ctx.args.benchTabs }, (_, i) =>
      `http://127.0.0.1:${FIXTURE_PORT}/medium.html?b=${i}`);
    writeFileSync(urlsFile, urls.join("\n") + "\n");
    console.log("  T07 baseline run...");
    const base = await runBenchSession(ctx, "baseline", join(PROFILES, `${ctx.runId}-bench-base`), null, urls, 9230);
    writeFileSync(join(ctx.runDir, "T07-baseline.json"), JSON.stringify(base, null, 2));
    console.log(`[baseline] mean ${base.config.memory_metric}: ${round((base.stats.pss_bytes.mean ?? base.stats.rss_bytes.mean) / 2 ** 20, 1)} MiB`);
    console.log("  T07 extension run...");
    const ext = await runBenchSession(ctx, "extension", join(PROFILES, `${ctx.runId}-bench-ext`), DIST, urls, 9231);
    writeFileSync(join(ctx.runDir, "T07-extension.json"), JSON.stringify(ext, null, 2));
    console.log(`[extension] mean ${ext.config.memory_metric}: ${round((ext.stats.pss_bytes.mean ?? ext.stats.rss_bytes.mean) / 2 ** 20, 1)} MiB`);

    const bInfo = sampledMemoryMean(base);
    const eInfo = sampledMemoryMean(ext);
    const b = bInfo.mean ?? 0, e = eInfo.mean ?? 0;
    const ratio = b ? e / b : null;
    const result = ratio !== null && ratio <= THRESHOLDS.T07_overhead_ratio_max ? "pass" : "fail";
    ctx.record("T07", result, {
      baseline_pss_mean: b, extension_pss_mean: e,
      ratio: ratio === null ? null : round(ratio, 4), delta_bytes: e - b,
      memory_metric: bInfo.metric, bench_memory_source: base.config.memory_source,
      baseline_cpu_mean: base.stats.cpu_percent.mean, extension_cpu_mean: ext.stats.cpu_percent.mean,
    }, {
      threshold: `extension/baseline ${bInfo.metric} ratio <= ${THRESHOLDS.T07_overhead_ratio_max} (extension loaded, no freeze used)`,
      config: { bench_tabs: ctx.args.benchTabs, samples: 30, interval_s: 2, warmup_s: 15 },
      started,
      notes: [
        "bench sessions use their own fresh profiles",
        IS_WINDOWS ? "Windows uses Working Set (RSS) because PSS does not exist there" : "PSS via /proc/smaps_rollup",
      ],
      artifacts: ["T07-baseline.json", "T07-extension.json", "T07-urls.txt"],
    });
  } catch (error) {
    ctx.record("T07", "error", {}, { error: String(error), started });
  }
}

async function t08(ctx: Harness): Promise<void> {
  const n = ctx.args.smallTabs;
  const started = nowIso();
  const urls: string[] = [];
  try {
    await ctx.warmupExtension();
    for (let i = 0; i < n; i++) urls.push(await ctx.openFixture("medium.html"));
    await ctx.ext!.activateControl();
    await ctx.sampler!.waitStable(20000);
    const freezeMs: number[] = [], restoreMs: number[] = [], rows: any[] = [], batchMs: number[] = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      await ctx.ext!.activateControl();
      ctx.sampler!.startCapture();
      const t0 = Date.now();
      const [, fresp] = await ctx.freezeUrl(url);
      const wall = Date.now() - t0;
      const cap = await ctx.sampler!.stopCapture();
      const basePss = (await ctx.sampler!.average(2, 200)).pss;
      const fRow = {
        url, ok: !!fresp?.ok, timings: fresp?.timings, wall_ms: round(wall, 1),
        peak_pss: cap.peak_pss, peak_cpu_pct: cap.peak_cpu_pct,
        baseline_pss: basePss, error: fresp?.error,
      };
      rows.push({ phase: "freeze", ...fRow });
      if (fresp?.timings?.totalMs !== undefined) freezeMs.push(fresp.timings.totalMs);

      ctx.sampler!.startCapture();
      const t1 = Date.now();
      const [, rresp] = await ctx.restoreUrl(url);
      const restoreWall = Date.now() - t1;
      const rcap = await ctx.sampler!.stopCapture();
      const hyd = rresp?.hydration ?? {};
      const rRow = {
        url, ok: !!rresp?.ok, totalMs: rresp?.totalMs, wall_ms: round(restoreWall, 1),
        mode: hyd.mode, maxBatchMs: hyd.maxBatchMs, formApplied: hyd.formApplied,
        peak_pss: rcap.peak_pss, peak_cpu_pct: rcap.peak_cpu_pct, error: rresp?.error,
      };
      rows.push({ phase: "restore", ...rRow });
      if (rresp?.totalMs) restoreMs.push(rresp.totalMs);
      if (typeof hyd.maxBatchMs === "number") batchMs.push(hyd.maxBatchMs);
      console.log(`  T08 ${i + 1}/${n}: freeze ${fRow.timings?.totalMs ?? "?"}ms, restore ${rRow.totalMs}ms`);
    }
    const fP95 = p95(freezeMs), rP95 = p95(restoreMs);
    const maxBatch = batchMs.length ? Math.max(...batchMs) : null;
    const ok = fP95 !== null && rP95 !== null
      && fP95 <= THRESHOLDS.T08_freeze_p95_ms && rP95 <= THRESHOLDS.T08_restore_p95_ms
      && (maxBatch === null || maxBatch <= THRESHOLDS.T08_max_batch_ms);
    ctx.record("T08", ok ? "pass" : "fail", {
      freeze_total_ms_p95: fP95, restore_total_ms_p95: rP95, max_batch_ms: maxBatch,
      freeze_peak_cpu_pct: Math.max(0, ...rows.filter((r) => r.phase === "freeze" && r.peak_cpu_pct).map((r) => r.peak_cpu_pct)) || null,
      restore_peak_cpu_pct: Math.max(0, ...rows.filter((r) => r.phase === "restore" && r.peak_cpu_pct).map((r) => r.peak_cpu_pct)) || null,
      rows,
    }, {
      threshold: `freeze p95 <= ${THRESHOLDS.T08_freeze_p95_ms}ms; restore p95 <= ${THRESHOLDS.T08_restore_p95_ms}ms; maxBatchMs <= ${THRESHOLDS.T08_max_batch_ms}ms`,
      config: { tabs: n, fixture: "medium.html", sampler_interval_s: 0.5 }, started,
      notes: ["peak CPU/PSS recorded as spike evidence (no thesis threshold)"],
    });
  } catch (error) {
    ctx.record("T08", "error", {}, { error: String(error), started, config: { tabs: n, fixture: "medium.html" } });
  } finally {
    await ctx.closeUrls(urls);
    if (ctx.ext) await ctx.ext.cleanupSnapshots();
  }
}

async function t09(ctx: Harness): Promise<void> {
  const started = nowIso();
  const excluded = ["timestamp", "tabId", "heapSnapshotRef"];
  const urls: string[] = [];
  try {
    const url = await ctx.openFixture("medium.html");
    urls.push(url);
    const runs: any[] = [], rawStates: any[] = [];
    for (let i = 0; i < 3; i++) {
      const [tid, resp] = await ctx.freezeUrl(url);
      if (!resp?.ok) throw new Error(`freeze run ${i + 1} failed: ${resp?.error}`);
      const b64 = await ctx.ext!.chunksB64(tid);
      const raw = Buffer.from(b64, "base64");
      const compPath = join(ctx.runDir, `T09-run${i + 1}.zst`);
      const outPath = join(ctx.runDir, `T09-run${i + 1}.json`);
      writeFileSync(compPath, raw);
      const decompressed = Buffer.from(await ctx.ext!.decompressB64(b64), "base64");
      writeFileSync(outPath, decompressed);
      const state = JSON.parse(decompressed.toString("utf8"));
      let cliAgrees: boolean | null = null;
      const zstd = Bun.which("zstd");
      if (zstd) {
        try {
          const cliOut = join(ctx.runDir, `T09-run${i + 1}-cli.json`);
          const proc = spawnSync(zstd, ["-d", "-f", compPath, "-o", cliOut], { timeout: 30000 });
          cliAgrees = proc.status === 0 && existsSync(cliOut) && readFileSync(cliOut).equals(decompressed);
        } catch { cliAgrees = null; }
      }
      rawStates.push(state);
      const normalized: Record<string, any> = {};
      for (const [k, v] of Object.entries(state)) if (!excluded.includes(k)) normalized[k] = v;
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
      const digest = createHash("sha256").update(canonical).digest("hex");
      runs.push({
        rawBytes: resp.rawBytes, compressedBytes: resp.compressedBytes,
        chunks_bytes: raw.length, normalized_sha256: digest, zstd_cli_agrees: cliAgrees,
      });
      console.log(`  T09 run ${i + 1}: ${digest.slice(0, 16)}… (${raw.length} B compressed)`);
      await ctx.restoreUrl(url);
      await sleep(500);
    }
    const varying = Object.keys(rawStates[0]).filter((k) =>
      rawStates.slice(1).some((s) => !(k in s) || JSON.stringify(s[k]) !== JSON.stringify(rawStates[0][k]))).sort();
    const hashes = new Set(runs.map((r) => r.normalized_sha256));
    const raws = new Set(runs.map((r) => r.rawBytes));
    const unexpected = varying.filter((k) => !excluded.includes(k));
    const result = hashes.size === 1 && raws.size === 1 && !unexpected.length ? "pass" : "fail";
    const artifacts: string[] = [];
    for (const i of [1, 2, 3]) artifacts.push(`T09-run${i}.zst`, `T09-run${i}.json`);
    ctx.record("T09", result, {
      runs, distinct_hashes: hashes.size, distinct_raw_bytes: raws.size,
      excluded_fields: excluded, varying_fields: varying,
    }, {
      threshold: "3 freezes of the same page: identical rawBytes and identical SHA-256 of decompressed state minus runtime-only fields (timestamp, tabId, heapSnapshotRef); no other field may vary",
      config: { fixture: "medium.html", runs: 3, decompression: "extension offscreen zstd-wasm via runtime message" },
      started,
      notes: result === "pass" ? [] : [unexpected.length
        ? `determinism violated — unexpected varying fields: ${unexpected.join(", ")}`
        : "determinism violated — inspect runs"],
      artifacts,
    });
  } catch (error) {
    ctx.record("T09", "error", {}, { error: String(error), started });
  } finally {
    await ctx.closeUrls(urls);
    if (ctx.ext) await ctx.ext.cleanupSnapshots();
  }
}

async function t10(ctx: Harness): Promise<void> {
  const cycles = ctx.args.cycles;
  const started = nowIso();
  const urls: string[] = [];
  try {
    const url = await ctx.openFixture("medium.html");
    urls.push(url);
    await ctx.ext!.activateControl();
    await sleep(2000);
    await ctx.freezeUrl(url);
    await ctx.restoreUrl(url);
    await ctx.sampler!.waitStable(10000);
    const series: number[] = [], errors: string[] = [];
    for (let i = 0; i < cycles; i++) {
      try {
        const [, fresp] = await ctx.freezeUrl(url);
        if (!fresp?.ok) errors.push(`cycle ${i + 1} freeze: ${fresp?.error}`);
        const [, rresp] = await ctx.restoreUrl(url);
        if (!rresp?.ok) errors.push(`cycle ${i + 1} restore: ${rresp?.error}`);
        await sleep(800);
        const alive = await (await ctx.pageFor(url)).evaluate("1+1", false, 10000);
        if (alive !== 2) errors.push(`cycle ${i + 1} page not responding`);
        const avg = await ctx.sampler!.average(3, 300);
        series.push(avg.pss);
        if ((i + 1) % 5 === 0) console.log(`  T10 cycle ${i + 1}/${cycles}: pss=${round(series[series.length - 1] / 2 ** 20, 1)} MiB`);
      } catch (error) {
        errors.push(`cycle ${i + 1}: ${error}`);
        break;
      }
    }
    let slopePct: number | null = null;
    if (series.length >= 4) {
      const xs = series.map((_, i) => i);
      const mx = mean(xs), my = mean(series);
      const variance = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
      const covariance = xs.reduce((sum, x, i) => sum + (x - mx) * (series[i] - my), 0);
      const slope = variance ? covariance / variance : 0;
      slopePct = my ? slope / my * 100 : 0;
    }
    const ok = !errors.length && series.length === cycles && slopePct !== null
      && slopePct <= THRESHOLDS.T10_slope_pct_per_cycle;
    ctx.record("T10", ok ? "pass" : "fail", {
      cycles_planned: cycles, cycles_completed: series.length,
      pss_series_bytes: series,
      slope_pct_per_cycle: slopePct === null ? null : round(slopePct, 4),
      first5_mean: series.length >= 5 ? mean(series.slice(0, 5)) : null,
      last5_mean: series.length >= 5 ? mean(series.slice(-5)) : null,
      errors,
    }, {
      threshold: `0 errors, all ${cycles} cycles, slope <= ${THRESHOLDS.T10_slope_pct_per_cycle}%/cycle`,
      config: { cycles, fixture: "medium.html" }, started, notes: errors.slice(0, 5),
    });
  } catch (error) {
    ctx.record("T10", "error", {}, { error: String(error), started });
  } finally {
    await ctx.closeUrls(urls);
    if (ctx.ext) await ctx.ext.cleanupSnapshots();
  }
}

const TESTS: Record<string, (ctx: Harness) => Promise<void>> = {
  T01: t01, T02: t02, T03: t03, T04: t04, T05: t05,
  T06: t06, T07: t07, T08: t08, T09: t09, T10: t10,
};

// --- Reports ----------------------------------------------------------------

const KEY_METRICS: Record<string, (m: any) => string> = {
  T01: (m) => `success rate ${((m.success_rate ?? 0) * 100).toFixed(1)}%`,
  T02: (m) => Object.values(m.comparisons ?? {}).every((c: any) => c.html_equal && c.forms_equal)
    ? "html/forms/scroll equal" : "MISMATCH",
  T03: (m) => `auto-restore ${m.auto_restore_ok ? "ok" : "FAILED"}`,
  T04: (m) => `max ratio ${m.max_ratio}`,
  T05: (m) => `mean ${m.mean_saved_pct}%, p10 ${m.p10_saved_pct}%, tree ${m.mean_tree_saved_pct}%`,
  T06: (m) => `${m.saved_pct}% of ${round((m.pss_before ?? 0) / 2 ** 20, 0)} MiB (transient ${m.transient_saved_pct}%, ${m.avg_tab_mib} MiB/tab)`,
  T07: (m) => `ratio ${m.ratio}`,
  T08: (m) => `freeze p95 ${(m.freeze_total_ms_p95 ?? 0).toFixed(1)}ms, restore p95 ${(m.restore_total_ms_p95 ?? 0).toFixed(1)}ms`,
  T09: (m) => `${m.distinct_hashes} distinct hash(es)`,
  T10: (m) => `slope ${m.slope_pct_per_cycle}%/cycle`,
};

function readRecords(runDir: string): any[] {
  return readdirSync(runDir).filter((f) => /^T\d{2}\.json$/.test(f)).map((f) => {
    try { return JSON.parse(readFileSync(join(runDir, f), "utf8")); } catch { return null; }
  }).filter(Boolean);
}

function metricOf(rec: any): string {
  if (!rec) return "—";
  try { return (KEY_METRICS[rec.test] ?? (() => ""))(rec.metrics ?? {}); }
  catch { return ""; }
}

function writeReport(runDir: string): string {
  const records = readRecords(runDir).sort((a, b) => a.test.localeCompare(b.test));
  const lines = [
    "# Thesis verification report", "",
    `- Run: \`${runDir.split(/[\\/]/).pop()}\``,
    `- Generated: ${nowIso()}`, "",
    "| Test | Name | Result | Key metric | Threshold |",
    "|---|---|---|---|---|",
  ];
  for (const rec of records) {
    lines.push(`| ${rec.test} | ${rec.name} | **${String(rec.result).toUpperCase()}** | ${metricOf(rec)} | ${rec.threshold ?? ""} |`);
  }
  const failures = records.filter((r) => r.result !== "pass");
  lines.push("", `Records: ${records.length} file(s), ${failures.length} not passing.`, "");
  for (const rec of failures) lines.push(`- **${rec.test} ${rec.result}**: ${rec.error || (rec.notes ?? []).join("; ")}`);
  if (!failures.length) lines.push("- All recorded tests passed their thresholds.");
  lines.push("", "Every test record (including failures) is a `T*.json` file next to this report.", "");
  const out = join(runDir, "report.md");
  writeFileSync(out, lines.join("\n"));
  return out;
}

const CLAIM_EVIDENCE: [string, string[], string][] = [
  ["90 % memory reduction per frozen tab", ["T05"], "per-tab renderer PSS (Linux) / Working Set (Windows) reclaimed (tree-level delta recorded as conservative secondary)"],
  ["80 % total reduction across 50 open tabs", ["T06"], "whole-tree PSS (Linux) / Working Set (Windows) in steady state"],
  ["Lossless restore", ["T02", "T03", "T04"], "byte-exact DOM/forms/scroll, correct restore mode, no duplicated UI"],
  ["Deterministic pipeline (no ML/AI)", ["T09", "T10"], "identical bytes across freezes; no memory slope over cycles"],
  ["Usable latency / idle cost", ["T07", "T08"], "extension overhead while loaded; freeze/restore p95"],
];

function writeSummary(): string {
  const runs: { dir: string; env: any; records: any[] }[] = [];
  const runNames = readdirSync(RESULTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of runNames) {
    const dir = join(RESULTS, name);
    let env: any = {};
    try { env = JSON.parse(readFileSync(join(dir, "env.json"), "utf8")); } catch { /* none */ }
    const records = existsSync(dir) ? readRecords(dir) : [];
    if (Object.keys(env).length || records.length) runs.push({ dir: name, env, records });
  }
  const latest = new Map<string, [string, any]>();
  const passing = new Map<string, [string, any]>();
  for (const run of runs) {
    for (const rec of run.records) {
      latest.set(rec.test, [run.dir, rec]);
      if (rec.result === "pass") passing.set(rec.test, [run.dir, rec]);
    }
  }
  const latestRun = runs.filter((r) => r.records.length).sort((a, b) =>
    String(b.env.timestamp ?? b.dir).localeCompare(String(a.env.timestamp ?? a.dir)))[0];
  const latestEnv = latestRun?.env ?? {};
  const machine = latestEnv.machine ?? {};
  const evidence = (tid: string): string => {
    const groups = new Map<string, string[]>();
    for (const run of runs) {
      for (const rec of run.records) {
        if (rec.test === tid && rec.result === "pass") {
          const metric = metricOf(rec);
          groups.set(metric, [...(groups.get(metric) ?? []), run.dir]);
        }
      }
    }
    if (!groups.size) return `${tid}: none`;
    return `${tid}: ` + [...groups].map(([m, ids]) => `${m} (\`${ids.join(", ")}\`)`).join("<br>");
  };
  const lines = [
    "# Verification suite — run index", "",
    `- Generated: ${nowIso()}`,
    `- Chrome: ${latestEnv.chrome ?? "?"}`,
    `- Machine: ${machine.cpu_count ?? "?"} CPUs, ${Math.floor((machine.mem_total_kb ?? 0) / 1024)} MiB RAM`,
    `- Latest run platform: ${latestEnv.os ?? "not recorded"} — memory metric: ${latestEnv.memory_metric ?? "not recorded"}`,
    "- Linux records PSS; Windows records Working Set (RSS). Do not compare numbers across operating systems.",
    "- Suite docs: `tools/thesis-verify/README.md`", "",
    "## Thesis claims vs evidence", "",
    "| Claim | Tests | Latest result | Evidence (all passing runs) |", "|---|---|---|---|",
  ];
  for (const [claim, tids, note] of CLAIM_EVIDENCE) {
    const cells = tids.map((tid) => {
      const entry = latest.get(tid);
      return entry ? `${tid} ${entry[1].result.toUpperCase()} (\`${entry[0]}\`)` : `${tid} —`;
    });
    lines.push(`| ${claim} — _${note}_ | ${tids.join(", ")} | ${cells.join("<br>")} | ${tids.map(evidence).join("<br>")} |`);
  }
  lines.push("", "## All runs", "", "Runs are never deleted — failures are part of the record.", "",
    "| Run | Platform | Metric | Tests recorded | Outcomes | Report |", "|---|---|---|---|---|---|");
  for (const run of runs) {
    if (!run.records.length) continue;
    const outcomes = run.records.map((r) => `${r.test} ${String(r.result).toUpperCase()}`).join(", ");
    const tests = run.records.map((r) => r.test).join(", ");
    lines.push(`| \`${run.dir}\` | ${run.env.os ?? "—"} | ${run.env.memory_metric ?? "—"} | ${tests} | ${outcomes} | [report.md](${run.dir}/report.md) |`);
  }
  lines.push("", "## Latest status per test", "",
    "| Test | Name | Latest run | Result | Key metric | Passing evidence |", "|---|---|---|---|---|---|");
  for (const tid of Object.keys(TEST_NAMES).sort()) {
    const entry = latest.get(tid);
    if (!entry) continue;
    const [rid, rec] = entry;
    lines.push(`| ${tid} | ${rec.name ?? TEST_NAMES[tid]} | \`${rid}\` | **${String(rec.result).toUpperCase()}** | ${metricOf(rec)} | ${metricOf(passing.get(tid)?.[1])} |`);
  }
  lines.push("");
  const out = join(RESULTS, "SUMMARY.md");
  writeFileSync(out, lines.join("\n"));
  return out;
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) { out[key] = inline; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "summary") { console.log(writeSummary()); return; }
  if (command === "report") {
    const opts = parseArgs(rest);
    const run = String(opts.run ?? "");
    const dir = join(RESULTS, run);
    if (!run || !existsSync(dir)) throw new Error(`no such run: ${dir}`);
    console.log(writeReport(dir));
    return;
  }
  if (command !== "run") {
    console.error("Usage: verify.ts run [--tests all|T01,T02] [--run id] [--tabs N] [--small-tabs N] [--bench-tabs N] [--cycles N] [--keep-profile] [--chrome PATH]");
    console.error("       verify.ts report --run <id>");
    console.error("       verify.ts summary");
    process.exit(2);
  }
  const opts = parseArgs(rest);
  const args: Args = {
    tests: String(opts.tests ?? "all"),
    run: opts.run ? String(opts.run) : undefined,
    tabs: Number(opts.tabs ?? 50),
    smallTabs: Number(opts["small-tabs"] ?? 8),
    benchTabs: Number(opts["bench-tabs"] ?? 10),
    cycles: Number(opts.cycles ?? 20),
    keepProfile: !!opts["keep-profile"],
    chrome: opts.chrome ? String(opts.chrome) : undefined,
  };
  let wanted = args.tests.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (wanted.length === 1 && wanted[0] === "ALL") wanted = Object.keys(TESTS);
  const unknown = wanted.filter((t) => !(t in TESTS));
  if (unknown.length) throw new Error(`unknown tests: ${unknown.join(", ")}`);
  const ctx = new Harness(args);
  console.log(`run ${ctx.runId}: ${wanted.join(", ")}`);
  await ctx.start();
  console.log(`extension loaded: ${ctx.session?.extensionId}`);
  try {
    for (const tid of wanted) {
      console.log(`--- ${tid}: ${TEST_NAMES[tid]}`);
      await TESTS[tid](ctx);
    }
  } finally {
    try { await ctx.ext?.cleanupSnapshots(); } catch { /* ignore */ }
    ctx.stop();
    console.log(`report: ${writeReport(ctx.runDir)}`);
    try { writeSummary(); } catch (error) { console.log(`summary update skipped: ${error}`); }
  }
}

if (import.meta.main) await main();
