// Deterministic micro-benchmark: chunking + batch arithmetic + stable-stringify.
// Run: npm run bench
import { performance } from "node:perf_hooks";

function stableStringify(v) {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const NODES = 5000;
const nodes = Array.from({ length: NODES }, (_, i) => ({
  id: i,
  parentId: i === 0 ? -1 : Math.floor((i - 1) / 4),
  tagName: "DIV",
  attributes: { class: "n", "data-i": String(i) },
  textContent: `node ${i}`,
}));
const t0 = performance.now();
const json = stableStringify({ tabId: 1, domTree: nodes });
const bytes = Buffer.byteLength(json, "utf8");
const chunks = Math.ceil(bytes / (64 * 1024));
const batches = Math.ceil(NODES / 100);
const t1 = performance.now();
console.log(JSON.stringify({
  nodes: NODES, jsonBytes: bytes, chunks64KiB: chunks,
  hydrationBatches100: batches, stringifyMs: +(t1 - t0).toFixed(2),
}, null, 2));
