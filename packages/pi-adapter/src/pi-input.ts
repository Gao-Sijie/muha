import { readFile } from "node:fs/promises";
import { MuhaError } from "@muha-sdk/core";
import type { AdapterTurnInput } from "@muha-sdk/core/internal";

function invalid(message: string): never { throw new MuhaError({ code: "INVALID_INPUT", message }); }

function mediaType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  return invalid("Pi image file became invalid before native acceptance");
}

export async function piInput(input: readonly AdapterTurnInput[]): Promise<unknown[]> {
  return Promise.all(input.map(async part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.source.type === "base64") return { type: "image", mimeType: part.source.mediaType, data: part.source.data };
    let bytes: Buffer;
    try { bytes = await readFile(part.source.path); }
    catch { return invalid("Pi image file became unreadable before native acceptance"); }
    // Snapshot verified bytes for IPC: subsequent file changes cannot alter
    // the content received by the SDK after Muha accepts this input.
    return { type: "image", mimeType: mediaType(bytes), data: bytes.toString("base64") };
  }));
}
