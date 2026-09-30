import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { OpenCodeV2Service } from "./opencode-v2-service.js";
import { OpenCodeV2Api } from "./opencode-v2-api.js";
import { OpenCodeV2Turn } from "./opencode-v2-turn.js";
import { openCodeV2Input } from "./opencode-v2-image-input.js";

import { MuhaError, type HarnessErrorData, type OfficialAdapterOptions } from "@muha-sdk/core";
import type {
  AdapterCreateSessionOptions,
  AdapterListedSession,
  AdapterQuestionAnswer,
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

type JsonObject = Record<string, unknown>;
type OpenCodeToolRecord = {
  readonly messageId: string;
  readonly callId: string;
  readonly toolName: string;
  completed: boolean;
  running: boolean;
  started: boolean;
  terminalState: JsonObject | undefined;
};

export class OpenCodeProcess implements LiveHarnessAdapter {
  readonly kind = "opencode" as const;
  readonly route = "native" as const;
  readonly #password = randomBytes(32).toString("base64url");
  readonly #authorization: string;
  readonly #workspaces = new Map<string, WorkspaceEventStream>();
  readonly #service: OpenCodeV2Service | undefined;
  #api: OpenCodeV2Api | undefined;
  #baseUrl: string | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #requests = new AbortController();

  constructor(
    readonly options: OfficialAdapterOptions,
    readonly context: LiveHarnessAdapterContext,
    attached?: { readonly baseUrl: string; readonly authorization: string },
  ) {
    this.#authorization = attached?.authorization ?? `Basic ${Buffer.from(`opencode:${this.#password}`).toString("base64")}`;
    this.#baseUrl = attached?.baseUrl;
    this.#service = attached === undefined ? new OpenCodeV2Service(options, context, this.#password) : undefined;
  }

  async initialize(): Promise<void> {
    if (this.#baseUrl !== undefined) { await this.#checkHealth(); return; }
    if (this.#service === undefined) throw failure("initialize", "ready", new Error("service missing"));
    await this.#service.initialize();
    this.#baseUrl = this.#service.baseUrl;
    this.#api = new OpenCodeV2Api(this.#service.client, this.context);
  }

  async createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession> {
    await this.#service?.ensureOrderedPlugin(options.workspacePath);
    const model = options.model === undefined
      ? undefined
      : await this.validateModel(options.model, "createSession", options.workspacePath);
    if (options.effort !== undefined) {
      await this.validateEffort(
        options.effort,
        model,
        "createSession",
        options.workspacePath,
      );
    }
    const stream = await this.#acquireWorkspace(options.workspacePath);
    try {
      const payload = await this.#requireApi().createSession(
        options.workspacePath,
        model === undefined ? undefined : toV2ModelRef(model, options.effort),
        v2Permissions(options.approvalPolicy),
      );
      const info = await validateSession(payload, options.workspacePath);
      if (model !== undefined) assertSelectedV2Model(payload, model, options.effort);
      const session = new OpenCodeSession(
        this,
        stream,
        info.id,
        options.approvalPolicy,
        model,
        options.effort,
      );
      return session;
    } catch (error) {
      stream.release();
      throw error;
    }
  }

  async resumeSession(options: AdapterResumeSessionOptions): Promise<AdapterSession> {
    await this.#service?.ensureOrderedPlugin(options.workspacePath);
    const payload = await this.#requireApi().getSession(options.nativeSessionId);
    const info = await validateSession(payload, options.workspacePath);
    if (info.id !== options.nativeSessionId) {
      throw protocolFailure("OpenCode resumed a different Session");
    }
    const nativeSelection = selectedV2Model(payload);
    const model = options.model === undefined
      ? nativeSelection?.model
      : await this.validateModel(options.model, "resumeSession", options.workspacePath);
    const effort = options.effort ??
      (options.model === undefined || options.model === nativeSelection?.model
        ? nativeSelection?.effort : undefined);
    if (options.effort !== undefined) {
      await this.validateEffort(
        options.effort,
        model,
        "resumeSession",
        options.workspacePath,
      );
    }
    const stream = await this.#acquireWorkspace(options.workspacePath);
    try {
      const permissions = v2Permissions(options.approvalPolicy);
      if (permissions !== undefined) await this.#requireApi().setPermissions(info.id, permissions);
      if ((options.model !== undefined && options.model !== nativeSelection?.model) ||
          options.effort !== undefined) {
        if (model === undefined) throw protocolFailure("OpenCode v2 Resume Model is unresolved");
        await this.selectModel(info.id, model, effort, "resumeSession");
      }
      return new OpenCodeSession(this, stream, info.id, options.approvalPolicy, model, effort);
    } catch (error) {
      stream.release();
      throw error;
    }
  }

  async listSessions(workspacePath: string): Promise<readonly AdapterListedSession[]> {
    await this.#service?.ensureOrderedPlugin(workspacePath);
    const sessions: AdapterListedSession[] = [];
    for (const value of await this.#requireApi().listSessions(workspacePath)) {
        const info = await validateListedSession(value, workspacePath);
        if (info === undefined) continue;
        sessions.push({
          nativeSessionId: info.id,
          workspacePath,
          ...(info.title === undefined ? {} : { title: info.title }),
          ...(info.createdAt === undefined ? {} : { createdAt: info.createdAt }),
          ...(info.updatedAt === undefined ? {} : { updatedAt: info.updatedAt }),
        });
    }
    return sessions;
  }

  #requireApi(): OpenCodeV2Api {
    if (this.#api === undefined) throw harnessCommandFailure("createSession", "OpenCode v2 service is not ready");
    return this.#api;
  }

  async startTurn(
    session: OpenCodeSession,
    input: readonly AdapterTurnInput[],
  ): Promise<AdapterTurn> {
    const prompt = await openCodeV2Input(input);
    await this.#service?.ensureOrderedPlugin(session.stream.workspacePath);
    await session.stream.ensureConnected();
    const api = this.#requireApi();
    if (prompt.files && prompt.files.length > 0) {
      await this.#validateImageModel(session, api);
    }
    const baseline = await api.listMessages(session.nativeSessionId);
    const capture = new OpenCodeV2Turn(
      api,
      session.nativeSessionId,
      baseline,
      () => session.closeAfterStreamFailure(),
      session.approvalPolicy,
    );
    const unsubscribe = session.stream.subscribe(session.nativeSessionId, (event) =>
      capture.receive(event), true);
    capture.attach(unsubscribe);
    try {
      const acknowledgement = await api.prompt(session.nativeSessionId, capture.inboxID, prompt);
      capture.accept(acknowledgement);
      return capture;
    } catch (error) {
      capture.dispose();
      throw error;
    }
  }

  async #validateImageModel(session: OpenCodeSession, api: OpenCodeV2Api): Promise<void> {
    const current = asObjectProtocol(await api.getSession(session.nativeSessionId), "OpenCode v2 Session");
    let selected: unknown = current.model;
    if (selected === undefined || selected === null) {
      selected = await api.defaultModel(session.stream.workspacePath);
    }
    const model = asObjectProtocol(selected, "OpenCode v2 selected Model");
    const providerID = requireProtocolString(model.providerID, "OpenCode v2 Model provider");
    const modelID = requireProtocolString(model.id, "OpenCode v2 Model id");
    const entry = (await api.listModels(session.stream.workspacePath, "startTurn"))
      .find((value) => isObject(value) && value.providerID === providerID && value.id === modelID);
    if (!isObject(entry)) {
      throw harnessCommandFailure("startTurn", "OpenCode image Model is unavailable", "model_not_found");
    }
    const capabilities = asObjectProtocol(entry.capabilities, "OpenCode v2 Model capabilities");
    if (!Array.isArray(capabilities.input) || !capabilities.input.every((value) => typeof value === "string")) {
      throw protocolFailure("OpenCode v2 Model input capabilities are invalid");
    }
    if (!capabilities.input.includes("image")) {
      throw harnessCommandFailure("startTurn", "OpenCode Model does not accept images", "image_not_supported");
    }
  }

  async abortTurn(workspacePath: string, nativeSessionId: string): Promise<void> {
    const value = await this.requestJson(
      "POST",
      `/session/${encodeURIComponent(nativeSessionId)}/abort`,
      "interruptTurn",
      workspacePath,
    );
    if (value !== true) throw protocolFailure("OpenCode abort response is invalid");
  }

  async observeSession(
    options: AdapterResumeSessionOptions,
    receive: (event: JsonObject) => void,
  ): Promise<() => void> {
    // Reuse native identity/Workspace checks and the already supported
    // Session-tree subscription without creating or executing a Session.
    const session = await this.resumeSession(options) as OpenCodeSession;
    const unsubscribe = session.stream.subscribe(session.nativeSessionId, receive, true);
    try {
      await this.#loadDescendants(session);
    } catch (error) { unsubscribe(); await session.close(); throw error; }
    return () => { unsubscribe(); void session.close(); };
  }

  async #loadDescendants(session: OpenCodeSession): Promise<void> {
    const pending = [session.nativeSessionId];
    const seen = new Set(pending);
    for (const parentId of pending) {
      const children = await this.requestJson("GET", `/session/${encodeURIComponent(parentId)}/children`,
        "startTurn", session.stream.workspacePath);
      if (!Array.isArray(children)) throw protocolFailure("OpenCode Session children must be an array");
      for (const child of children) {
        const info = await validateSession(child, session.stream.workspacePath);
        if (asObject(child, "OpenCode child Session").parentID !== parentId || seen.has(info.id)) {
          throw protocolFailure("OpenCode returned an invalid Session tree");
        }
        session.stream.rememberParent(info.id, parentId);
        seen.add(info.id);
        pending.push(info.id);
      }
    }
  }

  async respondToPermission(
    workspacePath: string,
    nativeRequestId: string,
    decision: "allowOnce" | "deny",
  ): Promise<void> {
    const value = await this.requestJson(
      "POST",
      `/permission/${encodeURIComponent(nativeRequestId)}/reply`,
      "respondToApproval",
      workspacePath,
      { reply: decision === "allowOnce" ? "once" : "reject" },
    );
    if (value !== true) throw protocolFailure("OpenCode permission response is invalid");
  }

  async respondToQuestion(
    workspacePath: string,
    nativeRequestId: string,
    response: { readonly action: "answer"; readonly answers: readonly string[][] } | { readonly action: "dismiss" },
  ): Promise<void> {
    const path = response.action === "answer"
      ? `/question/${encodeURIComponent(nativeRequestId)}/reply`
      : `/question/${encodeURIComponent(nativeRequestId)}/reject`;
    const value = await this.requestJson(
      "POST",
      path,
      "respondToQuestion",
      workspacePath,
      response.action === "answer" ? { answers: response.answers } : undefined,
    );
    if (value !== true) throw protocolFailure("OpenCode Question response is invalid");
  }

  async validateModel(
    model: string,
    operation: HarnessErrorData["operation"],
    workspacePath: string,
  ): Promise<string> {
    const pair = parseOpenCodeModel(model);
    for (const value of await this.#requireApi().listModels(workspacePath, operation)) {
      const entry = asObjectProtocol(value, "OpenCode v2 Model");
      if (entry.providerID === pair.providerID && entry.id === pair.modelID) return model;
    }
    throw harnessCommandFailure(
      operation,
      `OpenCode does not expose model: ${model}`,
      "model_not_found",
    );
  }

  async validateEffort(
    effort: string,
    model: string | undefined,
    operation: HarnessErrorData["operation"],
    workspacePath: string,
  ): Promise<void> {
    if (model === undefined) {
      throw harnessCommandFailure(
        operation,
        "OpenCode cannot validate Effort without a resolved Model",
        "model_unresolved",
      );
    }
    const pair = parseOpenCodeModel(model);
    for (const value of await this.#requireApi().listModels(workspacePath, operation)) {
      const entry = asObjectProtocol(value, "OpenCode v2 Model");
      if (entry.providerID !== pair.providerID || entry.id !== pair.modelID) continue;
      if (!Array.isArray(entry.variants)) {
        throw protocolFailure("OpenCode v2 Model variants are invalid");
      }
      if (entry.variants.some((candidate) => isObject(candidate) && candidate.id === effort)) return;
      throw harnessCommandFailure(
        operation,
        `OpenCode does not support Variant for model: ${model}`,
        "effort_not_supported",
      );
    }
    throw harnessCommandFailure(
      operation,
      `OpenCode does not expose model: ${model}`,
      "model_not_found",
    );
  }

  async selectModel(
    nativeSessionId: string,
    model: string,
    effort: string | undefined,
    operation: HarnessErrorData["operation"],
  ): Promise<void> {
    await this.#requireApi().switchModel(nativeSessionId, toV2ModelRef(model, effort), operation);
    const current = await this.#requireApi().getSession(nativeSessionId);
    assertSelectedV2Model(current, model, effort);
  }

  async #readSessionModel(nativeSessionId: string, workspacePath: string): Promise<string | undefined> {
    const payload = await this.requestJson(
      "GET",
      `/session/${encodeURIComponent(nativeSessionId)}/message`,
      "resumeSession",
      workspacePath,
    );
    if (!Array.isArray(payload)) throw protocolFailure("OpenCode Session messages must be an array");
    for (let index = payload.length - 1; index >= 0; index -= 1) {
      const entry = asObjectProtocol(payload[index], "OpenCode Session message");
      const info = asObjectProtocol(entry.info, "OpenCode Session message info");
      if (info.role !== "user" || info.model === undefined) continue;
      const model = asObjectProtocol(info.model, "OpenCode Session message model");
      const providerID = requireProtocolString(model.providerID, "OpenCode Session provider id");
      const modelID = requireProtocolString(model.modelID, "OpenCode Session model id");
      return joinOpenCodeModel(providerID, modelID);
    }
    return undefined;
  }

  async requestJson(
    method: "GET" | "POST",
    path: string,
    operation: HarnessErrorData["operation"],
    workspacePath?: string,
    body?: JsonObject,
  ): Promise<unknown> {
    return (await this.requestJsonResponse(method, path, operation, workspacePath, body)).payload;
  }

  async requestJsonResponse(
    method: "GET" | "POST",
    path: string,
    operation: HarnessErrorData["operation"],
    workspacePath?: string,
    body?: JsonObject,
  ): Promise<{ payload: unknown; response: Response }> {
    const response = await this.#request(method, path, operation, workspacePath, body);
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch {
      throw protocolFailure(`OpenCode ${operation} response is not valid JSON`);
    }
    await this.context.recordNativeEvent("opencode", payload);
    if (!response.ok) {
      throw harnessCommandFailure(operation, `OpenCode rejected ${operation}`, `http_${response.status}`);
    }
    return { payload, response };
  }

  async requestNoContent(
    method: "POST",
    path: string,
    operation: HarnessErrorData["operation"],
    workspacePath: string,
    body: JsonObject,
  ): Promise<void> {
    const response = await this.#request(method, path, operation, workspacePath, body);
    if (response.status === 204) return;
    const source = await response.text();
    if (source.length > 0) {
      try {
        await this.context.recordNativeEvent("opencode", JSON.parse(source) as unknown);
      } catch (error) {
        if (isEventStoreError(error)) throw error;
        throw protocolFailure(`OpenCode ${operation} response is not valid JSON`);
      }
    }
    throw harnessCommandFailure(operation, `OpenCode rejected ${operation}`, `http_${response.status}`);
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    operation: HarnessErrorData["operation"],
    workspacePath?: string,
    body?: JsonObject,
  ): Promise<Response> {
    const baseUrl = this.#baseUrl;
    if (!baseUrl) throw harnessCommandFailure(operation, "OpenCode server is not ready");
    try {
      return await fetch(`${baseUrl}${path}`, {
        method,
        signal: this.#requests.signal,
        headers: {
          authorization: this.#authorization,
          ...(workspacePath === undefined ? {} : { "x-opencode-directory": workspacePath }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw harnessCommandFailure(operation, `OpenCode ${operation} request failed`);
    }
  }

  async #checkHealth(): Promise<void> {
    const response = await this.#request("GET", "/global/health", "initialize");
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch {
      throw failure("initialize", "handshake", new Error("invalid health response"));
    }
    await this.context.recordNativeEvent("opencode", payload);
    if (
      response.status !== 200 ||
      !isObject(payload) ||
      payload.healthy !== true ||
      typeof payload.version !== "string" ||
      payload.version.length === 0
    ) {
      throw failure("initialize", "handshake", new Error("unhealthy server"));
    }
  }

  async #acquireWorkspace(workspacePath: string): Promise<WorkspaceEventStream> {
    let stream = this.#workspaces.get(workspacePath);
    if (!stream) {
      stream = new WorkspaceEventStream(
        workspacePath,
        this.#service?.client ?? OpenCode.make({
          baseUrl: this.#requireBaseUrl(),
          headers: { authorization: this.#authorization },
        }),
        this.context,
        () => this.#workspaces.delete(workspacePath),
      );
      this.#workspaces.set(workspacePath, stream);
    }
    try {
      await stream.acquire();
      return stream;
    } catch (error) {
      if (stream.references === 0) this.#workspaces.delete(workspacePath);
      throw error;
    }
  }

  #requireBaseUrl(): string {
    if (!this.#baseUrl) throw harnessCommandFailure("createSession", "OpenCode server is not ready");
    return this.#baseUrl;
  }

  #nextPage(response: Response): string | undefined {
    const link = response.headers.get("link");
    if (link) {
      const next = link.split(",").map((value) => value.trim()).find((value) => /;\s*rel="?next"?/.test(value));
      const match = next === undefined ? undefined : /^<([^>]+)>/.exec(next);
      if (!match) throw protocolFailure("OpenCode Session list Link header is invalid");
      const href = match[1];
      if (href === undefined) throw protocolFailure("OpenCode Session list Link target is missing");
      const base = new URL(this.#requireBaseUrl());
      const target = new URL(href, base);
      if (target.origin !== base.origin) {
        throw protocolFailure("OpenCode Session list next page left the owned server");
      }
      return `${target.pathname}${target.search}`;
    }
    const cursor = response.headers.get("x-next-cursor");
    if (cursor === null) return undefined;
    if (cursor.length === 0) throw protocolFailure("OpenCode Session list cursor is empty");
    return `/session?limit=2147483647&cursor=${encodeURIComponent(cursor)}`;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#requests.abort();
    for (const stream of this.#workspaces.values()) stream.close();
    this.#workspaces.clear();
    await this.#service?.close();
  }
}

interface WorkspaceStreamConnection {
  readonly controller: AbortController;
  readonly ready: Promise<void>;
  resolveReady: (() => void) | undefined;
  rejectReady: ((error: unknown) => void) | undefined;
  connected: boolean;
}

class WorkspaceEventStream {
  readonly #listeners = new Map<string, Set<{
    receive: (event: JsonObject) => void;
    includeDescendants: boolean;
  }>>();
  readonly #parents = new Map<string, string>();
  #references = 0;
  #connection: WorkspaceStreamConnection | undefined;
  #closed = false;

  constructor(
    readonly workspacePath: string,
    readonly client: OpenCodeClient,
    readonly context: LiveHarnessAdapterContext,
    readonly onUnused: () => void,
  ) {}

  get references(): number {
    return this.#references;
  }

  async acquire(): Promise<void> {
    this.#references += 1;
    try {
      await this.ensureConnected();
    } catch (error) {
      this.#references -= 1;
      if (this.#references === 0) this.close();
      throw error;
    }
  }

  async ensureConnected(): Promise<void> {
    if (this.#closed) throw protocolFailure("OpenCode Workspace event stream is closed");
    if (!this.#connection) {
      let resolveReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const connection: WorkspaceStreamConnection = {
        controller: new AbortController(),
        ready,
        resolveReady,
        rejectReady,
        connected: false,
      };
      this.#connection = connection;
      void this.#consume(connection);
    }
    return this.#connection.ready;
  }

  rememberParent(sessionId: string, parentId: string): void {
    const seen = new Set([sessionId]);
    let ancestor: string | undefined = parentId;
    while (ancestor !== undefined) {
      if (seen.has(ancestor)) throw protocolFailure("OpenCode returned a cyclic Session tree");
      seen.add(ancestor);
      ancestor = this.#parents.get(ancestor);
    }
    if (this.#parents.has(sessionId) && this.#parents.get(sessionId) !== parentId) {
      throw protocolFailure("OpenCode changed a Session parent");
    }
    this.#parents.set(sessionId, parentId);
  }

  subscribe(sessionId: string, receive: (event: JsonObject) => void, includeDescendants = false): () => void {
    const listener = { receive, includeDescendants };
    let listeners = this.#listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(sessionId);
    };
  }

  release(): void {
    if (this.#references === 0) return;
    this.#references -= 1;
    if (this.#references === 0) {
      this.close();
      this.onUnused();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const connection = this.#connection;
    this.#connection = undefined;
    connection?.controller.abort();
    if (connection && !connection.connected) {
      connection.rejectReady?.(protocolFailure("OpenCode Workspace event stream closed before readiness"));
    }
    if (connection) {
      connection.resolveReady = undefined;
      connection.rejectReady = undefined;
    }
  }

  async #consume(connection: WorkspaceStreamConnection): Promise<void> {
    const { signal } = connection.controller;
    try {
      for await (const inbound of this.client.event.subscribe({ signal })) {
        const event = asObject(inbound, "OpenCode v2 event");
        if (event.type === "server.heartbeat") continue;
        validateNativeEvent(event);
        const location = isObject(event.location) ? event.location.directory : undefined;
        if (location !== undefined && location !== this.workspacePath) continue;
        await this.context.recordNativeEvent("opencode", redactFormDiagnostic(event));
        if (event.type === "server.connected") {
          if (connection.connected) throw new Error("OpenCode event stream connected more than once");
          connection.connected = true;
          connection.resolveReady?.();
          connection.resolveReady = undefined;
          connection.rejectReady = undefined;
          continue;
        }
        if (event.type === "session.created") {
          const data = asObject(event.data, "OpenCode v2 Session event");
          if (data.parentID !== undefined && location === this.workspacePath) {
            this.rememberParent(requireString(data.sessionID, "OpenCode Session id"),
              requireString(data.parentID, "OpenCode parent Session id"));
          }
        }
        const recipients = this.#captureRecipients(event);
        for (const receive of recipients) receive(event);
      }
      if (!signal.aborted) throw new Error("OpenCode event stream ended");
    } catch (error) {
      if (signal.aborted) return;
      const protocol = protocolFailure(
        error instanceof Error ? error.message : "OpenCode event stream failed",
      );
      if (!connection.connected) connection.rejectReady?.(protocol);
      connection.resolveReady = undefined;
      connection.rejectReady = undefined;
      if (this.#connection === connection) this.#connection = undefined;
      this.#failListeners(protocol.message);
    }
  }

  #failListeners(message: string): void {
    for (const listeners of this.#listeners.values()) {
      for (const listener of [...listeners]) {
        listener.receive({ type: "adapter.protocolError", properties: { message, disconnect: true } });
      }
    }
  }

  #captureRecipients(event: JsonObject): readonly ((event: JsonObject) => void)[] {
    const sessionId = eventSessionId(event);
    if (sessionId === undefined) return [];
    const direct = this.#listeners.get(sessionId);
    const recipients = direct ? [...direct].map(listener => listener.receive) : [];
    let ancestor = this.#parents.get(sessionId);
    while (ancestor !== undefined) {
      const listeners = this.#listeners.get(ancestor);
      if (listeners?.size) recipients.push(...[...listeners]
        .filter(listener => listener.includeDescendants).map(listener => listener.receive));
      ancestor = this.#parents.get(ancestor);
    }
    return recipients;
  }
}

function redactFormDiagnostic(event: JsonObject): JsonObject {
  if (event.type === "form.replied") {
    const data = event.data;
    if (!isObject(data)) return event;
    return { ...event, data: { ...data, ...(data.answer === undefined ? {} : { answer: "[redacted]" }) } };
  }
  if (event.type !== "form.created") return event;
  const data = event.data;
  if (!isObject(data) || !isObject(data.form)) return event;
  const form = data.form;
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const hidden = new Set(fields.flatMap((value) =>
    isObject(value) && value.hidden === true && typeof value.key === "string" ? [value.key] : []));
  return { ...event, data: { ...data, form: { ...form,
    ...(form.metadata === undefined ? {} : { metadata: "[redacted]" }),
    fields: fields.map((value) => {
      if (!isObject(value)) return value;
      const conditions = Array.isArray(value.when) ? value.when.map((entry) =>
        isObject(entry) && typeof entry.key === "string" && hidden.has(entry.key)
          ? { ...entry, value: "[redacted]" } : entry) : value.when;
      return { ...value,
        ...(value.hidden === true && value.default !== undefined ? { default: "[redacted]" } : {}),
        ...(conditions === undefined ? {} : { when: conditions }) };
    }),
  } } };
}

class OpenCodeSession implements AdapterSession {
  #model: string | undefined;
  #effort: string | undefined;
  #closed = false;

  constructor(
    readonly process: OpenCodeProcess,
    readonly stream: WorkspaceEventStream,
    readonly nativeSessionId: string,
    readonly approvalPolicy: AdapterCreateSessionOptions["approvalPolicy"],
    model: string | undefined,
    effort: string | undefined = undefined,
  ) {
    this.#model = model;
    this.#effort = effort;
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

  get modelPair(): { providerID: string; modelID: string } | undefined {
    if (this.#model === undefined) return undefined;
    return parseOpenCodeModel(this.#model);
  }

  get variant(): string | undefined {
    return this.#effort;
  }

  updateModel(providerID: string, modelID: string): void {
    this.#model = `${providerID}/${modelID}`;
  }

  closeAfterStreamFailure(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stream.release();
  }

  startTurn(input: readonly AdapterTurnInput[]): Promise<AdapterTurn> {
    return this.process.startTurn(this, input);
  }

  async setModel(model: string): Promise<void> {
    await this.stream.ensureConnected();
    const selectedModel = await this.process.validateModel(model, "setModel", this.stream.workspacePath);
    // Validation uses a separate HTTP request: the stream may have been lost
    // while that request was pending. Confirm readiness before committing.
    await this.stream.ensureConnected();
    await this.process.selectModel(this.nativeSessionId, selectedModel, undefined, "setModel");
    this.#model = selectedModel;
    this.#effort = undefined;
  }

  async setEffort(effort: string): Promise<void> {
    await this.stream.ensureConnected();
    await this.process.validateEffort(effort, this.#model, "setEffort", this.stream.workspacePath);
    await this.stream.ensureConnected();
    if (this.#model === undefined) throw protocolFailure("OpenCode v2 Effort requires a selected Model");
    await this.process.selectModel(this.nativeSessionId, this.#model, effort, "setEffort");
    this.#effort = effort;
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.stream.release();
    }
    return Promise.resolve();
  }
}

class OpenCodeTurnCapture implements AdapterTurn {
  readonly nativeTurnId = randomUUID();
  readonly #queue = new AsyncQueue<AdapterTurnEvent>();
  readonly #messages = new Map<string, {
    completed: boolean;
    parts: Map<string, { type: "text" | "reasoning"; text: string }>;
    textPartOrder: string[];
  }>();
  readonly #nonAssistantMessageIds = new Set<string>();
  readonly #tools = new Map<string, OpenCodeToolRecord>();
  readonly #toolPartsByMessage = new Map<string, Map<string, string>>();
  readonly #questions = new Map<string, readonly AdapterLegacyQuestionItem[]>();
  readonly #locallyResolvedPermissions = new Set<string>();
  readonly #locallyResolvedQuestions = new Set<string>();
  readonly #usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
  #unsubscribe: (() => void) | undefined;
  #accepted = false;
  #started = false;
  #completedAssistantCount = 0;
  #lastCompletedAssistantText: string | undefined;
  #disposed = false;
  #interrupting = false;
  #pendingInterruptTerminal: {
    readonly type: "session.error" | "session.status";
    readonly properties: JsonObject;
  } | undefined;

  constructor(
    readonly process: OpenCodeProcess,
    readonly session: OpenCodeSession,
  ) {}

  attach(unsubscribe: () => void): void {
    this.#unsubscribe = unsubscribe;
  }

  accept(): void {
    this.#accepted = true;
  }

  receive(event: JsonObject): void {
    if (this.#disposed) return;
    try {
      if (event.type === "adapter.protocolError") {
        const properties = asObject(event.properties, "OpenCode protocol error");
        if (properties.disconnect === true) {
          this.session.closeAfterStreamFailure();
          void this.process.abortTurn(
            this.session.stream.workspacePath,
            this.session.nativeSessionId,
          ).catch(() => undefined);
        }
        this.#push({
          type: "adapter.protocolError",
          message: requireString(properties.message, "OpenCode protocol error message"),
        });
        this.dispose();
        return;
      }
      const properties = asObject(event.properties, "OpenCode event properties");
      if (event.type === "message.updated") {
        const info = asObject(properties.info, "OpenCode message info");
        if (info.sessionID !== this.session.nativeSessionId) return;
        const messageId = requireString(info.id, "OpenCode message id");
        if (info.role === "user") {
          this.#nonAssistantMessageIds.add(messageId);
          const model = asObject(info.model, "OpenCode user model");
          this.session.updateModel(
            requireString(model.providerID, "OpenCode provider id"),
            requireString(model.modelID, "OpenCode model id"),
          );
          if (!this.#started) {
            this.#started = true;
            this.#push({ type: "turn.started" });
          }
          return;
        }
        if (info.role !== "assistant") {
          this.#nonAssistantMessageIds.add(messageId);
          return;
        }
        if (!this.#started) throw new Error("OpenCode Assistant Message preceded the user message");
        let message = this.#messages.get(messageId);
        if (!message) {
          message = { completed: false, parts: new Map(), textPartOrder: [] };
          this.#messages.set(messageId, message);
          this.#push({ type: "assistant.message.started", nativeMessageId: messageId });
        }
        const time = asObject(info.time, "OpenCode Assistant Message time");
        if (time.completed !== undefined && !message.completed) {
          const tokens = asObject(info.tokens, "OpenCode Assistant Message tokens");
          const cache = asObject(tokens.cache, "OpenCode cache tokens");
          // Native tokens describe this model step. Muha usage describes the
          // current Turn; message.completed gates duplicate terminal snapshots.
          this.#usage.inputTokens += requireTokenCount(tokens.input, "input");
          this.#usage.outputTokens += requireTokenCount(tokens.output, "output");
          this.#usage.reasoningTokens += requireTokenCount(tokens.reasoning, "reasoning");
          this.#usage.cachedInputTokens += requireTokenCount(cache.read, "cached input");
          this.#push({
            type: "usage.updated",
            usage: { ...this.#usage },
          });
          message.completed = true;
          this.#completedAssistantCount += 1;
          const text = message.textPartOrder.map((partId) => message?.parts.get(partId)?.text ?? "").join("");
          this.#lastCompletedAssistantText = text;
          this.#push({
            type: "assistant.message.completed",
            nativeMessageId: messageId,
            text,
          });
        }
        return;
      }
      if (event.type === "message.part.updated") {
        this.#receivePartUpdated(properties);
        return;
      }
      if (event.type === "message.part.delta") {
        this.#receivePartDelta(properties);
        return;
      }
      if (event.type === "permission.asked") {
        const nativeRequestId = requireString(properties.id, "OpenCode permission id");
        const permission = requireString(properties.permission, "OpenCode permission name");
        const patterns = requireStringArray(properties.patterns, "OpenCode permission patterns");
        const metadata = asObject(properties.metadata, "OpenCode permission metadata");
        const tool = properties.tool === undefined ? undefined : asObject(properties.tool, "OpenCode permission Tool");
        this.#push({
          type: "approval.requested",
          nativeRequestId,
          title: `OpenCode requests ${permission} permission`,
          ...(patterns.length === 0 ? {} : { description: patterns.join("\n") }),
          ...(tool === undefined ? {} : this.#toolReference(tool, "OpenCode permission Tool")),
          details: { permission, patterns, metadata,
            ...(properties.sessionID === this.session.nativeSessionId ? {} : { nativeSessionId: properties.sessionID }) },
        });
        return;
      }
      if (event.type === "permission.replied") {
        const nativeRequestId = requireString(properties.requestID, "OpenCode permission reply id");
        if (!this.#locallyResolvedPermissions.has(nativeRequestId)) {
          this.#push({ type: "approval.invalidated", nativeRequestId });
        }
        return;
      }
      if (event.type === "question.asked") {
        const nativeRequestId = requireString(properties.id, "OpenCode Question id");
        if (!Array.isArray(properties.questions) || properties.questions.length === 0) {
          throw new Error("OpenCode Question has no items");
        }
        const questions = properties.questions.map(mapOpenCodeQuestionItem);
        assertUniqueQuestionLabels(questions);
        this.#questions.set(nativeRequestId, questions);
        const tool = properties.tool === undefined ? undefined : asObject(properties.tool, "OpenCode Question Tool");
        this.#push({
          type: "question.requested",
          nativeRequestId,
          questions,
          ...(tool === undefined ? {} : this.#toolReference(tool, "OpenCode Question Tool")),
        });
        return;
      }
      if (event.type === "question.replied") {
        const nativeRequestId = requireString(properties.requestID, "OpenCode Question reply id");
        if (this.#locallyResolvedQuestions.has(nativeRequestId)) return;
        const questions = this.#questions.get(nativeRequestId);
        if (!questions) throw new Error("OpenCode replied to an unknown Question");
        this.#push({
          type: "question.answered",
          nativeRequestId,
          answers: mapOpenCodeQuestionAnswers(properties.answers, questions),
        });
        return;
      }
      if (event.type === "question.rejected") {
        const nativeRequestId = requireString(properties.requestID, "OpenCode Question rejection id");
        if (!this.#locallyResolvedQuestions.has(nativeRequestId)) {
          this.#push({ type: "question.dismissed", nativeRequestId });
        }
        return;
      }
      if (event.type === "session.error") {
        if (this.#interrupting) {
          this.#pendingInterruptTerminal ??= { type: "session.error", properties };
          return;
        }
        const nativeError = asObject(properties.error, "OpenCode Session error");
        const nativeData = isObject(nativeError.data) ? nativeError.data : {};
        const nativeMessage = typeof nativeData.message === "string" && nativeData.message.length > 0
          ? nativeData.message
          : typeof nativeError.message === "string" && nativeError.message.length > 0
            ? nativeError.message
            : undefined;
        this.#push({
          type: "turn.failed",
          error: {
            code: "HARNESS_ERROR",
            message: nativeMessage === undefined
              ? "OpenCode Turn failed"
              : `OpenCode Turn failed: ${nativeMessage}`,
            harness: "opencode",
            operation: "startTurn",
            command: "opencode",
            ...(typeof nativeError.name === "string" && nativeError.name.length > 0
              ? { nativeCode: nativeError.name }
              : {}),
            ...(typeof nativeData.isRetryable === "boolean"
              ? { retryable: nativeData.isRetryable }
              : {}),
          },
        });
        this.dispose();
        return;
      }
      if (event.type === "session.status") {
        const status = asObject(properties.status, "OpenCode Session status");
        if (status.type === "idle") {
          if (this.#interrupting) {
            this.#pendingInterruptTerminal ??= { type: "session.status", properties };
            return;
          }
          if (this.#completedAssistantCount === 0) throw new Error("OpenCode became idle before completing output");
          if (this.#lastCompletedAssistantText?.trim().length === 0) {
            this.#push({
              type: "turn.failed",
              error: {
                code: "HARNESS_ERROR",
                message: "OpenCode Turn ended with an empty final message",
                harness: "opencode",
                operation: "startTurn",
                command: "opencode",
                nativeCode: "empty_final_message",
              },
            });
            this.dispose();
            return;
          }
          this.#push({ type: "turn.completed" });
          this.dispose();
        }
      }
    } catch (error) {
      this.#push({
        type: "adapter.protocolError",
        message: error instanceof Error ? error.message : "OpenCode event is invalid",
      });
      this.dispose();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AdapterTurnEvent> {
    return this.#queue[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<void> {
    this.#interrupting = true;
    try {
      await this.process.abortTurn(this.session.stream.workspacePath, this.session.nativeSessionId);
    } catch (error) {
      this.#interrupting = false;
      const pendingTerminal = this.#pendingInterruptTerminal;
      this.#pendingInterruptTerminal = undefined;
      if (pendingTerminal !== undefined && !this.#disposed) {
        this.receive(pendingTerminal);
      }
      throw error;
    }
    this.#interrupting = false;
    this.#pendingInterruptTerminal = undefined;
    if (!this.#disposed) {
      this.#push({ type: "turn.interrupted" });
      this.dispose();
    }
  }

  async respondToApproval(nativeRequestId: string, decision: "allowOnce" | "deny"): Promise<void> {
    this.#locallyResolvedPermissions.add(nativeRequestId);
    try {
      await this.process.respondToPermission(this.session.stream.workspacePath, nativeRequestId, decision);
    } catch (error) {
      this.#locallyResolvedPermissions.delete(nativeRequestId);
      throw error;
    }
  }

  async respondToQuestion(nativeRequestId: string, response: AdapterQuestionResponse): Promise<void> {
    const questions = this.#questions.get(nativeRequestId);
    if (!questions) throw protocolFailure("OpenCode Question response targets an unknown request");
    const nativeResponse = response.action === "dismiss"
      ? response
      : { action: "answer" as const, answers: mapQuestionResponseToOpenCode(response.answers, questions) };
    this.#locallyResolvedQuestions.add(nativeRequestId);
    try {
      await this.process.respondToQuestion(this.session.stream.workspacePath, nativeRequestId, nativeResponse);
    } catch (error) {
      this.#locallyResolvedQuestions.delete(nativeRequestId);
      throw error;
    }
  }

  #receivePartUpdated(properties: JsonObject): void {
    const part = asObject(properties.part, "OpenCode Message Part");
    if (part.sessionID !== this.session.nativeSessionId) return;
    if (part.type === "tool") {
      this.#receiveToolPart(part);
      return;
    }
    if (part.type !== "text" && part.type !== "reasoning") return;
    const messageId = requireString(part.messageID, "OpenCode Part message id");
    if (this.#nonAssistantMessageIds.has(messageId)) return;
    const message = this.#messages.get(messageId);
    if (!message || message.completed) throw new Error("OpenCode Part has no active Assistant Message");
    const partId = requireString(part.id, "OpenCode Part id");
    const fullText = requireString(part.text, "OpenCode Part text", true);
    let state = message.parts.get(partId);
    if (!state) {
      state = { type: part.type, text: "" };
      message.parts.set(partId, state);
      if (part.type === "text") message.textPartOrder.push(partId);
    } else if (state.type !== part.type) {
      throw new Error("OpenCode Part changed type");
    }
    if (!fullText.startsWith(state.text)) throw new Error("OpenCode Part rewrote delivered output");
    const delta = fullText.slice(state.text.length);
    state.text = fullText;
    if (delta.length > 0) this.#push({
      type: part.type === "text" ? "assistant.message.delta" : "assistant.reasoning.delta",
      nativeMessageId: messageId,
      delta,
    });
  }

  #receivePartDelta(properties: JsonObject): void {
    if (properties.sessionID !== this.session.nativeSessionId) return;
    if (properties.field !== "text") return;
    const messageId = requireString(properties.messageID, "OpenCode Part delta message id");
    if (this.#nonAssistantMessageIds.has(messageId)) return;
    const message = this.#messages.get(messageId);
    if (!message || message.completed) throw new Error("OpenCode Part delta has no active Assistant Message");
    const partId = requireString(properties.partID, "OpenCode Part delta id");
    const state = message.parts.get(partId);
    if (!state) throw new Error("OpenCode Part delta preceded Part creation");
    const delta = requireString(properties.delta, "OpenCode Part delta");
    state.text += delta;
    this.#push({
      type: state.type === "text" ? "assistant.message.delta" : "assistant.reasoning.delta",
      nativeMessageId: messageId,
      delta,
    });
  }

  #receiveToolPart(part: JsonObject): void {
    const partId = requireString(part.id, "OpenCode Tool Part id");
    const messageId = requireString(part.messageID, "OpenCode Tool Part message id");
    const callId = requireString(part.callID, "OpenCode Tool Call id");
    const toolName = requireString(part.tool, "OpenCode Tool name");
    const state = asObject(part.state, "OpenCode Tool state");
    const status = requireString(state.status, "OpenCode Tool status");
    let tool = this.#tools.get(partId);
    if (!tool) {
      const byCallId = this.#toolPartsByMessage.get(messageId) ?? new Map<string, string>();
      const associatedPartId = byCallId.get(callId);
      if (associatedPartId !== undefined && associatedPartId !== partId) {
        throw new Error("OpenCode reused a Tool Call id within one Assistant Message");
      }
      byCallId.set(callId, partId);
      this.#toolPartsByMessage.set(messageId, byCallId);
      tool = {
        messageId,
        callId,
        toolName,
        completed: false,
        running: false,
        started: false,
        terminalState: undefined,
      };
      this.#tools.set(partId, tool);
    } else if (
      tool.messageId !== messageId ||
      tool.callId !== callId ||
      tool.toolName !== toolName
    ) {
      throw new Error("OpenCode Tool Part identity changed");
    }
    if (tool.completed) {
      const terminal = this.#terminalToolState(status, state);
      if (terminal !== undefined && isDeepStrictEqual(tool.terminalState, state)) return;
      throw new Error("OpenCode updated a completed Tool Call");
    }
    if (status === "pending") {
      if (tool.started) throw new Error("OpenCode Tool Call returned to pending");
      return;
    }
    if (!tool.started) {
      tool.started = true;
      this.#push({
        type: "tool.started",
        nativeToolCallId: partId,
        toolName,
        input: asObject(state.input, "OpenCode Tool input"),
      });
    }
    if (status === "running") {
      if (tool.running) this.#push({
        type: "tool.updated",
        nativeToolCallId: partId,
        update: {
          status: "running",
          ...(state.title === undefined ? {} : { title: state.title }),
          ...(state.metadata === undefined ? {} : { metadata: state.metadata }),
        },
      });
      tool.running = true;
      return;
    }
    if (status === "completed" || status === "error") {
      const terminal = this.#terminalToolState(status, state)!;
      tool.completed = true;
      tool.terminalState = state;
      this.#push({
        type: "tool.completed",
        nativeToolCallId: partId,
        ...terminal,
      });
      return;
    }
    throw new Error("OpenCode Tool status is unsupported");
  }

  #terminalToolState(
    status: string,
    state: JsonObject,
  ): { readonly output: unknown; readonly isError: boolean } | undefined {
    if (status === "completed") return { output: state.output ?? null, isError: false };
    if (status === "error") return { output: state.error ?? null, isError: true };
    return undefined;
  }

  #toolReference(tool: JsonObject, label: string): { readonly nativeToolCallId?: string } {
    const messageId = requireString(tool.messageID, `${label} message id`);
    const callId = requireString(tool.callID, `${label} Call id`);
    const partId = this.#toolPartsByMessage.get(messageId)?.get(callId);
    if (partId === undefined || this.#tools.get(partId)?.started !== true) return {};
    return { nativeToolCallId: partId };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#queue.end();
  }

  #push(event: AdapterTurnEvent): void {
    if (!this.#accepted && event.type !== "adapter.protocolError") {
      // Native events may race ahead of the 204 response. Buffering in the
      // queue is safe; Core cannot consume this capture until accept returns.
    }
    this.#queue.push(event);
  }
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

