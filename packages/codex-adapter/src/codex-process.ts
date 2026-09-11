import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface, type Interface } from "node:readline";

import type { HarnessErrorData, OfficialAdapterOptions } from "@muha-sdk/core";
import type {
  AdapterCreateSessionOptions,
  AdapterListedSession,
  AdapterResumeSessionOptions,
  AdapterQuestionResponse,
  AdapterSession,
  AdapterTurnInput,
  AdapterTurn,
  AdapterTurnEvent,
  LiveHarnessAdapter,
  LiveHarnessAdapterContext,
} from "@muha-sdk/core/internal";

const defaultTimeoutMs = 60_000;
const adapterVersion = (createRequire(import.meta.url)("../package.json") as {
  version: string;
}).version;

type JsonObject = Record<string, unknown>;
type ServerRequestId = string | number;
type NotificationListener = (
  method: string,
  params: JsonObject,
  requestId: ServerRequestId | undefined,
) => void;

interface PendingRequest {
  readonly operation: HarnessErrorData["operation"];
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: HarnessErrorData) => void;
}

export class CodexProcess implements LiveHarnessAdapter {
  readonly kind = "codex" as const;
  readonly #options: OfficialAdapterOptions;
  readonly #context: LiveHarnessAdapterContext;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #threadHandles = new Map<string, number>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #processGroupId: number | undefined;
  #lines: Interface | undefined;
  #closePromise: Promise<void> | undefined;
  #nextRequestId = 1;
  #incoming: Promise<void> = Promise.resolve();
  #initialized = false;

  constructor(options: OfficialAdapterOptions, context: LiveHarnessAdapterContext) {
    this.#options = options;
    this.#context = context;
  }

  async initialize(): Promise<void> {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(this.#options.env ?? {})) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("codex", ["app-server", "--stdio", "-c", "thread_unload_delay_secs=0"], {
        detached: true,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw failure("initialize", "spawn", error);
    }
    this.#child = child;
    if (Number.isSafeInteger(child.pid) && child.pid !== undefined && child.pid > 1) {
      this.#processGroupId = child.pid;
    }
    child.stderr.resume();
    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on("line", (line) => {
      this.#incoming = this.#incoming.then(() => this.#handleLine(line));
      void this.#incoming.catch((error) => this.#rejectAll(normalizeFailure(error, "initialize", "handshake")));
    });
    child.once("error", (error) => this.#rejectAll(failure("initialize", "spawn", error)));
    child.once("exit", (exitCode, signal) => {
      const error = {
        code: "HARNESS_ERROR",
        message: "Codex control process exited",
        harness: "codex",
        operation: this.#initialized ? "closeHarness" : "initialize",
        command: "codex",
        stage: "ready",
        exitCode,
        signal,
      } as const;
      this.#rejectAll(error);
      if (this.#initialized && !this.#closePromise) this.#context.reportFatalError(error);
    });

    try {
      await withTimeout(
        this.#request(
          "initialize",
          {
            clientInfo: {
              name: "muha-sdk",
              title: "Muha SDK",
              version: adapterVersion,
            },
            capabilities: null,
          },
          "initialize",
        ),
        this.#options.startupTimeoutMs ?? defaultTimeoutMs,
        () => failure("initialize", "ready", new Error("startup timeout")),
      );
      this.#write({ method: "initialized" });
      this.#initialized = true;
    } catch (error) {
      await this.#forceReclaim();
      throw normalizeFailure(error, "initialize", "handshake");
    }
  }

  async createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession> {
    const result = asObject(
      await this.#request(
        "thread/start",
        {
          cwd: options.workspacePath,
          sandbox: options.approvalPolicy === "autoApprove" ? "danger-full-access" : "workspace-write",
          ...(options.model === undefined ? {} : { model: options.model }),
          approvalPolicy: mapApprovalPolicy(options.approvalPolicy),
        },
        "createSession",
      ),
      "thread/start result",
    );
    const thread = asObject(result.thread, "thread/start thread");
    const nativeSessionId = requireString(thread.id, "thread id");
    requireAppliedApprovalPolicy(result, options.approvalPolicy);
    const model = requireString(result.model, "resolved model");
    if (options.effort !== undefined) {
      await this.validateEffort(options.effort, model, "createSession");
    }
    return new CodexSession(this, nativeSessionId, model, options.effort);
  }

