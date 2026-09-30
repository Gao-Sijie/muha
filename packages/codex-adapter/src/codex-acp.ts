import { realpath } from "node:fs/promises";
import type { HarnessErrorData, OfficialAdapterOptions } from "@muha-sdk/core";
import {
  AcpSessionDriver, type AcpSessionIdentity, type AcpTurnSupplement,
  type AdapterCreateSessionOptions, type AdapterResumeSessionOptions, type AdapterTurnEvent,
  type LiveHarnessAdapter, type LiveHarnessAdapterContext,
} from "@muha-sdk/core/internal";
import { CodexNativeObserver } from "./codex-observer.js";
import type { NativeObject } from "./codex-observer-wire.js";
import { CodexProcess, mapToolCompleted, mapToolStarted, readPortableUsage, subtractUsage } from "./codex-process.js";
import { decodeCodexAcpQuestion } from "./acp-question.js";
import { resolvePinnedCodexBridge } from "./codex-bridge.js";

function object(value: unknown, label: string): NativeObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw protocol(`${label} must be an object`);
  return value as NativeObject;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw protocol(`${label} must be a nonempty string`);
  return value;
}
function protocol(message: string) { return { code: "ADAPTER_PROTOCOL_ERROR", harness: "codex", message } as const; }

/** ACP is the only executor; the observer commits native semantics before the
 * unmodified third-party bridge sees them, so Tool data is never guessed from
 * display text and cumulative usage is never inferred from last-step usage. */
