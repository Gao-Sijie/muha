import type { HarnessErrorData } from "@muha-sdk/core";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw failure("startTurn", "Invalid AGY protocol object");
  return value as JsonObject;
}
export function failure(operation: HarnessErrorData["operation"], message: string): HarnessErrorData {
  return { code: "HARNESS_ERROR", harness: "agy", operation, command: "agy", message, retryable: false };
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // A native channel can fail before its consumer reaches the await.
    void this.promise.catch(() => {});
  }
}

export async function bounded<T>(promise: Promise<T>, ms: number, error: HarnessErrorData): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(error), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export class EventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  push(value: T): void { if (!this.#ended) { this.#items.push(value); this.#wake?.(); } }
  end(): void { this.#ended = true; this.#wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.#items.length) { yield this.#items.shift()!; continue; }
      if (this.#ended) return;
      await new Promise<void>(resolve => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}
