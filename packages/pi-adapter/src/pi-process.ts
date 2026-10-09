import type { ChildProcess } from "node:child_process";
import { PiOwnedWorker } from "./pi-owned-worker.js";
import { randomUUID } from "node:crypto";
import { PiEvents } from "./pi-events.js";
import { piInput } from "./pi-input.js";
import { MuhaError, type HarnessErrorData, type OfficialAdapterOptions } from "@muha-sdk/core";
import type { AdapterCreateSessionOptions, AdapterResumeSessionOptions, AdapterSession,
  AdapterTurn, AdapterTurnEvent, AdapterTurnInput, AdapterListedSession, LiveHarnessAdapter, LiveHarnessAdapterContext } from "@muha-sdk/core/internal";

function failure(operation: HarnessErrorData["operation"], message: string): MuhaError {
  return new MuhaError({ code: "HARNESS_ERROR", harness: "pi", operation, message });
}

export class PiProcess implements LiveHarnessAdapter {
  readonly kind = "pi";
  readonly route = "native" as const;
  readonly #workers = new Set<PiWorker>();
  #closed = false;
  constructor(readonly options: OfficialAdapterOptions, readonly context: LiveHarnessAdapterContext) {}
  async #worker(): Promise<PiWorker> {
    if (this.#closed) throw failure("initialize", "Pi Adapter is closed");
    const worker = new PiWorker(this.options, this.context);
    this.#workers.add(worker);
    try { await worker.request("ready", {}); return worker; }
    catch (error) { await worker.close(); this.#workers.delete(worker); throw error; }
  }
  async initialize(): Promise<void> {
    const worker = await this.#worker();
    await worker.close(); this.#workers.delete(worker);
  }
  async createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession> {
    return this.#session("create", options);
  }
  async resumeSession(options: AdapterResumeSessionOptions): Promise<AdapterSession> {
    return this.#session("resume", options);
  }
  async #session(command: "create" | "resume", options: AdapterCreateSessionOptions | AdapterResumeSessionOptions): Promise<AdapterSession> {
    const worker = await this.#worker();
    try {
      const result = await worker.request(command, { ...options, shutdownTimeoutMs: this.options.shutdownTimeoutMs }) as { id: string; model?: string; effort?: string };
      const session = new PiSession(worker, result, () => this.#workers.delete(worker));
      worker.session = session;
      return session;
    } catch (error) { await worker.close(); this.#workers.delete(worker); throw error; }
  }
  async listSessions(workspacePath: string): Promise<readonly AdapterListedSession[]> {
    const worker = await this.#worker();
    try { return await worker.request("list", { workspacePath }) as AdapterListedSession[]; }
    finally { await worker.close(); this.#workers.delete(worker); }
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#workers].map(worker => worker.close()));
    this.#workers.clear();
  }
}

class PiWorker {
  readonly #child: ChildProcess;
  readonly #pending = new Map<string, { operation: HarnessErrorData["operation"]; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout | undefined }>();
  readonly #exited: Promise<void>;
  readonly #owner: PiOwnedWorker;
  #closing: Promise<void> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #lostReported = false;
  #protocolMessage: string | undefined;
  session: PiSession | undefined;
  turn: PiTurn | undefined;
  constructor(readonly options: OfficialAdapterOptions, readonly context: LiveHarnessAdapterContext) {
    const env = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete env[key]; else env[key] = value;
    }
    this.#owner = new PiOwnedWorker(env, this.options.shutdownTimeoutMs ?? 5000,
      message => this.#lost(message));
    this.#child = this.#owner.child;
    this.#exited = this.#owner.exited.then(() => {
      if (!this.#closing) this.#lost("Pi SDK process exited unexpectedly");
    });
    void this.#exited.catch(() => {});
    this.#child.on("error", error => this.#lost(error.message));
    this.#child.on("disconnect", () => { if (!this.#closing) this.#lost("Pi SDK control channel was lost"); });
    this.#child.on("message", message => {
      this.#queue = this.#queue.then(() => this.#receive(message)).catch(error => this.#failProtocol(error));
    });
  }
  #failProtocol(cause: unknown): void {
    const data = cause instanceof MuhaError ? cause.data : cause;
    if (data && typeof data === "object" && "code" in data && data.code === "EVENT_STORE_ERROR") return;
    if (this.#protocolMessage !== undefined || this.#lostReported) return;
    this.#protocolMessage = cause instanceof Error ? cause.message : "Invalid Pi SDK control output";
    if (this.session) this.session.closed = true;
    // Quarantine this Session through deliberate, bounded shutdown before
    // publishing its protocol failure. Do not label valid process exit during
    // that shutdown as unexpected loss, or retry malformed protocol behavior.
    void this.close().catch(error => this.#lost(String(error)));
  }
  #lost(message: string): void {
    if (this.#lostReported) return;
    this.#lostReported = true;
    const error = this.#protocolMessage === undefined ? failure("startTurn", message)
      : new MuhaError({ code: "ADAPTER_PROTOCOL_ERROR", harness: "pi", message: this.#protocolMessage });
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer); pending.reject(this.#protocolMessage === undefined ? failure(pending.operation, message) : error);
    }
    this.#pending.clear();
    if (this.#protocolMessage !== undefined) {
      this.turn?.finish({ type: "adapter.protocolError", message: this.#protocolMessage });
      return;
    }
    this.turn?.finish({ type: "turn.failed", error: error.data as HarnessErrorData });
    if (!this.#closing) this.context.reportFatalError(error.data as HarnessErrorData,
      this.session ? [this.session] : []);
  }
  async #receive(raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== "object") throw new Error("Malformed Pi SDK control message");
    const message = raw as Record<string, unknown>;
    // Quarantine stops public normalization, not native evidence retention.
    // SDK abort/shutdown callbacks can still arrive during bounded close.
    if (message.type === "native") {
      await this.context.recordNativeEvent("pi", { source: "AgentSession.subscribe", payload: message.event });
      if (this.#protocolMessage === undefined) this.turn?.nativeEvents.receive(message.event);
      return;
    }
    if (message.type === "diagnostic") {
      if (typeof message.source !== "string" || !["SessionManager.list", "createAgentSession.modelFallbackMessage",
        "createAgentSession.extensionsResult.errors", "AgentSession.bindExtensions.onError"].includes(message.source)) {
        throw new Error("Unknown Pi SDK diagnostic source");
      }
      await this.context.recordNativeEvent("pi", { source: message.source, payload: message.payload });
      return;
    }
    if (this.#protocolMessage !== undefined) return;
    if (message.type === "reply") {
      const pending = this.#pending.get(String(message.id));
      if (!pending) throw new Error("Unknown Pi command correlation");
      clearTimeout(pending.timer); this.#pending.delete(String(message.id));
      if (message.error) {
        if (message.protocolError === true) pending.reject(new MuhaError({ code: "ADAPTER_PROTOCOL_ERROR", harness: "pi", message: String(message.error) }));
        else pending.reject(new MuhaError({ code: "HARNESS_ERROR", harness: "pi", operation: pending.operation,
          message: String(message.error), ...(typeof message.nativeCode === "string" ? { nativeCode: message.nativeCode } : {}) }));
      }
      else pending.resolve(message.value);
      return;
    }
    const turn = this.turn;
    if (message.type === "settled" && turn && turn.nativeTurnId === message.turnId) {
      if (message.error) turn.finish({ type: "turn.failed", error: failure("startTurn", String(message.error)).data as HarnessErrorData });
      else if (message.interrupted) turn.finish({ type: "turn.interrupted" });
      else if (typeof message.text === "string") {
        turn.finish({ type: "turn.completed" });
      } else turn.finish({ type: "adapter.protocolError", message: "Pi completed without a final Assistant Message" });
      this.turn = undefined;
      return;
    }
    throw new Error("Unknown Pi SDK message");
  }
  request(command: string, args: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.#closing || this.#lostReported || !this.#child.connected) { reject(failure("initialize", "Pi SDK process is unavailable")); return; }
      const id = randomUUID();
      const operation: HarnessErrorData["operation"] = command === "create" ? "createSession"
        : command === "resume" ? "resumeSession" : command === "list" ? "listSessions"
        : command === "prompt" ? "startTurn" : command === "setModel" ? "setModel"
        : command === "setEffort" ? "setEffort" : command === "abort" ? "interruptTurn" : "initialize";
      // Only SDK startup uses the Registration startup bound. Once ready,
      // command acknowledgements remain under Core's existing watchdog.
      const timer = command === "ready" ? setTimeout(() => {
        this.#pending.delete(id); reject(failure(operation, `Pi SDK ${command} timed out`));
      }, this.options.startupTimeoutMs ?? 10000) : undefined;
      this.#pending.set(id, { operation, resolve, reject, timer });
      this.#child.send({ id, command, args }, error => { if (error) this.#lost(error.message); });
    });
  }
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      try {
        if (this.#child.connected) this.#child.send({ command: "close" });
        await this.#owner.close();
        await this.#queue;
        this.#lost("Pi SDK process closed");
      } catch (error) {
        this.#lost(error instanceof Error ? error.message : String(error));
        throw error;
      }
    })();
  }
}

