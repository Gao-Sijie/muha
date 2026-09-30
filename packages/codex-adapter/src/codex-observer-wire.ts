import type { Readable, Writable } from "node:stream";

export type NativeObject = Record<string, unknown>;

/** Bounded byte framing shared only by the private native observer endpoints. */
export async function* nativeFrames(input: Readable): AsyncGenerator<{ raw: Buffer; message: NativeObject }> {
  let parts: Buffer[] = [];
  let length = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(start, end);
      length += part.length;
      if (length > 8 * 1024 * 1024) throw new Error("Codex observer frame exceeds 8 MiB");
      parts.push(part);
      start = end;
      if (newline < 0) continue;
      const raw = Buffer.concat(parts, length);
      parts = []; length = 0;
      const source = decoder.decode(raw);
      if (!source.trim()) continue;
      const message: unknown = JSON.parse(source);
      if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("Codex observer frame must be an object");
      yield { raw, message: message as NativeObject };
    }
  }
  if (length !== 0) throw new Error("Codex observer received a truncated frame");
}

export function writeNative(target: Writable, value: Uint8Array | string): Promise<void> {
  return new Promise((resolve, reject) => target.write(value, error => error ? reject(error) : resolve()));
}