export class CodexAcpProcess implements LiveHarnessAdapter {
  readonly kind = "codex" as const;
  readonly route = "combined" as const;
  readonly resumeRoutes = Object.freeze(["combined", "native"] as const);
  readonly #sessions = new Map<string, NativeObject>();
  readonly #turns = new Map<string, CodexSupplement>();
  readonly #observer: CodexNativeObserver;
  #driver: AcpSessionDriver | undefined;
  #nativeRoute: CodexProcess | undefined;
  #nativeRouteReady: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(
    readonly options: OfficialAdapterOptions,
    readonly context: LiveHarnessAdapterContext,
    readonly launch?: { readonly command: string; readonly prefix: readonly string[] },
  ) {
    this.#observer = new CodexNativeObserver(context, (message, requestMethod) => {
      const params = typeof message.params === "object" && message.params !== null ? message.params as NativeObject : {};
      const turn = typeof params.threadId === "string" ? this.#turns.get(params.threadId) : undefined;
      return async () => {
        if ((requestMethod === "thread/start" || requestMethod === "thread/resume") && message.result !== undefined) {
          const result = object(message.result, "native Session result");
          const thread = object(result.thread, "native Thread");
          this.#sessions.set(text(thread.id, "native Thread ID"), thread);
        }
        await turn?.receive(message);
      };
    }, descriptor => {
      const turn = typeof descriptor.threadId === "string" ? this.#turns.get(descriptor.threadId) : undefined;
      if (!turn) throw protocol("Codex bridge attempted execution without the owning ACP Session");
      turn.verifyExecution(descriptor);
    });
  }

  async initialize(): Promise<void> {
    try {
      if (this.#closePromise) throw protocol("Codex ACP Driver is closed");
      const launch = this.launch ?? await resolvePinnedCodexBridge(this.options.env ?? {});
      if (this.#closePromise) throw protocol("Codex ACP Driver closed during initialization");
      const environment = await this.#observer.open(this.options.env ?? {});
      if (this.#closePromise) throw protocol("Codex ACP Driver closed during initialization");
      const driver = new AcpSessionDriver("codex", {
        command: launch.command, args: launch.prefix, env: environment,
        ...(this.options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.options.startupTimeoutMs }),
        ...(this.options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: this.options.shutdownTimeoutMs }),
      }, this.context, {
        effortConfigId: "reasoning_effort",
        clientCapabilities: { elicitation: { form: {} } },
        decodeQuestion: decodeCodexAcpQuestion,
        configureSession: async session => {
          const thread = this.#sessions.get(session.nativeSessionId);
          if (!thread || await realpath(text(thread.cwd, "native Thread Workspace")) !== session.workspacePath) throw protocol("Codex ACP/native Session identity does not match its Workspace");
          await driver.request("session/set_mode", { sessionId: session.nativeSessionId,
            modeId: session.approvalPolicy === "autoApprove" ? "agent-full-access" : "read-only" }, "createSession");
        },
        openTurn: async (session, publish) => {
          if (this.#turns.has(session.nativeSessionId)) throw protocol("Codex Session already has an execution owner");
          const turn = new CodexSupplement(session, publish, () => this.#turns.delete(session.nativeSessionId));
          this.#turns.set(session.nativeSessionId, turn);
          return turn;
        },
      });
      this.#driver = driver;
      await driver.initialize();
      this.#requireDriver();
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }

  createSession(options: AdapterCreateSessionOptions) { return this.#requireDriver().createSession(options); }
  async resumeSession(options: AdapterResumeSessionOptions) {
    this.#requireDriver();
    if (options.route === "native") {
      // Reference dispatch is determined before any execution. ACP errors
      // never initialize or retry a prompt through this alternate path.
      if (!this.#nativeRoute) {
        this.#nativeRoute = new CodexProcess(this.options, this.context);
        this.#nativeRouteReady = this.#nativeRoute.initialize();
      }
      await this.#nativeRouteReady;
      this.#requireDriver();
      return this.#nativeRoute.resumeSession(options);
    }
    if (options.route !== undefined && options.route !== "combined") throw protocol("Unsupported Codex Reference route");
    return this.#requireDriver().resumeSession(options);
  }
  listSessions(workspacePath: string) { return this.#requireDriver().listSessions(workspacePath); }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      // Mark the observer intentional-close before the owned native tree exits.
      const results = await Promise.allSettled([this.#observer.close(), this.#nativeRoute?.close(), this.#driver?.close()]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    })();
    return this.#closePromise;
  }

  #requireDriver(): AcpSessionDriver {
    if (!this.#driver || this.#closePromise) throw protocol("Codex ACP Driver is not available");
    return this.#driver;
  }
}

class CodexSupplement implements AcpTurnSupplement {
  readonly #items = new Map<string, { started?: NativeObject; completed?: NativeObject }>();
  readonly #itemWaiters = new Map<string, () => void>();
  #nativeTurnId: string | undefined;
  #baseline: ReturnType<typeof readPortableUsage> | undefined;
  #failure: HarnessErrorData | undefined;
  #completed = false;
  #closed = false;
  #submitted = false;

  constructor(
    readonly session: AcpSessionIdentity,
    readonly publish: (event: AdapterTurnEvent) => Promise<void>,
    readonly onClose: () => void,
  ) {}

  verifyExecution(descriptor: NativeObject): void {
    const automatic = this.session.approvalPolicy === "autoApprove";
    const sandbox = object(descriptor.sandboxPolicy, "native execution sandbox");
    if (this.#submitted || descriptor.model !== this.session.model ||
        (this.session.effort !== undefined && descriptor.effort !== this.session.effort) ||
        descriptor.approvalPolicy !== (automatic ? "never" : "on-request") ||
        (!automatic && descriptor.approvalsReviewer !== undefined && descriptor.approvalsReviewer !== "user") ||
        sandbox.type !== (automatic ? "dangerFullAccess" : "workspaceWrite")) {
      throw protocol("Codex bridge execution does not preserve the selected model, effort, policy and single executor");
    }
    this.#submitted = true;
  }

  async receive(message: NativeObject): Promise<void> {
    if (this.#closed) return;
    const params = object(message.params, "native notification params");
    if (message.method === "turn/started") {
      const turn = object(params.turn, "native Turn");
      const id = text(turn.id, "native Turn ID");
      if (this.#nativeTurnId !== undefined && this.#nativeTurnId !== id) throw protocol("Codex started a second native Turn for one ACP prompt");
      this.#nativeTurnId = id;
      return;
    }
    if (this.#nativeTurnId === undefined || (params.turnId !== undefined && params.turnId !== this.#nativeTurnId)) return;
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = object(params.item, "native item");
      const id = text(item.id, "native item ID");
      const snapshots = this.#items.get(id) ?? {};
      if (message.method === "item/started") snapshots.started ??= item;
      else snapshots.completed = item;
      this.#items.set(id, snapshots);
      if (message.method === "item/completed") { this.#itemWaiters.get(id)?.(); this.#itemWaiters.delete(id); }
    } else if (message.method === "thread/tokenUsage/updated") {
      const tokens = object(params.tokenUsage, "native token usage");
      const total = readPortableUsage(object(tokens.total, "total token usage"));
      const last = readPortableUsage(object(tokens.last, "last token usage"));
      this.#baseline ??= subtractUsage(total, last);
      await this.publish({ type: "usage.updated", usage: subtractUsage(total, this.#baseline) });
    } else if (message.method === "turn/completed") {
      const turn = object(params.turn, "native completed Turn");
      if (turn.id !== this.#nativeTurnId) return;
      this.#completed = true;
      for (const release of this.#itemWaiters.values()) release();
      this.#itemWaiters.clear();
      if (turn.status === "failed") {
        const error = turn.error === undefined || turn.error === null ? {} : object(turn.error, "native Turn error");
        this.#failure = { code: "HARNESS_ERROR", harness: "codex", command: "codex", operation: "startTurn", message: typeof error.message === "string" ? error.message : "Codex Turn failed" };
      }
    }
  }

  async tool(update: Parameters<NonNullable<AcpTurnSupplement["tool"]>>[0]) {
    const snapshots = this.#items.get(update.toolCallId);
    if (!snapshots?.started) throw protocol("Codex ACP tool lacks its committed native start snapshot");
    const start = mapToolStarted(snapshots.started, update.toolCallId);
    // The pinned bridge marks imageView complete at native item/started and
    // suppresses its later ACP update. Wait for the actual native terminal;
    // the independent observer can still commit it while ACP mapping waits.
    if (snapshots.started.type === "imageView" && snapshots.completed === undefined && !this.#completed && !this.#closed) {
      await new Promise<void>(resolve => this.#itemWaiters.set(update.toolCallId, resolve));
    }
    if (snapshots.started.type === "imageView" && snapshots.completed === undefined) throw protocol("Codex image view lacks its native completion");
    const end = snapshots.completed === undefined ? undefined : mapToolCompleted(snapshots.completed, update.toolCallId);
    if (start?.type !== "tool.started") throw protocol("Codex native Tool kind is not mapped");
    return { name: start.toolName, input: start.input,
      ...(end?.type === "tool.completed" && (update.status === "completed" || update.status === "failed") ? { output: end.output } : {}) };
  }

  async settle() {
    if (!this.#completed) throw protocol("ACP prompt completed without its committed native Turn terminal");
    return this.#failure === undefined ? {} : { failure: this.#failure };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const release of this.#itemWaiters.values()) release();
    this.#itemWaiters.clear();
    this.onClose();
  }
}
