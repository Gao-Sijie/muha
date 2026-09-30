import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface, type Interface } from "node:readline";

import type { HarnessErrorData, OfficialAdapterOptions } from "@muha-sdk/core";
import type {
  AdapterCreateSessionOptions,
  AdapterListedSession,
  AdapterQuestionAnswer,
  AdapterQuestionItem,
  AdapterLegacyQuestionItem,
  AdapterQuestionResponse,
  AdapterResumeSessionOptions,
  AdapterSession,
  AdapterTurn,
  AdapterTurnEvent,
  AdapterTurnInput,
  LiveHarnessAdapter,
  LiveHarnessAdapterContext,
} from "@muha-sdk/core/internal";

const defaultTimeoutMs = 60_000;
const wsBearerPrefix = "kimi-code.bearer.";
type JsonObject = Record<string, unknown>;

export class KimiProcess implements LiveHarnessAdapter {
  readonly kind = "kimi" as const;
  readonly route = "native" as const;
  readonly #listeners = new Map<string, Set<(event: JsonObject) => void>>();
  readonly #pendingAcks = new Map<string, {
    resolve: (value: JsonObject) => void;
    reject: (error: unknown) => void;
  }>();
  readonly #workspaceIds = new Map<string, string>();
  readonly #subscriptions = new Set<string>();
  readonly #cursors = new Map<string, { seq: number; epoch?: string }>();
  readonly #sessions = new Map<string, Set<KimiSession>>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #processGroupId: number | undefined;
  #lines: Interface | undefined;
  #origin: string | undefined;
  #token: string | undefined;
  #socket: WebSocket | undefined;
  #socketReady = false;
  #closePromise: Promise<void> | undefined;
  #reconnectPromise: Promise<void> | undefined;
  #incoming: Promise<void> = Promise.resolve();
  #closing = false;
  #fatalLoss = false;

  constructor(
    readonly options: OfficialAdapterOptions,
    readonly context: LiveHarnessAdapterContext,
  ) {}

  async initialize(): Promise<void> {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(this.options.env ?? {})) {
      if (value === undefined) delete environment[name];
      else environment[name] = value;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        "kimi",
        ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"],
        {
          detached: true,
          env: environment,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      throw failure("initialize", "spawn", error);
    }
    this.#child = child;
    if (Number.isSafeInteger(child.pid) && child.pid !== undefined && child.pid > 1) {
      this.#processGroupId = child.pid;
    }
    child.stdin.end();
    child.stderr.resume();
    this.#lines = createInterface({ input: child.stdout });

    const ready = new Promise<void>((resolve, reject) => {
      let observedReady = false;
      this.#lines?.on("line", (line) => {
        if (observedReady) return;
        const parsed = parseReadyLine(line);
        if (!parsed) return;
        observedReady = true;
        this.#origin = parsed.origin;
        this.#token = parsed.token;
        void this.#checkReadiness().then(resolve, reject);
      });
      child.once("error", (error) => reject(failure("initialize", "spawn", error)));
      child.once("exit", (exitCode, signal) => {
        const error = {
          code: "HARNESS_ERROR",
          message: observedReady ? "Kimi server exited" : "Kimi server exited before readiness",
          harness: "kimi",
          operation: observedReady ? "closeHarness" : "initialize",
          command: "kimi",
          stage: "ready",
          exitCode,
          signal,
        } satisfies HarnessErrorData;
        if (observedReady && !this.#closePromise) this.context.reportFatalError(error);
        else reject(error);
      });
    });

    try {
      await withTimeout(
        ready,
        this.options.startupTimeoutMs ?? defaultTimeoutMs,
        () => failure("initialize", "ready", new Error("startup timeout")),
      );
    } catch (error) {
      await this.#forceReclaim();
      throw normalizeHarnessFailure(error, "initialize", "handshake");
    }
  }

  async createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession> {
    await this.#ensureSocketReady();
    const model = options.model === undefined
      ? undefined
      : await this.validateModel(options.model, "createSession");
    const workspaceId = await this.#ensureWorkspace(options.workspacePath);
    const payload = await this.requestData(
      "POST",
      "/api/v1/sessions",
      "createSession",
      {
        workspace_id: workspaceId,
        ...(model === undefined ? {} : { agent_config: { model } }),
      },
    );
    const session = await validateSession(payload, options.workspacePath);
    const nativeSessionId = session.id;
    if (options.effort !== undefined) {
      await this.validateEffort(options.effort, model, "createSession");
    }
    const permissionMode = await this.#applyApprovalPolicy(nativeSessionId, options.approvalPolicy, "createSession");
    await this.#subscribe(nativeSessionId);
    const result = new KimiSession(
      this,
      nativeSessionId,
      options.workspacePath,
      permissionMode,
      model,
      options.effort,
    );
    this.#registerSession(result);
    return result;
  }

  async resumeSession(options: AdapterResumeSessionOptions): Promise<AdapterSession> {
    await this.#ensureSocketReady();
    let payload: unknown;
    try {
      payload = await this.requestData(
        "GET",
        `/api/v1/sessions/${encodeURIComponent(options.nativeSessionId)}`,
        "resumeSession",
      );
    } catch (error) {
      throw normalizeSessionLookupFailure(error);
    }
    const session = await validateSession(payload, options.workspacePath);
    if (session.id !== options.nativeSessionId) {
      throw protocolFailure("Kimi resumed a different Session");
    }
    const model = options.model === undefined
      ? await this.#readSessionModel(options.nativeSessionId)
      : await this.validateModel(options.model, "resumeSession");
    if (options.effort !== undefined) {
      await this.validateEffort(options.effort, model, "resumeSession");
    }
    const permissionMode = await this.#applyApprovalPolicy(session.id, options.approvalPolicy, "resumeSession");
    await this.#subscribe(session.id);
    const result = new KimiSession(
      this,
      session.id,
      options.workspacePath,
      permissionMode,
      model,
      options.effort,
    );
    this.#registerSession(result);
    return result;
  }

  async listSessions(workspacePath: string): Promise<readonly AdapterListedSession[]> {
    const workspaceId = await this.#ensureWorkspace(workspacePath);
    const sessions: AdapterListedSession[] = [];
    const cursors = new Set<string>();
    let beforeId: string | undefined;
    do {
      const query = new URLSearchParams({ workspace_id: workspaceId, page_size: "100" });
      if (beforeId !== undefined) query.set("before_id", beforeId);
      const page = asObjectProtocol(
        await this.requestData("GET", `/api/v1/sessions?${query}`, "listSessions"),
        "Kimi Session page",
      );
      if (!Array.isArray(page.items)) throw protocolFailure("Kimi Session page items must be an array");
      for (const value of page.items) {
        const info = await validateSession(value, workspacePath);
        sessions.push({
          nativeSessionId: info.id,
          workspacePath,
          ...(info.title === undefined ? {} : { title: info.title }),
          ...(info.createdAt === undefined ? {} : { createdAt: info.createdAt }),
          ...(info.updatedAt === undefined ? {} : { updatedAt: info.updatedAt }),
        });
      }
      if (page.has_more !== true) {
        if (page.has_more !== false) throw protocolFailure("Kimi Session page has_more must be boolean");
        break;
      }
      const last = page.items.at(-1);
      if (last === undefined) throw protocolFailure("Kimi Session page cannot advance its cursor");
      beforeId = requireProtocolString(
        asObjectProtocol(last, "Kimi listed Session").id,
        "Kimi listed Session id",
      );
      if (cursors.has(beforeId)) throw protocolFailure("Kimi repeated a Session page cursor");
      cursors.add(beforeId);
    } while (true);
    return sessions;
  }

  async startTurn(
    session: KimiSession,
    input: readonly AdapterTurnInput[],
  ): Promise<AdapterTurn> {
    await this.#ensureSocketReady();
    const content = await Promise.all(input.map(mapTurnInput));
    const capture = new KimiTurnCapture(this, session);
    const unsubscribe = this.#listen(session.nativeSessionId, (event) => capture.receive(event));
    capture.attach(unsubscribe);
    try {
      const payload = asObjectProtocol(
        await this.requestData(
          "POST",
          `/api/v1/sessions/${encodeURIComponent(session.nativeSessionId)}/prompts`,
          "startTurn",
          {
            content,
            permission_mode: session.permissionMode,
            ...(session.model === undefined ? {} : { model: session.model }),
            ...(session.effort === undefined ? {} : { thinking: session.effort }),
          },
        ),
        "Kimi Prompt result",
      );
      capture.setNativeTurnId(requireProtocolString(payload.prompt_id, "Kimi Prompt id"));
      return capture;
    } catch (error) {
      capture.dispose();
      throw error;
    }
  }

  async abortTurn(nativeSessionId: string, nativeTurnId: string): Promise<void> {
    await this.requestData(
      "POST",
      `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}/prompts/${encodeURIComponent(nativeTurnId)}:abort`,
      "interruptTurn",
    );
  }

  async #applyApprovalPolicy(
    nativeSessionId: string,
    policy: AdapterCreateSessionOptions["approvalPolicy"],
    operation: "createSession" | "resumeSession",
  ): Promise<"auto" | "manual"> {
    const mode = policy === "autoApprove" ? "auto" : "manual";
    await this.requestData("POST", `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}/profile`,
      operation, { agent_config: { permission_mode: mode } });
    return mode;
  }

  async validateModel(
    model: string,
    operation: HarnessErrorData["operation"],
  ): Promise<string> {
    const data = asObjectProtocol(
      await this.requestData("GET", "/api/v1/models", operation),
      "Kimi Model catalog",
    );
    if (!Array.isArray(data.items)) throw protocolFailure("Kimi Model catalog items must be an array");
    for (const value of data.items) {
      const item = asObjectProtocol(value, "Kimi Model catalog item");
      if (requireProtocolString(item.model, "Kimi Model identifier") === model) return model;
    }
    throw harnessCommandFailure(operation, `Kimi does not expose model: ${model}`, "model_not_found");
  }

  async validateEffort(
    effort: string,
    model: string | undefined,
    operation: HarnessErrorData["operation"],
  ): Promise<void> {
    if (model === undefined) {
      throw harnessCommandFailure(operation, "Kimi cannot validate Effort without a resolved Model", "model_unresolved");
    }
    const data = asObjectProtocol(
      await this.requestData("GET", "/api/v1/models", operation),
      "Kimi Model catalog",
    );
    if (!Array.isArray(data.items)) throw protocolFailure("Kimi Model catalog items must be an array");
    for (const value of data.items) {
      const item = asObjectProtocol(value, "Kimi Model catalog item");
      if (requireProtocolString(item.model, "Kimi Model identifier") !== model) continue;
      if (
        Array.isArray(item.support_efforts) &&
        item.support_efforts.some((candidate) => candidate === effort)
      ) return;
      throw harnessCommandFailure(
        operation,
        `Kimi does not support Thinking Effort for model: ${model}`,
        "effort_not_supported",
      );
    }
    throw harnessCommandFailure(operation, `Kimi does not expose model: ${model}`, "model_not_found");
  }

  async requestData(
    method: "GET" | "POST",
    path: string,
    operation: HarnessErrorData["operation"],
    body?: JsonObject,
    acceptedCodes: readonly number[] = [0],
  ): Promise<unknown> {
    const origin = this.#origin;
    const token = this.#token;
    if (!origin || !token) throw harnessCommandFailure(operation, "Kimi server is not ready");
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw harnessCommandFailure(operation, `Kimi ${operation} request failed`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch {
      throw protocolFailure(`Kimi ${operation} response is not valid JSON`);
    }
    await this.context.recordNativeEvent("kimi", payload);
    const envelope = asObjectProtocol(payload, `Kimi ${operation} response`);
    if (!response.ok || typeof envelope.code !== "number" || !acceptedCodes.includes(envelope.code)) {
      throw harnessCommandFailure(operation, `Kimi rejected ${operation}`, `http_${response.status}`);
    }
    return envelope.data;
  }

  async respondToApproval(
    nativeSessionId: string,
    nativeRequestId: string,
    decision: "allowOnce" | "deny",
  ): Promise<void> {
    await this.#ensureSocketReady();
    const data = asObjectProtocol(
      await this.requestData(
        "POST",
        `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}/approvals/${encodeURIComponent(nativeRequestId)}`,
        "respondToApproval",
        { decision: decision === "allowOnce" ? "approved" : "rejected" },
      ),
      "Kimi Approval response",
    );
    if (data.resolved !== true) throw protocolFailure("Kimi did not resolve the Approval Request");
  }

  async respondToQuestion(
    nativeSessionId: string,
    nativeRequestId: string,
    response: { readonly action: "answer"; readonly answers: JsonObject } | { readonly action: "dismiss" },
  ): Promise<void> {
    await this.#ensureSocketReady();
    const path = `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}/questions/${encodeURIComponent(nativeRequestId)}`;
    const data = asObjectProtocol(
      await this.requestData(
        "POST",
        response.action === "dismiss" ? `${path}:dismiss` : path,
        "respondToQuestion",
        response.action === "answer" ? { answers: response.answers } : undefined,
        response.action === "dismiss" ? [0, 40909] : [0],
      ),
      "Kimi Question response",
    );
    if (response.action === "dismiss") {
      if (data.dismissed !== true) throw protocolFailure("Kimi did not dismiss the Question Request");
    } else if (data.resolved !== true) {
      throw protocolFailure("Kimi did not resolve the Question Request");
    }
  }

  async #checkReadiness(): Promise<void> {
    const health = asObjectProtocol(
      await this.requestData("GET", "/api/v1/healthz", "initialize"),
      "Kimi health data",
    );
    if (health.ok !== true) throw failure("initialize", "handshake", new Error("unhealthy server"));
    await this.#connectSocket();
  }

  async #connectSocket(): Promise<void> {
    const origin = this.#origin;
    const token = this.#token;
    if (!origin || !token) throw failure("initialize", "handshake", new Error("missing server credential"));
    const url = new URL("/api/v1/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, [`${wsBearerPrefix}${token}`]);
    } catch {
      throw failure("initialize", "handshake", new Error("WebSocket construction failed"));
    }
    this.#socket = socket;
    let resolveHello!: () => void;
    let rejectHello!: (error: unknown) => void;
    const hello = new Promise<void>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });
    socket.addEventListener("message", (message) => {
      this.#incoming = this.#incoming.then(async () => {
        const frame = asObjectProtocol(
          JSON.parse(messageDataToString(message.data)) as unknown,
          "Kimi WebSocket frame",
        );
        await this.context.recordNativeEvent("kimi", frame);
        if (frame.type === "server_hello") {
          const payload = asObjectProtocol(frame.payload, "Kimi server hello");
          if (payload.protocol_version !== 2) throw new Error("Kimi WebSocket protocol is not v2");
          socket.send(JSON.stringify({
            type: "client_hello",
            id: "muha-ready",
            payload: { client_id: `muha-sdk-${randomUUID()}` },
          }));
          return;
        }
        if (frame.type === "ack" && frame.id === "muha-ready") {
          if (frame.code !== 0) throw new Error("Kimi WebSocket client hello was rejected");
          this.#socketReady = true;
          resolveHello();
          return;
        }
        if (frame.type === "ack" && typeof frame.id === "string") {
          const pending = this.#pendingAcks.get(frame.id);
          if (!pending) return;
          this.#pendingAcks.delete(frame.id);
          if (frame.code === 0) pending.resolve(frame);
          else pending.reject(protocolFailure("Kimi WebSocket control frame was rejected"));
          return;
        }
        if (frame.type === "ping") {
          const payload = asObjectProtocol(frame.payload, "Kimi ping");
          socket.send(JSON.stringify({
            type: "pong",
            payload: { nonce: requireProtocolString(payload.nonce, "Kimi ping nonce") },
          }));
          return;
        }
        if (frame.type === "resync_required") {
          this.#receiveResyncRequired(frame);
          return;
        }
        if (frame.type === "error") {
          const payload = asObjectProtocol(frame.payload, "Kimi WebSocket error");
          if (payload.fatal === true) {
            this.#declarePermanentLoss("Kimi WebSocket reported a fatal error");
          }
          return;
        }
        if (typeof frame.session_id === "string" && typeof frame.type === "string") {
          this.#routeSessionEvent(frame);
        }
      }).catch((error) => {
        rejectHello(error);
        this.#declarePermanentLoss(
          isErrorWithMessage(error) ? error.message : "Kimi WebSocket frame failed",
        );
      });
    });
    socket.addEventListener("error", () => rejectHello(new Error("Kimi WebSocket connection failed")));
    socket.addEventListener("close", () => {
      if (socket !== this.#socket) return;
      if (!this.#socketReady) rejectHello(new Error("Kimi WebSocket closed before readiness"));
      this.#rejectPendingAcks(protocolFailure("Kimi WebSocket connection closed"));
      this.#socketReady = false;
      this.#socket = undefined;
      if (!this.#closing && !this.#fatalLoss) void this.#recoverSocket().catch(() => undefined);
    });
    await hello;
  }

  async #ensureWorkspace(workspacePath: string): Promise<string> {
    const existing = this.#workspaceIds.get(workspacePath);
    if (existing) return existing;
    const payload = asObjectProtocol(
      await this.requestData("POST", "/api/v1/workspaces", "createSession", { root: workspacePath }),
      "Kimi Workspace",
    );
    const id = requireProtocolString(payload.id, "Kimi Workspace id");
    this.#workspaceIds.set(workspacePath, id);
    return id;
  }

  async #readSessionModel(nativeSessionId: string): Promise<string | undefined> {
    const status = asObjectProtocol(
      await this.requestData(
        "GET",
        `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}/status`,
        "resumeSession",
      ),
      "Kimi Session status",
    );
    if (status.model === undefined) return undefined;
    return requireProtocolString(status.model, "Kimi Session model");
  }

  async #subscribe(nativeSessionId: string, recover = true): Promise<void> {
    if (!this.#socketReady || !this.#socket) {
      if (recover) await this.#ensureSocketReady();
      if (!this.#socketReady || !this.#socket) throw protocolFailure("Kimi WebSocket is not ready");
    }
    const id = `subscribe-${randomUUID()}`;
    const ack = new Promise<JsonObject>((resolve, reject) => this.#pendingAcks.set(id, { resolve, reject }));
    const cursor = this.#cursors.get(nativeSessionId);
    let frame: JsonObject;
    try {
      this.#socket.send(JSON.stringify({
        type: "subscribe",
        id,
        payload: {
          session_ids: [nativeSessionId],
          ...(cursor === undefined ? {} : { cursors: { [nativeSessionId]: cursor } }),
        },
      }));
      frame = await ack;
    } finally {
      this.#pendingAcks.delete(id);
    }
    const payload = asObjectProtocol(frame.payload, "Kimi subscribe acknowledgement");
    if (!Array.isArray(payload.accepted) || !payload.accepted.includes(nativeSessionId)) {
      throw protocolFailure("Kimi did not accept the Session subscription");
    }
    if (!Array.isArray(payload.resync_required)) {
      throw protocolFailure("Kimi subscribe resync_required must be an array");
    }
    const serverCursor = readServerCursor(payload.cursors, nativeSessionId);
    if (payload.resync_required.includes(nativeSessionId)) {
      this.#handleResync(nativeSessionId, serverCursor, "Kimi subscription requires resync");
    } else if (cursor === undefined && serverCursor !== undefined) {
      this.#cursors.set(nativeSessionId, serverCursor);
    }
    this.#subscriptions.add(nativeSessionId);
  }

  async #ensureSocketReady(): Promise<void> {
    if (this.#fatalLoss) throw protocolFailure("Kimi WebSocket control channel was permanently lost");
    if (this.#socketReady) return;
    await this.#recoverSocket();
    if (!this.#socketReady) throw protocolFailure("Kimi WebSocket is not ready");
  }

  #recoverSocket(): Promise<void> {
    if (this.#reconnectPromise) return this.#reconnectPromise;
    const recovery = withTimeout(
      (async () => {
        await this.#connectSocket();
        for (const nativeSessionId of this.#subscriptions) await this.#subscribe(nativeSessionId, false);
      })(),
      this.options.startupTimeoutMs ?? defaultTimeoutMs,
      () => protocolFailure("Kimi WebSocket recovery timed out"),
    ).catch((error) => {
      this.#declarePermanentLoss(
        isErrorWithMessage(error) ? error.message : "Kimi WebSocket recovery failed",
      );
      throw error;
    }).finally(() => {
      if (this.#reconnectPromise === recovery) this.#reconnectPromise = undefined;
    });
    this.#reconnectPromise = recovery;
    return recovery;
  }

  #routeSessionEvent(frame: JsonObject): void {
    const nativeSessionId = requireProtocolString(frame.session_id, "Kimi event Session id");
    const seq = requireSequence(frame.seq, "Kimi event seq");
    const epoch = optionalProtocolString(frame.epoch, "Kimi event epoch");
    if (frame.volatile === true) {
      for (const listener of [...(this.#listeners.get(nativeSessionId) ?? [])]) listener(frame);
      return;
    }
    if (frame.volatile !== undefined && frame.volatile !== false) {
      throw new Error("Kimi event volatile flag must be boolean");
    }
    const cursor = this.#cursors.get(nativeSessionId);
    if (cursor !== undefined) {
      if (cursor.epoch !== undefined && epoch !== undefined && cursor.epoch !== epoch) {
        this.#handleResync(
          nativeSessionId,
          { seq, ...(epoch === undefined ? {} : { epoch }) },
          "Kimi event epoch changed",
        );
        return;
      }
      if (seq <= cursor.seq) return;
      if (seq !== cursor.seq + 1) {
        this.#handleResync(
          nativeSessionId,
          { seq, ...(epoch === undefined ? {} : { epoch }) },
          "Kimi event sequence has a gap",
        );
        return;
      }
    }
    this.#cursors.set(nativeSessionId, { seq, ...(epoch === undefined ? {} : { epoch }) });
    for (const listener of [...(this.#listeners.get(nativeSessionId) ?? [])]) listener(frame);
  }

  #receiveResyncRequired(frame: JsonObject): void {
    const payload = asObjectProtocol(frame.payload, "Kimi resync_required payload");
    const nativeSessionId = requireProtocolString(payload.session_id, "Kimi resync Session id");
    const seq = requireSequence(payload.current_seq, "Kimi resync current seq");
    const epoch = optionalProtocolString(payload.epoch, "Kimi resync epoch");
    this.#handleResync(
      nativeSessionId,
      { seq, ...(epoch === undefined ? {} : { epoch }) },
      `Kimi Session requires resync: ${requireProtocolString(payload.reason, "Kimi resync reason")}`,
    );
  }

  #handleResync(
    nativeSessionId: string,
    cursor: { seq: number; epoch?: string } | undefined,
    message: string,
  ): void {
    if ((this.#listeners.get(nativeSessionId)?.size ?? 0) > 0) {
      this.#failSession(nativeSessionId, message);
    }
    if (cursor !== undefined) this.#cursors.set(nativeSessionId, cursor);
  }

  #registerSession(session: KimiSession): void {
    let sessions = this.#sessions.get(session.nativeSessionId);
    if (!sessions) {
      sessions = new Set();
      this.#sessions.set(session.nativeSessionId, sessions);
    }
    sessions.add(session);
  }

  releaseSession(session: KimiSession): void {
    const sessions = this.#sessions.get(session.nativeSessionId);
    sessions?.delete(session);
    if (sessions?.size === 0) this.#sessions.delete(session.nativeSessionId);
  }

  #failSession(nativeSessionId: string, message: string): void {
    for (const session of this.#sessions.get(nativeSessionId) ?? []) session.closeAfterStreamFailure();
    for (const listener of [...(this.#listeners.get(nativeSessionId) ?? [])]) {
      listener({ type: "adapter.protocolError", message });
    }
  }

  #declarePermanentLoss(message: string): void {
    if (this.#fatalLoss || this.#closing) return;
    this.#fatalLoss = true;
    this.context.reportFatalError({
      code: "HARNESS_ERROR",
      message,
      harness: "kimi",
      operation: "closeHarness",
      command: "kimi",
      stage: "ready",
    });
    this.#socket?.close();
  }

  #listen(nativeSessionId: string, listener: (event: JsonObject) => void): () => void {
    let listeners = this.#listeners.get(nativeSessionId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(nativeSessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(nativeSessionId);
    };
  }

  #rejectPendingAcks(error: unknown): void {
    for (const pending of this.#pendingAcks.values()) pending.reject(error);
    this.#pendingAcks.clear();
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#closing = true;
    this.#listeners.clear();
    this.#rejectPendingAcks(protocolFailure("Kimi Adapter is closing"));
    this.#socket?.close();
    this.#socket = undefined;
    this.#socketReady = false;
    const child = this.#child;
    if (!child) return;
    const pid = this.#processGroupId;
    if (hasExited(child)) {
      if (pid !== undefined) signalProcessGroup(pid, "SIGKILL");
      return;
    }
    if (pid === undefined) throw failure("closeHarness", "shutdown", new Error("invalid child process id"));
    signalProcessGroup(pid, "SIGTERM");
    if (await exitsWithin(child, this.options.shutdownTimeoutMs ?? defaultTimeoutMs)) {
      signalProcessGroup(pid, "SIGKILL");
      return;
    }
    await this.#forceReclaim();
  }

  async #forceReclaim(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    const pid = this.#processGroupId;
    if (pid !== undefined) signalProcessGroup(pid, "SIGKILL");
    if (hasExited(child)) return;
    if (pid === undefined) throw failure("closeHarness", "shutdown", new Error("invalid child process id"));
    if (!(await exitsWithin(child, 5_000))) {
      throw failure("closeHarness", "shutdown", new Error("forced process reclamation timed out"));
    }
  }
}

class KimiSession implements AdapterSession {
  #closed = false;
  #model: string | undefined;
  #effort: string | undefined;

  constructor(
    readonly process: KimiProcess,
    readonly nativeSessionId: string,
    readonly workspacePath: string,
    readonly permissionMode: "auto" | "manual",
    model: string | undefined,
    effort: string | undefined = undefined,
  ) {
    this.#model = model;
    this.#effort = effort;
  }

  get model(): string | undefined { return this.#model; }
  get effort(): string | undefined { return this.#effort; }
  get closed(): boolean { return this.#closed; }

  startTurn(input: readonly AdapterTurnInput[]): Promise<AdapterTurn> {
    return this.process.startTurn(this, input);
  }

  async setModel(model: string): Promise<void> {
    this.#model = await this.process.validateModel(model, "setModel");
    this.#effort = undefined;
  }

  async setEffort(effort: string): Promise<void> {
    await this.process.validateEffort(effort, this.#model, "setEffort");
    this.#effort = effort;
  }

  close(): Promise<void> {
    this.process.releaseSession(this);
    this.#closed = true;
    return Promise.resolve();
  }

  closeAfterStreamFailure(): void {
    this.#closed = true;
  }
}

class KimiTurnCapture implements AdapterTurn {
  #nativeTurnId: string = randomUUID();
  readonly #queue = new AsyncQueue<AdapterTurnEvent>();
  #unsubscribe: (() => void) | undefined;
  #started = false;
  #assistantStarted = false;
  #assistantText = "";
  #reasoningLength = 0;
  #stepAssistantLength = 0;
  #stepReasoningLength = 0;
  readonly #tools = new Map<string, { completed: boolean; provisional: boolean }>();
  readonly #questions = new Map<string, readonly NativeKimiQuestion[]>();
  readonly #locallyResolvedApprovals = new Set<string>();
  readonly #locallyResolvedQuestions = new Set<string>();
  #usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  #disposed = false;

  constructor(
    readonly process: KimiProcess,
    readonly session: KimiSession,
  ) {}

  get nativeTurnId(): string { return this.#nativeTurnId; }
  setNativeTurnId(value: string): void { this.#nativeTurnId = value; }
  attach(unsubscribe: () => void): void { this.#unsubscribe = unsubscribe; }

  receive(envelope: JsonObject): void {
    if (this.#disposed) return;
    try {
      if (envelope.type === "adapter.protocolError") {
        this.session.closeAfterStreamFailure();
        void this.process.abortTurn(
          this.session.nativeSessionId,
          this.#nativeTurnId,
        ).catch(() => undefined);
        this.#push({
          type: "adapter.protocolError",
          message: requireProtocolString(envelope.message, "Kimi protocol error message"),
        });
        this.dispose();
        return;
      }
      const payload = asObjectProtocol(envelope.payload, "Kimi event payload");
      if (payload.agentId !== undefined) {
        if (typeof payload.agentId !== "string") {
          throw new Error("Kimi event agent id must be a string");
        }
        if (payload.agentId !== "main") return;
      }
      if (envelope.type === "turn.started") {
        if (this.#started) throw new Error("Kimi started the Turn more than once");
        this.#started = true;
        this.#push({ type: "turn.started" });
        this.#startAssistant(payload);
        return;
      }
      if (envelope.type === "turn.step.started") {
        if (!this.#started) throw new Error("Kimi step started before the Turn");
        this.#stepAssistantLength = 0;
        this.#stepReasoningLength = 0;
        return;
      }
      if (envelope.type === "assistant.delta") {
        if (!this.#started) throw new Error("Kimi Assistant delta preceded the Turn");
        this.#startAssistant(payload);
        const delta = requireProtocolString(payload.delta, "Kimi Assistant delta", true);
        const suffix = this.#alignStepDelta(envelope, delta, this.#stepAssistantLength);
        if (suffix.length === 0) return;
        this.#assistantText += suffix;
        this.#stepAssistantLength += suffix.length;
        this.#push({
          type: "assistant.message.delta",
          nativeMessageId: this.#messageId(payload),
          delta: suffix,
        });
        return;
      }
      if (envelope.type === "thinking.delta") {
        if (!this.#started) throw new Error("Kimi reasoning delta preceded the Turn");
        this.#startAssistant(payload);
        const delta = requireProtocolString(payload.delta, "Kimi reasoning delta", true);
        const suffix = this.#alignStepDelta(envelope, delta, this.#stepReasoningLength);
        if (suffix.length === 0) return;
        this.#reasoningLength += suffix.length;
        this.#stepReasoningLength += suffix.length;
        this.#push({
          type: "assistant.reasoning.delta",
          nativeMessageId: this.#messageId(payload),
          delta: suffix,
        });
        return;
      }
      if (envelope.type === "permission.approval.requested") {
        if (!this.#started) throw new Error("Kimi Tool approval preceded the Turn");
        const nativeToolCallId = requireProtocolString(payload.toolCallId, "Kimi Tool Call id");
        const toolName = requireProtocolString(payload.toolName, "Kimi Tool name");
        if (!this.#tools.has(nativeToolCallId)) {
          this.#tools.set(nativeToolCallId, { completed: false, provisional: true });
          this.#push({
            type: "tool.started",
            nativeToolCallId,
            toolName,
            input: payload.toolInput ?? null,
          });
        }
        return;
      }
      if (envelope.type === "tool.call.started") {
        if (!this.#started) throw new Error("Kimi Tool Call preceded the Turn");
        const nativeToolCallId = requireProtocolString(payload.toolCallId, "Kimi Tool Call id");
        const existingTool = this.#tools.get(nativeToolCallId);
        if (existingTool) {
          if (!existingTool.provisional) throw new Error("Kimi started a Tool Call more than once");
          existingTool.provisional = false;
          return;
        }
        this.#tools.set(nativeToolCallId, { completed: false, provisional: false });
        this.#push({
          type: "tool.started",
          nativeToolCallId,
          toolName: requireProtocolString(payload.name, "Kimi Tool name"),
          input: payload.args ?? null,
        });
        return;
      }
      if (envelope.type === "tool.progress") {
        const nativeToolCallId = requireProtocolString(payload.toolCallId, "Kimi Tool Call id");
        const tool = this.#tools.get(nativeToolCallId);
        if (!tool || tool.completed) throw new Error("Kimi updated an inactive Tool Call");
        this.#push({ type: "tool.updated", nativeToolCallId, update: payload.update ?? null });
        return;
      }
      if (envelope.type === "tool.result") {
        const nativeToolCallId = requireProtocolString(payload.toolCallId, "Kimi Tool Call id");
        const tool = this.#tools.get(nativeToolCallId);
        if (!tool || tool.completed) throw new Error("Kimi completed an inactive Tool Call");
        if (payload.isError !== undefined && typeof payload.isError !== "boolean") {
          throw new Error("Kimi Tool result isError must be boolean");
        }
        tool.completed = true;
        this.#push({
          type: "tool.completed",
          nativeToolCallId,
          output: payload.output ?? null,
          isError: payload.isError === true,
        });
        return;
      }
      if (envelope.type === "event.approval.requested") {
        const nativeRequestId = requireProtocolString(payload.approval_id, "Kimi Approval id");
        const toolName = requireProtocolString(payload.tool_name, "Kimi Approval Tool name");
        const action = requireProtocolString(payload.action, "Kimi Approval action");
        const nativeToolCallId = payload.tool_call_id === undefined
          ? undefined
          : requireProtocolString(payload.tool_call_id, "Kimi Approval Tool Call id");
        this.#push({
          type: "approval.requested",
          nativeRequestId,
          title: `Kimi requests ${toolName} approval`,
          description: action,
          ...(nativeToolCallId === undefined ? {} : { nativeToolCallId }),
          details: {
            action,
            toolInput: payload.tool_input_display ?? null,
            ...(payload.expires_at === undefined ? {} : { expiresAt: payload.expires_at }),
          },
        });
        return;
      }
      if (envelope.type === "event.approval.resolved") {
        const nativeRequestId = requireProtocolString(payload.approval_id, "Kimi Approval id");
        if (!this.#locallyResolvedApprovals.has(nativeRequestId)) {
          this.#push({ type: "approval.invalidated", nativeRequestId });
        }
        return;
      }
      if (envelope.type === "event.question.requested") {
        const nativeRequestId = requireProtocolString(payload.question_id, "Kimi Question id");
        if (!Array.isArray(payload.questions) || payload.questions.length === 0) {
          throw new Error("Kimi Question Request has no items");
        }
        const questions = payload.questions.map(mapKimiQuestion);
        if (new Set(questions.map(({ id }) => id)).size !== questions.length) {
          throw new Error("Kimi Question item ids must be unique");
        }
        this.#questions.set(nativeRequestId, questions);
        const nativeToolCallId = payload.tool_call_id === undefined
          ? undefined
          : requireProtocolString(payload.tool_call_id, "Kimi Question Tool Call id");
        this.#push({
          type: "question.requested",
          nativeRequestId,
          questions: questions.map(({ item }) => item),
          ...(nativeToolCallId === undefined ? {} : { nativeToolCallId }),
        });
        return;
      }
      if (
        envelope.type === "event.question.answered" ||
        envelope.type === "event.question.dismissed"
      ) {
        const nativeRequestId = requireProtocolString(payload.question_id, "Kimi Question id");
        if (!this.#locallyResolvedQuestions.has(nativeRequestId)) {
          this.#push({
            type: envelope.type === "event.question.dismissed" ? "question.dismissed" : "question.invalidated",
            nativeRequestId,
          });
        }
        return;
      }
      if (envelope.type === "turn.step.completed" && payload.usage !== undefined) {
        const usage = asObjectProtocol(payload.usage, "Kimi Turn usage");
        this.#usage = {
          inputTokens: this.#usage.inputTokens + tokenCount(usage.inputOther, "input") +
            tokenCount(usage.inputCacheCreation, "cache creation"),
          outputTokens: this.#usage.outputTokens + tokenCount(usage.output, "output"),
          cachedInputTokens: this.#usage.cachedInputTokens + tokenCount(usage.inputCacheRead, "cached input"),
        };
        this.#push({
          type: "usage.updated",
          usage: this.#usage,
        });
        return;
      }
      if (envelope.type === "turn.ended") {
        const reason = requireProtocolString(payload.reason, "Kimi Turn end reason");
        if (reason === "completed") {
          this.#startAssistant(payload);
          this.#push({
            type: "assistant.message.completed",
            nativeMessageId: this.#messageId(payload),
            text: this.#assistantText,
          });
          this.#push({ type: "turn.completed" });
        } else if (reason === "cancelled") {
          this.#push({ type: "turn.interrupted" });
        } else {
          this.#push({
            type: "turn.failed",
            error: harnessCommandFailure("startTurn", "Kimi Turn failed", `turn_${reason}`),
          });
        }
        this.dispose();
      }
    } catch (error) {
      this.#push({
        type: "adapter.protocolError",
        message: error instanceof Error ? error.message : "Kimi event is invalid",
      });
      this.dispose();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AdapterTurnEvent> {
    return this.#queue[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<void> {
    await this.process.abortTurn(this.session.nativeSessionId, this.#nativeTurnId);
  }

  async respondToApproval(nativeRequestId: string, decision: "allowOnce" | "deny"): Promise<void> {
    this.#locallyResolvedApprovals.add(nativeRequestId);
    try {
      await this.process.respondToApproval(this.session.nativeSessionId, nativeRequestId, decision);
    } catch (error) {
      this.#locallyResolvedApprovals.delete(nativeRequestId);
      throw error;
    }
  }

  async respondToQuestion(nativeRequestId: string, response: AdapterQuestionResponse): Promise<void> {
    const questions = this.#questions.get(nativeRequestId);
    if (!questions) throw protocolFailure("Kimi Question response targets an unknown request");
    const nativeResponse = response.action === "dismiss"
      ? response
      : { action: "answer" as const, answers: mapQuestionResponseToKimi(response.answers, questions) };
    this.#locallyResolvedQuestions.add(nativeRequestId);
    try {
      await this.process.respondToQuestion(this.session.nativeSessionId, nativeRequestId, nativeResponse);
    } catch (error) {
      this.#locallyResolvedQuestions.delete(nativeRequestId);
      throw error;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#queue.end();
  }

  #startAssistant(payload: JsonObject): void {
    if (this.#assistantStarted) return;
    this.#assistantStarted = true;
    this.#push({
      type: "assistant.message.started",
      nativeMessageId: this.#messageId(payload),
    });
  }

  #messageId(payload: JsonObject): string {
    const turnId = payload.turnId;
    if (typeof turnId !== "number" || !Number.isSafeInteger(turnId)) {
      throw new Error("Kimi Turn id must be an integer");
    }
    return `${this.session.nativeSessionId}:turn-${turnId}:assistant`;
  }

  #alignStepDelta(envelope: JsonObject, delta: string, localLength: number): string {
    if (envelope.offset === undefined) return delta;
    const offset = requireSequence(envelope.offset, "Kimi volatile delta offset");
    if (offset > localLength) throw new Error("Kimi volatile delta has a gap");
    const covered = localLength - offset;
    if (covered >= delta.length) return "";
    return delta.slice(covered);
  }

  #push(event: AdapterTurnEvent): void { this.#queue.push(event); }
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

