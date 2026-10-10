/**
 * Compression worker bridge (background page context).
 *
 * Owns a dedicated `Worker` running `compression.worker.ts`, which hosts the
 * Wasm zstd engine. All transfers use zero-copy `TransferableObjects`:
 * the underlying `ArrayBuffer` is moved, not copied.
 *
 * Message protocol (deterministic, request/response by `id`):
 *   { id, op: "compress",   payload: ArrayBuffer } -> { id, ok, result: ArrayBuffer, rawBytes, compressedBytes }
 *   { id, op: "decompress", payload: ArrayBuffer } -> { id, ok, result: ArrayBuffer }
 *   { id, op: "status" }                           -> { id, ok, ready: boolean }
 */

export type WorkerOp = "compress" | "decompress" | "status";

interface Pending {
  resolve: (v: ArrayBuffer) => void;
  reject: (e: Error) => void;
}

export class CompressionBridge {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready = false;

  constructor(private workerUrl: string | URL) {}

  async init(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(this.workerUrl, { type: "module" });
    this.worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { id: number; ok: boolean; result?: ArrayBuffer; error?: string; ready?: boolean };
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok && msg.result) p.resolve(msg.result);
      else if (msg.ok) p.resolve(new ArrayBuffer(0));
      else p.reject(new Error(msg.error ?? "worker error"));
    };
    this.worker.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new Error(`worker error: ${String(e.message ?? e)}`));
      this.pending.clear();
    };
    // Wait for engine init handshake.
    await this.call("status", new ArrayBuffer(0));
    this.ready = true;
  }

  get isReady(): boolean {
    return this.ready;
  }

  private call(op: WorkerOp, payload: ArrayBuffer): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("bridge not initialized"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      // Zero-copy transfer: buffer is detached on send.
      this.worker.postMessage({ id, op, payload }, [payload]);
    });
  }

  async compress(raw: Uint8Array): Promise<Uint8Array> {
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const res = await this.call("compress", buf);
    return new Uint8Array(res);
  }

  async decompress(compressed: Uint8Array): Promise<Uint8Array> {
    const buf = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer;
    const res = await this.call("decompress", buf);
    return new Uint8Array(res);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.pending.clear();
  }
}