export function mapOpenCodeQuestionItem(value: unknown): AdapterLegacyQuestionItem {
  const item = asObject(value, "OpenCode Question item");
  const header = requireString(item.header, "OpenCode Question header", true);
  const question = requireString(item.question, "OpenCode Question text");
  if (!Array.isArray(item.options)) throw new Error("OpenCode Question options must be an array");
  const options = item.options.map((value) => {
    const option = asObject(value, "OpenCode Question option");
    const description = requireString(option.description, "OpenCode Question option description", true);
    return {
      label: requireString(option.label, "OpenCode Question option label"),
      ...(description.length === 0 ? {} : { description }),
    };
  });
  return {
    ...(header.length === 0 ? {} : { header }),
    question,
    options,
    multiple: item.multiple === true,
    allowCustom: item.custom !== false,
  };
}

export function assertUniqueQuestionLabels(questions: readonly AdapterLegacyQuestionItem[]): void {
  for (const question of questions) {
    const labels = new Set<string>();
    for (const option of question.options) {
      if (labels.has(option.label)) throw new Error("OpenCode Question option labels must be unique");
      labels.add(option.label);
    }
  }
}

export function mapOpenCodeQuestionAnswers(
  value: unknown,
  questions: readonly AdapterLegacyQuestionItem[],
): readonly AdapterQuestionAnswer[] {
  if (!Array.isArray(value) || value.length !== questions.length) {
    throw new Error("OpenCode Question reply must answer every item");
  }
  return value.map((answer, questionIndex) => {
    if (!Array.isArray(answer) || answer.some((entry) => typeof entry !== "string")) {
      throw new Error("OpenCode Question answer must be a string array");
    }
    const question = questions[questionIndex]!;
    const optionIndexes: number[] = [];
    const custom: string[] = [];
    for (const entry of answer as string[]) {
      const optionIndex = question.options.findIndex(({ label }) => label === entry);
      if (optionIndex >= 0) optionIndexes.push(optionIndex);
      else custom.push(entry);
    }
    if (custom.length > 1) throw new Error("OpenCode Question returned multiple custom answers");
    if (optionIndexes.length === 0 && custom.length === 0) return { questionIndex, kind: "skipped" };
    if (optionIndexes.length === 0) return { questionIndex, kind: "custom", text: custom[0]! };
    if (custom.length === 0) return { questionIndex, kind: "options", optionIndexes };
    return { questionIndex, kind: "optionsWithCustom", optionIndexes, text: custom[0]! };
  });
}

