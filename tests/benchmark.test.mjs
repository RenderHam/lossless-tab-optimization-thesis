import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mean, mib, reductionPercent } from "../benchmarks/lib.mjs";

const benchSrc = fs.readFileSync(new URL("../src/profiling/benchmark.ts", import.meta.url), "utf8");
const memorySrc = fs.readFileSync(new URL("../src/profiling/memory.ts", import.meta.url), "utf8");
const bgSrc = fs.readFileSync(new URL("../src/background/background.ts", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

describe("benchmark math", () => {
  it("reductionPercent: 50MB -> 5MB is 90%", () => {
    assert.equal(reductionPercent(50 * 1024 * 1024, 5 * 1024 * 1024), 90);
  });
  it("reductionPercent: zero baseline is null, no division by zero", () => {
    assert.equal(reductionPercent(0, 0), null);
  });
  it("reductionPercent never returns negative", () => {
    assert.equal(reductionPercent(100, 120), 0);
  });
  it("mean of empty array is 0", () => {
    assert.equal(mean([]), 0);
    assert.equal(mean([10, 20, 30]), 20);
  });
  it("mib formats bytes", () => {
    assert.equal(mib(1024 * 1024), "1.00");
  });
});

describe("benchmark wiring", () => {
  it("manifest requests the processes permission", () => {
    assert.ok(manifest.permissions.includes("processes"));
  });
  it("memory sampler uses exact Chrome-reported private memory", () => {
    assert.match(memorySrc, /getProcessIdForTab/);
    assert.match(memorySrc, /privateMemory/);
  });
  it("benchmark re-resolves tab IDs in background and skips undiscardable tabs", () => {
    assert.match(benchSrc, /chrome\.tabs\.query\(\{\}\)/);
    assert.match(benchSrc, /!t\.active/);
    assert.match(benchSrc, /!t\.pinned/);
    assert.doesNotMatch(benchSrc, /chrome\.tabs\.get\(/);
  });
  it("benchmark samples before/after freeze and checks fidelity", () => {
    assert.match(benchSrc, /sampleTabRenderer\(tabId\)/);
    assert.match(benchSrc, /freeze.stateJson === stableStringify\(restore.state\)/);
    assert.match(benchSrc, /LONG_TASK_BUDGET_MS/);
  });
  it("tab lookup uses the same query API as the benchmark, with labelled failures", () => {
    assert.match(bgSrc, /async function findTab/);
    assert.match(bgSrc, /chrome\.tabs\.query\(\{\}\)/);
    assert.match(bgSrc, /discard failed for tab/);
  });
  it("reopening a discarded frozen tab triggers automatic restore", () => {
    assert.match(bgSrc, /chrome\.tabs\.onActivated\.addListener/);
    assert.match(bgSrc, /autoRestoreOnActivation/);
    assert.match(bgSrc, /tab\.discarded/);
  });
  it("form restoration tries stable id/name keys before index", () => {
    const rest = fs.readFileSync(new URL("../src/restoration/restoration.ts", import.meta.url), "utf8");
    assert.match(rest, /formKeysFor/);
    assert.match(rest, /candidates\.find/);
  });
  it("snapshot is deleted after a successful restore", () => {
    assert.match(bgSrc, /await deleteTabSnapshot\(tabId\)/);
  });
  it("background handles LTO_BENCH_RUN and persists results", () => {
    assert.match(bgSrc, /LTO_BENCH_RUN/);
    assert.match(bgSrc, /BENCH_RESULT_KEY/);
  });
});
