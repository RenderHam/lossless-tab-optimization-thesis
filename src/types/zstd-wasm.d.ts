declare module "@bokuweb/zstd-wasm" {
  export function ZstdInit(): Promise<{
    ZstdCodec: new () => {
      compress(data: Uint8Array, level: number): Uint8Array;
      decompress(data: Uint8Array): Uint8Array;
    };
  }>;
}