export function mapQuestionResponseToOpenCode(
  answers: readonly AdapterQuestionAnswer[],
  questions: readonly AdapterLegacyQuestionItem[],
): readonly string[][] {
  return answers.map((answer) => {
    const question = questions[answer.questionIndex];
    if (!question) throw protocolFailure("OpenCode Question answer index is invalid");
    if (answer.kind === "skipped") return [];
    if (answer.kind === "custom") return [answer.text];
    if (answer.kind !== "options" && answer.kind !== "optionsWithCustom") {
      throw protocolFailure("OpenCode Question answer kind is unsupported");
    }
    const labels = answer.optionIndexes.map((index) => {
      const option = question.options[index];
      if (!option) throw protocolFailure("OpenCode Question option index is invalid");
      return option.label;
    });
    return answer.kind === "options" ? labels : [...labels, answer.text];
  });
}

async function validateSession(
  value: unknown,
  workspacePath: string,
): Promise<{ id: string; title?: string; createdAt?: string; updatedAt?: string }> {
  if (!isObject(value)) throw protocolFailure("OpenCode Session response must be an object");
  const session = value;
  if (typeof session.id !== "string" || session.id.length === 0) {
    throw protocolFailure("OpenCode Session id must be a non-empty string");
  }
  const id = session.id;
  const directory = isObject(session.location) ? session.location.directory : session.directory;
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw protocolFailure("OpenCode Session directory must be an absolute path");
  }
  let nativeWorkspacePath: string;
  try {
    nativeWorkspacePath = await realpath(directory);
  } catch {
    throw protocolFailure("OpenCode Session directory cannot be canonicalized");
  }
  if (nativeWorkspacePath !== workspacePath) {
    throw protocolFailure("OpenCode Session belongs to a different Workspace");
  }
  const title = typeof session.title === "string" && session.title.length > 0
    ? session.title
    : undefined;
  if (session.title !== undefined && typeof session.title !== "string") {
    throw protocolFailure("OpenCode Session title must be a string");
  }
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  if (session.time !== undefined) {
    const time = asObjectProtocol(session.time, "OpenCode Session time");
    if (time.created !== undefined) createdAt = unixMillisecondsToRfc3339(time.created, "created");
    if (time.updated !== undefined) updatedAt = unixMillisecondsToRfc3339(time.updated, "updated");
  }
  return {
    id,
    ...(title === undefined ? {} : { title }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

async function validateListedSession(
  value: unknown,
  workspacePath: string,
): Promise<Awaited<ReturnType<typeof validateSession>> | undefined> {
  if (!isObject(value)) throw protocolFailure("OpenCode Session response must be an object");
  const directory = isObject(value.location) ? value.location.directory : value.directory;
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw protocolFailure("OpenCode Session directory must be an absolute path");
  }
  let nativeWorkspacePath: string;
  try {
    nativeWorkspacePath = await realpath(directory);
  } catch {
    if (directory === workspacePath) {
      throw protocolFailure("OpenCode Session directory cannot be canonicalized");
    }
    return undefined;
  }
  if (nativeWorkspacePath !== workspacePath) return undefined;
  return validateSession(value, workspacePath);
}

async function mapTurnInput(input: AdapterTurnInput): Promise<JsonObject> {
  if (input.type === "text") return { type: "text", text: input.text };
  if (input.source.type === "base64") {
    return {
      type: "file",
      mime: input.source.mediaType,
      url: `data:${input.source.mediaType};base64,${input.source.data}`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(input.source.path);
  } catch {
    throw harnessCommandFailure("startTurn", "OpenCode image file became unreadable", "image_unreadable");
  }
  const mime = detectImageMediaType(bytes);
  if (mime === undefined) {
    throw harnessCommandFailure("startTurn", "OpenCode image file changed after validation", "image_invalid");
  }
  return {
    type: "file",
    mime,
    filename: basename(input.source.path),
    url: pathToFileURL(input.source.path).href,
  };
}

function detectImageMediaType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
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

function parseOpenCodeModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (model !== model.trim() || slash <= 0 || slash === model.length - 1) {
    throw new MuhaError({
      code: "INVALID_INPUT",
      message: "OpenCode model must be a providerID/modelID pair without outer whitespace",
    });
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function toV2ModelRef(
  model: string,
  effort: string | undefined,
): { readonly providerID: string; readonly id: string; readonly variant?: string } {
  const pair = parseOpenCodeModel(model);
  return {
    providerID: pair.providerID,
    id: pair.modelID,
    ...(effort === undefined ? {} : { variant: effort }),
  };
}

function assertSelectedV2Model(value: unknown, model: string, effort: string | undefined): void {
  const info = asObjectProtocol(value, "OpenCode v2 Session");
  const actual = asObjectProtocol(info.model, "OpenCode v2 selected Model");
  const expected = toV2ModelRef(model, effort);
  if (
    actual.providerID !== expected.providerID ||
    actual.id !== expected.id ||
    (effort !== undefined && actual.variant !== effort)
  ) throw protocolFailure("OpenCode v2 selected a different Model or Effort");
}

function selectedV2Model(value: unknown): { readonly model: string; readonly effort?: string } | undefined {
  const session = asObjectProtocol(value, "OpenCode v2 Session");
  if (session.model === undefined || session.model === null) return undefined;
  const selected = asObjectProtocol(session.model, "OpenCode v2 selected Model");
  const providerID = requireProtocolString(selected.providerID, "OpenCode v2 selected provider");
  const id = requireProtocolString(selected.id, "OpenCode v2 selected Model id");
  const effort = selected.variant;
  if (effort !== undefined && (typeof effort !== "string" || effort.length === 0)) {
    throw protocolFailure("OpenCode v2 selected Variant is invalid");
  }
  return { model: joinOpenCodeModel(providerID, id),
    ...(effort === undefined ? {} : { effort: effort as string }) };
}

function joinOpenCodeModel(providerID: string, modelID: string): string {
  const value = `${providerID}/${modelID}`;
  if (
    providerID.length === 0 ||
    providerID.includes("/") ||
    modelID.length === 0 ||
    value !== value.trim()
  ) {
    throw protocolFailure("OpenCode Session model pair cannot be encoded losslessly");
  }
  return value;
}

function asObjectProtocol(value: unknown, description: string): JsonObject {
  if (!isObject(value)) throw protocolFailure(`${description} must be an object`);
  return value;
}

function requireProtocolString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw protocolFailure(`${description} must be a non-empty string`);
  }
  return value;
}

function unixMillisecondsToRfc3339(value: unknown, description: string): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolFailure(`OpenCode Session ${description} time must be milliseconds`);
  }
  try {
    return new Date(value as number).toISOString();
  } catch {
    throw protocolFailure(`OpenCode Session ${description} time is out of range`);
  }
}

