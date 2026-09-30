import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { HarnessErrorData, OfficialAdapterOptions } from "@muha-sdk/core";
import {
  AcpSessionDriver,
  type AcpSessionIdentity,
  type AcpTurnSupplement,
  type AdapterCreateSessionOptions,
  type AdapterLegacyQuestionItem,
  type AdapterQuestionResponse,
  type AdapterResumeSessionOptions,
  type AdapterTurnEvent,
  type AdapterTurnUsage,
  type LiveHarnessAdapter,
  type LiveHarnessAdapterContext,
} from "@muha-sdk/core/internal";
import {
  OpenCodeProcess, assertUniqueQuestionLabels, mapOpenCodeQuestionAnswers,
  mapOpenCodeQuestionItem, mapQuestionResponseToOpenCode,
} from "./opencode-process.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown, label: string): ObjectValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw protocol(`${label} must be an object`);
  return value as ObjectValue;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw protocol(`${label} must be a nonempty string`);
  return value;
};
const protocol = (message: string) => ({ code: "ADAPTER_PROTOCOL_ERROR", harness: "opencode", message } as const);

/** One owned OpenCode process: ACP executes; its authenticated native listener
 * supplies only the missing semantic data and Question/descendant replies.
 * The launch seam is repository-private, never an OfficialAdapterOptions field.
 */
export class OpenCodeAcpProcess implements LiveHarnessAdapter {
  readonly kind = "opencode" as const;
  readonly route = "combined" as const;
  readonly resumeRoutes = Object.freeze(["combined", "native"] as const);
  #driver: AcpSessionDriver | undefined;
  #native: OpenCodeProcess | undefined;
  #nativeRoute: OpenCodeProcess | undefined;
  #nativeRouteReady: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #startup = new AbortController();

  constructor(
    readonly options: OfficialAdapterOptions,
    readonly context: LiveHarnessAdapterContext,
    readonly launch = { command: "opencode", prefix: [] as readonly string[] },
  ) {}

