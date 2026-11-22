/**
 * Compression bridge — service-worker side.
 *
 * MV3 service workers have no `Worker` constructor, so compression is hosted
 * in an offscreen document (public/offscreen.html). This class ensures that
 * document exists and relays compress/decompress requests to it via
 * chrome.runtime messages. Inside the offscreen document the payload is still
 * transferred to the zstd worker as a zero-copy Transferable; the extension
 * message hop itself is a structured clone (documented limitation).
 */

interface CompressionReply {
  ok: boolean;
  result?: Uint8Array;
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
    const reply = (await chrome.runtime.sendMessage({ type, payload })) as CompressionReply | undefined;
    if (!reply) throw new Error(`no reply from offscreen document for ${type}`);
    if (!reply.ok) throw new Error(reply.error ?? `${type} failed`);
    return reply;
  }

  async compress(raw: Uint8Array): Promise<Uint8Array> {
    const reply = await this.call("LTO_OFFSCREEN_COMPRESS", raw);
    return new Uint8Array(reply.result ?? new Uint8Array(0));
  }

  async decompress(compressed: Uint8Array): Promise<Uint8Array> {
    const reply = await this.call("LTO_OFFSCREEN_DECOMPRESS", compressed);
    return new Uint8Array(reply.result ?? new Uint8Array(0));
  }
}