  async resumeSession(options: AdapterResumeSessionOptions): Promise<AdapterSession> {
    const result = asObject(
      await this.#request(
        "thread/resume",
        {
          threadId: options.nativeSessionId,
          cwd: options.workspacePath,
          sandbox: options.approvalPolicy === "autoApprove" ? "danger-full-access" : "workspace-write",
          ...(options.model === undefined ? {} : { model: options.model }),
          approvalPolicy: mapApprovalPolicy(options.approvalPolicy),
        },
        "resumeSession",
      ),
      "thread/resume result",
    );
    const thread = asObject(result.thread, "thread/resume thread");
    if (thread.id !== options.nativeSessionId || thread.cwd !== options.workspacePath) {
      throw protocolFailure("Codex resumed a different Session or Workspace");
    }
    requireAppliedApprovalPolicy(result, options.approvalPolicy);
    const model = requireString(result.model, "resolved model");
    if (options.effort !== undefined) {
      await this.validateEffort(options.effort, model, "resumeSession");
    }
    return new CodexSession(this, options.nativeSessionId, model, options.effort);
  }

  retainThread(threadId: string): void {
    this.#threadHandles.set(threadId, (this.#threadHandles.get(threadId) ?? 0) + 1);
  }

  async releaseThread(threadId: string): Promise<void> {
    const remaining = (this.#threadHandles.get(threadId) ?? 1) - 1;
    if (remaining > 0) {
      this.#threadHandles.set(threadId, remaining);
      return;
    }
    this.#threadHandles.delete(threadId);
    if (this.#closePromise || !this.#child || hasExited(this.#child)) return;
    const response = asObject(await this.#request("thread/unsubscribe", { threadId }, "closeSession"),
      "thread/unsubscribe result");
    if (!["notLoaded", "unsubscribed", "notSubscribed"].includes(String(response.status))) {
      throw protocolFailure("Codex returned an invalid unsubscribe status");
    }
  }

  async listSessions(workspacePath: string): Promise<readonly AdapterListedSession[]> {
    const sessions: AdapterListedSession[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = asObject(
        await this.#request(
          "thread/list",
          {
            cwd: workspacePath,
            sourceKinds: [
              "cli",
              "vscode",
              "exec",
              "appServer",
              "subAgent",
              "subAgentReview",
              "subAgentCompact",
              "subAgentThreadSpawn",
              "subAgentOther",
              "unknown",
            ],
            ...(cursor === undefined ? {} : { cursor }),
          },
          "listSessions",
        ),
        "thread/list result",
      );
      if (!Array.isArray(result.data)) throw protocolFailure("Codex thread/list data is invalid");
      for (const value of result.data) {
        const thread = asObject(value, "listed thread");
        const nativeWorkspace = requireString(thread.cwd, "listed thread cwd");
        sessions.push({
          nativeSessionId: requireString(thread.id, "listed thread id"),
          workspacePath: nativeWorkspace,
          ...(typeof thread.name === "string" && thread.name.length > 0 ? { title: thread.name } : {}),
          ...(thread.createdAt === undefined ? {} : { createdAt: unixSecondsToRfc3339(thread.createdAt) }),
          ...(thread.updatedAt === undefined ? {} : { updatedAt: unixSecondsToRfc3339(thread.updatedAt) }),
        });
      }
      if (result.nextCursor === null || result.nextCursor === undefined) break;
      cursor = requireString(result.nextCursor, "thread/list cursor");
      if (cursors.has(cursor)) throw protocolFailure("Codex repeated a thread/list cursor");
      cursors.add(cursor);
    } while (true);
    return sessions;
  }

  async validateModel(model: string): Promise<void> {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = asObject(
        await this.#request(
          "model/list",
          { includeHidden: true, ...(cursor === undefined ? {} : { cursor }) },
          "setModel",
        ),
        "model/list result",
      );
      if (!Array.isArray(result.data)) throw protocolFailure("Codex model/list data is invalid");
      if (result.data.some((value) => isObject(value) && value.id === model)) return;
      if (result.nextCursor === null || result.nextCursor === undefined) break;
      cursor = requireString(result.nextCursor, "model/list cursor");
      if (cursors.has(cursor)) throw protocolFailure("Codex repeated a model/list cursor");
      cursors.add(cursor);
    } while (true);
    throw {
      code: "HARNESS_ERROR",
      message: `Codex does not expose model: ${model}`,
      harness: "codex",
      operation: "setModel",
      command: "codex",
      nativeCode: "model_not_found",
    } satisfies HarnessErrorData;
  }

  async validateEffort(
    effort: string,
    model: string | undefined,
    operation: HarnessErrorData["operation"],
  ): Promise<void> {
    if (model === undefined) {
      throw {
        code: "HARNESS_ERROR",
        message: "Codex cannot validate Effort without a resolved Model",
        harness: "codex",
        operation,
        command: "codex",
        nativeCode: "model_unresolved",
      } satisfies HarnessErrorData;
    }
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = asObject(
        await this.#request(
          "model/list",
          { includeHidden: true, ...(cursor === undefined ? {} : { cursor }) },
          operation,
        ),
        "model/list result",
      );
      if (!Array.isArray(result.data)) throw protocolFailure("Codex model/list data is invalid");
      const entry = result.data.find((value) => isObject(value) && value.id === model);
      if (entry !== undefined) {
        const supported = isObject(entry) ? entry.supportedReasoningEfforts : undefined;
        const supportedValues = Array.isArray(supported)
          ? supported.map((candidate) =>
              isObject(candidate) ? candidate.reasoningEffort : candidate)
          : [];
        if (supportedValues.some((candidate) => candidate === effort)) return;
        throw {
          code: "HARNESS_ERROR",
          message: `Codex does not support Effort for model: ${model}`,
          harness: "codex",
          operation,
          command: "codex",
          nativeCode: "effort_not_supported",
        } satisfies HarnessErrorData;
      }
      if (result.nextCursor === null || result.nextCursor === undefined) break;
      cursor = requireString(result.nextCursor, "model/list cursor");
      if (cursors.has(cursor)) throw protocolFailure("Codex repeated a model/list cursor");
      cursors.add(cursor);
    } while (true);
    throw {
      code: "HARNESS_ERROR",
      message: `Codex does not expose model: ${model}`,
      harness: "codex",
      operation,
      command: "codex",
      nativeCode: "model_not_found",
    } satisfies HarnessErrorData;
  }

  requestThreadRead(threadId: string): Promise<unknown> {
    return this.#request("thread/read", { threadId, includeTurns: true }, "startTurn");
  }

  requestTurn(
    threadId: string,
    input: readonly AdapterTurnInput[],
    model: string | undefined,
    effort: string | undefined,
  ): Promise<AdapterTurn> {
    const capture = new CodexTurnCapture(this, threadId);
    return this.#request(
      "turn/start",
      {
        threadId,
        input: input.map(mapTurnInput),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      },
      "startTurn",
    ).then(
      (value) => {
        const result = asObject(value, "turn/start result");
        const turn = asObject(result.turn, "turn/start turn");
        capture.accept(requireString(turn.id, "turn id"));
        return capture;
      },
      (error) => {
        capture.dispose();
        throw error;
      },
    );
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.#request(
      "turn/interrupt",
      { threadId, turnId },
      "interruptTurn",
    );
  }

  subscribe(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  respondToServerRequest(id: ServerRequestId, result: JsonObject): Promise<void> {
    this.#write({ id, result });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  #request(
    method: string,
    params: JsonObject,
    operation: HarnessErrorData["operation"],
  ): Promise<unknown> {
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { operation, resolve, reject });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(failure(operation, "ready", error));
      }
    });
  }

  #write(message: JsonObject): void {
    const child = this.#child;
    if (!child || child.stdin.destroyed) throw new Error("Codex control channel is unavailable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async #handleLine(line: string): Promise<void> {
    const message = asObject(JSON.parse(line) as unknown, "Codex message");
    await this.#context.recordNativeEvent("codex", message);
    if (message.method === "mcpServer/elicitation/request" && isObject(message.params)) {
      const requestId = typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : undefined;
      if (requestId === undefined) {
        throw protocolFailure("Codex MCP elicitation has no request id");
      }
      await this.respondToServerRequest(requestId, {
        action: "decline",
        content: null,
        _meta: null,
      });
      return;
    }
    if (typeof message.method === "string" && isObject(message.params)) {
      const requestId = typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : undefined;
      for (const listener of [...this.#notificationListeners]) {
        listener(message.method, message.params, requestId);
      }
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if ("error" in message) {
        const native = isObject(message.error) ? message.error : {};
        pending.reject({
          code: "HARNESS_ERROR",
          message: `Codex rejected ${pending.operation}`,
          harness: "codex",
          operation: pending.operation,
          command: "codex",
          ...(typeof native.code === "string" ? { nativeCode: native.code } : {}),
        });
      } else if ("result" in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(failure(pending.operation, "handshake", new Error("response has no result")));
      }
      return;
    }
  }

  #rejectAll(error: HarnessErrorData): void {
    for (const pending of this.#pending.values()) pending.reject({ ...error, operation: pending.operation });
    this.#pending.clear();
  }

  async #performClose(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    const pid = this.#processGroupId;
    if (hasExited(child)) {
      if (pid !== undefined) killProcessGroup(pid);
      return;
    }
    if (pid === undefined) throw failure("closeHarness", "shutdown", new Error("invalid child process id"));
    child.stdin.end();
    const graceful = await exitsWithin(child, this.#options.shutdownTimeoutMs ?? defaultTimeoutMs);
    if (graceful) {
      killProcessGroup(pid);
      return;
    }
    await this.#forceReclaim();
  }

  async #forceReclaim(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    const pid = this.#processGroupId;
    if (pid !== undefined) killProcessGroup(pid);
    if (hasExited(child)) return;
    if (pid === undefined) throw failure("closeHarness", "shutdown", new Error("invalid child process id"));
    if (!(await exitsWithin(child, 5_000))) {
      throw failure("closeHarness", "shutdown", new Error("forced process reclamation timed out"));
    }
  }
}

