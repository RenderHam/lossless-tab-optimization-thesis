/**
 * Unit tests for tools/thesis-verify/platform_support.ts.
 *
 * Both OS branches are exercised with injected fakes — no browser launch and
 * no PowerShell required on Linux. Run with:
 *
 *   bun test tools/thesis-verify/tests
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ps from "../platform_support.ts";

describe("decompressRequestJs", () => {
  test("uses the extension worker and safely quotes the payload", () => {
    const payload = 'ab"c\\d';
    const js = ps.decompressRequestJs(payload);
    expect(js.startsWith("(async()=>{")).toBe(true);
    expect(js.endsWith("})()")).toBe(true);
    expect(js).toContain("LTO_OFFSCREEN_DECOMPRESS");
    expect(js).toContain("resultB64");
    expect(js).toContain("payloadB64:");
    expect(js).toContain(JSON.stringify(payload));
    expect(js).toContain("!r.ok");
  });
});

describe("sampledMemoryMean", () => {
  test("prefers PSS when present", () => {
    const result = { stats: { pss_bytes: { mean: 123 }, rss_bytes: { mean: 456 } } };
    expect(ps.sampledMemoryMean(result)).toEqual({ mean: 123, metric: ps.MEMORY_PSS });
  });
  test("falls back to Working Set when PSS is null", () => {
    const result = { stats: { pss_bytes: { mean: null }, rss_bytes: { mean: 456 } } };
    expect(ps.sampledMemoryMean(result)).toEqual({ mean: 456, metric: ps.MEMORY_WORKING_SET });
  });
  test("tolerates missing stats", () => {
    expect(ps.sampledMemoryMean({})).toEqual({ mean: null, metric: ps.MEMORY_WORKING_SET });
  });
});

describe("popenOptions", () => {
  test("detaches on POSIX and hides the window on Windows", () => {
    expect(ps.popenOptions(false).detached).toBe(true);
    expect(ps.popenOptions(true).detached).toBe(true);
    expect((ps.popenOptions(true) as any).windowsHide).toBe(true);
  });
});

describe("findChrome", () => {
  test("an explicit existing path wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "lto-chrome-"));
    const exe = join(dir, "chrome.exe");
    writeFileSync(exe, "stub");
    expect(ps.findChrome(exe)).toBe(exe);
  });
  test("an explicit missing path is an error", () => {
    expect(() => ps.findChrome(join(tmpdir(), "definitely-not-chrome.exe"))).toThrow();
  });
  test("finds a known Windows install location", () => {
    const root = mkdtempSync(join(tmpdir(), "lto-pf-"));
    const exe = join(root, "Google", "Chrome", "Application", "chrome.exe");
    mkdirSync(join(root, "Google", "Chrome", "Application"), { recursive: true });
    writeFileSync(exe, "stub");
    const original = process.env["PROGRAMFILES"];
    process.env["PROGRAMFILES"] = root;
    try {
      expect(ps.findChrome(null, true, () => null)).toBe(exe);
    } finally {
      if (original === undefined) delete process.env["PROGRAMFILES"];
      else process.env["PROGRAMFILES"] = original;
    }
  });
});

describe("machineMemoryKb", () => {
  test("reads /proc/meminfo on POSIX", () => {
    expect(ps.machineMemoryKb(false)).toBeGreaterThan(0);
  });
});

describe("Windows memory sampling", () => {
  const runner: ps.PowerShellRunner = () => ({
    status: 0,
    stdout: "10,1000,2.5\n11,500,1.0\nnot-a-row\n",
  });

  test("maps Working Set into the shared sample shape", () => {
    const sample = ps.sampleMemory(1, "C:\\profile", true, runner);
    expect(sample.metric).toBe(ps.MEMORY_WORKING_SET);
    expect(sample.rss).toBe(1500);
    expect(sample.pss).toBe(1500); // Working Set proxy on Windows
    expect([...sample.pids].sort()).toEqual([10, 11]);
    expect(sample.pidPss.get(10)).toBe(1000);
    expect(sample.ticks.get(11)).toBe(1);
  });

  test("windowsSnapshot filters malformed rows", () => {
    expect(ps.windowsSnapshot("C:\\profile", runner)).toEqual({
      10: { rss_bytes: 1000, cpu_seconds: 2.5 },
      11: { rss_bytes: 500, cpu_seconds: 1.0 },
    });
  });
});

describe("POSIX process tree", () => {
  test("includes the current process and reads its smaps_rollup", () => {
    const { pids } = ps.processTree(process.pid);
    expect(pids.has(process.pid)).toBe(true);
    const value = ps.smapsFor(process.pid);
    expect(value.rss).toBeGreaterThanOrEqual(0);
    expect(value.pss).toBeGreaterThanOrEqual(0);
  });
});
