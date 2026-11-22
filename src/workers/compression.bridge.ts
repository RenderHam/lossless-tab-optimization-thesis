/**
 * Compression bridge — service-worker side.
 *
 * MV3 service workers have no `Worker` constructor, so compression is hosted
 * in an offscreen document (public/offscreen.html). This class ensures that
 * document exists and relays compress/decompress requests to it via
 * chrome.runtime messages. Chrome serializes extension messages as JSON, so
 * binary payloads are base64-encoded on this hop; the offscreen→worker hop
 * remains a zero-copy Transferable transfer.
 */

import { base64ToBytes, bytesToBase64 } from "../shared/codec";

interface CompressionReply {
  ok: boolean;
  resultB64?: string;
  error?: string;
}

export class CompressionBridge {
  private ready = false;

  get isReady(): boolean {
    return this.ready;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    // @types/chrome 0.0.280 predates OFFSCREEN_DOCUMENT / WORKERS literals.
    const runtimeApi = chrome.runtime as unknown as {
      getContexts: (info: { contextTypes: string[] }) => Promise<unknown[]>;
    };
    const offscreenApi = (chrome as unknown as {
      offscreen: {
        createDocument: (info: { url: string; reasons: string[]; justification: string }) => Promise<void>;
      };
    }).offscreen;
    const contexts = await runtimeApi.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length === 0) {
      await offscreenApi.createDocument({
        url: chrome.runtime.getURL("offscreen.html"),
        reasons: ["WORKERS"],
        justification: "Host the zstd-wasm worker used for lossless tab state compression",
      });
    }
    const reply = await this.call("LTO_OFFSCREEN_PING");
    if (!reply.ok) throw new Error(reply.error ?? "offscreen document not responding");
    this.ready = true;
  }

  private async call(type: string, payload?: Uint8Array): Promise<CompressionReply> {
    const reply = (await chrome.runtime.sendMessage({
      type,
      payloadB64: payload ? bytesToBase64(payload) : undefined,
    })) as CompressionReply | undefined;
    if (!reply) throw new Error(`no reply from offscreen document for ${type}`);
    if (!reply.ok) throw new Error(reply.error ?? `${type} failed`);
    return reply;
  }

  async compress(raw: Uint8Array): Promise<Uint8Array> {
    const reply = await this.call("LTO_OFFSCREEN_COMPRESS", raw);
    if (!reply.resultB64) throw new Error("offscreen compression returned no data");
    return base64ToBytes(reply.resultB64);
  }

  async decompress(compressed: Uint8Array): Promise<Uint8Array> {
    const reply = await this.call("LTO_OFFSCREEN_DECOMPRESS", compressed);
    if (!reply.resultB64) throw new Error("offscreen decompression returned no data");
    return base64ToBytes(reply.resultB64);
  }
}