class PiSession implements AdapterSession {
  readonly nativeSessionId: string;
  model: string | undefined;
  effort: string | undefined;
  closed = false;
  constructor(readonly worker: PiWorker, result: { id: string; model?: string; effort?: string }, readonly release: () => void) {
    this.nativeSessionId = result.id; this.model = result.model; this.effort = result.effort;
  }
  async startTurn(input: readonly AdapterTurnInput[]): Promise<AdapterTurn> {
    const nativeInput = await piInput(input);
    const turn = new PiTurn(this.worker);
    this.worker.turn = turn;
    turn.push({ type: "turn.started" });
    try { await this.worker.request("prompt", { input: nativeInput, turnId: turn.nativeTurnId }); }
    catch (error) { this.worker.turn = undefined; throw error; }
    return turn;
  }
  async setModel(model: string): Promise<void> {
    const result = await this.worker.request("setModel", { model }) as { model: string };
    this.model = result.model; this.effort = undefined;
  }
  async setEffort(effort: string): Promise<void> {
    const result = await this.worker.request("setEffort", { effort }) as { effort: string };
    this.effort = result.effort;
  }
  async close(): Promise<void> {
    this.closed = true;
    try { await this.worker.close(); } finally { this.release(); }
  }
}

class PiTurn implements AdapterTurn {
  readonly nativeTurnId = randomUUID();
  readonly nativeEvents = new PiEvents(event => this.push(event));
  #events: AdapterTurnEvent[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  constructor(readonly worker: PiWorker) {}
  push(event: AdapterTurnEvent): void { if (!this.#ended) { this.#events.push(event); this.#wake?.(); } }
  finish(event: AdapterTurnEvent): void { if (!this.#ended) { this.push(event); this.#ended = true; } }
  async *[Symbol.asyncIterator](): AsyncIterator<AdapterTurnEvent> {
    while (true) {
      const event = this.#events.shift();
      if (event) yield event;
      else if (this.#ended) return;
      else await new Promise<void>(resolve => { this.#wake = resolve; });
    }
  }
  async interrupt(): Promise<void> { await this.worker.request("abort", {}); }
  async respondToApproval(): Promise<void> { throw failure("respondToApproval", "Pi has no native Approval Request"); }
  async respondToQuestion(): Promise<void> { throw failure("respondToQuestion", "Pi Questions are not supported"); }
}
