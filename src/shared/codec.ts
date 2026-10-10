/**
 * Deterministic stable stringify: recursively sorts object keys so that
 * the byte representation fed into zstd is byte-identical for
 * semantically identical states. Pure function, no randomness.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value) ?? "null";
  const t = typeof value;
  if (t === "number" || t === "boolean" || t === "string") return JSON.stringify(value) as string;
  if (Array.isArray(value)) {
    const parts = new Array<string>(value.length);
    for (let i = 0; i < value.length; i++) parts[i] = stableStringify(value[i]);
    return `[${parts.join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined || typeof v === "function") continue; // match JSON.stringify
      parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(String(value)) as string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeUtf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Split bytes into fixed-size chunks (last chunk may be short). Deterministic. */
export function chunkBytes(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("chunkSize must be a positive integer");
  }
  const out: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += chunkSize) {
    out.push(bytes.slice(off, off + chunkSize));
  }
  if (bytes.length === 0) out.push(new Uint8Array(0));
  return out;
}

/** Concatenate chunks back in index order. */
export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
