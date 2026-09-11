export interface RuntimeScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemScheduler: RuntimeScheduler = Object.freeze({
  setTimeout(callback: () => void, delayMs: number) {
    const timer = globalThis.setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout(handle: unknown) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

let installedScheduler: RuntimeScheduler | undefined;

export function currentRuntimeScheduler(): RuntimeScheduler {
  return installedScheduler ?? systemScheduler;
}

export function installRuntimeSchedulerForTesting(
  scheduler: RuntimeScheduler,
): () => void {
  if (installedScheduler) {
    throw new Error("A Runtime scheduler is already installed");
  }
  installedScheduler = scheduler;
  return () => {
    if (installedScheduler === scheduler) installedScheduler = undefined;
  };
}
