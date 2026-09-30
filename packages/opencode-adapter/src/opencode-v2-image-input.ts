import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { SessionPromptInput } from "@opencode/client";
import { MuhaError } from "@muha-sdk/core";
import type { AdapterTurnInput } from "@muha-sdk/core/internal";
import { orderedInputMetadataKey } from "./opencode-v2-order-plugin.js";

type PromptContent = Pick<SessionPromptInput, "text" | "files" | "metadata">;
type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

function invalid(message: string): never {
  throw new MuhaError({ code: "INVALID_INPUT", message });
}

function mediaType(bytes: Buffer): ImageMediaType {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  return invalid("OpenCode image file became invalid before native acceptance");
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function openCodeV2Input(input: readonly AdapterTurnInput[]): Promise<PromptContent> {
  const parts = await Promise.all(input.map(async (part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    if (part.source.type === "base64") {
      return {
        type: "image" as const,
        mime: part.source.mediaType,
        bytes: Buffer.from(part.source.data, "base64"),
        name: undefined,
      };
    }
    let bytes: Buffer;
    try { bytes = await readFile(part.source.path); }
    catch { return invalid("OpenCode image file became unreadable before native acceptance"); }
    return {
      type: "image" as const,
      mime: mediaType(bytes),
      bytes,
      name: basename(part.source.path),
    };
  }));
  const texts: string[] = [];
  const files: NonNullable<SessionPromptInput["files"]>[number][] = [];
  const order: Array<{ readonly type: "text"; readonly length: number } |
    { readonly type: "image"; readonly index: number; readonly mime: string; readonly sha256: string }> = [];
  for (const part of parts) {
    if (part.type === "text") {
      texts.push(part.text);
      order.push({ type: "text", length: part.text.length });
      continue;
    }
    const index = files.length;
    files.push({
      uri: `data:${part.mime};base64,${part.bytes.toString("base64")}`,
      ...(part.name === undefined ? {} : { name: part.name }),
    });
    order.push({ type: "image", index, mime: part.mime, sha256: sha256(part.bytes) });
  }
  const text = texts.join("");
  return {
    text,
    files,
    metadata: {
      [orderedInputMetadataKey]: { version: 1, textSha256: sha256(text), parts: order },
    },
  };
}
