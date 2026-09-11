import { MuhaError, type HarnessErrorData } from "./errors.js";
import type { HarnessKind } from "./index.js";
import type { RuntimeScheduler } from "./scheduler.js";

export const controlCommandTimeoutMs = 60 * 60 * 1_000;

export type ControlCommandRunner = <T>(
  harness: HarnessKind,
  operation: HarnessErrorData["operation"],
  start: () => Promise<T>,
) => Promise<T>;

interface PendingCommand {
  cancel(): void;
}

export class RuntimeCommandSupervisor {
  readonly #pending = new Set<PendingCommand>();
  #closed = false;

  constructor(
    readonly scheduler: RuntimeScheduler,
    readonly onTimeout: (error: HarnessErrorData) => void,
  ) {}

  runControl<T>(
    harness: HarnessKind,
    operation: HarnessErrorData["operation"],
    start: () => Promise<T>,
  ): Promise<T> {
    return this.#run(start, { harness, operation });
  }

  runCancellable<T>(start: () => Promise<T>): Promise<T> {
    return this.#run(start);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const command of [...this.#pending]) command.cancel();
  }

  #run<T>(
    start: () => Promise<T>,
    control?: {
      readonly harness: HarnessKind;
      readonly operation: HarnessErrorData["operation"];
    },
  ): Promise<T> {
    if (this.#closed) return Promise.reject(runtimeClosed());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: unknown;
      const finish = (outcome: "resolve" | "reject", value: T | unknown) => {
        if (settled) return;
        settled = true;
        this.#pending.delete(command);
        if (timer !== undefined) this.scheduler.clearTimeout(timer);
        if (outcome === "resolve") resolve(value as T);
        else reject(value);
      };
      const command: PendingCommand = {
        cancel: () => finish("reject", runtimeClosed()),
      };
      this.#pending.add(command);
      if (control) {
        timer = this.scheduler.setTimeout(() => {
          const error: HarnessErrorData = {
            code: "HARNESS_ERROR",
            message: "Harness control command acknowledgement timed out",
            harness: control.harness,
            operation: control.operation,
          };
          finish("reject", new MuhaError(error));
          // Let an enclosing cancellable public command adopt this exact failure
          // before fatal close rejects every other pending command as RUNTIME_CLOSED.
          queueMicrotask(() => queueMicrotask(() => this.onTimeout(error)));
        }, controlCommandTimeoutMs);
      }
      let operation: Promise<T>;
      try {
        operation = start();
      } catch (error) {
        finish("reject", error);
        return;
      }
      operation.then(
        (value) => finish("resolve", value),
        (error: unknown) => finish("reject", error),
      );
    });
  }
}

function runtimeClosed(): MuhaError {
  return new MuhaError({
    code: "RUNTIME_CLOSED",
    message: "Runtime closed before the command completed",
  });
}