  async initialize(): Promise<void> {
    if (this.#closePromise) throw protocol("OpenCode ACP Driver is closed");
    const port = await reservePort();
    if (this.#closePromise) throw protocol("OpenCode ACP Driver closed during initialization");
    const password = randomBytes(32).toString("base64url");
    const baseUrl = `http://127.0.0.1:${port}`;
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const native = new OpenCodeProcess(this.options, this.context, { baseUrl, authorization });
    const driver = new AcpSessionDriver("opencode", {
      command: this.launch.command,
      args: [...this.launch.prefix, "acp", "--hostname", "127.0.0.1", "--port", String(port), "--no-mdns"],
      env: { ...this.options.env, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password, OPENCODE_ENABLE_QUESTION_TOOL: "true" },
      ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
      ...(this.options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: this.options.shutdownTimeoutMs }),
    }, this.context, {
      effortConfigId: "effort",
      // Host file/terminal methods are not advertised. OpenCode executes its
      // own tools, preserving their native permission and filesystem behavior.
      configureSession: async identity => {
        const reader = await native.resumeSession(identity);
        await reader.close();
      },
      openTurn: (identity, publish) => OpenCodeSupplement.open(native, identity, publish),
    });
    this.#native = native;
    this.#driver = driver;
    const timer = setTimeout(() => {
      this.#startup.abort();
      // The attached HTTP client has its own request controller. Reclaiming
      // both halves also preempts a hung authenticated health response.
      void this.close().catch(() => {});
    }, this.options.startupTimeoutMs ?? 60_000);
    try {
      await driver.initialize();
      // A port reservation alone does not prove ownership: require rejection
      // without our per-process secret, then a valid authenticated handshake.
      const denied = await fetch(`${baseUrl}/global/health`, { signal: this.#startup.signal });
      await denied.body?.cancel();
      if (denied.status !== 401) throw protocol("OpenCode ACP native listener does not enforce owned authentication");
      await native.initialize();
      this.#requireDriver();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }
  }

  createSession(options: AdapterCreateSessionOptions) { return this.#requireDriver().createSession(options); }
  async resumeSession(options: AdapterResumeSessionOptions) {
    this.#requireDriver();
    if (options.route === "native") {
      // Dispatch before execution according to the validated Reference. A
      // failed ACP operation never reaches or initializes this native path.
      if (!this.#nativeRoute) {
        this.#nativeRoute = new OpenCodeProcess(this.options, this.context);
        this.#nativeRouteReady = this.#nativeRoute.initialize();
      }
      await this.#nativeRouteReady;
      this.#requireDriver();
      return this.#nativeRoute.resumeSession(options);
    }
    if (options.route !== undefined && options.route !== "combined") throw protocol("Unsupported OpenCode Reference route");
    // Native read-only preflight checks identity/Workspace before ACP load can
    // bind it, retaining the established not-found error classification.
    const reader = await this.#native!.resumeSession(options);
    await reader.close();
    return this.#requireDriver().resumeSession(options);
  }
  listSessions(workspacePath: string) { return this.#requireDriver().listSessions(workspacePath); }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#startup.abort();
    this.#closePromise = (async () => {
      // Abort pending native reads before reclaiming the shared process.
      const results = await Promise.allSettled([this.#native?.close(), this.#nativeRoute?.close(), this.#driver?.close()]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    })();
    return this.#closePromise;
  }

  #requireDriver(): AcpSessionDriver {
    if (!this.#driver || this.#closePromise) throw protocol("OpenCode ACP Driver is not available");
    return this.#driver;
  }
}

class OpenCodeSupplement implements AcpTurnSupplement {
  readonly #questions = new Map<string, readonly AdapterLegacyQuestionItem[]>();
  readonly #locallyAnswered = new Set<string>();
  readonly #permissions = new Set<string>();
  readonly #locallyDecided = new Set<string>();
  readonly #baseline = new Set<string>();
  #unsubscribe: (() => void) | undefined;
  #closed = false;
  #started = false;
  #failure: HarnessErrorData | undefined;
  #incoming = Promise.resolve();
  #resolveIdle!: () => void;
  readonly #idle = new Promise<void>(resolve => { this.#resolveIdle = resolve; });

  private constructor(
    readonly native: OpenCodeProcess,
    readonly session: AcpSessionIdentity,
    readonly publish: (event: AdapterTurnEvent) => Promise<void>,
  ) {}

  static async open(native: OpenCodeProcess, session: AcpSessionIdentity, publish: (event: AdapterTurnEvent) => Promise<void>): Promise<OpenCodeSupplement> {
    const supplement = new OpenCodeSupplement(native, session, publish);
    // Snapshot history before the sole ACP prompt is submitted. Replayed/late
    // known messages cannot count toward this Turn's usage or start barrier.
    for (const message of await supplement.#messages()) supplement.#baseline.add(text(object(message.info, "message info").id, "message id"));
    supplement.#unsubscribe = await native.observeSession(session, event => {
      if (supplement.#closed) return;
      if (event.type === "adapter.protocolError") {
        // A broken observer cannot be queued behind a Question waiting on the
        // other channel. All earlier native payloads were already committed.
        void publish({ type: "adapter.protocolError", message: text(object(event.properties, "stream failure").message, "stream failure") });
        supplement.#resolveIdle();
        return;
      }
      supplement.#incoming = supplement.#incoming.then(() => supplement.#receive(event)).catch(async error => {
        await publish({ type: "adapter.protocolError", message: typeof error?.message === "string" ? error.message : "OpenCode native supplement failed" });
        supplement.#resolveIdle();
      });
    });
    return supplement;
  }

  async tool(update: Parameters<NonNullable<AcpTurnSupplement["tool"]>>[0]) {
    for (const message of await this.#messages()) {
      if (this.#baseline.has(text(object(message.info, "message info").id, "message id"))) continue;
      if (!Array.isArray(message.parts)) throw protocol("OpenCode message parts must be an array");
      for (const value of message.parts) {
        const part = object(value, "message part");
        if (part.type !== "tool" || part.callID !== update.toolCallId) continue;
        const state = object(part.state, "tool state");
        return { name: text(part.tool, "tool name"), input: object(state.input, "tool input"),
          ...(state.status === "completed" ? { output: state.output ?? null } : state.status === "error" ? { output: state.error ?? null } : {}) };
      }
    }
    throw protocol("OpenCode ACP tool has no matching native Tool Part in this Turn");
  }

  async settle(result: Parameters<NonNullable<AcpTurnSupplement["settle"]>>[0]): Promise<{ usage?: AdapterTurnUsage; failure?: HarnessErrorData }> {
    return this.#settle(result.stopReason !== "cancelled");
  }

  async settleFailure(): Promise<{ usage?: AdapterTurnUsage; failure?: HarnessErrorData }> {
    // A rejection before execution has no idle event. A post-execution RPC
    // failure does: query the same native Session to distinguish these even
    // when the SSE observation is behind the ACP response.
    const started = this.#started || (await this.#messages()).some(message => {
      const info = object(message.info, "message info");
      return info.role === "user" && !this.#baseline.has(text(info.id, "message id"));
    });
    return started ? this.#settle(false) : {};
  }

  async #settle(checkFinalMessage: boolean): Promise<{ usage?: AdapterTurnUsage; failure?: HarnessErrorData }> {
    // ACP and SSE are separate channels. ACP's idle barrier does not mean our
    // native payloads have committed yet; wait for this observer's barrier too.
    await this.#idle;
    await this.#incoming;
    if (this.#closed) return {};
    const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
    let steps = 0;
    let finalText: string | undefined;
    const seen = new Set<string>();
    for (const message of await this.#messages()) {
      const info = object(message.info, "message info");
      const id = text(info.id, "message id");
      if (this.#baseline.has(id) || seen.has(id) || info.role !== "assistant") continue;
      seen.add(id);
      if (object(info.time, "message time").completed === undefined) continue;
      if (!Array.isArray(message.parts)) throw protocol("OpenCode completed message parts must be an array");
      finalText = message.parts.map(value => {
        const part = object(value, "message part");
        if (part.type !== "text") return "";
        if (typeof part.text !== "string") throw protocol("OpenCode text part must contain text");
        return part.text;
      }).join("");
      const tokens = object(info.tokens, "message tokens");
      const cache = object(tokens.cache, "token cache");
      usage.inputTokens += count(tokens.input);
      usage.outputTokens += count(tokens.output);
      usage.reasoningTokens += count(tokens.reasoning);
      usage.cachedInputTokens += count(cache.read);
      steps++;
    }
    // A native rejection may end after a tool-only assistant step, without a
    // session.error or ACP text chunk. Preserve the existing native contract,
    // rather than letting Core misclassify the missing final message.
    if (checkFinalMessage && finalText !== undefined && finalText.trim().length === 0) {
      this.#failure ??= { code: "HARNESS_ERROR", harness: "opencode", command: "opencode", operation: "startTurn",
        message: "OpenCode Turn ended with an empty final message", nativeCode: "empty_final_message" };
    }
    return { ...(steps === 0 ? {} : { usage }), ...(this.#failure === undefined ? {} : { failure: this.#failure }) };
  }

  async respondToQuestion(id: string, response: AdapterQuestionResponse): Promise<void> {
    const questions = this.#questions.get(id);
    if (!questions || this.#closed) throw protocol("OpenCode Question response targets an inactive request");
    this.#locallyAnswered.add(id);
    try {
      await this.native.respondToQuestion(this.session.workspacePath, id, response.action === "dismiss" ? response
        : { action: "answer", answers: mapQuestionResponseToOpenCode(response.answers, questions) });
    } catch (error) { this.#locallyAnswered.delete(id); throw error; }
  }

  async respondToApproval(id: string, decision: "allowOnce" | "deny"): Promise<boolean> {
    if (!this.#permissions.has(id)) return false; // Root permissions belong to ACP.
    if (this.#closed) throw protocol("OpenCode permission targets an inactive Turn");
    this.#locallyDecided.add(id);
    try { await this.native.respondToPermission(this.session.workspacePath, id, decision); }
    catch (error) { this.#locallyDecided.delete(id); throw error; }
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#resolveIdle();
  }

  async #messages(): Promise<ObjectValue[]> {
    const value = await this.native.requestJson("GET", `/session/${encodeURIComponent(this.session.nativeSessionId)}/message`, "startTurn", this.session.workspacePath);
    if (!Array.isArray(value)) throw protocol("OpenCode Session messages must be an array");
    return value.map(message => object(message, "message"));
  }

  async #receive(event: ObjectValue): Promise<void> {
    if (this.#closed) return;
    const properties = object(event.properties, "event properties");
    if (event.type === "adapter.protocolError") throw protocol(text(properties.message, "stream failure"));
    if (event.type === "message.updated") {
      const info = object(properties.info, "message info");
      if (info.role === "user" && !this.#baseline.has(text(info.id, "message id"))) this.#started = true;
      return;
    }
    if (!this.#started) return;
    if (event.type === "permission.asked" || event.type === "permission.replied") {
      // ACP's permission bridge only knows the root ACP Session. The existing
      // native observer routes descendants only for the current autoApprove
      // Session tree; unrelated Sessions are not delivered here.
      if (properties.sessionID === this.session.nativeSessionId) return;
      if (this.session.approvalPolicy !== "autoApprove") throw protocol("Unexpected descendant permission delivery");
      const id = text(event.type === "permission.asked" ? properties.id : properties.requestID, "permission id");
      if (event.type === "permission.replied") {
        if (this.#permissions.has(id) && !this.#locallyDecided.has(id)) await this.publish({ type: "approval.invalidated", nativeRequestId: id });
        return;
      }
      if (this.#permissions.has(id)) throw protocol("Duplicate native permission request");
      this.#permissions.add(id);
      const name = text(properties.permission, "permission name");
      await this.publish({ type: "approval.requested", nativeRequestId: id, title: `OpenCode requests ${name} permission`, details: properties });
      return;
    }
    if (event.type === "session.status" && object(properties.status, "status").type === "idle") { this.#resolveIdle(); return; }
    if (event.type === "session.error") {
      const error = object(properties.error, "Session error");
      const data = error.data === undefined ? {} : object(error.data, "error data");
      this.#failure = { code: "HARNESS_ERROR", harness: "opencode", command: "opencode", operation: "startTurn",
        message: typeof data.message === "string" ? data.message : "OpenCode Turn failed",
        ...(typeof error.name === "string" ? { nativeCode: error.name } : {}),
        ...(typeof data.isRetryable === "boolean" ? { retryable: data.isRetryable } : {}) };
      return;
    }
    if (event.type === "question.asked") {
      const id = text(properties.id, "Question id");
      if (!Array.isArray(properties.questions) || properties.questions.length === 0) throw protocol("OpenCode Question has no items");
      const questions = properties.questions.map(mapOpenCodeQuestionItem);
      assertUniqueQuestionLabels(questions);
      this.#questions.set(id, questions);
      const tool = properties.tool === undefined ? undefined : object(properties.tool, "Question tool");
      await this.publish({ type: "question.requested", nativeRequestId: id, questions,
        ...(tool === undefined || properties.sessionID !== this.session.nativeSessionId ? {} : { nativeToolCallId: text(tool.callID, "Question tool call id") }) });
    } else if (event.type === "question.replied" || event.type === "question.rejected") {
      const id = text(properties.requestID, "Question reply id");
      if (this.#locallyAnswered.has(id)) return;
      const questions = this.#questions.get(id);
      if (!questions) throw protocol("OpenCode replied to an unknown Question");
      await this.publish(event.type === "question.rejected" ? { type: "question.dismissed", nativeRequestId: id }
        : { type: "question.answered", nativeRequestId: id, answers: mapOpenCodeQuestionAnswers(properties.answers, questions) });
    }
  }
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw protocol("Invalid OpenCode token count");
  return value;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw protocol("Cannot reserve native listener port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
