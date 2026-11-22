import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const offscreenSrc = fs.readFileSync(new URL("../public/offscreen.js", import.meta.url), "utf8");
const bridgeSrc = fs.readFileSync(new URL("../src/workers/compression.bridge.ts", import.meta.url), "utf8");
const codecSrc = fs.readFileSync(new URL("../src/shared/codec.ts", import.meta.url), "utf8");

function loadOffscreen(workerImpl) {
  const sandbox = {
    Worker: workerImpl,
    chrome: { runtime: { onMessage: { addListener: (fn) => { sandbox.listener = fn; } } } },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    Uint8Array,
    ArrayBuffer,
    Error,
    String,
    Map,
    Promise,
    setTimeout,
    console,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(offscreenSrc, sandbox);
  return sandbox;
}

describe("Chrome JSON messaging binary bridge", () => {
  it("base64 helpers exist on both sides of the hop", () => {
    assert.match(codecSrc, /export function bytesToBase64/);
    assert.match(codecSrc, /export function base64ToBytes/);
    assert.match(bridgeSrc, /payloadB64/);
    assert.match(bridgeSrc, /resultB64/);
    assert.match(offscreenSrc, /payloadB64/);
    assert.match(offscreenSrc, /resultB64/);
  });

  it("offscreen decodes the base64 payload and returns a base64 result", async () => {
    const input = new Uint8Array([0, 1, 2, 250, 255]);
    let posted;
    let reply;
    const sandbox = loadOffscreen(class {
      postMessage(msg) {
        posted = msg;
        setTimeout(() => this.onmessage({ data: { id: msg.id, ok: true, result: msg.payload } }), 0);
      }
    });
    sandbox.listener(
      { type: "LTO_OFFSCREEN_COMPRESS", payloadB64: Buffer.from(input).toString("base64") },
      {},
      (r) => { reply = r; },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(posted.op, "compress");
    assert.deepEqual(Array.from(new Uint8Array(posted.payload)), Array.from(input));
    assert.equal(reply.ok, true);
    assert.deepEqual(Buffer.from(reply.resultB64, "base64"), Buffer.from(input));
  });
});
