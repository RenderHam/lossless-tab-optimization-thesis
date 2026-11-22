/**
 * Compression worker — classic Worker (MV3-compatible).
 *
 * Vendored Emscripten zstd glue + wasm live in public/zstd/. A classic worker
 * with importScripts() is used because the npm package's "web" entry point is
 * broken (declares dist/web/lib/index.js, which is not published), and because
 * MV3 CSP blocks data: URLs produced by bundlers for module workers.
 *
 * Deterministic: fixed compression level 3, byte-identical output for equal input.
 * Zero-copy: compressed/decompressed ArrayBuffers are transferred back.
 */
importScripts("/zstd/zstd.js");

const Zstd = self.ZstdEmscripten;
const COMPRESSION_LEVEL = 3;

let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
Zstd.onRuntimeInitialized = () => resolveReady();
try {
  Zstd.init("/zstd/zstd.wasm");
} catch (err) {
  rejectReady(err);
}

function cwrap(name, ret, args) {
  return Zstd.cwrap(name, ret, args);
}

function compress(input, level) {
  const bound = cwrap("ZSTD_compressBound", "number", ["number"])(input.byteLength);
  const malloc = cwrap("malloc", "number", ["number"]);
  const free = cwrap("free", "number");
  const compressed = malloc(bound);
  const src = malloc(input.byteLength);
  Zstd.HEAP8.set(input, src);
  try {
    const compressRaw = cwrap("ZSTD_compress", "number", ["number", "number", "number", "number", "number"]);
    const sizeOrError = compressRaw(compressed, bound, src, input.byteLength, level);
    if (cwrap("ZSTD_isError", "number", ["number"])(sizeOrError)) {
      const namePtr = cwrap("ZSTD_getErrorName", "number", ["number"])(sizeOrError);
      throw new Error("zstd compress failed: " + String(Zstd.HEAPU8.slice(namePtr, namePtr + 64)));
    }
    return new Uint8Array(Zstd.HEAPU8.buffer, compressed, sizeOrError).slice();
  } finally {
    free(compressed);
    free(src);
  }
}

function decompress(input) {
  const malloc = cwrap("malloc", "number", ["number"]);
  const free = cwrap("free", "number");
  const src = malloc(input.byteLength);
  Zstd.HEAP8.set(input, src);
  const contentSize = cwrap("ZSTD_getFrameContentSize", "number", ["number", "number"])(src, input.byteLength);
  const size = contentSize === -1 ? 4 * 1024 * 1024 : contentSize;
  const out = malloc(size);
  try {
    const decompressRaw = cwrap("ZSTD_decompress", "number", ["number", "number", "number", "number"]);
    const sizeOrError = decompressRaw(out, size, src, input.byteLength);
    if (cwrap("ZSTD_isError", "number", ["number"])(sizeOrError)) {
      const namePtr = cwrap("ZSTD_getErrorName", "number", ["number"])(sizeOrError);
      throw new Error("zstd decompress failed: " + String(Zstd.HEAPU8.slice(namePtr, namePtr + 64)));
    }
    return new Uint8Array(Zstd.HEAPU8.buffer, out, sizeOrError).slice();
  } finally {
    free(out);
    free(src);
  }
}

self.onmessage = async (event) => {
  const { id, op, payload } = event.data;
  const post = (msg, transfer = []) => self.postMessage(msg, transfer);
  try {
    if (op === "status") {
      await ready;
      post({ id, ok: true, ready: true });
      return;
    }
    await ready;
    const input = payload ? new Uint8Array(payload) : new Uint8Array(0);
    if (op === "compress") {
      const out = compress(input, COMPRESSION_LEVEL);
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      post({ id, ok: true, result: buf, rawBytes: input.length, compressedBytes: out.length }, [buf]);
      return;
    }
    if (op === "decompress") {
      const out = decompress(input);
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      post({ id, ok: true, result: buf }, [buf]);
      return;
    }
    post({ id, ok: false, error: "unknown op: " + String(op) });
  } catch (err) {
    post({ id, ok: false, error: String(err) });
  }
};