function validateNativeEvent(event: JsonObject): void {
  requireString(event.type, "OpenCode event type");
  asObject(event.data, "OpenCode v2 event data");
}

function eventSessionId(event: JsonObject): string | undefined {
  if (!isObject(event.data)) return undefined;
  if (typeof event.data.sessionID === "string") return event.data.sessionID;
  if (isObject(event.data.form) && typeof event.data.form.sessionID === "string") return event.data.form.sessionID;
  return undefined;
}

function v2Permissions(policy: AdapterCreateSessionOptions["approvalPolicy"]):
  readonly { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }[] | undefined {
  if (policy === "harnessManaged") return undefined;
  return [{ action: "*", resource: "*", effect: policy === "autoApprove" ? "allow" :
    policy === "autoDeny" ? "deny" : "ask" }];
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

function requireStringArray(value: unknown, description: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid ${description}`);
  }
  return value;
}

function requireTokenCount(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid OpenCode ${description} token count`);
  }
  return value as number;
}

function protocolFailure(message: string): {
  readonly code: "ADAPTER_PROTOCOL_ERROR";
  readonly message: string;
  readonly harness: "opencode";
} {
  return { code: "ADAPTER_PROTOCOL_ERROR", message, harness: "opencode" };
}

function harnessCommandFailure(
  operation: HarnessErrorData["operation"],
  message: string,
  nativeCode?: string,
): HarnessErrorData {
  return {
    code: "HARNESS_ERROR",
    message,
    harness: "opencode",
    operation,
    command: "opencode",
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
  error: unknown,
): HarnessErrorData {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return {
    code: "HARNESS_ERROR",
    message: `OpenCode ${stage} failed${detail}`,
    harness: "opencode",
    operation,
    command: "opencode",
    stage,
  };
}

function isEventStoreError(error: unknown): boolean {
  return isObject(error) && error.code === "EVENT_STORE_ERROR";
}
