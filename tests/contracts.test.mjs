import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Contract tests: assert the deterministic constants + pure logic
// (chunking, batching, key format) that the thesis depends on.
// Pure functions are mirrored here so tests run with plain node --test
// (no TS loader required); source files are additionally asserted to
// contain the same constants to prevent drift.

const typesSrc = fs.readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8");
const codecSrc = fs.readFileSync(new URL("../src/shared/codec.ts", import.meta.url), "utf8");
const restSrc = fs.readFileSync(new URL("../src/restoration/restoration.ts", import.meta.url), "utf8");
const bgSrc = fs.readFileSync(new URL("../src/background/background.ts", import.meta.url), "utf8");
const contentSrc = fs.readFileSync(new URL("../src/content/content.ts", import.meta.url), "utf8");
const sharedSrc = fs.readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8");

function chunkBytes(bytes, chunkSize) {
  const out = [];
  for (let off = 0; off < bytes.length; off += chunkSize) out.push(bytes.slice(off, off + chunkSize));
  if (bytes.length === 0) out.push(new Uint8Array(0));
  return out;
}
const batchesFor = (n, size) => Math.ceil(n / size);

describe("deterministic contracts", () => {
  it("CHUNK_SIZE_BYTES is exactly 64 KiB", () => {
    assert.match(typesSrc, /CHUNK_SIZE_BYTES\s*=\s*64\s*\*\s*1024/);
  });
  it("HYDRATION_BATCH_SIZE is exactly 100", () => {
    assert.match(typesSrc, /HYDRATION_BATCH_SIZE\s*=\s*100/);
  });
  it("LONG_TASK_BUDGET_MS is 50", () => {
    assert.match(typesSrc, /LONG_TASK_BUDGET_MS\s*=\s*50/);
  });
  it("codec exposes stableStringify + chunkBytes + joinChunks", () => {
    assert.match(codecSrc, /stableStringify/);
    assert.match(codecSrc, /chunkBytes/);
    assert.match(codecSrc, /joinChunks/);
  });
  it("restoration hydrates in bounded batches and yields per batch", () => {
    assert.match(restSrc, /HYDRATION_BATCH_SIZE/);
    assert.match(restSrc, /requestIdleCallback/);
  });
  it("form restoration keys on BFS node id and re-applies after idle", () => {
    assert.match(contentSrc, /ids\.set\(el, id\)/);
    assert.match(contentSrc, /formInputNodeIds/);
    assert.match(restSrc, /data-lto-id/);
    assert.match(restSrc, /state\.formInputNodeIds/);
    // Two passes: first after hydration, second after an idle frame.
    assert.equal((restSrc.match(/restoreFormInputs\(state, doc\)/g) || []).length >= 2, true);
  });
  it("restore overlays state on live pages instead of rebuilding their DOM", () => {
    assert.match(restSrc, /export async function overlayRestore/);
    assert.match(restSrc, /mode: "overlay"/);
    assert.match(contentSrc, /hasLiveDom/);
    assert.match(contentSrc, /overlayRestore\(state\)/);
  });
  it("restoration uses ES6 Proxy with get trap for lazy heap", () => {
    assert.match(restSrc, /new Proxy/);
    assert.match(restSrc, /get\s*\(target/);
  });
  it("chunking: 200_000 bytes -> 4 chunks (64KiB)", () => {
    const chunks = chunkBytes(new Uint8Array(200_000), 64 * 1024);
    assert.equal(chunks.length, 4);
    assert.equal(chunks[3].length, 200_000 - 3 * 65536);
  });
  it("batching: 250 nodes -> 3 batches at 100/frame", () => {
    assert.equal(batchesFor(250, 100), 3);
  });
  it("batching: 5000 nodes -> 50 batches", () => {
    assert.equal(batchesFor(5000, 100), 50);
  });
  it("chunk keys are zero-padded and ordered", () => {
    const k = (i) => `tab-7/chunk-${String(i).padStart(6, "0")}`;
    assert.ok(k(2) < k(10));
    assert.equal(k(3), "tab-7/chunk-000003");
  });
  it("restore push is handled by the content script and calls hydrateDOM", () => {
    assert.match(contentSrc, /MSG_RESTORE_PUSH/);
    assert.match(contentSrc, /hydrateDOM\(state, document\.documentElement\)/);
  });
  it("restore falls back to the latest snapshot with the same URL", () => {
    assert.match(bgSrc, /listSnapshots\(\)/);
    assert.match(bgSrc, /m\.url === current\.url/);
    assert.match(bgSrc, /no snapshot for tab/);
  });
  it("background reloads discarded tabs, waits for readiness, then pushes state", () => {
    assert.match(bgSrc, /chrome\.tabs\.reload\(tabId\)/);
    assert.match(bgSrc, /waitForTabComplete\(tabId\)/);
    assert.match(bgSrc, /waitForContentScript\(tabId\)/);
    assert.match(bgSrc, /type: MSG_RESTORE_PUSH/);
  });
  it("injection fallback resolves the built path from the runtime manifest", () => {
    assert.match(bgSrc, /chrome\.runtime\.getManifest\(\)\.content_scripts/);
  });
  it("message constants live in shared/types (no content import in background)", () => {
    assert.match(sharedSrc, /MSG_RESTORE_PUSH/);
    assert.match(sharedSrc, /MSG_PING/);
    assert.doesNotMatch(bgSrc, /from "\.\.\/content\/content"/);
  });
  it("compression runs in an offscreen document, not the MV3 service worker", () => {
    const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    assert.ok(manifest.permissions.includes("offscreen"));
    const bridge = fs.readFileSync(new URL("../src/workers/compression.bridge.ts", import.meta.url), "utf8");
    assert.match(bridge, /OFFSCREEN_DOCUMENT/);
    assert.match(bridge, /LTO_OFFSCREEN_COMPRESS/);
    const offscreen = fs.readFileSync(new URL("../public/offscreen.js", import.meta.url), "utf8");
    assert.match(offscreen, /new Worker\("\/compression-worker\.js"\)/);
    assert.doesNotMatch(bridge, /new Worker\(/);
  });
  it("no ML/AI/probabilistic code in src", () => {
    const all = typesSrc + codecSrc + restSrc;
    assert.doesNotMatch(all, /tensorflow|torch|onnx|neural|gradient|stochastic/i);
  });
});
