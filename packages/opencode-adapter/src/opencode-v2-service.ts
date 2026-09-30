import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { OpenCode, type OpenCodeClient } from "@opencode/client";
import type { HarnessErrorData, OfficialAdapterOptions } from "@muha-sdk/core";
import type { LiveHarnessAdapterContext } from "@muha-sdk/core/internal";
import { orderedInputPluginID } from "./opencode-v2-order-plugin.js";

const defaultTimeoutMs = 60_000;

export class OpenCodeV2Service {
  #child: ChildProcessWithoutNullStreams | undefined;
  #processGroupId: number | undefined;
  #baseUrl: string | undefined;
  #client: OpenCodeClient | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #configRoot: string | undefined;
  #pluginPath: string | undefined;

  constructor(
    readonly options: OfficialAdapterOptions,
    readonly context: LiveHarnessAdapterContext,
    readonly password: string,
  ) {}

  get baseUrl(): string {
    if (!this.#baseUrl) throw serviceFailure("initialize", "ready");
    return this.#baseUrl;
  }

  get client(): OpenCodeClient {
    if (!this.#client) throw serviceFailure("initialize", "ready");
    return this.#client;
  }

  async initialize(): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(this.options.env ?? {})) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    delete env.OPENCODE_SERVER_USERNAME;
    delete env.OPENCODE_SERVER_PASSWORD;
    env.OPENCODE_PASSWORD = this.password;
    if (env.OPENCODE_CONFIG_DIR !== undefined) {
      throw {
        ...serviceFailure("initialize", "handshake"),
        message: "OpenCode v2 ordered input cannot safely compose an existing OPENCODE_CONFIG_DIR",
      } satisfies HarnessErrorData;
    }

    try {
      this.#configRoot = await mkdtemp(join(tmpdir(), "muha-opencode-v2-config-"));
      const plugins = join(this.#configRoot, "plugins");
      await mkdir(plugins);
      this.#pluginPath = join(plugins, "muha-order.js");
      await copyFile(new URL("./opencode-v2-order-plugin.js", import.meta.url), this.#pluginPath);
      env.OPENCODE_CONFIG_DIR = this.#configRoot;
    } catch {
      await this.close();
      throw serviceFailure("initialize", "handshake");
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("opencode", ["serve", "--stdio", "--port", "0"], {
        detached: true,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      await this.close();
      throw serviceFailure("initialize", "spawn");
    }
    this.#child = child;
    if (child.pid !== undefined && Number.isSafeInteger(child.pid) && child.pid > 1) {
      this.#processGroupId = child.pid;
    }
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    let observedReady = false;
    const ready = new Promise<string>((resolve, reject) => {
      lines.once("line", (line) => {
        try {
          const value: unknown = JSON.parse(line);
          if (!isRecord(value) || typeof value.url !== "string") throw new Error();
          const url = new URL(value.url);
          if (
            url.protocol !== "http:" ||
            !["127.0.0.1", "[::1]"].includes(url.hostname) ||
            !Number.isSafeInteger(Number(url.port)) ||
            Number(url.port) < 1 ||
            url.username !== "" ||
            url.password !== "" ||
            url.pathname !== "/" ||
            url.search !== "" ||
            url.hash !== ""
          ) throw new Error();
          observedReady = true;
          resolve(url.origin);
        } catch {
          reject(serviceFailure("initialize", "ready"));
        }
      });
      child.once("error", () => reject(serviceFailure("initialize", "spawn")));
      child.once("exit", (exitCode, signal) => {
        if (observedReady && !this.#closing) {
          this.context.reportFatalError({
            code: "HARNESS_ERROR",
            message: "OpenCode v2 service exited",
            harness: "opencode",
            operation: "closeHarness",
            command: "opencode",
            stage: "ready",
            exitCode,
            signal,
          });
        } else {
          reject(serviceFailure("initialize", "ready"));
        }
      });
    });

    try {
      const baseUrl = await withTimeout(
        ready,
        this.options.startupTimeoutMs ?? defaultTimeoutMs,
        () => serviceFailure("initialize", "ready"),
      );
      const unauthenticated = await withTimeout(
        fetch(baseUrl + "/api/info", { signal: AbortSignal.timeout(this.options.startupTimeoutMs ?? defaultTimeoutMs) }),
        this.options.startupTimeoutMs ?? defaultTimeoutMs,
        () => serviceFailure("initialize", "handshake"),
      );
      if (unauthenticated.status !== 401) throw serviceFailure("initialize", "handshake");
      await unauthenticated.body?.cancel();

      const authorization = "Basic " + Buffer.from("opencode:" + this.password).toString("base64");
      const client = OpenCode.make({ baseUrl, headers: { authorization } });
      let info: unknown;
      try {
        info = await withTimeout(
          client.server.info({ signal: AbortSignal.timeout(this.options.startupTimeoutMs ?? defaultTimeoutMs) }),
          this.options.startupTimeoutMs ?? defaultTimeoutMs,
          () => serviceFailure("initialize", "handshake"),
        );
      } catch {
        throw serviceFailure("initialize", "handshake");
      }
      if (
        !isRecord(info) ||
        typeof info.version !== "string" ||
        !/^2\.\d+\.\d+(?:[-+].+)?$/.test(info.version) ||
        info.pid !== child.pid ||
        !Array.isArray(info.urls) ||
        !info.urls.includes(baseUrl)
      ) throw serviceFailure("initialize", "handshake");
      await this.context.recordNativeEvent("opencode", info);
      this.#baseUrl = baseUrl;
      this.#client = client;
    } catch (error) {
      await this.close();
      if (isHarnessFailure(error)) throw error;
      throw serviceFailure("initialize", "handshake");
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    try {
      if (!child) return;
      child.stdin.end();
      const timeout = this.options.shutdownTimeoutMs ?? defaultTimeoutMs;
      if (await exitsWithin(child, timeout)) {
        this.#signalGroup("SIGKILL");
        return;
      }
      this.#signalGroup("SIGTERM");
      if (await exitsWithin(child, Math.min(timeout, 5_000))) {
        this.#signalGroup("SIGKILL");
        return;
      }
      this.#signalGroup("SIGKILL");
      if (!(await exitsWithin(child, 5_000))) throw serviceFailure("closeHarness", "shutdown");
    } finally {
      if (this.#configRoot !== undefined) {
        await rm(this.#configRoot, { recursive: true, force: true });
        this.#configRoot = undefined;
        this.#pluginPath = undefined;
      }
    }
  }

  async ensureOrderedPlugin(workspacePath: string): Promise<void> {
    const expected = this.#pluginPath;
    if (!expected || !this.#client) throw serviceFailure("initialize", "handshake");
    const deadline = Date.now() + Math.min(this.options.startupTimeoutMs ?? defaultTimeoutMs, 10_000);
    for (;;) {
      let response: unknown;
      try { response = await this.#client.plugin.list({ location: { directory: workspacePath } }); }
      catch { throw serviceFailure("initialize", "handshake"); }
      await this.context.recordNativeEvent("opencode", response);
      if (!isRecord(response) || !Array.isArray(response.data)) throw serviceFailure("initialize", "handshake");
      const plugin = response.data.find((value) => isRecord(value) && value.id === orderedInputPluginID);
      if (isRecord(plugin)) {
        const source = plugin.source;
        const state = plugin.state;
        if (!isRecord(source) || source.type !== "local" || source.path !== expected ||
            !isRecord(state)) throw serviceFailure("initialize", "handshake");
        if (state.status === "active") return;
        if (state.status === "failed") throw serviceFailure("initialize", "handshake");
      }
      if (Date.now() >= deadline) throw serviceFailure("initialize", "handshake");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  #signalGroup(signal: NodeJS.Signals): void {
    if (this.#processGroupId === undefined) return;
    try {
      process.kill(-this.#processGroupId, signal);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ESRCH") throw serviceFailure("closeHarness", "shutdown");
    }
  }
}

function serviceFailure(
  operation: HarnessErrorData["operation"],
  stage: NonNullable<HarnessErrorData["stage"]>,
): HarnessErrorData {
  return {
    code: "HARNESS_ERROR",
    message: "OpenCode v2 " + stage + " failed",
    harness: "opencode",
    operation,
    command: "opencode",
    stage,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHarnessFailure(value: unknown): value is HarnessErrorData {
  return isRecord(value) && value.code === "HARNESS_ERROR";
}

function withTimeout<T>(work: Promise<T>, milliseconds: number, fail: () => HarnessErrorData): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(fail()), milliseconds); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function exitsWithin(child: ChildProcessWithoutNullStreams, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
