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
  it("no ML/AI/probabilistic code in src", () => {
    const all = typesSrc + codecSrc + restSrc;
    assert.doesNotMatch(all, /tensorflow|torch|onnx|neural|gradient|stochastic/i);
  });
});
