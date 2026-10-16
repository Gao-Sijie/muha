import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { delimiter, dirname, isAbsolute, join, toNamespacedPath } from "node:path";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

const owners = new WeakMap<ChildProcess, { close(timeout: number): Promise<void>; nativeExitCode(): number | undefined; nativePid(): number | undefined }>();
const supervisor = fileURLToPath(new URL("./acp-supervisor.exe", import.meta.url));

/** Environment overrides retain their native case-insensitive Windows meaning. */
export function harnessEnvironment(overrides: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    if (process.platform === "win32") {
      for (const key of Object.keys(result)) if (key.toLowerCase() === name.toLowerCase()) delete result[key];
    }
    const nativeName = process.platform === "win32" ? name.toUpperCase() : name;
    if (value === undefined) delete result[nativeName]; else result[nativeName] = value;
  }
  return result;
}

function environmentPath(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).sort().find(name => name.toLowerCase() === "path");
  return key === undefined ? "" : env[key] ?? "";
}

/** Resolve executable files and Node bin entries without invoking a command shell. */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv): { command: string; args: readonly string[] } {
  const directories = isAbsolute(command) || command.includes("/") || command.includes("\\") ? [""] : environmentPath(env).split(delimiter).filter(Boolean);
  const candidates = command.toLowerCase().endsWith(".exe") ? [command] : [command + ".exe", command, command + ".cmd"];
  for (const directory of directories) for (const name of candidates) {
    const path = directory ? join(directory, name) : name;
    try {
      if (!statSync(path).isFile()) continue;
      if (path.toLowerCase().endsWith(".exe")) return { command: path, args: [] };
      const bytes = readFileSync(path);
      if (bytes.length > 256 * 1024) continue;
      const source = bytes.toString("utf8");
      if (/^#![^\r\n]*\bnode(?:\s|\r?\n|$)/u.test(source)) return { command: process.execPath, args: [path] };
      // npm-generated shims: resolve only a literal package entry under the shim directory.
      const entry = /(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.(?:m?js|cjs|exe))"/iu.exec(source)?.[1];
      if (entry) {
        const target = join(dirname(path), entry);
        if (statSync(target).isFile()) return target.toLowerCase().endsWith(".exe")
          ? { command: target, args: [] } : { command: process.execPath, args: [target] };
      }
    } catch { /* inspect the next explicit PATH entry */ }
  }
  throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
}

export function spawnHarnessProcess(command: string, args: readonly string[], options: SpawnOptions,
  shutdownMs = 5000, autoStart = true, workerPipe?: string, ownerExecutable = supervisor): ChildProcess {
  if (process.platform !== "win32") return spawn(command, [...args], options);
  const env = options.env ?? process.env;
  const launch = resolveWindowsCommand(command, env);
  const base = Array.isArray(options.stdio) ? [...options.stdio].slice(0, 3)
    : [options.stdio ?? "pipe", options.stdio ?? "pipe", options.stdio ?? "pipe"];
  const child = spawn(ownerExecutable, [String(Math.min(1000, Math.floor(shutdownMs / 4))),
    ...(workerPipe ? ["--worker-pipe", workerPipe] : []), launch.command, ...launch.args, ...args],
  { ...options, env, detached: false, windowsHide: true, stdio: [...base, "pipe", ...(workerPipe ? ["overlapped" as const] : [])] });
  const control = child.stdio[3] as Duplex;
  let closing = false, proof = false, terminated = false, failure: Error | undefined, closed: Promise<void> | undefined, nativeExit: number | undefined, nativePid: number | undefined;
  const launchErrors = new WeakSet<Error>();
  const lines = createInterface({ input: control });
  const lose = (error: Error): void => { failure ??= error; child.emit("error", error); };
  // Owner errors are also observed by the Adapter; retain an internal listener after its once-listener fires.
  child.on("error", error => { if (!launchErrors.has(error)) failure ??= error; });
  control.on("error", () => lose(new Error("Windows ownership control channel failed")));
  lines.on("error", () => lose(new Error("Windows ownership control reader failed")));
  lines.on("line", line => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "ready") { if (autoStart && !closing) control.write("go\n"); }
      else if (event.type === "spawned") nativePid = typeof event.pid === "number" ? event.pid : undefined;
      else if (event.type === "closed") proof = event.noChildren === true && event.cleanupError === false;
      else if (event.type === "nativeExit") nativeExit = typeof event.code === "number" ? event.code : undefined;
      else if (event.type === "error") {
        const error = new Error(`Windows owner failed during ${String(event.operation)} (${String(event.win32)})`);
        if (["spawn", "commandLine", "duplicateStdio", "attributesAllocation", "attributesInitialization", "handleList"].includes(String(event.operation))) {
          launchErrors.add(error); child.emit("error", error);
        } else lose(error);
      }
      else if (!["spawned", "nativeExit", "closing"].includes(String(event.type))) lose(new Error("Invalid Windows ownership response"));
    } catch { lose(new Error("Invalid Windows ownership response")); }
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", error => { if (!launchErrors.has(error)) reject(error); });
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null && proof && !failure) resolve();
      else reject(failure ?? new Error("Windows owner exited without proving descendant cleanup"));
    });
    child.once("exit", (code, signal) => {
      terminated = true;
      if (code !== 0 || signal !== null) reject(new Error("Windows ownership helper was lost"));
    });
  });
  void exited.catch(() => {});
  owners.set(child, { nativeExitCode: () => nativeExit, nativePid: () => nativePid, close(timeout) {
    if (closed) return closed;
    closing = true;
    if (!terminated && !child.stdin?.destroyed) child.stdin?.end();
    if (!proof && !terminated && !control.destroyed) control.write("close\n");
    closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Windows descendant cleanup timed out")); }, Math.max(1, timeout));
      exited.then(resolve, reject).finally(() => { clearTimeout(timer); control.destroy(); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); });
    });
    return closed;
  } });
  return child;
}

export function closeHarnessProcess(child: ChildProcess, timeout = 5000): Promise<void> {
  const owner = owners.get(child);
  if (!owner) return Promise.reject(new Error("Process has no Windows ownership boundary"));
  return owner.close(timeout);
}

export function harnessProcessExitCode(child: ChildProcess): number | null | undefined {
  const owner = owners.get(child);
  return owner ? owner.nativeExitCode() : child.exitCode;
}

export function harnessProcessPid(child: ChildProcess): number | undefined {
  const owner = owners.get(child);
  return owner ? owner.nativePid() : child.pid;
}

function protect(args: readonly string[]): void {
  try { execFileSync(supervisor, [...args], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], timeout: 10000 }); }
  catch { throw new Error("Windows Diagnostic Event Store access control is unsafe or unavailable"); }
}

export async function preparePrivateDataDirectory(path: string): Promise<string> {
  if (process.platform !== "win32") { await mkdir(path, { recursive: true, mode: 0o700 }); return realpath(path); }
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(path), { recursive: true });
    canonical = path;
  }
  protect(["--ensure-private-dir", toNamespacedPath(canonical)]);
  return realpath(path);
}

export function checkPrivateDataFiles(paths: readonly string[]): void {
  protect(["--check-private-files", ...paths.map(toNamespacedPath)]);
}
