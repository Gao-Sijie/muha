import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { MuhaError, type HarnessModelInfo } from "@muha-sdk/core";
import { snapshotHarnessModels, type LiveHarnessAdapterContext } from "@muha-sdk/core/internal";
import { spawnHarnessProcess } from "@muha-sdk/core/internal/host-process";
import { bounded, Deferred, failure } from "./protocol.js";

/** A finite catalog command under the same descendant ownership boundary as AGY Turns. */
export class OwnedModelQuery {
  readonly result: Promise<string>;
  readonly #result = new Deferred<string>();
  readonly #closed = new Deferred<void>();
  readonly #child: ChildProcess;
  readonly #control: Duplex;
  #closing: Promise<void> | undefined;
  #reaped = false;
  #exited = false;
  #nativeCode: number | undefined;
  #error: unknown;
  #output = "";

  constructor(cwd: string, env: NodeJS.ProcessEnv, startupMs: number, readonly shutdownMs: number,
    readonly context: LiveHarnessAdapterContext) {
    this.result = this.#result.promise;
    this.#child = process.platform === "win32"
      ? spawnHarnessProcess("agy", ["models"], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] },
        shutdownMs, false, undefined, fileURLToPath(new URL("./agy-supervisor.exe", import.meta.url)))
      : spawn(fileURLToPath(new URL("./agy-supervisor", import.meta.url)),
        [String(Math.min(1_000, Math.floor(shutdownMs / 2))), "agy", "models"],
        { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    this.#control = this.#child.stdio[3] as Duplex;
    const abort = (error: unknown) => {
      this.#error ??= error;
      void this.close().catch(() => {});
    };
    this.#child.on("error", () => abort(failure("listModels", "AGY Model query could not start")));
    this.#child.stdin!.on("error", () => abort(failure("listModels", "AGY Model query input failed")));
    this.#control.on("error", () => abort(failure("listModels", "AGY Model ownership channel failed")));
    const lines = createInterface({ input: this.#control });
    lines.on("error", () => abort(failure("listModels", "AGY Model ownership reader failed")));
    lines.on("line", line => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "ready") { if (!this.#closing) this.#control.write("go\n"); }
        else if (event.type === "nativeExit") {
          if (typeof event.code !== "number") throw new Error();
          this.#nativeCode = event.code;
        } else if (event.type === "closed") {
          this.#reaped = event.noChildren === true && event.cleanupError === false;
        } else if (event.type === "error") abort(failure("listModels", "AGY Model query native startup failed"));
        else if (event.type !== "spawned" && event.type !== "closing") throw new Error();
      } catch { abort(failure("listModels", "Invalid AGY Model ownership response")); }
    });
    this.#child.stdout!.setEncoding("utf8");
    this.#child.stdout!.on("data", (chunk: string) => {
      if (this.#error !== undefined) return;
      if (Buffer.byteLength(this.#output) + Buffer.byteLength(chunk) > 8 * 1024 * 1024) {
        abort(new MuhaError({ code: "ADAPTER_PROTOCOL_ERROR", harness: "agy", message: "AGY Model catalog exceeds 8 MiB" }));
      } else this.#output += chunk;
    });
    this.#child.stdout!.on("error", () => abort(failure("listModels", "AGY Model output failed")));
    // Native process diagnostics are drained, never included in a catalog or command error.
    this.#child.stderr!.resume();
    this.#child.stderr!.on("error", () => abort(failure("listModels", "AGY Model error channel failed")));
    const timer = setTimeout(() => abort(failure("listModels", "AGY Model catalog query timed out")), startupMs);
    this.#child.once("close", (code, signal) => {
      clearTimeout(timer);
      this.#exited = true;
      // The Linux helper exits zero only after proving ECHILD; Windows also sends explicit proof.
      if (code === 0 && signal === null && (process.platform !== "win32" || this.#reaped)) {
        this.#reaped = true;
        this.#closed.resolve();
        if (this.#error !== undefined) this.#result.reject(this.#error);
        else if (this.#nativeCode !== 0) this.#result.reject({ ...failure("listModels", "AGY Model catalog command failed"),
          ...(this.#nativeCode === undefined ? {} : { exitCode: this.#nativeCode }) });
        else this.#result.resolve(this.#output);
      } else {
        const error = failure("closeHarness", "AGY Model query owner exited without proving descendant cleanup");
        this.#closed.reject(error);
        this.#result.reject(error);
        this.context.reportFatalError(error);
      }
      this.#control.destroy();
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (!this.#exited) {
      this.#error ??= failure("listModels", "AGY Model query was closed");
      if (!this.#control.destroyed) this.#control.write("close\n");
    }
    this.#closing = bounded(this.#closed.promise, this.shutdownMs,
      failure("closeHarness", "AGY Model query descendant cleanup timed out")).catch(error => {
      this.#child.kill("SIGKILL");
      this.#control.destroy();
      this.#child.stdin?.destroy();
      this.#child.stdout?.destroy();
      this.#child.stderr?.destroy();
      this.#result.reject(error);
      this.context.reportFatalError(failure("closeHarness", "AGY Model query descendant cleanup failed"));
      throw error;
    });
    return this.#closing;
  }
}

export function parseModelCatalog(output: string): readonly HarnessModelInfo[] {
  const models = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line === "") continue;
    // CLI 1.4.5 emits a tab; retain its documented aligned-column representation too.
    const match = /^([A-Za-z0-9][A-Za-z0-9._/-]*)(?:\t| {2,})([^\t\r\n]+)$/u.exec(line);
    if (!match || match[2]!.trim() !== match[2]) {
      throw new MuhaError({ code: "ADAPTER_PROTOCOL_ERROR", harness: "agy", message: "AGY returned an unrecognized Model catalog" });
    }
    models.push({ id: match[1], name: match[2] });
  }
  return snapshotHarnessModels("agy", models);
}
