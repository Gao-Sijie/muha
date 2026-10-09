import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

// The exact Core dependency ships this private, qualified Linux subreaper.
// fd3 carries ownership control; fd4 carries Node's unchanged SDK IPC protocol.
// Kernel adoption covers children born before the SDK can report their PID.
export class PiOwnedWorker {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly #control: Duplex;
  #closing: Promise<void> | undefined;
  #reaped = false;
  #lossReported = false;

  constructor(env: NodeJS.ProcessEnv, readonly shutdownMs: number,
    readonly onLoss: (message: string) => void) {
    const supervisor = new URL("./acp-supervisor", import.meta.resolve("@muha-sdk/core"));
    this.child = spawn(fileURLToPath(supervisor),
      [String(Math.min(1000, Math.floor(shutdownMs / 4))), process.execPath,
        fileURLToPath(new URL("./sdk-worker.mjs", import.meta.url))],
      { env, stdio: ["ignore", "ignore", "ignore", "pipe", "ipc"], serialization: "json" });
    this.#control = this.child.stdio[3] as Duplex;
    const lose = (message: string): void => {
      if (!this.#closing && !this.#lossReported) {
        this.#lossReported = true;
        this.onLoss(message);
      }
    };
    this.#control.on("error", () => lose("Pi ownership channel failed"));
    const lines = createInterface({ input: this.#control });
    lines.on("error", () => lose("Pi ownership reader failed"));
    lines.on("line", line => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "ready") {
          if (!this.#closing) this.#control.write("go\n");
        } else if (event.type === "closed") {
          this.#reaped = event.noChildren === true && event.cleanupError === false;
        } else if (event.type === "error") {
          lose(`Pi supervisor failed during ${String(event.operation)} (${String(event.errno)})`);
        } else if (!["spawned", "nativeExit", "closing"].includes(String(event.type))) {
          lose("Invalid Pi ownership response");
        }
      } catch { lose("Invalid Pi ownership response"); }
    });
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", () => {
        lose("Pi ownership helper could not start");
        reject(new Error("Pi ownership helper could not start"));
      });
      this.child.once("exit", (code, signal) => {
        if (code !== 0 || signal !== null) {
          const message = "Pi supervisor exited without proving descendant cleanup";
          lose(message);
          reject(new Error(message));
        }
      });
      this.child.once("close", (code, signal) => {
        // The unchanged helper exits zero only after proving ECHILD.
        if (code === 0 && signal === null) this.#reaped = true;
        if (this.#reaped) resolve();
        else reject(new Error("Pi supervisor exited without proving descendant cleanup"));
      });
    });
    void this.exited.catch(() => {});
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    // First allow the SDK's normal abort/dispose path. An unresponsive SDK is
    // then terminated by its independent owner, which also adopts late forks.
    this.#closing = new Promise((resolve, reject) => {
      const force = setTimeout(() => {
        if (!this.#reaped && !this.#control.destroyed) this.#control.write("close\n");
      }, Math.floor(this.shutdownMs / 2));
      const deadline = setTimeout(() => {
        clearTimeout(force);
        this.child.kill("SIGKILL");
        this.#release();
        reject(new Error("Pi descendant cleanup timed out"));
      }, this.shutdownMs);
      this.exited.then(() => {
        clearTimeout(force); clearTimeout(deadline); this.#release(); resolve();
      }, error => {
        clearTimeout(force); clearTimeout(deadline); this.#release(); reject(error);
      });
    });
    return this.#closing;
  }

  #release(): void {
    this.#control.destroy();
    if (this.child.connected) this.child.disconnect();
  }
}
