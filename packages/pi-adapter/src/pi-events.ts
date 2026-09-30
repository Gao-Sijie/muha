import type { AdapterTurnEvent } from "@muha-sdk/core/internal";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Pi event object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Pi event string");
  return value;
}
function tokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Pi usage");
  return value;
}

export class PiEvents {
  #message = 0;
  #input = 0;
  #output = 0;
  #cached = 0;
  constructor(readonly emit: (event: AdapterTurnEvent) => void) {}

  receive(raw: unknown): void {
    const event = object(raw);
    if (event.type === "message_start" && object(event.message).role === "assistant") {
      this.#message++;
      this.emit({ type: "assistant.message.started", nativeMessageId: String(this.#message) });
    } else if (event.type === "message_update") {
      const update = object(event.assistantMessageEvent);
      if ((update.type === "text_delta" || update.type === "thinking_delta") && update.delta) {
        this.emit({ type: update.type === "text_delta" ? "assistant.message.delta" : "assistant.reasoning.delta",
          nativeMessageId: String(this.#message), delta: string(update.delta) });
      }
    } else if (event.type === "message_end" && object(event.message).role === "assistant") {
      const { content, usage } = object(event.message);
      if (!Array.isArray(content)) throw new Error("Invalid Pi Assistant Message content");
      this.emit({ type: "assistant.message.completed", nativeMessageId: String(this.#message),
        text: content.map(object).filter(part => part.type === "text").map(part => string(part.text)).join("") });
      if (usage) {
        const native = object(usage);
        this.#input += tokens(native.input) + tokens(native.cacheRead) + tokens(native.cacheWrite);
        this.#output += tokens(native.output);
        this.#cached += tokens(native.cacheRead);
        this.emit({ type: "usage.updated", usage: {
          inputTokens: this.#input, outputTokens: this.#output, cachedInputTokens: this.#cached,
        } });
      }
    } else if (event.type === "tool_execution_start") {
      this.emit({ type: "tool.started", nativeToolCallId: string(event.toolCallId), toolName: string(event.toolName), input: event.args });
    } else if (event.type === "tool_execution_update") {
      this.emit({ type: "tool.updated", nativeToolCallId: string(event.toolCallId), update: event.partialResult ?? null });
    } else if (event.type === "tool_execution_end") {
      if (typeof event.isError !== "boolean") throw new Error("Invalid Pi tool result status");
      this.emit({ type: "tool.completed", nativeToolCallId: string(event.toolCallId), output: event.result ?? null, isError: event.isError });
    }
  }
}
