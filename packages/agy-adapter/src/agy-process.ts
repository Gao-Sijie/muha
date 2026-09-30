import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessErrorData, OfficialAdapterOptions } from "@muha-sdk/core";
import type { AdapterCreateSessionOptions, AdapterResumeSessionOptions, AdapterSession, AdapterTurn,
  AdapterTurnEvent, AdapterTurnInput, LiveHarnessAdapter, LiveHarnessAdapterContext } from "@muha-sdk/core/internal";
import { OwnedCli } from "./owned-cli.js";
import { nativeBinding } from "./native-metadata.js";
import { bounded, Deferred, EventQueue, failure, object, type JsonObject } from "./protocol.js";

export class AgyProcess implements LiveHarnessAdapter {
  readonly kind = "agy" as const;
  readonly route = "native" as const;
  readonly #sessions = new Set<AgySession>();
  readonly #env: NodeJS.ProcessEnv;
  #initialized = false;
  #closing: Promise<void> | undefined;
  get closing(): boolean { return this.#closing !== undefined; }
  get initialized(): boolean { return this.#initialized; }
  constructor(readonly options: OfficialAdapterOptions, readonly context: LiveHarnessAdapterContext) {
    this.#env = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete this.#env[key];
      else this.#env[key] = value;
    }
  }
  async initialize(): Promise<void> {
    const workspacePath = await mkdtemp(join(tmpdir(), "muha-agy-ready-"));
    try {
      const session = await this.createSession({ workspacePath, approvalPolicy: "harnessManaged" });
      await session.close();
      this.#initialized = true;
      process.emitWarning("AGY cannot disable its native print timeout; AGY Turns use a 60 minute native limit.",
        { code: "MUHA_AGY_NATIVE_TURN_TIMEOUT" });
    } finally { await rm(workspacePath, { recursive: true, force: true }); }
  }
  async createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession> {
    const session = new AgySession(this, options, this.#env);
    this.#sessions.add(session);
    try { await session.open(); return session; }
    catch (error) { await session.close(); throw error; }
  }
  async resumeSession(options: AdapterResumeSessionOptions): Promise<AdapterSession> {
    const projectId = await nativeBinding(this.#env, options.nativeSessionId, options.workspacePath);
    const session = new AgySession(this, options, this.#env, { id: options.nativeSessionId, projectId });
    this.#sessions.add(session);
    try { await session.open(); return session; }
    catch (error) { await session.close(); throw error; }
  }
  async listSessions(): Promise<never> { throw failure("listSessions", "AGY listing is unsupported"); }
  lost(session: AgySession, error: HarnessErrorData): void {
    session.fail(error);
    if (this.#initialized && !this.#closing) this.context.reportFatalError(error, [session]);
  }
  release(session: AgySession): void { this.#sessions.delete(session); }
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      const results = await Promise.allSettled([...this.#sessions].map(session => session.close()));
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw {
        ...failed.reason, code: "HARNESS_ERROR", harness: "agy", operation: "closeHarness", retryable: false,
      };
    })();
  }
}

class AgySession implements AdapterSession {
  nativeSessionId = "";
  readonly model: string | undefined;
  readonly effort: string | undefined;
  closed = false;
  #cli: OwnedCli | undefined;
  #turn: TextTurn | undefined;
  #closePromise: Promise<void> | undefined;
  #restart = false;
  readonly #stepOwners = new Map<number, number>();
  #turnSequence = 0;
  #resultCount: number | undefined;
  #resume: { id: string; projectId: string } | undefined;
  constructor(readonly owner: AgyProcess, readonly options: AdapterCreateSessionOptions, readonly env: NodeJS.ProcessEnv,
    resume?: { id: string; projectId: string }) {
    this.model = options.model;
    this.effort = options.effort;
    this.#resume = resume;
  }
  async open(): Promise<void> {
    const operation = !this.owner.initialized ? "initialize" : this.#resume ? "resumeSession" : "createSession";
    if (this.closed || this.owner.closing) throw failure(operation, "AGY Session is closing");
    this.#stepOwners.clear();
    this.#resultCount = undefined;
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "60m"];
    if (this.#resume) args.push("--conversation", this.#resume.id, "--project", this.#resume.projectId);
    else args.push("--new-project", "--add-dir", this.options.workspacePath);
    if (this.model !== undefined) args.push("--model", this.model);
    if (this.effort !== undefined) args.push("--effort", this.effort);
    if (this.options.approvalPolicy === "autoApprove") args.push("--dangerously-skip-permissions");
    this.#cli = new OwnedCli(args, this.options.workspacePath, this.env,
      this.owner.options.shutdownTimeoutMs ?? 60_000, this.owner.context,
      (event, printTimedOut) => this.#receive(event, printTimedOut), error => this.owner.lost(this, error),
      operation);
    const ready = await bounded(this.#cli.ready.promise, this.owner.options.startupTimeoutMs ?? 60_000,
      failure(operation, "AGY native readiness timed out"));
    const init = object(ready.init);
    if (typeof ready.conversation_id !== "string" || !ready.conversation_id || init.cwd !== this.options.workspacePath) {
      throw failure(operation, "AGY initialized a different Workspace or invalid Session identity");
    }
    if (this.options.approvalPolicy === "autoApprove" && init.permission_mode !== "always-proceed") {
      throw failure(operation, "AGY did not apply autonomous permissions");
    }
    this.nativeSessionId = ready.conversation_id;
    if (this.#resume && this.nativeSessionId !== this.#resume.id) {
      throw failure("resumeSession", "AGY resumed a different Session identity");
    }
    const projectId = await nativeBinding(this.env, this.nativeSessionId, this.options.workspacePath, operation);
    if (this.#resume && projectId !== this.#resume.projectId) {
      throw failure("resumeSession", "AGY resumed a different Session or changed Project binding");
    }
    if (this.closed || this.owner.closing) throw failure(operation, "AGY Session closed during initialization");
  }
  #receive(event: JsonObject, printTimedOut: boolean): void {
    const turn = this.#turn;
    if (!turn) return;
    // A timeout can happen before the new input is accepted, leaving the
    // cumulative native count unchanged. Its explicit signal takes priority.
    if (event.event === "result" && printTimedOut) {
      turn.event(event, true);
      return;
    }
    if (event.event === "step_update") {
      const step = object(event.step_update);
      const index = step.step_index;
      if (step.conversation_id === this.nativeSessionId && typeof index === "number" && Number.isSafeInteger(index)) {
        // Step IDs are Session-scoped. Preserve known ownership without
        // assuming that new indexes must arrive in increasing order.
        const owner = this.#stepOwners.get(index);
        if (owner !== undefined && owner !== this.#turnSequence) return;
        this.#stepOwners.set(index, this.#turnSequence);
      }
    } else if (event.event === "result") {
      const result = object(event.result);
      const count = result.num_turns;
      if (result.conversation_id === this.nativeSessionId && typeof count === "number" && Number.isSafeInteger(count)) {
        // Native num_turns is cumulative across the Session. A previous
        // terminal must never settle input submitted after that terminal.
        if (this.#resultCount !== undefined && count <= this.#resultCount) return;
        this.#resultCount = count;
      }
    }
    turn.event(event, printTimedOut);
  }
  async startTurn(input: readonly AdapterTurnInput[]): Promise<AdapterTurn> {
    if (this.#restart) {
      this.#restart = false;
      try {
        this.#resume = { id: this.nativeSessionId,
          projectId: await nativeBinding(this.env, this.nativeSessionId, this.options.workspacePath) };
        await this.open();
      } catch (error) {
        this.owner.lost(this, failure("startTurn", "AGY could not reopen the interrupted Session"));
        throw error;
      }
    }
    const turn = new TextTurn(this.nativeSessionId, async () => {
      await this.#cli!.close(true);
      this.#restart = !this.closed && !this.owner.closing;
    });
    this.#turnSequence++;
    this.#turn = turn;
    this.#cli!.write({ event: "user", message: { content: input.map(part => {
      if (part.type !== "text") throw failure("startTurn", "AGY only supports text input");
      return { type: "text", text: part.text };
    }) } });
    await turn.accepted.promise;
    return turn;
  }
  async setModel(): Promise<never> { throw failure("setModel", "AGY idle selection is unsupported"); }
  async setEffort(): Promise<never> { throw failure("setEffort", "AGY idle selection is unsupported"); }
  fail(error: HarnessErrorData): void { this.#turn?.fail(error); }
  close(): Promise<void> {
    return this.#closePromise ??= (async () => {
      this.closed = true;
      this.#turn?.fail(failure("closeSession", "AGY Session is closing"));
      await this.#cli?.close();
      // Keep a failed close reachable until the Harness aggregates it.
      this.owner.release(this);
    })();
  }
}

