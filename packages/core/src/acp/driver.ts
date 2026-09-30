// ACP v1 shared Driver (ADR-0136): implements the LiveHarnessAdapter and
// AdapterSession/Turn contracts over the shared AcpConnection, translating
// agent notifications into the existing Adapter event surface. Harness-neutral
// except for the kind identity and per-Harness native Session IDs; used by the
// OpenCode and Codex ACP routes (internal test binding).
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AdapterProtocolErrorData, HarnessErrorData } from "../errors.js";
import type { AcpFailure } from "./connection.js";
import type {
  AdapterCreateSessionOptions,
  AdapterListedSession,
  AdapterQuestionResponse,
  AdapterResumeSessionOptions,
  AdapterSession,
  AdapterTurn,
  AdapterTurnEvent,
  AdapterTurnInput,
  HarnessIntegrationRoute,
  HarnessKind,
  LiveHarnessAdapter,
  LiveHarnessAdapterContext,
} from "../internal.js";
import { AcpConnection, type RpcId } from "./connection.js";
import { acpInput } from "./input.js";
import type { CreateElicitationRequest, PromptResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AcpHarnessBehavior, AcpQuestionMapping, AcpRouteOptions, AcpSessionIdentity, AcpTurnSupplement } from "./types.js";

type JsonObject = Record<string, unknown>;

interface ErrorAttribution {
  readonly harness: HarnessKind;
  readonly command: string;
}

function harnessError(attribution: ErrorAttribution, operation: HarnessErrorData["operation"], message: string, nativeCode?: string, retryable = false): HarnessErrorData {
  return { code: "HARNESS_ERROR", harness: attribution.harness, command: attribution.command, operation, message, retryable, ...(nativeCode === undefined ? {} : { nativeCode }) };
}

function protocolError(attribution: ErrorAttribution, message: string): AdapterProtocolErrorData {
  return { code: "ADAPTER_PROTOCOL_ERROR", harness: attribution.harness, message };
}

function attributionFor(kind: HarnessKind, command: string): ErrorAttribution {
  return { harness: kind, command };
}

