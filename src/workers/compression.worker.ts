/**
 * Dedicated compression worker: hosts the Wasm zstd engine.
 *
 * Deterministic: same input bytes + same level => byte-identical output.
 * Level is fixed at COMPRESSION_LEVEL (no adaptation, no sampling).
 *
 * Engine: `@bokuweb/zstd-wasm` (Emscripten build of zstd). Initialized once
 * per worker lifetime. If the Wasm module fails to load (e.g. CSP), the
 * worker reports `ok: false` explicitly — it never silently swaps codecs,
 * because that would break the thesis byte-determinism claim.
 */

export const COMPRESSION_LEVEL = 3;

type InitState = { kind: "uninit" } | { kind: "ready"; zstd: ZstdModule } | { kind: "failed"; error: string };

interface ZstdModule {
  compress(data: Uint8Array, level: number): Uint8Array;
  decompress(data: Uint8Array): Uint8Array;
}

let state: InitState = { kind: "uninit" };

async function ensureEngine(): Promise<ZstdModule> {
  if (state.kind === "ready") return state.zstd;
  if (state.kind === "failed") throw new Error(state.error);
  try {
    // Dynamic import keeps the worker boot path explicit.
    const mod = (await import("@bokuweb/zstd-wasm")) as unknown as {
      ZstdInit: () => Promise<{ ZstdCodec: new () => ZstdModule }>;
    };
    const { ZstdCodec } = await mod.ZstdInit();
    const zstd = new ZstdCodec();
    state = { kind: "ready", zstd };
    return zstd;
  } catch (err) {
    state = { kind: "failed", error: String(err) };
    throw err;
  }
}

export interface WorkerRequest {
  id: number;
  op: "compress" | "decompress" | "status";
  payload?: ArrayBuffer;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, op, payload } = ev.data;
  const post = (msg: object, transfer: Transferable[] = []) => self.postMessage(msg, transfer);
  try {
    if (op === "status") {
      await ensureEngine();
      post({ id, ok: true, ready: true });
      return;
    }
    const engine = await ensureEngine();
    const input = payload ? new Uint8Array(payload) : new Uint8Array(0);
    if (op === "compress") {
      const out = engine.compress(input, COMPRESSION_LEVEL);
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      post({ id, ok: true, result: buf, rawBytes: input.length, compressedBytes: out.length }, [buf]);
      return;
    }
    if (op === "decompress") {
      const out = engine.decompress(input);
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      post({ id, ok: true, result: buf }, [buf]);
      return;
    }
    post({ id, ok: false, error: `unknown op: ${String(op)}` });
  } catch (err) {
    post({ id, ok: false, error: String(err) });
  }
};
