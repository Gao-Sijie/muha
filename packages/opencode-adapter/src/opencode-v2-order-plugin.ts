import { createHash } from "node:crypto";

export const orderedInputPluginID = "muha.ordered-input";
export const orderedInputMetadataKey = "muhaOrderedInput";

type Part = Record<string, unknown>;
type Message = { metadata?: Record<string, unknown>; content: Part[] };
type ContextEvent = { messages: Message[]; model?: unknown };
type PluginContext = {
  session: {
    hook(name: "context" | "compaction" | "generate" | "title",
      callback: (event: ContextEvent) => void | Promise<void>): Promise<unknown>;
  };
  model: { list(): Promise<unknown> };
};

type TextPart = { readonly type: "text"; readonly length: number };
type ImagePart = { readonly type: "image"; readonly index: number; readonly mime: string; readonly sha256: string };
type OrderedPart = TextPart | ImagePart;
type Manifest = { readonly version: 1; readonly textSha256: string; readonly parts: readonly OrderedPart[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(value: unknown): Manifest {
  if (!record(value) || value.version !== 1 || typeof value.textSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.textSha256) || !Array.isArray(value.parts) || value.parts.length === 0) {
    throw new Error("Muha ordered input manifest is invalid");
  }
  const parts: OrderedPart[] = [];
  for (const item of value.parts) {
    if (!record(item)) throw new Error("Muha ordered input part is invalid");
    if (item.type === "text" && Number.isSafeInteger(item.length) && (item.length as number) > 0) {
      parts.push({ type: "text", length: item.length as number });
      continue;
    }
    if (item.type === "image" && Number.isSafeInteger(item.index) && (item.index as number) >= 0 &&
        typeof item.mime === "string" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mime) &&
        typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256)) {
      parts.push({ type: "image", index: item.index as number, mime: item.mime, sha256: item.sha256 });
      continue;
    }
    throw new Error("Muha ordered input part is invalid");
  }
  return { version: 1, textSha256: value.textSha256, parts };
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Muha ordered image data is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("Muha ordered image data is invalid");
  }
  return decoded;
}

export function restoreOrderedMessages(event: ContextEvent): void {
  for (const message of event.messages) {
    const raw = message.metadata?.[orderedInputMetadataKey];
    if (raw === undefined) continue;
    const order = manifest(raw);
    if (!Array.isArray(message.content)) throw new Error("Muha ordered message content is invalid");
    const images = message.content.filter((part) => part.type === "media");
    const texts = message.content.filter((part) => part.type === "text");
    const expectedImages = order.parts.filter((part) => part.type === "image").length;
    if (images.length !== expectedImages || texts.length > 1 ||
        message.content.length !== images.length + texts.length) {
      throw new Error("Muha ordered message content changed before model dispatch");
    }
    const joinedText = texts.map((part) => part.text).join("");
    if (typeof joinedText !== "string" || sha256(joinedText) !== order.textSha256) {
      throw new Error("Muha ordered message text changed before model dispatch");
    }
    const restored: Part[] = [];
    let offset = 0;
    let nextImage = 0;
    for (const part of order.parts) {
      if (part.type === "text") {
        const base = texts[0];
        if (base === undefined || offset + part.length > joinedText.length) {
          throw new Error("Muha ordered message text length is invalid");
        }
        restored.push({ ...base, text: joinedText.slice(offset, offset + part.length) });
        offset += part.length;
        continue;
      }
      if (part.index !== nextImage) throw new Error("Muha ordered image index is invalid");
      const image = images[nextImage];
      if (image === undefined || image.mediaType !== part.mime || sha256(bytes(image.data)) !== part.sha256) {
        throw new Error("Muha ordered image changed before model dispatch");
      }
      restored.push(image);
      nextImage++;
    }
    if (offset !== joinedText.length || nextImage !== images.length) {
      throw new Error("Muha ordered message manifest is incomplete");
    }
    message.content.splice(0, message.content.length, ...restored);
  }
}

export default {
  id: orderedInputPluginID,
  async setup(context: PluginContext) {
    for (const name of ["context", "compaction", "generate", "title"] as const) {
      await context.session.hook(name, async (event) => {
        restoreOrderedMessages(event);
        const hasImage = event.messages.some((message) => {
          const order = message.metadata?.[orderedInputMetadataKey];
          return record(order) && Array.isArray(order.parts) &&
            order.parts.some((part: unknown) => record(part) && part.type === "image");
        });
        if (!hasImage) return;
        const selected = event.model;
        if (!record(selected)) throw new Error("Muha ordered image Model is unavailable");
        const providerID = selected.providerID;
        const id = selected.id ?? selected.modelID;
        if (typeof providerID !== "string" || typeof id !== "string") {
          throw new Error("Muha ordered image Model identity is invalid");
        }
        const catalog = await context.model.list();
        if (!record(catalog) || !Array.isArray(catalog.data)) {
          throw new Error("Muha ordered image Model catalog is invalid");
        }
        const model = catalog.data.find((value) =>
          record(value) && value.providerID === providerID && value.id === id);
        if (!record(model) || !record(model.capabilities) ||
            !Array.isArray(model.capabilities.input) ||
            !model.capabilities.input.includes("image")) {
          throw new Error("Muha ordered image Model does not support images");
        }
      });
    }
  },
};