interface NativeKimiQuestion {
  readonly id: string;
  readonly optionIds: readonly string[];
  readonly item: AdapterLegacyQuestionItem;
}

function mapKimiQuestion(value: unknown): NativeKimiQuestion {
  const question = asObjectProtocol(value, "Kimi Question item");
  const id = requireProtocolString(question.id, "Kimi Question item id");
  const text = requireProtocolString(question.question, "Kimi Question text");
  if (!Array.isArray(question.options)) throw new Error("Kimi Question options must be an array");
  const optionIds = new Set<string>();
  const options = question.options.map((value) => {
    const option = asObjectProtocol(value, "Kimi Question option");
    const optionId = requireProtocolString(option.id, "Kimi Question option id");
    if (optionIds.has(optionId)) throw new Error("Kimi Question option ids must be unique");
    optionIds.add(optionId);
    const description = optionalProtocolString(option.description, "Kimi Question option description");
    return {
      label: requireProtocolString(option.label, "Kimi Question option label"),
      ...(description === undefined ? {} : { description }),
    };
  });
  const header = optionalProtocolString(question.header, "Kimi Question header");
  const description = optionalProtocolString(question.body, "Kimi Question body");
  if (question.multi_select !== undefined && typeof question.multi_select !== "boolean") {
    throw new Error("Kimi Question multi_select must be boolean");
  }
  if (question.allow_other !== undefined && typeof question.allow_other !== "boolean") {
    throw new Error("Kimi Question allow_other must be boolean");
  }
  return {
    id,
    optionIds: [...optionIds],
    item: {
      ...(header === undefined ? {} : { header }),
      question: text,
      ...(description === undefined ? {} : { description }),
      options,
      multiple: question.multi_select === true,
      allowCustom: question.allow_other === true,
    },
  };
}

