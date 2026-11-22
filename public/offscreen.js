/**
 * Offscreen document: hosts the zstd compression worker.
 *
 * Chrome MV3 service workers have no `Worker` constructor, so the actual
 * worker lives in this hidden extension page. The background service worker
 * sends LTO_OFFSCREEN_* messages here via chrome.runtime; this script forwards
 * them to the worker with zero-copy transfers and replies with the result.
 */
const worker = new Worker("/compression-worker.js");
const pending = new Map();
let nextId = 1;

worker.onmessage = (event) => {
  const { id, ok, result, error } = event.data;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (ok) entry.resolve(result ? new Uint8Array(result) : new Uint8Array(0));
  else entry.reject(new Error(error ?? "worker error"));
};

worker.onerror = (event) => {
  for (const [, entry] of pending) entry.reject(new Error(String(event.message ?? event)));
  pending.clear();
};

function callWorker(op, bytes) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    // Zero-copy transfer into the worker: the ArrayBuffer is moved.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    worker.postMessage({ id, op, payload: buffer }, [buffer]);
  });
}

// Chrome runtime messaging is JSON-serialized: binary must travel as base64.
function base64ToBytes(encoded) {
  const binary = atob(encoded || "");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let binary = "";
  const windowSize = 0x8000;
  for (let i = 0; i < bytes.length; i += windowSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + windowSize));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message && message.type;
  if (type === "LTO_OFFSCREEN_PING") {
    sendResponse({ ok: true });
    return false;
  }
  if (type === "LTO_OFFSCREEN_COMPRESS" || type === "LTO_OFFSCREEN_DECOMPRESS") {
    const op = type === "LTO_OFFSCREEN_COMPRESS" ? "compress" : "decompress";
    const input = base64ToBytes(message.payloadB64);
    callWorker(op, input)
      .then((out) => sendResponse({ ok: true, resultB64: bytesToBase64(out) }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
