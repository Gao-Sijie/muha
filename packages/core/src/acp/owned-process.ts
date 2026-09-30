import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

/** Private Linux subreaper. fd3 controls ownership; stdin/out belong to ACP.
 * It never changes the consumer's signal handlers or reaps its other children.
 * A successful close means ECHILD, not merely that the entry process exited.
 * ADR-0138 excludes full reclamation after this helper dies, not reporting
 * that failure or releasing our own handles. */
export class AcpOwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #control: Duplex;
  readonly #closed: Promise<void>;
  readonly #shutdownMs: number;
  #closing = false;
  #lost = false;
  #reaped = false;
  #closePromise: Promise<void> | undefined;

  constructor(command: string, args: readonly string[], env: NodeJS.ProcessEnv, shutdownMs: number,
    onLoss: (message: string, kind: "ownership" | "native") => void) {
    this.#shutdownMs = shutdownMs;
    const child = spawn(fileURLToPath(new URL("../acp-supervisor", import.meta.url)),
      [String(Math.min(1000, Math.floor(shutdownMs / 2))), command, ...args],
      { cwd: process.cwd(), env, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    this.child = child as ChildProcessWithoutNullStreams;
    this.#control = child.stdio[3] as Duplex;
    const lose = (message: string, kind: "ownership" | "native" = "ownership"): void => {
      if (!this.#closing && !this.#lost) { this.#lost = true; onLoss(message, kind); }
    };
    const lines = createInterface({ input: this.#control });
    lines.on("error", () => lose("ACP ownership reader failed"));
    lines.on("line", line => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "ready") {
          if (!this.#closing) this.#control.write("go\n");
        } else if (event.type === "closed") {
          this.#reaped = event.noChildren === true && event.cleanupError === false;
        } else if (event.type === "error") {
          lose(`ACP supervisor failed during ${String(event.operation)} (${String(event.errno)})`);
        }
      } catch { lose("Invalid ACP ownership response"); }
    });
    this.#control.on("error", () => lose("ACP ownership channel failed"));
    child.stdin!.on("error", () => lose("ACP input channel failed"));
    // Stderr must never block the child and must never enter the semantic log.
    child.stderr!.resume();
    child.stderr!.on("error", () => lose("ACP stderr channel failed"));
    this.#closed = new Promise((resolve, reject) => {
      child.once("error", () => {
        lose("ACP ownership helper could not start");
        reject(new Error("ACP ownership helper could not start"));
      });
      child.once("exit", (code, signal) => {
        // Descendants inherit ACP stdout/stderr, so ChildProcess.close may
        // never follow helper death. Observe the owning process independently
        // and fail promptly without claiming its descendants were reclaimed.
        if (code !== 0 || signal !== null) {
          reject(new Error("ACP supervisor exited without proving descendant cleanup"));
          lose("ACP ownership helper exited unexpectedly");
        }
      });
      child.once("close", (code, signal) => {
        // The shipped helper exits zero only after proving it has no children.
        if (code === 0 && signal === null) this.#reaped = true;
        if (this.#reaped) resolve();
        else reject(new Error("ACP supervisor exited without proving descendant cleanup"));
        lose("ACP agent service exited", "native");
      });
    });
    void this.#closed.catch(() => {});
  }

  close(deadline = Date.now() + this.#shutdownMs): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.child.stdin.end();
    if (!this.#reaped && !this.#control.destroyed) this.#control.write("close\n");
    this.#closePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Helper loss cannot honestly be reported as complete reclamation.
        // The normal helper force-kills/reaps descendants well before this.
        this.child.kill("SIGKILL");
        this.#control.destroy();
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        this.child.stderr.destroy();
        reject(new Error("ACP descendant cleanup timed out"));
      }, Math.max(1, deadline - Date.now()));
      this.#closed.then(() => { clearTimeout(timer); resolve(); }, error => {
        clearTimeout(timer);
        // We cannot report descendant reclamation, but must still release our
        // descriptors so a dead helper cannot keep the consumer alive forever.
        this.#control.destroy();
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        this.child.stderr.destroy();
        reject(error);
      });
    });
    return this.#closePromise;
  }
}