function mapQuestionResponseToKimi(
  answers: readonly AdapterQuestionAnswer[],
  questions: readonly NativeKimiQuestion[],
): JsonObject {
  const result: JsonObject = {};
  for (const answer of answers) {
    const question = questions[answer.questionIndex];
    if (!question) throw protocolFailure("Kimi Question answer index is invalid");
    if (answer.kind === "skipped") {
      result[question.id] = { kind: "skipped" };
      continue;
    }
    if (answer.kind === "custom") {
      result[question.id] = { kind: "other", text: answer.text };
      continue;
    }
    if (answer.kind !== "options" && answer.kind !== "optionsWithCustom") {
      throw protocolFailure("Kimi Question answer kind is unsupported");
    }
    const optionIds = answer.optionIndexes.map((index) => {
      const optionId = question.optionIds[index];
      if (!optionId) throw protocolFailure("Kimi Question option index is invalid");
      return optionId;
    });
    if (answer.kind === "optionsWithCustom") {
      result[question.id] = {
        kind: "multi_with_other",
        option_ids: optionIds,
        other_text: answer.text,
      };
    } else if (question.item.multiple) {
      result[question.id] = { kind: "multi", option_ids: optionIds };
    } else {
      if (optionIds.length !== 1) throw protocolFailure("Kimi single-select Question requires one option");
      result[question.id] = { kind: "single", option_id: optionIds[0] };
    }
  }
  return result;
}