function isAcpFailure(value: unknown): value is AcpFailure {
  return isRecord(value) && (value.code === "HARNESS_ERROR" || value.code === "ADAPTER_PROTOCOL_ERROR");
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

class AcpEventQueue implements AsyncIterable<AdapterTurnEvent> {
  readonly #items: AdapterTurnEvent[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  push(value: AdapterTurnEvent): void { if (!this.#ended) { this.#items.push(value); this.#wake?.(); } }
  end(): void { this.#ended = true; this.#wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<AdapterTurnEvent> {
    for (;;) {
      if (this.#items.length > 0) { yield this.#items.shift()!; continue; }
      if (this.#ended) return;
      await new Promise<void>((resolve) => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}

interface PendingInteraction {
  readonly turn: AcpManagedTurn;
  readonly rpcId: RpcId;
}

interface PendingApproval extends PendingInteraction {
  readonly allowOnce: string;
  readonly rejectOnce: string | undefined;
}
interface PendingQuestion extends PendingInteraction { readonly mapping: AcpQuestionMapping; }

/** Shared ACP Driver bound to one Harness Kind (internal test binding). */
export class AcpSessionDriver implements LiveHarnessAdapter {
  readonly kind: HarnessKind;
  readonly route: HarnessIntegrationRoute = "acp";
  readonly #options: AcpRouteOptions;
  readonly #context: LiveHarnessAdapterContext;
  readonly #attribution: ErrorAttribution;
  readonly #sessions = new Map<string, AcpManagedSession>();
  // Tombstones retain IDs, not Turn objects or buffered message contents. They
  // also cover replay received before session/load creates a public handle.
  readonly #contentOwners = new Map<string, Map<string, string | undefined>>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #pendingElicitations = new Map<string, PendingQuestion>();
  #connection: AcpConnection | undefined;
  #closePromise: Promise<void> | undefined;
  #lost = false;

  constructor(kind: HarnessKind, options: AcpRouteOptions, context: LiveHarnessAdapterContext, readonly behavior: AcpHarnessBehavior) {
    this.kind = kind;
    this.#options = options;
    this.#context = context;
    this.#attribution = attributionFor(kind, options.command);
  }

  async initialize(): Promise<void> {
    if (this.#closePromise || this.#connection) throw protocolError(this.#attribution, "ACP Driver is closed or already started");
    const connection = new AcpConnection(this.#options, {
      captureInbound: message => {
        const params = isRecord(message.params) ? message.params : {};
        const sessionId = stringField(params, "sessionId");
        const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
        const turn = this.#captureTurn(sessionId, params, session?.activeTurn);
        // Authentication state is control-plane data, not a Turn semantic.
        // We never issue authenticate requests or persist process logs.
        if (typeof message.method === "string" && message.method.startsWith("_auth/")) return async () => {};
        // Start recording at receipt, independently of ordered mapping: a
        // previous Tool may await native completion until fatal close releases
        // it. That must not discard later complete decoded payloads. Core's
        // store commits synchronously here; mapping still awaits its result.
        const committed = this.#context.recordNativeEvent(this.kind, message);
        // The ordered mapping may be skipped on fatal close. Core already
        // reports store failure; retain a rejection handler in that case too.
        void committed.catch(() => {});
        return async () => {
          await committed;
          if (typeof message.method === "string") await this.#onNotification(message, session, turn);
        };
      },
      onNotification: () => {},
      onLoss: (error) => this.#onLoss(error),
    }, this.#attribution);
    // Publish ownership before the first asynchronous handshake so rollback
    // from another Adapter can reclaim this still-initializing process.
    this.#connection = connection;
    try {
      const initialized = await connection.connect(1, { ...this.behavior.clientCapabilities });
      if (this.#closePromise) throw protocolError(this.#attribution, "ACP Driver closed during initialization");
      const capabilities = initialized.agentCapabilities;
      const prompt = isRecord(capabilities) ? capabilities.promptCapabilities : undefined;
      const sessions = isRecord(capabilities) ? capabilities.sessionCapabilities : undefined;
      if (initialized.protocolVersion !== 1 || !isRecord(capabilities) || capabilities.loadSession !== true ||
          !isRecord(prompt) || prompt.image !== true || !isRecord(sessions) ||
          !isRecord(sessions.list) || !isRecord(sessions.close)) {
        throw protocolError(this.#attribution, "ACP endpoint lacks required v1 Session, listing, close or image capabilities");
      }
    } catch (error) {
      // Kill the child so a failed handshake cannot leak a live process.
      await connection.close().catch(() => undefined);
      if (this.#connection === connection) this.#connection = undefined;
      throw error;
    }
  }

  async createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession> {
    const connection = this.#requireConnection();
    const result = await this.#call(connection, "session/new", { cwd: options.workspacePath, mcpServers: [] }, "createSession");
    const sessionId = sessionIdOf(this.#attribution, result, "createSession");
    this.#assertWorkspaceBound(result, options.workspacePath, "createSession");
    if (this.#sessions.has(sessionId)) throw protocolError(this.#attribution, "ACP created an already-owned native Session identity");
    const session = new AcpManagedSession(this, sessionId, options.workspacePath, options.model, options.effort, options.approvalPolicy);
    this.#sessions.set(sessionId, session);
    try { await session.configure(result, options.model, options.effort); }
    catch (error) { await session.close().catch(() => {}); throw error; }
    return session.openHandle();
  }

  async resumeSession(options: AdapterResumeSessionOptions): Promise<AdapterSession> {
    const connection = this.#requireConnection();
    const existing = this.#sessions.get(options.nativeSessionId);
    if (existing !== undefined) {
      if (existing.closed || existing.activeTurn !== undefined || existing.workspacePath !== options.workspacePath) {
        throw protocolError(this.#attribution, "Cannot rebind a busy or closed ACP Session or change its Workspace");
      }
      // One protocol subscription and executor, multiple SDK handles. Loading
      // again would replay history and replace the current notification owner.
      await existing.prepareRun(options);
      return existing.openHandle();
    }
    let result: unknown;
    try {
      result = await this.#call(connection, "session/load", { sessionId: options.nativeSessionId, cwd: options.workspacePath, mcpServers: [] }, "resumeSession");
    } catch (error) {
      if (isAcpFailure(error) && error.code === "HARNESS_ERROR" && error.nativeCode === "session_not_found") {
        throw harnessError(this.#attribution, "resumeSession", "Native Session was not found", "session_not_found");
      }
      throw error;
    }
    if (!isRecord(result)) throw protocolError(this.#attribution, "ACP session/load result must be an object");
    const sessionId = options.nativeSessionId;
    if (result.sessionId !== undefined && result.sessionId !== sessionId) {
      throw protocolError(this.#attribution, "ACP session/load returned a different Session identity");
    }
    this.#assertWorkspaceBound(result, options.workspacePath, "resumeSession");
    const session = new AcpManagedSession(this, sessionId, options.workspacePath, options.model, options.effort, options.approvalPolicy);
    this.#sessions.set(sessionId, session);
    try { await session.configure(result, options.model, options.effort); }
    catch (error) { await session.close().catch(() => {}); throw error; }
    return session.openHandle();
  }

  async listSessions(workspacePath: string): Promise<readonly AdapterListedSession[]> {
    const connection = this.#requireConnection();
    const entries: AdapterListedSession[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
    const result = await this.#call(connection, "session/list", { cwd: workspacePath, ...(cursor === undefined ? {} : { cursor }) }, "listSessions");
    if (!isRecord(result) || !Array.isArray(result.sessions)) throw protocolError(this.#attribution, "ACP session/list must return sessions");
    for (const entry of result.sessions) {
      if (!isRecord(entry)) throw protocolError(this.#attribution, "ACP session/list entry must be an object");
      const cwd = stringField(entry, "cwd");
      if (cwd === undefined) throw protocolError(this.#attribution, "ACP session/list entry lacks cwd");
      if (resolve(cwd) !== resolve(workspacePath)) continue;
      const sessionId = stringField(entry, "sessionId");
      if (sessionId === undefined) throw protocolError(this.#attribution, "ACP session/list entry lacks sessionId");
      entries.push({
        nativeSessionId: sessionId,
        workspacePath,
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
        ...(typeof entry.createdAt === "string" ? { createdAt: entry.createdAt } : {}),
        ...(typeof entry.updatedAt === "string" ? { updatedAt: entry.updatedAt } : {}),
      });
    }
    if (result.nextCursor !== undefined && result.nextCursor !== null && typeof result.nextCursor !== "string") {
      throw protocolError(this.#attribution, "ACP session/list returned an invalid cursor");
    }
    cursor = result.nextCursor == null ? undefined : result.nextCursor as string;
    if (cursor !== undefined && cursors.has(cursor)) throw protocolError(this.#attribution, "ACP session/list repeated a cursor");
    if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    return entries;
  }

  get errorAttribution(): ErrorAttribution {
    return this.#attribution;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = (async () => {
      // Runtime has already closed its public Sessions. Pending initialization
      // or Session control operations must not prevent transport reclamation.
      for (const session of this.#sessions.values()) session.dispose();
      this.#sessions.clear();
      this.#contentOwners.clear();
      await this.#connection?.close();
      this.#connection = undefined;
    })();
    return this.#closePromise;
  }

  // ---- host-method and notification handling ----

  #captureTurn(sessionId: string | undefined, params: JsonObject, current: AcpManagedTurn | undefined): AcpManagedTurn | undefined {
    if (sessionId === undefined) return undefined;
    const update = isRecord(params.update) ? params.update : undefined;
    const tool = isRecord(params.toolCall) ? params.toolCall : undefined;
    const messageId = update === undefined ? undefined : stringField(update, "messageId");
    const toolId = stringField(tool ?? update ?? params, "toolCallId");
    const key = messageId !== undefined ? `message:${messageId}` : toolId !== undefined ? `tool:${toolId}` : undefined;
    if (key === undefined) return current;
    let owners = this.#contentOwners.get(sessionId);
    if (owners === undefined) { owners = new Map(); this.#contentOwners.set(sessionId, owners); }
    if (owners.has(key)) return owners.get(key) === current?.nativeTurnId ? current : undefined;
    owners.set(key, current?.nativeTurnId);
    return current;
  }

  async #onNotification(message: JsonObject, session: AcpManagedSession | undefined, turn: AcpManagedTurn | undefined): Promise<void> {
    const method = String(message.method ?? "");
    const id = (typeof message.id === "string" || typeof message.id === "number") ? message.id as RpcId : undefined;
    const params = isRecord(message.params) ? message.params : {};
    switch (method) {
      case "session/update":
        await this.#onSessionUpdate(params, session, turn);
        return;
      case "session/request_permission":
        await this.#onPermissionRequest(params, id, turn);
        return;
      case "elicitation/create":
        this.#onElicitationCreate(params, id, turn);
        return;
      case "fs/read_text_file":
      case "fs/write_text_file":
      case "fs/list_directory":
      case "terminal/create":
      case "terminal/output":
      case "terminal/wait_for_exit":
      case "terminal/release":
      case "terminal/kill":
        if (id !== undefined) {
          await this.#connection?.respondToNotification(id, undefined, { code: -32601, message: `Host method ${method} is not supported` });
        }
        return;
      default:
        if (id !== undefined) {
          this.#connection?.respondToNotification(id, undefined, { code: -32601, message: `Unknown ACP method: ${method}` });
        }
    }
  }

  async #onSessionUpdate(params: JsonObject, session: AcpManagedSession | undefined, turn: AcpManagedTurn | undefined): Promise<void> {
    if (!isRecord(params.update) || typeof params.update.sessionUpdate !== "string") {
      throw protocolError(this.#attribution, "Invalid ACP Session update");
    }
    if (session !== undefined && params.update.sessionUpdate === "config_option_update") {
      session.acceptConfigurationUpdate(params.update);
      return;
    }
    if (session === undefined || turn === undefined || turn.completed) return;
    await turn.acceptUpdate(params.update);
  }

  async #onPermissionRequest(params: JsonObject, id: RpcId | undefined, turn: AcpManagedTurn | undefined): Promise<void> {
    if (id === undefined) throw protocolError(this.#attribution, "ACP permission requires a request ID");
    if (turn === undefined || turn.completed) {
      this.#connection?.respondToNotification(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const toolCall = params.toolCall;
    if (!isRecord(toolCall) || !Array.isArray(params.options)) throw protocolError(this.#attribution, "Malformed ACP permission request");
    const allow = params.options.find(option => isRecord(option) && option.kind === "allow_once");
    const reject = params.options.find(option => isRecord(option) && option.kind === "reject_once");
    if (!isRecord(allow) || stringField(allow, "optionId") === undefined) throw protocolError(this.#attribution, "ACP permission has no one-shot allow option");
    await turn.acceptTool(toolCall, true);
    const permissionId = `${typeof id}:${id}`;
    if (this.#pendingApprovals.has(permissionId)) throw protocolError(this.#attribution, "Duplicate ACP permission request ID");
    this.#pendingApprovals.set(permissionId, { turn, rpcId: id, allowOnce: allow.optionId as string,
      rejectOnce: isRecord(reject) ? stringField(reject, "optionId") : undefined });
    turn.pushEvent({
      type: "approval.requested",
      nativeRequestId: permissionId,
      title: stringField(toolCall, "title") ?? "Tool permission",
      nativeToolCallId: toolCall.toolCallId as string,
      details: params,
    });
  }

  #onElicitationCreate(params: JsonObject, id: RpcId | undefined, turn: AcpManagedTurn | undefined): void {
    if (id === undefined) throw protocolError(this.#attribution, "ACP elicitation requires a request ID");
    const mapping = this.behavior.decodeQuestion?.(params as CreateElicitationRequest);
    // Generic MCP/auth elicitation is not a native Question (ADR-0091).
    if (turn === undefined || turn.completed || mapping === undefined) {
      this.#connection?.respondToNotification(id, { action: "decline" }); return;
    }
    const elicitationId = `${typeof id}:${id}`;
    if (this.#pendingElicitations.has(elicitationId)) throw protocolError(this.#attribution, "Duplicate ACP elicitation request ID");
    this.#pendingElicitations.set(elicitationId, { turn, rpcId: id, mapping });
    turn.pushEvent({
      type: "question.requested",
      nativeRequestId: elicitationId,
      questions: mapping.questions,
      ...(mapping.nativeToolCallId === undefined ? {} : { nativeToolCallId: mapping.nativeToolCallId }),
    });
  }

  // ---- session/turn plumbing ----

  request(method: string, params: JsonObject, operation: HarnessErrorData["operation"]): Promise<unknown> {
    return this.#call(this.#requireConnection(), method, params, operation);
  }

  notify(method: string, params: JsonObject, operation: HarnessErrorData["operation"]): Promise<void> {
    return this.#requireConnection().notify(method, params, operation);
  }

  async closeSession(session: AcpManagedSession): Promise<void> {
    const connection = this.#requireConnection();
    const budget = this.#options.shutdownTimeoutMs ?? 60_000;
    const deadline = Date.now() + budget;
    let timedOut = false;
    // Reserve bounded time from the one total budget for TERM/KILL/reap. A missing close
    // confirmation makes the shared control plane untrustworthy, not reusable.
    const timer = setTimeout(() => {
      timedOut = true;
      const error = harnessError(this.#attribution, "closeSession", "ACP Session close confirmation timed out");
      this.#onLoss(error);
      void connection.close(deadline).catch(() => {});
    }, budget - Math.min(2000, Math.ceil(budget / 2)));
    try {
      await this.#call(connection, "session/close", { sessionId: session.nativeSessionId }, "closeSession");
    } catch (error) {
      if (timedOut) {
        await connection.close(deadline);
        throw harnessError(this.#attribution, "closeSession", "ACP Session close was unacknowledged; owned process reclaimed");
      }
      if (!this.#lost) throw error;
    } finally {
      clearTimeout(timer);
      if (this.#sessions.get(session.nativeSessionId) === session) this.#sessions.delete(session.nativeSessionId);
    }
  }

  async replyApproval(permissionId: string, decision: "allowOnce" | "deny"): Promise<void> {
    const pending = this.#pendingApprovals.get(permissionId);
    if (pending === undefined) throw protocolError(this.#attribution, `Unknown Approval Request: ${permissionId}`);
    const optionId = decision === "allowOnce" ? pending.allowOnce : pending.rejectOnce;
    await this.#requireConnection().respondToNotification(pending.rpcId, { outcome: optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId } });
    this.#pendingApprovals.delete(permissionId);
  }

  async replyQuestion(elicitationId: string, response: AdapterQuestionResponse): Promise<void> {
    const pending = this.#pendingElicitations.get(elicitationId);
    if (pending === undefined) throw protocolError(this.#attribution, `Unknown Question: ${elicitationId}`);
    await this.#requireConnection().respondToNotification(pending.rpcId, pending.mapping.reply(response));
    this.#pendingElicitations.delete(elicitationId);
    // Core resolves the Question through the caller acknowledgement path; no
    // duplicate harness-side answered event is pushed (that event exists for
    // agent-initiated answers only).
  }

  invalidateInteractions(turn: AcpManagedTurn): void {
    for (const [permissionId, pending] of this.#pendingApprovals) {
      if (pending.turn === turn) {
        this.#pendingApprovals.delete(permissionId);
        this.#connection?.respondToNotification(pending.rpcId, { outcome: { outcome: "cancelled" } });
        turn.pushEvent({ type: "approval.invalidated", nativeRequestId: permissionId });
      }
    }
    for (const [elicitationId, pending] of this.#pendingElicitations) {
      if (pending.turn === turn) {
        this.#pendingElicitations.delete(elicitationId);
        this.#connection?.respondToNotification(pending.rpcId, { action: "cancel" });
        turn.pushEvent({ type: "question.invalidated", nativeRequestId: elicitationId });
      }
    }
  }

  #assertWorkspaceBound(result: unknown, workspacePath: string, operation: string): void {
    if (!isRecord(result)) throw protocolError(this.#attribution, `${operation}: ACP result must be an object`);
    const cwd = stringField(result, "cwd");
    if (cwd !== undefined && resolve(cwd) !== resolve(workspacePath)) {
      throw protocolError(this.#attribution, `${operation}: ACP Session is bound to a different Workspace: ${cwd}`);
    }
  }

  async #call(connection: AcpConnection, method: string, params: JsonObject, operation: HarnessErrorData["operation"]): Promise<unknown> {
    try {
      return await connection.request(method, params, operation);
    } catch (error) {
      if (isAcpFailure(error)) throw error.code === "HARNESS_ERROR" ? this.behavior.classifyError?.(error) ?? error : error;
      throw harnessError(this.#attribution, operation, String(error));
    }
  }

  #requireConnection(): AcpConnection {
    if (this.#connection === undefined || !this.#connection.initialized || this.#closePromise) throw protocolError(this.#attribution, "ACP connection is not initialized or is closed");
    return this.#connection;
  }

  #onLoss(error: AcpFailure): void {
    if (this.#lost) return;
    this.#lost = true;
    // Connection/process loss follows the existing fatal contract: the Runtime
    // closes affected Sessions and fails active Turns with the normalized
    // HARNESS_ERROR. Protocol-class violations (malformed frames, unknown
    // methods) instead settle the affected Turns with ADAPTER_PROTOCOL_ERROR
    // through the adapter event channel and close the owned connection without
    // impersonating a Harness failure.
    if (error.code === "HARNESS_ERROR") {
      for (const session of this.#sessions.values()) session.loseConnection(error);
      this.#sessions.clear();
      this.#pendingApprovals.clear();
      this.#pendingElicitations.clear();
      this.#context.reportFatalError(error);
      return;
    }
    for (const session of this.#sessions.values()) session.loseConnection(error);
    this.#sessions.clear();
    this.#pendingApprovals.clear();
    this.#pendingElicitations.clear();
    void this.#connection?.close();
  }

}

class AcpManagedSession implements AdapterSession {
  readonly nativeSessionId: string;
  readonly workspacePath: string;
  readonly #driver: AcpSessionDriver;
  #model: string | undefined;
  #effort: string | undefined;
  #approvalPolicy: AdapterCreateSessionOptions["approvalPolicy"];
  #activeTurn: AcpManagedTurn | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #handles = 0;
  #selecting: { model?: string; effort?: string } | undefined;

  constructor(driver: AcpSessionDriver, nativeSessionId: string, workspacePath: string, model: string | undefined, effort: string | undefined, approvalPolicy: AdapterCreateSessionOptions["approvalPolicy"]) {
    this.#driver = driver;
    this.nativeSessionId = nativeSessionId;
    this.workspacePath = workspacePath;
    this.#model = model;
    this.#effort = effort;
    this.#approvalPolicy = approvalPolicy;
  }

  get model(): string | undefined { return this.#model; }
  get attribution(): ErrorAttribution { return this.#driver.errorAttribution; }
  get effort(): string | undefined { return this.#effort; }
  get closed(): boolean { return this.#closed; }
  get activeTurn(): AcpManagedTurn | undefined { return this.#activeTurn; }
  get identity(): AcpSessionIdentity {
    return { nativeSessionId: this.nativeSessionId, workspacePath: this.workspacePath, approvalPolicy: this.#approvalPolicy,
      ...(this.#model === undefined ? {} : { model: this.#model }), ...(this.#effort === undefined ? {} : { effort: this.#effort }) };
  }

  openHandle(): AdapterSession {
    this.#handles++;
    const owner = this;
    // Handles share one protocol subscription, not mutable run selections.
    // Core serializes native-ID execution; reapply this handle's selections
    // before its next prompt, including after another route/handle ran.
    let selection = owner.identity;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    return {
      nativeSessionId: owner.nativeSessionId,
      get model() { return selection.model; },
      get effort() { return selection.effort; },
      get closed() { return closed || owner.closed; },
      startTurn: input => owner.startTurn(input, selection),
      async setModel(model) {
        await owner.prepareRun(selection);
        await owner.setModel(model);
        selection = owner.identity;
      },
      async setEffort(effort) {
        await owner.prepareRun(selection);
        await owner.setEffort(effort);
        selection = owner.identity;
      },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = --owner.#handles === 0 ? owner.close() : Promise.resolve();
        return closePromise;
      },
    };
  }

  markFinishSettled(turn: AcpManagedTurn): void {
    if (this.#activeTurn === turn) {
      this.#activeTurn = undefined;
    }
  }

  async startTurn(input: readonly AdapterTurnInput[], selection = this.identity): Promise<AdapterTurn> {
    if (this.#closed) throw harnessError(this.#driver.errorAttribution, "startTurn", "Session is closed", "session_closed");
    if (this.#activeTurn !== undefined) throw harnessError(this.#driver.errorAttribution, "startTurn", "Session already has an active Turn", "session_busy");
    const promptRequestId = randomUUID();
    const parts = await acpInput(input);
    // Register the Turn before issuing the prompt so notifications that arrive
    // in the same stdin chunk as the prompt response always find an active Turn.
    const turn = new AcpManagedTurn(this, promptRequestId);
    this.#activeTurn = turn;
    try {
      await this.prepareRun(selection);
      await turn.initialize(this.#driver.behavior, this.identity);
      if (this.#closed) throw harnessError(this.attribution, "startTurn", "Session closed before prompt submission");
    } catch (error) {
      turn.dispose();
      this.#activeTurn = undefined;
      throw error;
    }
    // ACP returns the terminal response, not a Turn-acceptance ACK. Register
    // before sending, then return the interruptible handle without awaiting it.
    void this.#driver.request("session/prompt", {
        sessionId: this.nativeSessionId,
        prompt: parts,
      }, "startTurn").then(result => turn.completePrompt(result), error => turn.failPrompt(error)).catch(error => {
        if (isAcpFailure(error) && error.code === "ADAPTER_PROTOCOL_ERROR") turn.protocolEnd(error.message);
        else turn.finish({ type: "turn.failed", error: isAcpFailure(error) && error.code === "HARNESS_ERROR" ? error : harnessError(this.#driver.errorAttribution, "startTurn", "ACP prompt failed") });
      });
    return turn;
  }

  async configure(result: unknown, model: string | undefined, effort: string | undefined): Promise<void> {
    this.#readConfiguration(result);
    await this.prepareRun({ model, effort, approvalPolicy: this.#approvalPolicy });
  }

  async prepareRun(selection: { readonly model?: string | undefined; readonly effort?: string | undefined; readonly approvalPolicy: AdapterCreateSessionOptions["approvalPolicy"] }): Promise<void> {
    const { model, effort } = selection;
    if (model !== undefined && model !== this.#model) await this.setModel(model);
    if (effort !== undefined && effort !== this.#effort) await this.setEffort(effort);
    this.#approvalPolicy = selection.approvalPolicy;
    await this.#driver.behavior.configureSession?.(this.identity);
  }

  #readConfiguration(result: unknown, expected?: { model?: string; effort?: string }): void {
    if (!isRecord(result) || !Array.isArray(result.configOptions)) {
      throw protocolError(this.#driver.errorAttribution, "ACP Session lacks configuration options");
    }
    const ids = new Set<string>();
    let model: string | undefined;
    let effort: string | undefined;
    for (const option of result.configOptions) {
      if (!isRecord(option) || typeof option.id !== "string" || ids.has(option.id)) {
        throw protocolError(this.attribution, "ACP Session configuration has invalid or duplicate IDs");
      }
      ids.add(option.id);
      if (option.id !== "model" && option.id !== this.#driver.behavior.effortConfigId) continue;
      if (option.type !== "select" || typeof option.currentValue !== "string" || !Array.isArray(option.options)) {
        throw protocolError(this.attribution, "ACP model/effort configuration is not a select option");
      }
      const values = new Set<string>();
      for (const value of option.options) {
        if (!isRecord(value)) throw protocolError(this.attribution, "ACP configuration option is invalid");
        const entries = Array.isArray(value.options) ? value.options : [value];
        for (const entry of entries) {
          if (!isRecord(entry) || typeof entry.value !== "string" || values.has(entry.value)) {
            throw protocolError(this.attribution, "ACP configuration select values are invalid or duplicate");
          }
          values.add(entry.value);
        }
      }
      if (!values.has(option.currentValue)) throw protocolError(this.attribution, "ACP current selection is not among its options");
      if (option.id === "model") model = option.currentValue;
      else effort = option.currentValue;
    }
    if (!model) throw protocolError(this.attribution, "ACP Session lacks model configuration");
    if ((expected?.model !== undefined && model !== expected.model) || (expected?.effort !== undefined && effort !== expected.effort)) {
      throw protocolError(this.attribution, "ACP model/effort selection was not acknowledged");
    }
    // Commit the full validated snapshot at once. A model without native
    // variants clears the previous model's effort instead of retaining it.
    this.#model = model;
    this.#effort = effort;
  }

  acceptConfigurationUpdate(update: JsonObject): void {
    if (this.#closed) return;
    const effort = this.#effort;
    this.#readConfiguration(update, this.#selecting ?? {
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(effort === undefined ? {} : { effort }),
    });
    if (this.#selecting === undefined && this.#effort !== effort) throw protocolError(this.attribution, "ACP effort changed without a caller selection");
  }

  async setModel(model: string): Promise<void> {
    if (this.#closed) throw harnessError(this.#driver.errorAttribution, "setModel", "Session is closed", "session_closed");
    this.#selecting = { model };
    try {
      const result = await this.#driver.request("session/set_config_option", { sessionId: this.nativeSessionId, configId: "model", value: model }, "setModel");
      try { this.#readConfiguration(result, { model }); }
      catch (error) { await this.close().catch(() => {}); throw error; }
    } finally { this.#selecting = undefined; }
  }

  async setEffort(effort: string): Promise<void> {
    if (this.#closed) throw harnessError(this.#driver.errorAttribution, "setEffort", "Session is closed", "session_closed");
    this.#selecting = { effort, ...(this.#model === undefined ? {} : { model: this.#model }) };
    try {
      const result = await this.#driver.request("session/set_config_option", { sessionId: this.nativeSessionId, configId: this.#driver.behavior.effortConfigId, value: effort }, "setEffort");
      try { this.#readConfiguration(result, this.#selecting); }
      catch (error) { await this.close().catch(() => {}); throw error; }
    } finally { this.#selecting = undefined; }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return;
    this.dispose();
    this.#closePromise = this.#driver.closeSession(this);
    return this.#closePromise;
  }

  dispose(): void {
    this.#closed = true;
    this.#activeTurn?.finish({ type: "turn.interrupted" });
    this.#activeTurn = undefined;
  }

  async cancelTurn(turn: AcpManagedTurn): Promise<void> {
    this.clearInteractions(turn);
    await this.#driver.notify("session/cancel", {
      sessionId: this.nativeSessionId,
    }, "interruptTurn");
  }

  async replyApproval(nativeRequestId: string, decision: "allowOnce" | "deny"): Promise<void> {
    await this.#driver.replyApproval(nativeRequestId, decision);
  }

  async replyQuestion(nativeRequestId: string, response: AdapterQuestionResponse): Promise<void> {
    await this.#driver.replyQuestion(nativeRequestId, response);
  }

  clearInteractions(turn: AcpManagedTurn): void {
    this.#driver.invalidateInteractions(turn);
  }

  loseConnection(error: AcpFailure): void {
    this.#closed = true;
    const turn = this.#activeTurn;
    this.#activeTurn = undefined;
    if (turn !== undefined) {
      if (error.code === "ADAPTER_PROTOCOL_ERROR") {
        // Canonical protocol-failure channel: Core maps the adapter.protocolError
        // event to ADAPTER_PROTOCOL_ERROR with full diagnostics.
        turn.protocolEnd(error.message);
      } else {
        turn.finishWithOwner({ type: "turn.failed", error }, this);
      }
    }
  }
}

class AcpManagedTurn implements AdapterTurn {
  readonly nativeTurnId: string;
  readonly #session: AcpManagedSession;
  readonly #queue = new AcpEventQueue();
  #resolveSettled!: () => void;
  readonly #settled = new Promise<void>(resolve => { this.#resolveSettled = resolve; });
  #completed = false;
  readonly #tools = new Map<string, { record: JsonObject; started: boolean; completed: boolean }>();
  #currentMessage: { id: string; text: string } | undefined;
  #supplement: AcpTurnSupplement | undefined;
  #nativeWrites: Promise<void> = Promise.resolve();
  readonly #toolWaiters = new Map<string, Set<() => void>>();

  get completed(): boolean { return this.#completed; }

  constructor(session: AcpManagedSession, nativeTurnId: string) {
    this.#session = session;
    this.nativeTurnId = nativeTurnId;
    this.pushEvent({ type: "turn.started" });
  }

  pushEvent(event: AdapterTurnEvent): void {
    if (this.#completed) return;
    this.#queue.push(event);
  }

  async initialize(behavior: AcpHarnessBehavior, session: AcpSessionIdentity): Promise<void> {
    this.#supplement = await behavior.openTurn?.(session, event => {
      if (event.type === "adapter.protocolError") {
        // Transport loss cannot wait behind a semantic event whose missing
        // counterpart will never arrive (e.g. Question before ACP Tool start).
        this.protocolEnd(event.message);
        void this.#session.close().catch(() => {});
        return Promise.resolve();
      }
      const next = this.#nativeWrites.then(async () => {
        if ((event.type === "question.requested" || event.type === "approval.requested") && event.nativeToolCallId !== undefined) {
          await this.#waitForTool(event.nativeToolCallId);
        }
        this.pushEvent(event);
      });
      this.#nativeWrites = next;
      return next;
    });
  }

  #waitForTool(id: string): Promise<void> {
    if (this.#completed || this.#tools.get(id)?.started) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.#toolWaiters.get(id) ?? new Set();
      waiters.add(resolve);
      this.#toolWaiters.set(id, waiters);
    });
  }

  dispose(): void {
    this.#supplement?.close?.();
    for (const waiters of this.#toolWaiters.values()) for (const resolve of waiters) resolve();
    this.#toolWaiters.clear();
  }

  async acceptUpdate(update: JsonObject): Promise<void> {
    const type = update.sessionUpdate;
    if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
      const content = update.content;
      if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
        throw protocolError(this.#session.attribution, "Unsupported ACP assistant content");
      }
      const id = stringField(update, "messageId") ?? this.#currentMessage?.id ?? this.nativeTurnId;
      if (this.#currentMessage?.id !== id) {
        this.#completeMessage();
        this.#currentMessage = { id, text: "" };
        this.pushEvent({ type: "assistant.message.started", nativeMessageId: id });
      }
      if (type === "agent_message_chunk") {
        this.#currentMessage!.text += content.text;
        this.pushEvent({ type: "assistant.message.delta", nativeMessageId: id, delta: content.text });
      } else this.pushEvent({ type: "assistant.reasoning.delta", nativeMessageId: id, delta: content.text });
    } else if (type === "tool_call" || type === "tool_call_update") {
      const id = stringField(update, "toolCallId");
      if (id === undefined || (type === "tool_call" && this.#tools.has(id)) || (type === "tool_call_update" && !this.#tools.has(id))) {
        throw protocolError(this.#session.attribution, "ACP tool lifecycle is inconsistent");
      }
      await this.acceptTool(update);
    } else if (!["user_message_chunk", "plan", "plan_update", "plan_removed", "available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "usage_update", "compaction_update", "compaction_summary_chunk"].includes(String(type))) {
      throw protocolError(this.#session.attribution, "Unknown ACP Session update");
    }
    // Context usage updates are not current-Turn usage. Per-Harness native
    // supplementation supplies the latter; do not manufacture token counts.
  }

  async acceptTool(update: JsonObject, permission = false): Promise<void> {
    const id = stringField(update, "toolCallId");
    if (id === undefined) throw protocolError(this.#session.attribution, "ACP tool lacks identity");
    let state = this.#tools.get(id);
    if (state === undefined) {
      state = { record: {}, started: false, completed: false };
      this.#tools.set(id, state);
    }
    if (state.completed) throw protocolError(this.#session.attribution, "ACP tool update after completion");
    state.record = { ...state.record, ...update };
    const tool = state.record;
    if (!permission && (tool.status === "pending" || tool.status === undefined)) return;
    const terminal = tool.status === "completed" || tool.status === "failed";
    const native = !state.started || terminal ? await this.#supplement?.tool?.(tool as ToolCallUpdate) : undefined;
    if (!state.started) {
      const name = native?.name ?? stringField(tool, "name");
      const input = native === undefined ? tool.rawInput : native.input;
      if (name === undefined || input === undefined) throw protocolError(this.#session.attribution, "ACP tool lacks complete native name/input");
      state.started = true;
      this.pushEvent({ type: "tool.started", nativeToolCallId: id, toolName: name, input });
      for (const resolve of this.#toolWaiters.get(id) ?? []) resolve();
      this.#toolWaiters.delete(id);
    } else if (!permission) {
      const { sessionUpdate: _, toolCallId: __, ...details } = update;
      this.pushEvent({ type: "tool.updated", nativeToolCallId: id, update: details });
    }
    if (terminal) {
      state.completed = true;
      this.pushEvent({ type: "tool.completed", nativeToolCallId: id,
        output: native !== undefined && Object.hasOwn(native, "output") ? native.output : Object.hasOwn(tool, "rawOutput") ? tool.rawOutput : tool.content ?? null, isError: tool.status === "failed" });
    }
  }

  async completePrompt(result: unknown): Promise<void> {
    if (this.#completed) return;
    if (!isRecord(result) || !["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(String(result.stopReason))) {
      this.protocolEnd("Invalid ACP prompt completion"); return;
    }
    const supplement = await this.#supplement?.settle?.(result as PromptResponse);
    await this.#nativeWrites;
    if (supplement?.usage !== undefined) this.pushEvent({ type: "usage.updated", usage: supplement.usage });
    this.finish(supplement?.failure === undefined
      ? { type: result.stopReason === "cancelled" ? "turn.interrupted" : "turn.completed" }
      : { type: "turn.failed", error: supplement.failure });
  }

  async failPrompt(error: unknown): Promise<void> {
    if (this.#completed) return;
    if (isAcpFailure(error) && error.code === "ADAPTER_PROTOCOL_ERROR") { this.protocolEnd(error.message); return; }
    const failure = isAcpFailure(error) && error.code === "HARNESS_ERROR" ? error
      : harnessError(this.#session.attribution, "startTurn", "ACP prompt failed");
    const supplement = await this.#supplement?.settleFailure?.(failure);
    await this.#nativeWrites;
    if (supplement?.usage !== undefined) this.pushEvent({ type: "usage.updated", usage: supplement.usage });
    this.finish({ type: "turn.failed", error: supplement?.failure ?? failure });
  }

  #completeMessage(): void {
    if (this.#currentMessage === undefined) return;
    const { id, text } = this.#currentMessage;
    this.#currentMessage = undefined;
    this.pushEvent({ type: "assistant.message.completed", nativeMessageId: id, text });
  }


  finish(event: AdapterTurnEvent): void {
    this.finishWithOwner(event, this.#session);
  }

  /** Terminal protocol failure: emit adapter.protocolError and end the stream. */
  protocolEnd(message: string): void {
    if (this.#completed) return;
    this.#session.clearInteractions(this);
    this.#session.markFinishSettled(this);
    this.dispose();
    this.#completed = true;
    this.#queue.push({ type: "adapter.protocolError", message });
    this.#queue.end();
    this.#resolveSettled();
  }

  finishWithOwner(event: AdapterTurnEvent, session: AcpManagedSession): void {
    if (this.#completed) return;
    this.#completeMessage();
    session.markFinishSettled(this);
    session.clearInteractions(this);
    this.dispose();
    this.#completed = true;
    this.#queue.push(event);
    this.#queue.end();
    this.#resolveSettled();
  }

  async interrupt(): Promise<void> {
    if (this.#completed) return;
    await this.#session.cancelTurn(this);
    // Writing the cancellation notification does not stop native execution.
    // Keep ownership until the prompt terminal (and native supplement) settles;
    // Core's existing control watchdog and Runtime close bound this wait.
    await this.#settled;
  }

  async respondToApproval(nativeRequestId: string, decision: "allowOnce" | "deny"): Promise<void> {
    if (await this.#supplement?.respondToApproval?.(nativeRequestId, decision)) return;
    await this.#session.replyApproval(nativeRequestId, decision);
  }

  async respondToQuestion(nativeRequestId: string, response: AdapterQuestionResponse): Promise<void> {
    if (this.#supplement?.respondToQuestion) {
      await this.#supplement.respondToQuestion(nativeRequestId, response); return;
    }
    await this.#session.replyQuestion(nativeRequestId, response);
  }

  [Symbol.asyncIterator](): AsyncIterator<AdapterTurnEvent> {
    return this.#queue[Symbol.asyncIterator]();
  }
}

function sessionIdOf(attribution: ErrorAttribution, result: unknown, operation: string): string {
  if (!isRecord(result) || stringField(result, "sessionId") === undefined) {
    throw protocolError(attribution, `${operation}: ACP result lacks a non-empty sessionId`);
  }
  return result.sessionId as string;
}
