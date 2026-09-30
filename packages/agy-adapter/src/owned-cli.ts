import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Duplex, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { HarnessErrorData } from "@muha-sdk/core";
import type { LiveHarnessAdapterContext } from "@muha-sdk/core/internal";
import { bounded, Deferred, failure, object, type JsonObject } from "./protocol.js";

// The independent helper owns/reaps its descendants. Nothing changes the
// consuming Node process's signals, child ownership, cwd, or environment.
export class OwnedCli {
  readonly ready = new Deferred<JsonObject>();
  readonly #closed = new Deferred<void>();
  readonly #child: ChildProcess;
  readonly #control: Duplex;
  readonly #input: Writable;
  readonly #shutdownMs: number;
  readonly #onLoss: (error: HarnessErrorData) => void;
  #incoming: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #reaped = false;
  #lost = false;
  #nativeReady = false;
  #nativeExited = false;
  #printTimedOut = false;
  readonly #outputEnded = new Deferred<void>();

  constructor(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, shutdownMs: number,
    context: LiveHarnessAdapterContext, onEvent: (event: JsonObject, printTimedOut: boolean) => void,
    onLoss: (error: HarnessErrorData) => void, operation: HarnessErrorData["operation"]) {
    this.#shutdownMs = shutdownMs;
    this.#onLoss = onLoss;
    this.#child = spawn(fileURLToPath(new URL("./agy-supervisor", import.meta.url)),
      [String(Math.min(1_000, Math.floor(shutdownMs / 2))), "agy", ...args],
      { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    this.#control = this.#child.stdio[3] as Duplex;
    this.#input = this.#child.stdin!;
    const lose = (message: string): void => {
      const error = failure("closeHarness", message);
      this.ready.reject(error);
      if (!this.#closing && !this.#lost) { this.#lost = true; onLoss(error); }
    };
    this.#child.once("error", error => lose(`AGY supervisor spawn failed: ${error.message}`));
    this.#input.on("error", error => lose(`AGY input channel failed: ${error.message}`));
    this.#control.on("error", error => lose(`AGY ownership channel failed: ${error.message}`));
    this.#control.on("end", () => {
      if (!this.#reaped && !this.#nativeExited) lose("AGY ownership channel ended before cleanup");
    });
    const controlLines = createInterface({ input: this.#control });
    controlLines.on("error", error => lose(`AGY ownership reader failed: ${error.message}`));
    controlLines.on("line", line => {
      try {
        const event = object(JSON.parse(line));
        if (event.type === "ready") this.#control.write("go\n");
        else if (event.type === "closed") {
          this.#reaped = event.noChildren === true && event.cleanupError === false;
          if (!this.#reaped) this.#closed.reject(failure("closeSession", "AGY owned-process cleanup failed"));
        } else if (event.type === "nativeExit") {
          this.#nativeExited = true;
          // stdout and fd3 are independent pipes: drain semantic responses
          // before classifying an exit, especially an explicit startup ERROR.
          void this.#outputEnded.promise.then(() => this.#incoming).then(() => lose("AGY native process exited"), () => lose("AGY output failed before exit"));
        } else if (event.type === "error") lose(`AGY supervisor failed during ${String(event.operation)} (${String(event.errno)})`);
      } catch { lose("Invalid AGY ownership response"); }
    });
    const output = this.#child.stdout as Readable;
    const handle = async (line: string): Promise<void> => {
        if (!line.trim()) return;
        const event = object(JSON.parse(line));
        if (event.event !== "init" && event.event !== "step_update" && event.event !== "result") {
          throw new Error("Unrecognized AGY semantic envelope");
        }
        await context.recordNativeEvent("agy", event);
        if (event.event === "init") {
          if (this.#nativeReady) throw new Error("AGY repeated Session initialization");
          this.#nativeReady = true;
          this.ready.resolve(event);
        }
        else if (!this.#nativeReady && event.event === "result" && object(event.result).status === "ERROR") {
          const result = object(event.result);
          this.#closing = true;
          this.ready.reject({ ...failure(operation, typeof result.error === "string" ? result.error : "AGY rejected Session initialization"),
            nativeCode: "ERROR", stage: "handshake" });
        }
        else {
          // Native timeout reporting precedes result on a separate stderr
          // pipe. Drain this poll's ready descriptors before its terminal.
          if (event.event === "result") await new Promise<void>(resolve => setImmediate(resolve));
          onEvent(event, this.#printTimedOut);
        }
    };
    output.setEncoding("utf8");
    this.#incoming = (async () => {
      let buffer = "";
      try {
        for await (const chunk of output) {
          buffer += String(chunk);
          if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error("AGY protocol frame exceeds 8 MiB");
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            await handle(line);
          }
        }
        if (buffer.trim()) await handle(buffer);
        lose("AGY output channel ended");
      } catch { lose("AGY output protocol or diagnostic recording failed"); }
      finally { this.#outputEnded.resolve(); }
    })();
    // Stderr is a bounded control observation, never a Native Event Record.
    let stderrLine = "";
    this.#child.stderr!.setEncoding("utf8");
    this.#child.stderr!.on("data", (chunk: string) => {
      stderrLine += chunk;
      let end: number;
      while ((end = stderrLine.indexOf("\n")) >= 0) {
        const line = stderrLine.slice(0, end);
        stderrLine = stderrLine.slice(end + 1);
        if (/^\[agy\] print timeout after .+ with turn in progress; returning partial output\r?$/u.test(line)) this.#printTimedOut = true;
      }
      if (stderrLine.length > 4_096) stderrLine = stderrLine.slice(-4_096);
    });
    this.#child.stderr!.on("error", error => lose(`AGY error channel failed: ${error.message}`));
    this.#child.once("close", (code, signal) => {
      void this.#incoming.finally(() => {
        // This shipped helper exits 0 only after ECHILD with no cleanup error.
        // A close write can race its exit and lose the final fd3 response; the
        // child's exit status remains independent evidence of reclamation.
        if (code === 0 && signal === null) this.#reaped = true;
        if (this.#reaped) this.#closed.resolve();
        else this.#closed.reject(failure("closeSession", "AGY supervisor exited without confirming descendant cleanup"));
        lose("AGY supervisor exited");
      }).catch(() => {});
    });
  }

  write(event: JsonObject): void { this.#printTimedOut = false; this.#input.write(`${JSON.stringify(event)}\n`); }
  close(interrupt = false): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    if (!this.#reaped && !this.#control.destroyed) this.#control.write(interrupt ? "interrupt\n" : "close\n");
    this.#closePromise = bounded(this.#closed.promise, this.#shutdownMs,
      failure("closeSession", "AGY descendant cleanup timed out")).catch(error => {
        // Helper death is outside the complete cleanup guarantee (ADR-0128).
        // A deadline reports failure and never claims descendants were reaped.
        this.#child.kill("SIGKILL");
        this.#control.destroy();
        this.#input.destroy();
        this.#child.stdout?.destroy();
        this.#child.stderr?.destroy();
        // An intentional close suppresses expected EOF, never an inability
        // to reclaim execution. Helper loss remains fatal under ADR-0128.
        if (!this.#lost) {
          this.#lost = true;
          this.#onLoss(error);
        }
        throw error;
      });
    return this.#closePromise;
  }
}