async function validateSession(value: unknown, workspacePath: string): Promise<{
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}> {
  const session = asObjectProtocol(value, "Kimi Session");
  const id = requireProtocolString(session.id, "Kimi Session id");
  const metadata = asObjectProtocol(session.metadata, "Kimi Session metadata");
  const cwd = requireProtocolString(metadata.cwd, "Kimi Session cwd");
  if (!isAbsolute(cwd)) throw protocolFailure("Kimi Session cwd must be an absolute path");
  let nativeWorkspacePath: string;
  try {
    nativeWorkspacePath = await realpath(cwd);
  } catch {
    throw protocolFailure("Kimi Session Workspace cannot be canonicalized");
  }
  if (nativeWorkspacePath !== workspacePath) {
    throw protocolFailure("Kimi Session belongs to a different Workspace");
  }
  if (session.title !== undefined && typeof session.title !== "string") {
    throw protocolFailure("Kimi Session title must be a string");
  }
  const title = typeof session.title === "string" && session.title.length > 0
    ? session.title
    : undefined;
  const createdAt = session.created_at === undefined
    ? undefined
    : rfc3339(session.created_at, "created_at");
  const updatedAt = session.updated_at === undefined
    ? undefined
    : rfc3339(session.updated_at, "updated_at");
  return {
    id,
    ...(title === undefined ? {} : { title }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

async function mapTurnInput(input: AdapterTurnInput): Promise<JsonObject> {
  if (input.type === "text") return { type: "text", text: input.text };
  if (input.source.type === "base64") {
    return {
      type: "image",
      source: {
        kind: "base64",
        media_type: input.source.mediaType,
        data: input.source.data,
      },
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(input.source.path);
  } catch {
    throw harnessCommandFailure("startTurn", "Kimi image file became unreadable", "image_unreadable");
  }
  const mediaType = detectImageMediaType(bytes);
  if (mediaType === undefined) {
    throw harnessCommandFailure("startTurn", "Kimi image file changed after validation", "image_invalid");
  }
  return {
    type: "image",
    source: { kind: "base64", media_type: mediaType, data: bytes.toString("base64") },
  };
}

function detectImageMediaType(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return undefined;
}

function rfc3339(value: unknown, description: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw protocolFailure(`Kimi Session ${description} must be an RFC 3339 timestamp`);
  }
  return new Date(value).toISOString();
}

function parseReadyLine(line: string): { origin: string; token: string } | undefined {
  const trimmed = line.trim();
  const legacyPrefix = "Kimi server: ";
  const current = /^Local:\s+(\S+)$/.exec(trimmed);
  const serializedUrl = trimmed.startsWith(legacyPrefix)
    ? trimmed.slice(legacyPrefix.length)
    : current?.[1];
  if (serializedUrl === undefined) return undefined;
  try {
    const readyUrl = new URL(serializedUrl);
    const token = new URLSearchParams(readyUrl.hash.slice(1)).get("token");
    if (
      readyUrl.protocol !== "http:" ||
      readyUrl.hostname !== "127.0.0.1" ||
      readyUrl.port.length === 0 ||
      readyUrl.username.length > 0 ||
      readyUrl.password.length > 0 ||
      readyUrl.search.length > 0 ||
      readyUrl.pathname !== "/" ||
      typeof token !== "string" ||
      token.length === 0
    ) return undefined;
    return { origin: readyUrl.origin, token };
  } catch {
    return undefined;
  }
}

function messageDataToString(value: string | ArrayBuffer | Blob): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  throw new Error("Kimi WebSocket binary frame is unsupported");
}

function asObjectProtocol(value: unknown, description: string): JsonObject {
  if (!isObject(value)) throw protocolFailure(`${description} must be an object`);
  return value;
}

function requireProtocolString(value: unknown, description: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw protocolFailure(`${description} must be ${allowEmpty ? "a" : "a non-empty"} string`);
  }
  return value;
}

function optionalProtocolString(value: unknown, description: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireProtocolString(value, description);
}

function requireSequence(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolFailure(`${description} must be a non-negative integer`);
  }
  return value as number;
}