class CodexSession implements AdapterSession {
  #model: string | undefined;
  #effort: string | undefined;
  #closed = false;

  constructor(
    readonly process: CodexProcess,
    readonly nativeSessionId: string,
    model: string | undefined,
    effort: string | undefined = undefined,
  ) {
    this.#model = model;
    this.#effort = effort;
    process.retainThread(nativeSessionId);
  }

  get model(): string | undefined {
    return this.#model;
  }

  get effort(): string | undefined {
    return this.#effort;
  }

  get closed(): boolean {
    return this.#closed;
  }

  startTurn(input: readonly AdapterTurnInput[]): Promise<AdapterTurn> {
    return this.process.requestTurn(this.nativeSessionId, input, this.#model, this.#effort);
  }

  async setModel(model: string): Promise<void> {
    await this.process.validateModel(model);
    this.#model = model;
    this.#effort = undefined;
  }

  async setEffort(effort: string): Promise<void> {
    await this.process.validateEffort(effort, this.#model, "setEffort");
    this.#effort = effort;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return this.process.releaseThread(this.nativeSessionId);
  }
}

class CodexTurnCapture implements AdapterTurn {
  readonly #queue = new AsyncQueue<AdapterTurnEvent>();
  readonly #unsubscribe: () => void;
  #nativeTurnId: string | undefined;
  #logicalMessageId: string | undefined;
  readonly #messageAliases = new Map<string, string>();
  readonly #tools = new Map<string, { completed: boolean }>();
  #usageBaseline: PortableUsage | undefined;
  readonly #serverRequests = new Map<string, NativeServerRequest>();
  readonly #respondedServerRequests = new Set<string>();
  #started = false;

  constructor(readonly process: CodexProcess, readonly threadId: string) {
    this.#unsubscribe = process.subscribe((method, params, requestId) =>
      this.#onNotification(method, params, requestId),
    );
  }

  get nativeTurnId(): string {
    if (!this.#nativeTurnId) throw new Error("Codex Turn has not been accepted");
    return this.#nativeTurnId;
  }

  accept(nativeTurnId: string): void {
    this.#nativeTurnId = nativeTurnId;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#queue.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<AdapterTurnEvent> {
    return this.#queue[Symbol.asyncIterator]();
  }

  interrupt(): Promise<void> {
    return this.process.interruptTurn(this.threadId, this.nativeTurnId);
  }

  async respondToApproval(
    nativeRequestId: string,
    decision: "allowOnce" | "deny",
  ): Promise<void> {
    const request = this.#serverRequests.get(nativeRequestId);
    if (!request || request.kind !== "approval") {
      throw new Error("Unknown Codex Approval Request");
    }
    let result: JsonObject;
    if (request.approvalKind === "permissions") {
      const permissions: JsonObject = {};
      if (decision === "allowOnce") {
        if (isObject(request.permissions?.network)) permissions.network = request.permissions.network;
        if (isObject(request.permissions?.fileSystem)) permissions.fileSystem = request.permissions.fileSystem;
      }
      result = { permissions, scope: "turn" };
    } else {
      result = { decision: decision === "allowOnce" ? "accept" : "decline" };
    }
    await this.process.respondToServerRequest(request.transportId, result);
    this.#respondedServerRequests.add(nativeRequestId);
  }

  async respondToQuestion(
    nativeRequestId: string,
    response: AdapterQuestionResponse,
  ): Promise<void> {
    const request = this.#serverRequests.get(nativeRequestId);
    if (!request || request.kind !== "question") {
      throw new Error("Unknown Codex Question Request");
    }
    const answers: JsonObject = {};
    if (response.action === "answer") {
      for (const answer of response.answers) {
        const question = request.questions[answer.questionIndex];
        if (!question) throw new Error("Codex Question answer index is invalid");
        let values: string[];
        if (answer.kind === "skipped") {
          values = [];
        } else if (answer.kind === "custom") {
          values = [answer.text];
        } else {
          values = answer.optionIndexes.map((index) => {
            const option = question.options[index];
            if (!option) throw new Error("Codex Question option index is invalid");
            return option;
          });
          if (answer.kind === "optionsWithCustom") values.push(answer.text);
        }
        answers[question.id] = { answers: values };
      }
    }
    await this.process.respondToServerRequest(request.transportId, { answers });
    this.#respondedServerRequests.add(nativeRequestId);
  }

  #onNotification(
    method: string,
    params: JsonObject,
    requestId: ServerRequestId | undefined,
  ): void {
    if (params.threadId !== this.threadId) return;
    try {
      if (!this.#belongsToAcceptedTurn(method, params)) return;
      const events = this.#mapNotification(method, params, requestId);
      for (const event of events) {
        this.#queue.push(event);
        if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted") {
          this.dispose();
        }
      }
    } catch (error) {
      this.#queue.push({
        type: "adapter.protocolError",
        message: error instanceof Error ? error.message : "Codex notification is invalid",
      });
      this.dispose();
    }
  }

  #belongsToAcceptedTurn(method: string, params: JsonObject): boolean {
    if (!this.#nativeTurnId) return false;
    if (method === "turn/started") {
      const turn = asObject(params.turn, "started turn");
      if (requireString(turn.id, "started turn id") !== this.#nativeTurnId) return false;
      this.#started = true;
      return true;
    }
    if (!this.#started) return false;
    if (typeof params.turnId === "string" && params.turnId !== this.#nativeTurnId) return false;
    if (method === "turn/completed") {
      const turn = asObject(params.turn, "completed turn");
      return requireString(turn.id, "completed turn id") === this.#nativeTurnId;
    }
    return true;
  }

  #mapNotification(
    method: string,
    params: JsonObject,
    requestId: ServerRequestId | undefined,
  ): readonly AdapterTurnEvent[] {
    if (method === "turn/started") return [{ type: "turn.started" }];
    if (method === "item/started") {
      const item = asObject(params.item, "started item");
      const itemId = requireString(item.id, "item id");
      if (item.type === "reasoning") {
        const logicalId = this.#logicalMessageId ?? itemId;
        this.#messageAliases.set(itemId, logicalId);
        if (this.#logicalMessageId === undefined) {
          this.#logicalMessageId = logicalId;
          return [{ type: "assistant.message.started", nativeMessageId: logicalId }];
        }
        return [];
      }
      if (item.type === "agentMessage") {
        const logicalId = this.#logicalMessageId ?? itemId;
        this.#messageAliases.set(itemId, logicalId);
        if (this.#logicalMessageId === undefined) {
          this.#logicalMessageId = logicalId;
          return [{ type: "assistant.message.started", nativeMessageId: logicalId }];
        }
        return [];
      }
      const tool = mapToolStarted(item, itemId);
      if (tool) {
        this.#tools.set(itemId, { completed: false });
        return [tool];
      }
      return [];
    }
    if (method === "item/agentMessage/delta") {
      const itemId = requireString(params.itemId, "item id");
      return [{
        type: "assistant.message.delta",
        nativeMessageId: this.#messageAliases.get(itemId) ?? itemId,
        delta: requireString(params.delta, "message delta"),
      }];
    }
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      const itemId = requireString(params.itemId, "item id");
      return [{
        type: "assistant.reasoning.delta",
        nativeMessageId: this.#messageAliases.get(itemId) ?? itemId,
        delta: requireString(params.delta, "reasoning delta"),
      }];
    }
    const update = mapToolUpdate(method, params);
    if (update) return [update];
    if (method === "item/completed") {
      const item = asObject(params.item, "completed item");
      const itemId = requireString(item.id, "item id");
      if (item.type === "agentMessage") {
        const logicalId = this.#messageAliases.get(itemId) ?? itemId;
        this.#logicalMessageId = undefined;
        return [{
          type: "assistant.message.completed",
          nativeMessageId: logicalId,
          text: requireString(item.text, "message text", true),
        }];
      }
      const tool = mapToolCompleted(item, itemId);
      if (tool) {
        const tracked = this.#tools.get(itemId);
        if (tracked) tracked.completed = true;
        return [tool];
      }
      return [];
    }
    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = asObject(params.tokenUsage, "token usage");
      const total = readPortableUsage(asObject(tokenUsage.total, "total token usage"));
      const last = asObject(tokenUsage.last, "last token usage");
      const lastUsage = readPortableUsage(last);
      this.#usageBaseline ??= subtractUsage(total, lastUsage);
      return [{
        type: "usage.updated",
        usage: subtractUsage(total, this.#usageBaseline),
      }];
    }
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      if (requestId === undefined) throw new Error("Codex Approval Request has no request id");
      const nativeRequestId = encodeServerRequestId(requestId);
      const kind = method === "item/commandExecution/requestApproval"
        ? "command"
        : method === "item/fileChange/requestApproval"
          ? "fileChange"
          : "permissions";
      this.#serverRequests.set(nativeRequestId, {
        transportId: requestId,
        kind: "approval",
        approvalKind: kind,
        ...(kind === "permissions" && isObject(params.permissions)
          ? { permissions: params.permissions }
          : {}),
      });
      const reason = typeof params.reason === "string" && params.reason.length > 0
        ? params.reason
        : undefined;
      return [{
        type: "approval.requested",
        nativeRequestId,
        title: kind === "command"
          ? "Approve command execution"
          : kind === "fileChange"
            ? "Approve file changes"
            : "Approve requested permissions",
        ...(reason === undefined ? {} : { description: reason }),
        nativeToolCallId: requireString(params.itemId, "Approval item id"),
        details: approvalDetails(kind, params),
      }];
    }
    if (method === "item/tool/requestUserInput") {
      if (requestId === undefined) throw new Error("Codex Question Request has no request id");
      if (typeof params.isBlocking !== "boolean") {
        throw new Error("Codex Question Request blocking mode is invalid");
      }
      if (!Array.isArray(params.questions) || params.questions.length === 0) {
        throw new Error("Codex Question Request has no questions");
      }
      const nativeRequestId = encodeServerRequestId(requestId);
      const nativeQuestions = params.questions.map((value) => {
        const question = asObject(value, "Codex Question");
        if (typeof question.isOther !== "boolean" || typeof question.isSecret !== "boolean") {
          throw new Error("Codex Question flags are invalid");
        }
        if (question.isSecret) {
          throw new Error("Codex secret Questions cannot be represented safely");
        }
        const options = question.options === null
          ? []
          : requireArray(question.options, "Codex Question options").map((value) => {
              const option = asObject(value, "Codex Question option");
              return {
                label: requireString(option.label, "Codex Question option label"),
                description: requireString(
                  option.description,
                  "Codex Question option description",
                  true,
                ),
              };
            });
        return {
          id: requireString(question.id, "Codex Question id"),
          options: options.map(({ label }) => label),
          public: {
            header: requireString(question.header, "Codex Question header", true),
            question: requireString(question.question, "Codex Question text"),
            options,
            multiple: false,
            allowCustom: question.options === null || question.isOther === true,
          },
        };
      });
      this.#serverRequests.set(nativeRequestId, {
        transportId: requestId,
        kind: "question",
        questions: nativeQuestions.map(({ id, options }) => ({ id, options })),
      });
      return [{
        type: "question.requested",
        nativeRequestId,
        questions: nativeQuestions.map(({ public: publicQuestion }) => publicQuestion),
      }];
    }
    if (method === "serverRequest/resolved") {
      const resolvedId = params.requestId;
      if (typeof resolvedId !== "string" && typeof resolvedId !== "number") {
        throw new Error("Codex resolved request id is invalid");
      }
      const nativeRequestId = encodeServerRequestId(resolvedId);
      const request = this.#serverRequests.get(nativeRequestId);
      if (!request || this.#respondedServerRequests.has(nativeRequestId)) return [];
      return [{
        type: request.kind === "approval" ? "approval.invalidated" : "question.invalidated",
        nativeRequestId,
      }];
    }
    if (method === "turn/completed") {
      const turn = asObject(params.turn, "completed turn");
      if (turn.status === "completed") {
        const unfinished = [...this.#tools.entries()]
          .filter(([, state]) => !state.completed)
          .map(([itemId]) => itemId);
        if (unfinished.length > 0) {
          void this.#recoverUnfinishedTools(unfinished);
          return [];
        }
        return [{ type: "turn.completed" }];
      }
      if (turn.status === "interrupted") return [{ type: "turn.interrupted" }];
      if (turn.status === "failed") {
        const nativeError = isObject(turn.error) ? turn.error : {};
        return [{
          type: "turn.failed",
          error: {
            code: "HARNESS_ERROR",
            message: typeof nativeError.message === "string" ? nativeError.message : "Codex Turn failed",
            harness: "codex",
            operation: "startTurn",
            command: "codex",
          },
        }];
      }
    }
    return [];
  }

  async #recoverUnfinishedTools(unfinished: readonly string[]): Promise<void> {
    let payload: unknown;
    try {
      payload = await this.process.requestThreadRead(this.threadId);
    } catch (error) {
      this.#queue.push({
        type: "adapter.protocolError",
        message: `Codex thread/read recovery failed: ${errorMessage(error)}`,
      });
      this.dispose();
      return;
    }
    try {
      const result = asObject(payload, "thread/read result");
      const thread = asObject(result.thread, "thread/read thread");
      if (!Array.isArray(thread.turns)) throw new Error("Codex thread/read did not return Turns");
      const turn = thread.turns.find(
        (value) => isObject(value) && value.id === this.#nativeTurnId,
      );
      if (!turn) throw new Error("Codex thread/read did not return the completed Turn");
      const items = asObject(turn, "read Turn").items;
      if (!Array.isArray(items)) throw new Error("Codex read Turn items are invalid");
      for (const itemId of unfinished) {
        const item = items.find((value) => isObject(value) && value.id === itemId);
        if (!item) throw new Error(`Codex thread/read omits the unfinished Tool Call ${itemId}`);
        const snapshot = asObject(item, "recovered Tool Call");
        const completed = mapToolCompleted(snapshot, itemId);
        if (!completed) throw new Error(`Codex cannot map the recovered Tool Call ${itemId}`);
        if (!isTerminalToolSnapshot(snapshot)) {
          throw new Error(`Codex recovered Tool Call ${itemId} is still running`);
        }
        this.#queue.push(completed);
      }
      this.#queue.push({ type: "turn.completed" });
    } catch (error) {
      this.#queue.push({
        type: "adapter.protocolError",
        message: error instanceof Error ? error.message : "Codex Tool Call recovery failed",
      });
    } finally {
      this.dispose();
    }
  }
}

