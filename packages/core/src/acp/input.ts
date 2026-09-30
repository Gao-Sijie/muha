import { readFile } from "node:fs/promises";
import { MuhaError } from "../errors.js";
import type { AdapterTurnInput } from "../internal.js";
import { detectImageMediaType } from "../session.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";

/** ACP ContentBlock conversion. Re-check file bytes at the actual read boundary
 * rather than trusting a filename or the earlier public input validation. */
export async function acpInput(input: readonly AdapterTurnInput[]): Promise<ContentBlock[]> {
  return Promise.all(input.map(async (part): Promise<ContentBlock> => {
    if (part.type === "text") return { type: "text", text: part.text };
    const source = part.source;
    if (source.type === "base64") return { type: "image", mimeType: source.mediaType, data: source.data };
    let bytes: Buffer;
    try { bytes = await readFile(source.path); }
    catch { throw new MuhaError({ code: "INVALID_INPUT", message: "Image file must be readable" }); }
    const mimeType = detectImageMediaType(bytes);
    if (!mimeType) throw new MuhaError({ code: "INVALID_INPUT", message: "Image file has an unsupported or invalid signature" });
    return { type: "image", mimeType, data: bytes.toString("base64") };
  }));
}