function readServerCursor(
  value: unknown,
  nativeSessionId: string,
): { seq: number; epoch?: string } | undefined {
  if (value === undefined) return undefined;
  const cursors = asObjectProtocol(value, "Kimi subscription cursors");
  if (cursors[nativeSessionId] === undefined) return undefined;
  const cursor = asObjectProtocol(cursors[nativeSessionId], "Kimi subscription cursor");
  const epoch = optionalProtocolString(cursor.epoch, "Kimi subscription cursor epoch");
  return {
    seq: requireSequence(cursor.seq, "Kimi subscription cursor seq"),
    ...(epoch === undefined ? {} : { epoch }),
  };
}

function isErrorWithMessage(value: unknown): value is { readonly message: string } {
  return isObject(value) && typeof value.message === "string";
}

function tokenCount(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Kimi ${description} token count is invalid`);
  }
  return value as number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolFailure(message: string): {
  readonly code: "ADAPTER_PROTOCOL_ERROR";
  readonly message: string;
  readonly harness: "kimi";
} {
  return { code: "ADAPTER_PROTOCOL_ERROR", message, harness: "kimi" };
}

function harnessCommandFailure(
  operation: HarnessErrorData["operation"],
  message: string,
  nativeCode?: string,
): HarnessErrorData {
  return {
    code: "HARNESS_ERROR",
    message,
    harness: "kimi",
    operation,
    command: "kimi",
    ...(nativeCode === undefined ? {} : { nativeCode }),
  };
}

function normalizeSessionLookupFailure(error: unknown): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "HARNESS_ERROR" &&
    "nativeCode" in error &&
    error.nativeCode === "http_404"
  ) {
    return { ...error, nativeCode: "session_not_found" };
  }
  return error;
}

function failure(
  operation: HarnessErrorData["operation"],
  stage: NonNullable<HarnessErrorData["stage"]>,
  _error: unknown,
): HarnessErrorData {
  return {
    code: "HARNESS_ERROR",
    message: `Kimi ${stage} failed`,
    harness: "kimi",
    operation,
    command: "kimi",
    stage,
  };
}

function normalizeHarnessFailure(
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

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  createError: () => unknown,
): Promise<T> {
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

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isObject(error) || error.code !== "ESRCH") {
      throw failure("closeHarness", "shutdown", error);
    }
  }
}