class TextTurn implements AdapterTurn {
  nativeTurnId = "pending";
  readonly accepted = new Deferred<void>();
  readonly #queue = new EventQueue<AdapterTurnEvent>();
  readonly #messages = new Map<number, string>();
  readonly #completedMessages = new Map<number, string | undefined>();
  readonly #usage = new Map<number, Record<string, number>>();
  readonly #tools = new Map<number, { id: string; name: string; state: unknown; info: JsonObject; error?: unknown }>();
  #accepted = false;
  #ended = false;
  #interrupting: Promise<void> | undefined;
  constructor(readonly sessionId: string, readonly stop: () => Promise<void>) {}
  event(event: JsonObject, printTimedOut = false): void {
    if (this.#ended || this.#interrupting) return;
    if (event.event === "result" && printTimedOut) {
      this.#interrupting = this.stop().then(() => this.fail({
        ...failure("startTurn", "AGY reached its native 60 minute print timeout and returned partial output"), nativeCode: "timeout",
      })).catch(() => this.fail(failure("startTurn", "AGY timed out and owned execution could not be stopped")));
      return;
    }
    try { this.#receive(event); }
    catch { this.#protocol("Invalid AGY semantic event"); }
  }
  #receive(event: JsonObject): void {
    if (event.event === "step_update") {
      const step = object(event.step_update);
      if (step.conversation_id !== this.sessionId || !Number.isSafeInteger(step.step_index)) {
        this.#protocol("AGY step identity is invalid"); return;
      }
      const index = step.step_index as number;
      if (step.step_type === "user_input" && step.state === "DONE" && !this.#accepted) {
        this.nativeTurnId = `${this.sessionId}:${index}`;
        this.#accepted = true;
        this.accepted.resolve();
        this.#queue.push({ type: "turn.started" });
      }
      if (step.usage !== undefined) {
        const native = object(step.usage);
        const snapshot: Record<string, number> = {};
        for (const [from, to] of Object.entries({ input_tokens: "inputTokens", output_tokens: "outputTokens",
          cache_read_tokens: "cachedInputTokens", thinking_tokens: "reasoningTokens" })) {
          const value = native[from];
          if (value === undefined) continue;
          if (!Number.isSafeInteger(value) || (value as number) < 0) {
            this.#protocol("AGY reported invalid token usage");
            return;
          }
          snapshot[to] = value as number;
        }
        this.#usage.set(index, snapshot);
        const total: Record<string, number> = {};
        for (const usage of this.#usage.values()) for (const [key, count] of Object.entries(usage)) {
          const sum = (total[key] ?? 0) + count;
          if (!Number.isSafeInteger(sum)) {
            this.#protocol("AGY token usage exceeds the safe integer range");
            return;
          }
          total[key] = sum;
        }
        if (Object.keys(total).length) this.#queue.push({ type: "usage.updated", usage: total });
      }
      if (step.step_type === "tool") {
        const info = step.tool_info === undefined ? {} : object(step.tool_info);
        const name = step.tool_name;
        if (typeof name !== "string" || !name || (info.name !== undefined && info.name !== name)) {
          this.#protocol("AGY tool identity is invalid"); return;
        }
        const existing = this.#tools.get(index);
        if (existing && existing.name !== name) { this.#protocol("AGY changed a Tool identity"); return; }
        const nativeToolCallId = `${this.sessionId}:${index}`;
        if (!existing) this.#queue.push({ type: "tool.started", nativeToolCallId, toolName: name, input: info.parameters ?? null });
        const merged = { ...existing?.info, ...info };
        this.#tools.set(index, { id: nativeToolCallId, name, state: step.state, info: merged,
          ...(step.error === undefined ? {} : { error: step.error }) });
        this.#queue.push({ type: "tool.updated", nativeToolCallId, update: { state: step.state, ...merged } });
      }
      if (step.step_type === "agent_response") {
        if (this.#completedMessages.has(index)) {
          if (step.state !== "DONE" || (step.text_delta !== undefined &&
            step.text_delta !== this.#completedMessages.get(index))) {
            this.#protocol("AGY changed a completed Assistant Message");
          }
          return;
        }
        const nativeMessageId = `${this.sessionId}:${index}`;
        if (!this.#messages.has(index)) {
          this.#messages.set(index, "");
          this.#queue.push({ type: "assistant.message.started", nativeMessageId });
        }
        if (typeof step.text_delta === "string" && step.text_delta.length) {
          this.#messages.set(index, this.#messages.get(index)! + step.text_delta);
          this.#queue.push({ type: "assistant.message.delta", nativeMessageId, delta: step.text_delta });
        }
        if (step.state === "DONE") {
          this.#completedMessages.set(index, typeof step.text_delta === "string" ? step.text_delta : undefined);
          this.#queue.push({ type: "assistant.message.completed", nativeMessageId, text: this.#messages.get(index)! });
        }
      }
    } else if (event.event === "result") {
      const result = object(event.result);
      if (result.conversation_id !== this.sessionId) { this.#protocol("AGY result belongs to a different Session"); return; }
      if (!Number.isSafeInteger(result.num_turns) || (result.num_turns as number) < 1) {
        this.#protocol("AGY result has no valid cumulative Turn identity"); return;
      }
      if (result.status === "SUCCESS" && (this.#messages.size === 0 || this.#messages.size !== this.#completedMessages.size)) {
        this.#protocol("AGY succeeded without a complete final Assistant Message"); return;
      }
      const denials = result.denied_actions ?? [];
      if (!Array.isArray(denials)) { this.#protocol("AGY denied_actions is invalid"); return; }
      const deniedByTool = new Map<string, JsonObject[]>();
      for (const value of denials) {
        const denial = object(value);
        // The qualified protocol supplies only an action category, not a
        // call ID. Do not guess among multiple calls of the same category.
        const candidates = [...this.#tools.values()].filter(tool => denial.action === "command" && tool.name === "run_command");
        if (candidates.length !== 1) { this.#protocol("AGY denial cannot be uniquely attributed to a Tool"); return; }
        const toolId = candidates[0]!.id;
        deniedByTool.set(toolId, [...(deniedByTool.get(toolId) ?? []), denial]);
      }
      for (const tool of this.#tools.values()) {
        if (tool.state !== "DONE" && tool.state !== "ERROR") {
          if (result.status === "SUCCESS") { this.#protocol("AGY succeeded with an unfinished Tool"); return; }
          continue;
        }
        const denied = deniedByTool.get(tool.id);
        const error = tool.error ?? tool.info.error;
        this.#queue.push({ type: "tool.completed", nativeToolCallId: tool.id,
          output: denied ? { denied_actions: denied } : error ?? tool.info.output ?? null,
          isError: denied !== undefined || tool.state === "ERROR" || error !== undefined });
      }
      if (result.status === "ERROR") this.fail({
        ...failure("startTurn", typeof result.error === "string" ? result.error : "AGY native Turn failed"), nativeCode: "ERROR",
      });
      else if (result.status !== "SUCCESS") this.#protocol("AGY reported an unknown native Turn status");
      else if (!this.#accepted) this.fail(failure("startTurn", "AGY ended before accepting input"));
      else { this.#ended = true; this.#queue.push({ type: "turn.completed" }); this.#queue.end(); }
    }
  }
  #protocol(message: string): void {
    if (this.#ended || this.#interrupting) return;
    this.#interrupting = this.stop().then(() => {
      this.#ended = true;
      this.accepted.reject({ code: "ADAPTER_PROTOCOL_ERROR", harness: "agy", message });
      this.#queue.push({ type: "adapter.protocolError", message });
      this.#queue.end();
    }).catch(() => this.fail(failure("startTurn", "AGY protocol failure could not stop owned execution")));
  }
  fail(error: HarnessErrorData): void {
    if (this.#ended) return;
    this.#ended = true;
    this.accepted.reject(error);
    this.#queue.push({ type: "turn.failed", error });
    this.#queue.end();
  }
  [Symbol.asyncIterator](): AsyncIterator<AdapterTurnEvent> { return this.#queue[Symbol.asyncIterator](); }
  interrupt(): Promise<void> {
    if (this.#ended) return Promise.resolve();
    return this.#interrupting ??= this.stop().then(() => {
      this.#ended = true;
      this.#queue.push({ type: "turn.interrupted" });
      this.#queue.end();
    });
  }
  async respondToApproval(): Promise<never> { throw failure("respondToApproval", "AGY structured approvals are unsupported"); }
  async respondToQuestion(): Promise<never> { throw failure("respondToQuestion", "AGY structured questions are unsupported"); }
}