interface NativeApprovalRequest {
  readonly kind: "approval";
  readonly transportId: ServerRequestId;
  readonly approvalKind: "command" | "fileChange" | "permissions";
  readonly permissions?: JsonObject;
}

interface NativeQuestionRequest {
  readonly kind: "question";
  readonly transportId: ServerRequestId;
  readonly questions: readonly {
    readonly id: string;
    readonly options: readonly string[];
  }[];
}

type NativeServerRequest = NativeApprovalRequest | NativeQuestionRequest;

function encodeServerRequestId(id: ServerRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function approvalDetails(
  kind: NativeApprovalRequest["approvalKind"],
  params: JsonObject,
): JsonObject {
  if (kind === "command") {
    return {
      command: params.command ?? null,
      cwd: params.cwd ?? null,
      networkApprovalContext: params.networkApprovalContext ?? null,
    };
  }
  if (kind === "fileChange") return { grantRoot: params.grantRoot ?? null };
  return {
    cwd: params.cwd ?? null,
    permissions: params.permissions ?? null,
  };
}

interface PortableUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

function readPortableUsage(value: JsonObject): PortableUsage {
  return {
    inputTokens: requireNumber(value.inputTokens, "input tokens"),
    outputTokens: requireNumber(value.outputTokens, "output tokens"),
    cachedInputTokens: requireNumber(value.cachedInputTokens, "cached input tokens"),
    reasoningTokens: requireNumber(value.reasoningOutputTokens, "reasoning output tokens"),
  };
}

function subtractUsage(left: PortableUsage, right: PortableUsage): PortableUsage {
  return {
    inputTokens: left.inputTokens - right.inputTokens,
    outputTokens: left.outputTokens - right.outputTokens,
    cachedInputTokens: left.cachedInputTokens - right.cachedInputTokens,
    reasoningTokens: left.reasoningTokens - right.reasoningTokens,
  };
}

function mapToolStarted(item: JsonObject, itemId: string): AdapterTurnEvent | undefined {
  if (item.type === "commandExecution") {
    return {
      type: "tool.started",
      nativeToolCallId: itemId,
      toolName: "commandExecution",
      input: {
        command: requireString(item.command, "command"),
        cwd: requireString(item.cwd, "command cwd"),
      },
    };
  }
  if (item.type === "fileChange") {
    return { type: "tool.started", nativeToolCallId: itemId, toolName: "fileChange", input: { changes: item.changes } };
  }
  if (item.type === "mcpToolCall") {
    return {
      type: "tool.started",
      nativeToolCallId: itemId,
      toolName: `${requireString(item.server, "MCP server")}.${requireString(item.tool, "MCP tool")}`,
      input: item.arguments,
    };
  }
  if (item.type === "dynamicToolCall") {
    return {
      type: "tool.started",
      nativeToolCallId: itemId,
      toolName: requireString(item.tool, "dynamic tool"),
      input: item.arguments,
    };
  }
  return undefined;
}

function mapToolUpdate(method: string, params: JsonObject): AdapterTurnEvent | undefined {
  const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
  if (!itemId) return undefined;
  if (method === "item/commandExecution/outputDelta") {
    return { type: "tool.updated", nativeToolCallId: itemId, update: { outputDelta: requireString(params.delta, "command output delta") } };
  }
  if (method === "item/fileChange/patchUpdated") {
    return { type: "tool.updated", nativeToolCallId: itemId, update: { changes: params.changes } };
  }
  if (method === "item/mcpToolCall/progress") {
    return { type: "tool.updated", nativeToolCallId: itemId, update: { message: requireString(params.message, "MCP progress") } };
  }
  return undefined;
}

function mapToolCompleted(item: JsonObject, itemId: string): AdapterTurnEvent | undefined {
  if (item.type === "commandExecution") {
    return {
      type: "tool.completed",
      nativeToolCallId: itemId,
      output: {
        aggregatedOutput: item.aggregatedOutput ?? null,
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null,
        status: item.status,
      },
      isError: item.status === "failed" || item.status === "declined",
    };
  }
  if (item.type === "fileChange") {
    return {
      type: "tool.completed",
      nativeToolCallId: itemId,
      output: { changes: item.changes, status: item.status },
      isError: item.status === "failed" || item.status === "declined",
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      type: "tool.completed",
      nativeToolCallId: itemId,
      output: item.error ?? item.result ?? null,
      isError: item.error !== null && item.error !== undefined,
    };
  }
  if (item.type === "dynamicToolCall") {
    return {
      type: "tool.completed",
      nativeToolCallId: itemId,
      output: { contentItems: item.contentItems ?? null, durationMs: item.durationMs ?? null },
      isError: item.success === false,
    };
  }
  return undefined;
}

function isTerminalToolSnapshot(item: JsonObject): boolean {
  if (typeof item.status === "string") {
    return item.status === "completed" || item.status === "failed" || item.status === "declined";
  }
  if (item.type === "mcpToolCall") {
    return (
      (item.error !== null && item.error !== undefined) ||
      (item.result !== null && item.result !== undefined)
    );
  }
  return false;
}

function errorMessage(error: unknown): string {
  return isObject(error) && typeof error.message === "string" && error.message.length > 0
    ? error.message
    : "Codex recovery failed";
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #ended = false;

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function mapApprovalPolicy(policy: AdapterCreateSessionOptions["approvalPolicy"]): "on-request" | "never" {
  return policy === "autoApprove" ? "never" : "on-request";
}

function requireAppliedApprovalPolicy(result: JsonObject, policy: AdapterCreateSessionOptions["approvalPolicy"]): void {
  const sandbox = asObject(result.sandbox, "resolved sandbox");
  if (result.approvalPolicy !== mapApprovalPolicy(policy) ||
      sandbox.type !== (policy === "autoApprove" ? "dangerFullAccess" : "workspaceWrite")) {
    throw protocolFailure("Codex did not apply the selected Approval Policy and sandbox");
  }
}

function mapTurnInput(part: AdapterTurnInput): JsonObject {
  if (part.type === "text") return { type: "text", text: part.text, text_elements: [] };
  if (part.source.type === "file") return { type: "localImage", path: part.source.path };
  return {
    type: "image",
    url: `data:${part.source.mediaType};base64,${part.source.data}`,
  };
}

function unixSecondsToRfc3339(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw protocolFailure("Codex returned an invalid Session timestamp");
  }
  const date = new Date(value * 1_000);
  if (Number.isNaN(date.getTime())) throw protocolFailure("Codex returned an invalid Session timestamp");
  return date.toISOString();
}

function protocolFailure(message: string): {
  readonly code: "ADAPTER_PROTOCOL_ERROR";
  readonly message: string;
  readonly harness: "codex";
} {
  return { code: "ADAPTER_PROTOCOL_ERROR", message, harness: "codex" };
}

function asObject(value: unknown, description: string): JsonObject {
  if (!isObject(value)) throw new Error(`Invalid ${description}`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, description: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Invalid ${description}`);
  }
  return value;
}

function requireArray(value: unknown, description: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${description}`);
  return value;
}

function requireNumber(value: unknown, description: string): number {
  if (typeof value !== "number") throw new Error(`Invalid ${description}`);
  return value;
}

function failure(
  operation: HarnessErrorData["operation"],
  stage: NonNullable<HarnessErrorData["stage"]>,
  error: unknown,
): HarnessErrorData {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return {
    code: "HARNESS_ERROR",
    message: `Codex ${stage} failed${detail}`,
    harness: "codex",
    operation,
    command: "codex",
    stage,
  };
}

function normalizeFailure(
  error: unknown,
  operation: HarnessErrorData["operation"],
  stage: NonNullable<HarnessErrorData["stage"]>,
): HarnessErrorData {
  if (isObject(error) && error.code === "HARNESS_ERROR") return error as unknown as HarnessErrorData;
  return failure(operation, stage, error);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number, createError: () => HarnessErrorData): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(createError()), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function exitsWithin(child: ChildProcessWithoutNullStreams, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      waitForExit(child).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return isObject(error) && error.code === "ESRCH";
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isNoSuchProcess(error)) throw failure("closeHarness", "shutdown", error);
  }
}
