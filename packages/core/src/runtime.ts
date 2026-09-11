import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import { DiagnosticEventStore } from "./event-store.js";
import { RuntimeCommandSupervisor } from "./control.js";
import {
  MuhaError,
  type EventStoreErrorData,
  type HarnessErrorData,
  type McpConfigurationErrorData,
  type MuhaErrorData,
  type RuntimeCloseFailedErrorData,
  type SkillConfigurationErrorData,
  type UnsupportedCapabilityErrorData,
  unsupportedCapabilityError as unsupportedCapability,
  unsupportedCapabilityErrorData as unsupportedCapabilityData,
} from "./errors.js";
import {
  isHarnessKind,
  readOfficialHarnessRegistration,
  type LiveHarnessAdapter,
  type AdapterSession,
  type OfficialHarnessRegistration,
  type WorkspaceWorkerInvocation,
} from "./internal.js";
import {
  CoreAgentSession,
  validateEffortInput,
  type AgentSession,
  type ApprovalPolicy,
  type TurnRetryPolicy,
  type TurnQueueLimits,
} from "./session.js";
import type { ListedSession, SessionReference } from "./session.js";
import { assertSupportedHost } from "./platform.js";
import { currentRuntimeScheduler } from "./scheduler.js";
import type { HarnessKind, HarnessRegistration } from "./index.js";
import type { HarnessCapabilities, SessionSelectionPoint } from "./capabilities.js";

const runtimeGuard = Symbol.for("@muha-sdk/core/active-runtime");
const defaultMaxQueuedEventsPerTurn = 4_096;
const defaultMaxQueuedEventBytesPerTurn = 16 * 1024 * 1024;
const workspaceAttemptTimeoutMs = 60 * 60 * 1_000;

interface RuntimeGuardState {
  token: object;
}

type GuardedGlobal = typeof globalThis & {
  [runtimeGuard]?: RuntimeGuardState;
};

export interface MuhaRuntimeConfig {
  readonly harnesses: readonly [HarnessRegistration, ...HarnessRegistration[]];
  readonly dataDir?: string;
  readonly maxQueuedEventsPerTurn?: number;
  readonly maxQueuedEventBytesPerTurn?: number;
}

export type RuntimeTermination =
  | {
      readonly reason: "callerClosed";
      readonly closeError?: RuntimeCloseFailedErrorData;
    }
  | {
      readonly reason: "fatal";
      readonly error: HarnessErrorData | EventStoreErrorData;
      readonly closeError?: RuntimeCloseFailedErrorData;
    };

export interface MuhaRuntime {
  readonly runtimeId: string;
  readonly dataDir: string;
  readonly enabledHarnesses: readonly HarnessKind[];
  readonly status: "active" | "closing" | "closed";
  readonly termination: Promise<RuntimeTermination>;
  getHarnessCapabilities(harness: HarnessKind): HarnessCapabilities;
  configureWorkspace(options: ConfigureWorkspaceOptions): Promise<ConfigureWorkspaceResult>;
  createSession(options: CreateSessionOptions): Promise<AgentSession>;
  resumeSession(options: ResumeSessionOptions): Promise<AgentSession>;
  listSessions(options: ListSessionsOptions): Promise<readonly ListedSession[]>;
  close(): Promise<void>;
}

export interface SkillSource {
  readonly source: string;
  readonly skillNames?: readonly [string, ...string[]];
}

export interface ConfigureWorkspaceOptions {
  readonly workspacePath: string;
  readonly createIfMissing?: boolean;
  readonly harnesses?: readonly [HarnessKind, ...HarnessKind[]];
  readonly skills?: readonly SkillSource[];
  readonly mcpServers?: readonly McpServerConfig[];
}

export type McpServerConfig =
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly transport: "http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export type WorkspaceConfigurationAttempt =
  | {
      readonly kind: "skill";
      readonly harness: HarnessKind;
      readonly inputIndex: number;
      readonly status: "succeeded";
    }
  | {
      readonly kind: "skill";
      readonly harness: HarnessKind;
      readonly inputIndex: number;
      readonly status: "failed";
      readonly error: SkillConfigurationErrorData | UnsupportedCapabilityErrorData;
    }
  | {
      readonly kind: "mcp";
      readonly harness: HarnessKind;
      readonly inputIndex: number;
      readonly status: "succeeded";
    }
  | {
      readonly kind: "mcp";
      readonly harness: HarnessKind;
      readonly inputIndex: number;
      readonly status: "failed";
      readonly error: McpConfigurationErrorData | UnsupportedCapabilityErrorData;
    };

export interface ConfigureWorkspaceResult {
  readonly workspacePath: string;
  readonly created: boolean;
  readonly attempts: readonly WorkspaceConfigurationAttempt[];
}

export interface CreateSessionOptions {
  readonly harness: HarnessKind;
  readonly workspacePath: string;
  readonly model?: string;
  readonly effort?: string;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly turnRetryPolicy?: TurnRetryPolicy;
}

export interface ResumeSessionOptions {
  readonly reference: SessionReference;
  readonly model?: string;
  readonly effort?: string;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly turnRetryPolicy?: TurnRetryPolicy;
  readonly createWorkspaceIfMissing?: boolean;
}

export interface ListSessionsOptions {
  readonly harness: HarnessKind;
  readonly workspacePath: string;
}

export async function createMuhaRuntime(
  config: MuhaRuntimeConfig,
): Promise<MuhaRuntime> {
  assertSupportedHost();
  const registrations = validateConfig(config);
  const token = acquireRuntimeGuard();
  const runtimeId = randomUUID();
  const requestedDataDir = config.dataDir ?? join(homedir(), ".muha", runtimeId);
  let store: DiagnosticEventStore | undefined;
  let runtime: Runtime | undefined;
  const adapters: LiveHarnessAdapter[] = [];
  const initializationFailures: (HarnessErrorData | EventStoreErrorData)[] = [];
  const rollbackFailures: (HarnessErrorData | EventStoreErrorData)[] = [];
  const reportedFatalFailures: Array<HarnessErrorData | undefined> = [];
  let adapterRollback: Promise<readonly PromiseSettledResult<void>[]> | undefined;
  const beginAdapterRollback = () => {
    adapterRollback ??= Promise.allSettled(adapters.map((adapter) => adapter.close()));
    return adapterRollback;
  };

  try {
    try {
      store = await DiagnosticEventStore.open(requestedDataDir, runtimeId);
    } catch (error) {
      if (isErrorData(error, "DATA_DIR_LOCKED")) throw new MuhaError(error);
      initializationFailures.push(asEventStoreError(error, "open"));
    }

    if (store) {
      for (const [index, registration] of registrations.entries()) {
        const adapter = registration.create({
          recordNativeEvent: async (harness, payload) => {
            try {
              store?.recordNativeEvent(runtimeId, harness, payload);
            } catch (error) {
              const failure = asEventStoreError(error, "write");
              runtime?.failFromEventStore(failure);
              throw failure;
            }
          },
          reportFatalError: (error, affectedSessions) => {
            const failure = asHarnessError(error, registration.kind, error.operation);
            if (runtime) runtime.failFromAdapter(failure, affectedSessions);
            else {
              reportedFatalFailures[index] ??= failure;
              void beginAdapterRollback();
            }
          },
        });
        adapters.push(adapter);
        if (adapter.kind !== registration.kind) {
          initializationFailures.push({
            code: "HARNESS_ERROR",
            message: "Harness initialize failed",
            harness: registration.kind,
            operation: "initialize",
          });
        }
      }
      if (initializationFailures.length === 0) {
        const initializeResults = await Promise.allSettled(adapters.map((adapter) =>
          adapter.initialize().catch((error) => {
            void beginAdapterRollback();
            throw error;
          })));
        initializeResults.forEach((result, index) => {
          const registration = registrations[index];
          if (!registration) return;
          if (result.status === "rejected") {
            initializationFailures.push(isErrorData(result.reason, "EVENT_STORE_ERROR")
              ? result.reason
              : asHarnessError(result.reason, registration.kind, "initialize"));
          } else {
            const reported = reportedFatalFailures[index];
            if (reported) initializationFailures.push(reported);
          }
        });
      }
    }

    if (initializationFailures.length > 0 || !store) {
      const adapterResults = await beginAdapterRollback();
      adapterResults.forEach((result, index) => {
        if (result.status === "rejected") {
          const adapter = adapters[index];
          if (!adapter) return;
          rollbackFailures.push(
            asHarnessError(result.reason, adapter.kind, "closeHarness"),
          );
        }
      });
      if (store) {
        try {
          store.close();
        } catch (error) {
          rollbackFailures.push(asEventStoreError(error, "close"));
        }
      }

      throw new MuhaError({
        code: "RUNTIME_INITIALIZATION_FAILED",
        message: "Muha Runtime initialization failed",
        initializationFailures,
        rollbackFailures,
      });
    }

    runtime = new Runtime(
      runtimeId,
      store,
      registrations,
      adapters,
      token,
      Object.freeze({
        maxEvents: config.maxQueuedEventsPerTurn ?? defaultMaxQueuedEventsPerTurn,
        maxBytes: config.maxQueuedEventBytesPerTurn ?? defaultMaxQueuedEventBytesPerTurn,
      }),
    );
    return runtime;
  } catch (error) {
    releaseRuntimeGuard(token);
    throw error;
  }
}

class Runtime implements MuhaRuntime {
  readonly runtimeId: string;
  readonly dataDir: string;
  readonly enabledHarnesses: readonly HarnessKind[];
  readonly termination: Promise<RuntimeTermination>;
  #status: "active" | "closing" | "closed" = "active";
  #closePromise: Promise<void> | undefined;
  #fatalError: HarnessErrorData | EventStoreErrorData | undefined;
  #fatalAffectedSessions: ReadonlySet<AdapterSession> | undefined;
  #resolveTermination!: (termination: RuntimeTermination) => void;
  readonly #sessions = new Set<CoreAgentSession>();
  readonly #workspaceConfigurationTails = new Map<string, Promise<void>>();
  readonly #workspaceOperations = new Set<Promise<unknown>>();
  readonly #registrationsByKind: ReadonlyMap<HarnessKind, OfficialHarnessRegistration>;
  readonly #commands: RuntimeCommandSupervisor;
  readonly #workspaceAbort = new AbortController();

  constructor(
    runtimeId: string,
    readonly store: DiagnosticEventStore,
    registrations: readonly OfficialHarnessRegistration[],
    readonly adapters: readonly LiveHarnessAdapter[],
    readonly guardToken: object,
    readonly turnQueueLimits: TurnQueueLimits,
  ) {
    this.runtimeId = runtimeId;
    this.dataDir = store.dataDir;
    this.enabledHarnesses = Object.freeze(
      registrations.map(({ kind }) => kind),
    );
    this.#registrationsByKind = new Map(
      registrations.map((registration) => [registration.kind, registration]),
    );
    this.termination = new Promise((resolve) => {
      this.#resolveTermination = resolve;
    });
    this.#commands = new RuntimeCommandSupervisor(
      currentRuntimeScheduler(),
      (error) => this.failFromAdapter(error),
    );
  }

  get status(): "active" | "closing" | "closed" {
    return this.#status;
  }

  getHarnessCapabilities(harness: HarnessKind): HarnessCapabilities {
    if (!isHarnessKind(harness)) invalid("Unknown Harness Kind");
    const registration = this.#registrationsByKind.get(harness);
    if (!registration) {
      throw new MuhaError({
        code: "HARNESS_NOT_ENABLED",
        message: `Harness is not enabled: ${harness}`,
        harness,
      });
    }
    return registration.capabilities;
  }

  async configureWorkspace(
    options: ConfigureWorkspaceOptions,
  ): Promise<ConfigureWorkspaceResult> {
    this.#assertActive();
    validateConfigureWorkspaceOptions(options, this.enabledHarnesses);
    return this.#commands.runCancellable(() => {
      const operation = this.#configureWorkspace(options);
      this.#workspaceOperations.add(operation);
      operation.then(
        () => this.#workspaceOperations.delete(operation),
        () => this.#workspaceOperations.delete(operation),
      );
      return operation;
    });
  }

  async #configureWorkspace(
    options: ConfigureWorkspaceOptions,
  ): Promise<ConfigureWorkspaceResult> {
    const { workspacePath, created } = await prepareConfiguredWorkspace(
      options.workspacePath,
      options.createIfMissing ?? true,
    );
    const harnesses = Object.freeze([
      ...(options.harnesses ?? this.enabledHarnesses),
    ]);
    const skills = Object.freeze(
      (options.skills ?? []).map((skill) => Object.freeze({
        source: skill.source,
        ...(skill.skillNames === undefined
          ? {}
          : {
              skillNames: Object.freeze([...skill.skillNames]) as readonly [
                string,
                ...string[],
              ],
            }),
      })),
    );
    const mcpServers = Object.freeze(
      (options.mcpServers ?? []).map(snapshotMcpServer),
    );
    return this.#withWorkspaceConfigurationLock(workspacePath, async () => {
      const attempts: WorkspaceConfigurationAttempt[] = [];
      for (const harness of harnesses) {
        const registration = this.#registrationsByKind.get(harness);
        if (!registration) {
          throw new Error(`Missing validated Harness Registration: ${harness}`);
        }
        for (const [inputIndex, skill] of skills.entries()) {
          assertWorkspaceCommandActive(this.#workspaceAbort.signal);
          if (!registration.capabilities.workspaceSkills) {
            attempts.push(Object.freeze({
              kind: "skill",
              harness,
              inputIndex,
              status: "failed",
              error: unsupportedCapabilityData(
                harness,
                "workspaceSkills",
                "configureWorkspace",
              ),
            }));
            continue;
          }
          const plannerInput = Object.freeze({
            workspacePath,
            source: skill.source,
            ...(skill.skillNames === undefined
              ? {}
              : { skillNames: skill.skillNames }),
          });
          const succeeded = await planAndRunWorkspaceProcess(
            () => registration.workspaceConfigurator.planSkill(plannerInput),
            workspacePath,
            this.#commands.scheduler,
            this.#workspaceAbort.signal,
          );
          const attempt: WorkspaceConfigurationAttempt = succeeded
            ? { kind: "skill", harness, inputIndex, status: "succeeded" }
            : {
                kind: "skill",
                harness,
                inputIndex,
                status: "failed",
                error: {
                  code: "SKILL_CONFIGURATION_FAILED",
                  message: "Skills CLI failed to configure the Workspace",
                },
              };
          attempts.push(Object.freeze(attempt));
        }
        for (const [inputIndex, server] of mcpServers.entries()) {
          assertWorkspaceCommandActive(this.#workspaceAbort.signal);
          if (!registration.capabilities.workspaceMcp) {
            attempts.push(Object.freeze({
              kind: "mcp",
              harness,
              inputIndex,
              status: "failed",
              error: unsupportedCapabilityData(
                harness,
                "workspaceMcp",
                "configureWorkspace",
              ),
            }));
            continue;
          }
          const plannerInput = Object.freeze({ workspacePath, server });
          const succeeded = await planAndRunWorkspaceProcess(
            () => registration.workspaceConfigurator.planMcpServer(plannerInput),
            workspacePath,
            this.#commands.scheduler,
            this.#workspaceAbort.signal,
          );
          const attempt: WorkspaceConfigurationAttempt = succeeded
            ? { kind: "mcp", harness, inputIndex, status: "succeeded" }
            : {
                kind: "mcp",
                harness,
                inputIndex,
                status: "failed",
                error: {
                  code: "MCP_CONFIGURATION_FAILED",
                  message: "MCP configuration writer failed for the Workspace",
                },
              };
          attempts.push(Object.freeze(attempt));
        }
      }
      return Object.freeze({
        workspacePath,
        created,
        attempts: Object.freeze(attempts),
      });
    });
  }

  async #withWorkspaceConfigurationLock<T>(
    workspacePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#workspaceConfigurationTails.get(workspacePath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#workspaceConfigurationTails.set(workspacePath, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#workspaceConfigurationTails.get(workspacePath) === tail) {
        this.#workspaceConfigurationTails.delete(workspacePath);
      }
    }
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    if (this.#status !== "active") {
      throw new MuhaError({ code: "RUNTIME_CLOSED", message: "Runtime is not active" });
    }
    validateCreateSessionOptions(options);
    return this.#commands.runCancellable(() => this.#createSession(options));
  }

  async #createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const adapter = this.adapters.find(({ kind }) => kind === options.harness);
    if (!adapter) {
      throw new MuhaError({
        code: "HARNESS_NOT_ENABLED",
        message: `Harness is not enabled: ${options.harness}`,
        harness: options.harness,
      });
    }
    const capabilities = this.#registrationsByKind.get(options.harness)!.capabilities;
    const approvalPolicy = options.approvalPolicy ?? "interactive";
    requireSessionOptionCapabilities(
      options.harness,
      capabilities,
      "createSession",
      approvalPolicy,
      options,
    );
    let workspacePath: string;
    try {
      const metadata = await stat(options.workspacePath);
      if (!metadata.isDirectory()) throw new Error("path is not a directory");
      workspacePath = await realpath(options.workspacePath);
    } catch {
      throw new MuhaError({
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace must be an existing directory",
        workspacePath: options.workspacePath,
      });
    }
    let adapterSession;
    try {
      adapterSession = await this.#commands.runControl(
        options.harness,
        "createSession",
        () => adapter.createSession({
          workspacePath,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.effort === undefined ? {} : { effort: options.effort }),
          approvalPolicy,
        }),
      );
    } catch (error) {
      throw normalizeAdapterCommandError(error, options.harness, "createSession");
    }
    if (this.#status !== "active") {
      await adapterSession.close().catch(() => undefined);
      throw new MuhaError({
        code: "RUNTIME_CLOSED",
        message: "Runtime closed before Session creation completed",
      });
    }
    const session = new CoreAgentSession(
      options.harness,
      workspacePath,
      adapterSession,
      approvalPolicy,
      capabilities,
      async (payload) => this.#recordCoreEvent(payload),
      this.turnQueueLimits,
      (harness, operation, start) => this.#commands.runControl(harness, operation, start),
      { maxRetries: options.turnRetryPolicy?.maxRetries ?? 0 },
    );
    this.#sessions.add(session);
    return session;
  }

  async resumeSession(options: ResumeSessionOptions): Promise<AgentSession> {
    this.#assertActive();
    validateResumeSessionOptions(options);
    return this.#commands.runCancellable(() => this.#resumeSession(options));
  }

  async #resumeSession(options: ResumeSessionOptions): Promise<AgentSession> {
    const { reference } = options;
    const adapter = this.#requireAdapter(reference.harness);
    const capabilities = this.#registrationsByKind.get(reference.harness)!.capabilities;
    const approvalPolicy = options.approvalPolicy ?? "interactive";
    requireSessionOptionCapabilities(
      reference.harness,
      capabilities,
      "resumeSession",
      approvalPolicy,
      options,
    );
    const workspacePath = await prepareResumeWorkspace(
      reference.workspacePath,
      options.createWorkspaceIfMissing ?? false,
    );
    if (workspacePath !== reference.workspacePath) {
      throw new MuhaError({
        code: "INVALID_INPUT",
        message: "Session Reference workspacePath is not canonical",
      });
    }
    let adapterSession;
    try {
      adapterSession = await this.#commands.runControl(
        reference.harness,
        "resumeSession",
        () => adapter.resumeSession({
          nativeSessionId: reference.sessionId,
          workspacePath,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.effort === undefined ? {} : { effort: options.effort }),
          approvalPolicy,
        }),
      );
    } catch (error) {
      throw normalizeResumeSessionError(error, reference);
    }
    if (this.#status !== "active") {
      await adapterSession.close().catch(() => undefined);
      throw new MuhaError({
        code: "RUNTIME_CLOSED",
        message: "Runtime closed before Session resumption completed",
      });
    }
    const session = new CoreAgentSession(
      reference.harness,
      workspacePath,
      adapterSession,
      approvalPolicy,
      capabilities,
      async (payload) => this.#recordCoreEvent(payload),
      this.turnQueueLimits,
      (harness, operation, start) => this.#commands.runControl(harness, operation, start),
      { maxRetries: options.turnRetryPolicy?.maxRetries ?? 0 },
    );
    this.#sessions.add(session);
    return session;
  }

  async listSessions(options: ListSessionsOptions): Promise<readonly ListedSession[]> {
    this.#assertActive();
    validateListSessionsOptions(options);
    return this.#commands.runCancellable(() => this.#listSessions(options));
  }

  async #listSessions(options: ListSessionsOptions): Promise<readonly ListedSession[]> {
    const adapter = this.#requireAdapter(options.harness);
    const capabilities = this.#registrationsByKind.get(options.harness)!.capabilities;
    if (!capabilities.sessionListing) {
      throw unsupportedCapability(options.harness, "sessionListing", "listSessions");
    }
    const workspacePath = await canonicalizeListWorkspace(options.workspacePath);
    let entries;
    try {
      entries = await this.#commands.runControl(
        options.harness,
        "listSessions",
        () => adapter.listSessions(workspacePath),
      );
    } catch (error) {
      throw normalizeAdapterCommandError(error, options.harness, "listSessions");
    }
    return Object.freeze(
      entries.map((entry) => {
        if (entry.workspacePath !== workspacePath) {
          throw new MuhaError({
            code: "ADAPTER_PROTOCOL_ERROR",
            message: "Harness listed a Session bound to a different Workspace",
            harness: options.harness,
          });
        }
        return Object.freeze({
          reference: Object.freeze({
            harness: options.harness,
            sessionId: entry.nativeSessionId,
            workspacePath,
          }),
          ...(entry.title === undefined ? {} : { title: entry.title }),
          ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
          ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
        });
      }),
    );
  }

  #assertActive(): void {
    if (this.#status !== "active") {
      throw new MuhaError({ code: "RUNTIME_CLOSED", message: "Runtime is not active" });
    }
  }

  #requireAdapter(harness: HarnessKind): LiveHarnessAdapter {
    const adapter = this.adapters.find(({ kind }) => kind === harness);
    if (!adapter) {
      throw new MuhaError({
        code: "HARNESS_NOT_ENABLED",
        message: `Harness is not enabled: ${harness}`,
        harness,
      });
    }
    return adapter;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#status = "closing";
    this.#commands.close();
    this.#workspaceAbort.abort();
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  failFromEventStore(error: EventStoreErrorData): void {
    if (this.#status !== "active") return;
    this.#fatalError = error;
    this.#status = "closing";
    this.#commands.close();
    this.#workspaceAbort.abort();
    this.#closePromise = this.#performClose();
    void this.#closePromise.catch(() => undefined);
  }

  failFromAdapter(error: HarnessErrorData, affectedSessions?: readonly AdapterSession[]): void {
    if (this.#status !== "active") return;
    this.#fatalError = error;
    this.#fatalAffectedSessions = affectedSessions === undefined ? undefined : new Set(affectedSessions);
    this.#status = "closing";
    this.#commands.close();
    this.#workspaceAbort.abort();
    this.#closePromise = this.#performClose();
    void this.#closePromise.catch(() => undefined);
  }

  async #recordCoreEvent(payload: unknown): Promise<void> {
    try {
      this.store.recordCoreEvent(this.runtimeId, payload);
    } catch (error) {
      const failure = asEventStoreError(error, "write");
      this.failFromEventStore(failure);
      throw failure;
    }
  }

  async #performClose(): Promise<void> {
    const failures: (HarnessErrorData | EventStoreErrorData)[] = [];
    try {
      const workspaceOperations = Promise.allSettled([...this.#workspaceOperations]);
      const harnessOrder = new Map(
        this.adapters.map((adapter, index) => [adapter.kind, index]),
      );
      const sessions = [...this.#sessions].sort((left, right) => {
        const byHarness = (harnessOrder.get(left.reference.harness) ?? Number.MAX_SAFE_INTEGER) -
          (harnessOrder.get(right.reference.harness) ?? Number.MAX_SAFE_INTEGER);
        if (byHarness !== 0) return byHarness;
        const bySessionId = compareStableString(
          left.reference.sessionId,
          right.reference.sessionId,
        );
        if (bySessionId !== 0) return bySessionId;
        return compareStableString(
          left.reference.workspacePath,
          right.reference.workspacePath,
        );
      });
      const sessionResults = await Promise.allSettled(
        sessions.map((session) => {
          if (this.#fatalError?.code === "EVENT_STORE_ERROR") {
            return session.closeForEventStoreFailure(this.#fatalError);
          }
          if (
            this.#fatalError?.code === "HARNESS_ERROR" &&
            session.reference.harness === this.#fatalError.harness &&
            (this.#fatalAffectedSessions === undefined || this.#fatalAffectedSessions.has(session.adapterSession))
          ) return session.closeForHarnessFailure(this.#fatalError);
          return session.closeForRuntime();
        }),
      );
      sessionResults.forEach((result, index) => {
        if (result.status === "rejected") {
          const session = sessions[index];
          if (session) failures.push(asHarnessError(result.reason, session.reference.harness, "closeSession"));
        }
      });
      await workspaceOperations;
      const adapterResults = await Promise.allSettled(
        this.adapters.map((adapter) => adapter.close()),
      );
      adapterResults.forEach((result, index) => {
        if (result.status === "rejected") {
          const adapter = this.adapters[index];
          if (adapter) {
            failures.push(
              asHarnessError(result.reason, adapter.kind, "closeHarness"),
            );
          }
        }
      });

      try {
        this.store.close();
      } catch (error) {
        failures.push(asEventStoreError(error, "close"));
      }
    } finally {
      releaseRuntimeGuard(this.guardToken);
      this.#status = "closed";
    }

    if (failures.length > 0) {
      const closeError: RuntimeCloseFailedErrorData = {
        code: "RUNTIME_CLOSE_FAILED",
        message: "Muha Runtime close did not reclaim every component",
        failures,
      };
      this.#resolveTermination(this.#fatalError
        ? { reason: "fatal", error: this.#fatalError, closeError }
        : { reason: "callerClosed", closeError });
      throw new MuhaError(closeError);
    }

    this.#resolveTermination(this.#fatalError
      ? { reason: "fatal", error: this.#fatalError }
      : { reason: "callerClosed" });
  }
}

function requireSessionOptionCapabilities(
  harness: HarnessKind,
  capabilities: HarnessCapabilities,
  operation: Extract<SessionSelectionPoint, "createSession" | "resumeSession">,
  approvalPolicy: ApprovalPolicy,
  options: { readonly model?: string; readonly effort?: string },
): void {
  if (!capabilities.approvalPolicies.includes(approvalPolicy)) {
    throw unsupportedCapability(harness, `approvalPolicy.${approvalPolicy}`, operation);
  }
  if (options.model !== undefined && !capabilities.model.selectionAt.includes(operation)) {
    throw unsupportedCapability(harness, `model.selectionAt.${operation}`, operation);
  }
  if (options.effort !== undefined && !capabilities.effort.selectionAt.includes(operation)) {
    throw unsupportedCapability(harness, `effort.selectionAt.${operation}`, operation);
  }
}

function compareStableString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateCreateSessionOptions(options: CreateSessionOptions): void {
  if (!isPlainObject(options)) invalid("createSession options must be an object");
  assertKnownKeys(options, ["harness", "workspacePath", "model", "effort", "approvalPolicy", "turnRetryPolicy"]);
  if (!isHarnessKind(options.harness)) {
    invalid("Unknown Harness Kind");
  }
  if (typeof options.workspacePath !== "string" || !isAbsolute(options.workspacePath)) {
    invalid("Workspace path must be absolute");
  }
  if (options.model !== undefined && (typeof options.model !== "string" || options.model.length === 0)) {
    invalid("Model must be a non-empty string");
  }
  if (options.effort !== undefined) validateEffortInput(options.effort);
  if (options.approvalPolicy !== undefined &&
    !["interactive", "autoApprove", "autoDeny", "harnessManaged"].includes(options.approvalPolicy)) {
    invalid("Unknown Approval Policy");
  }
  if (options.turnRetryPolicy !== undefined) validateTurnRetryPolicy(options.turnRetryPolicy);
}

function validateConfigureWorkspaceOptions(
  options: ConfigureWorkspaceOptions,
  enabledHarnesses: readonly HarnessKind[],
): void {
  if (!isPlainObject(options)) invalid("configureWorkspace options must be an object");
  assertKnownKeys(options, [
    "workspacePath",
    "createIfMissing",
    "harnesses",
    "skills",
    "mcpServers",
  ]);
  if (typeof options.workspacePath !== "string" || !isAbsolute(options.workspacePath)) {
    invalid("Workspace path must be absolute");
  }
  if (options.createIfMissing !== undefined && typeof options.createIfMissing !== "boolean") {
    invalid("createIfMissing must be boolean");
  }
  if (options.harnesses !== undefined) {
    if (!Array.isArray(options.harnesses) || options.harnesses.length === 0) {
      invalid("Workspace Harness targets must be a non-empty array");
    }
    const targets = new Set<HarnessKind>();
    for (const harness of options.harnesses) {
      if (!(enabledHarnesses as readonly unknown[]).includes(harness)) {
        invalid("Workspace Harness target is not enabled");
      }
      if (targets.has(harness)) invalid("Workspace Harness targets must be unique");
      targets.add(harness);
    }
  }
  if (options.skills !== undefined && !Array.isArray(options.skills)) {
    invalid("Workspace Skills must be an array");
  }
  for (const skill of options.skills ?? []) {
    if (!isPlainObject(skill)) invalid("Skill source must be an object");
    assertOnlyOptionKeys(skill, ["source", "skillNames"], "Skill source");
    if (typeof skill.source !== "string" || skill.source.length === 0) {
      invalid("Skill source must be a non-empty string");
    }
    if (skill.skillNames !== undefined) {
      if (!Array.isArray(skill.skillNames) || skill.skillNames.length === 0) {
        invalid("Skill names must be a non-empty array");
      }
      const names = new Set<string>();
      for (const name of skill.skillNames) {
        if (typeof name !== "string" || name.length === 0) {
          invalid("Skill names must be non-empty strings");
        }
        if (names.has(name)) invalid("Skill names must be unique");
        names.add(name);
      }
    }
  }
  if (options.mcpServers !== undefined && !Array.isArray(options.mcpServers)) {
    invalid("Workspace MCP servers must be an array");
  }
  for (const server of options.mcpServers ?? []) validateMcpServer(server);
}

function validateMcpServer(server: McpServerConfig): void {
  if (!isPlainObject(server)) invalid("MCP server must be an object");
  if (typeof server.name !== "string" || server.name.length === 0) {
    invalid("MCP server name must be a non-empty string");
  }
  if (server.transport === "stdio") {
    assertOnlyOptionKeys(server, ["name", "transport", "command", "args", "env"], "stdio MCP server");
    if (typeof server.command !== "string" || server.command.length === 0) {
      invalid("stdio MCP command must be a non-empty string");
    }
    if (server.args !== undefined && (
      !Array.isArray(server.args) || server.args.some((value) => typeof value !== "string")
    )) {
      invalid("stdio MCP arguments must be strings");
    }
    validateStringRecord(server.env, "stdio MCP environment");
    return;
  }
  if (server.transport !== "http") invalid("MCP transport must be stdio or http");
  assertOnlyOptionKeys(server, ["name", "transport", "url", "headers"], "HTTP MCP server");
  if (typeof server.url !== "string") invalid("HTTP MCP URL must be a string");
  try {
    const parsed = new URL(server.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    invalid("HTTP MCP URL must be an absolute HTTP(S) URL");
  }
  validateStringRecord(server.headers, "HTTP MCP headers");
}

function validateStringRecord(
  value: Readonly<Record<string, string>> | undefined,
  description: string,
): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) invalid(`${description} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || typeof entry !== "string") {
      invalid(`${description} must contain non-empty string keys and string values`);
    }
  }
}

function snapshotMcpServer(server: McpServerConfig): McpServerConfig {
  if (server.transport === "stdio") {
    return Object.freeze({
      name: server.name,
      transport: "stdio",
      command: server.command,
      ...(server.args === undefined ? {} : { args: Object.freeze([...server.args]) }),
      ...(server.env === undefined ? {} : { env: Object.freeze({ ...server.env }) }),
    });
  }
  return Object.freeze({
    name: server.name,
    transport: "http",
    url: server.url,
    ...(server.headers === undefined ? {} : { headers: Object.freeze({ ...server.headers }) }),
  });
}

async function planAndRunWorkspaceProcess(
  plan: () => WorkspaceWorkerInvocation,
  workspacePath: string,
  scheduler: import("./scheduler.js").RuntimeScheduler,
  signal: AbortSignal,
): Promise<boolean> {
  assertWorkspaceCommandActive(signal);
  let planned: WorkspaceWorkerInvocation;
  try {
    planned = plan();
  } catch {
    assertWorkspaceCommandActive(signal);
    return false;
  }
  assertWorkspaceCommandActive(signal);
  const invocation = snapshotWorkspaceWorkerInvocation(planned);
  if (!invocation) return false;
  return runWorkspaceProcess(workspacePath, invocation, scheduler, signal);
}

function runWorkspaceProcess(
  workspacePath: string,
  invocation: WorkspaceWorkerInvocation,
  scheduler: import("./scheduler.js").RuntimeScheduler,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    let timer: unknown;
    const finish = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) scheduler.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(succeeded);
    };
    const reclaim = () => {
      const pid = child?.pid;
      if (Number.isSafeInteger(pid) && pid !== undefined && pid > 1) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (!isNodeError(error, "ESRCH")) {
            finish(false);
            return;
          }
          finish(false);
        }
        return;
      }
      finish(false);
    };
    const abort = () => reclaim();
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, [invocation.entrypoint, ...invocation.args], {
        cwd: workspacePath,
        detached: true,
        env: {
          ...process.env,
          DISABLE_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
        },
        shell: false,
        stdio: invocation.stdin === undefined ? "ignore" : ["pipe", "ignore", "ignore"],
      });
    } catch {
      finish(false);
      return;
    }
    child.once("error", () => finish(false));
    child.once("exit", (code, signal) => finish(code === 0 && signal === null));
    if (invocation.stdin !== undefined && child.stdin) {
      child.stdin.on("error", reclaim);
      child.stdin.end(invocation.stdin);
    }
    signal.addEventListener("abort", abort, { once: true });
    timer = scheduler.setTimeout(reclaim, workspaceAttemptTimeoutMs);
  });
}

function snapshotWorkspaceWorkerInvocation(
  value: WorkspaceWorkerInvocation,
): WorkspaceWorkerInvocation | undefined {
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "entrypoint" && key !== "args" && key !== "stdin")) {
    return undefined;
  }
  if (
    typeof value.entrypoint !== "string" ||
    value.entrypoint.length === 0 ||
    !isAbsolute(value.entrypoint) ||
    !Array.isArray(value.args) ||
    value.args.some((argument) => typeof argument !== "string") ||
    (value.stdin !== undefined && typeof value.stdin !== "string")
  ) {
    return undefined;
  }
  return Object.freeze({
    entrypoint: value.entrypoint,
    args: Object.freeze([...value.args]),
    ...(value.stdin === undefined ? {} : { stdin: value.stdin }),
  });
}

function assertWorkspaceCommandActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new MuhaError({
      code: "RUNTIME_CLOSED",
      message: "Runtime closed before Workspace configuration completed",
    });
  }
}

async function prepareConfiguredWorkspace(
  requestedPath: string,
  createIfMissing: boolean,
): Promise<{ readonly workspacePath: string; readonly created: boolean }> {
  let created = false;
  try {
    const metadata = await stat(requestedPath);
    if (!metadata.isDirectory()) throw new Error("path is not a directory");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw new MuhaError({
        code: "WORKSPACE_IO_ERROR",
        message: "Workspace path is not a readable directory",
      });
    }
    if (!createIfMissing) {
      throw new MuhaError({
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace directory does not exist",
        workspacePath: requestedPath,
      });
    }
    try {
      created = (await mkdir(requestedPath, { recursive: true })) !== undefined;
    } catch {
      throw new MuhaError({
        code: "WORKSPACE_IO_ERROR",
        message: "Workspace directory could not be created",
      });
    }
  }
  try {
    return { workspacePath: await realpath(requestedPath), created };
  } catch {
    throw new MuhaError({
      code: "WORKSPACE_IO_ERROR",
      message: "Workspace path could not be canonicalized",
    });
  }
}

function validateResumeSessionOptions(options: ResumeSessionOptions): void {
  if (!isPlainObject(options)) invalid("resumeSession options must be an object");
  assertKnownKeys(options, ["reference", "model", "effort", "approvalPolicy", "turnRetryPolicy", "createWorkspaceIfMissing"]);
  validateSessionReference(options.reference);
  if (options.model !== undefined && (typeof options.model !== "string" || options.model.length === 0)) invalid("Model must be a non-empty string");
  if (options.effort !== undefined) validateEffortInput(options.effort);
  if (options.approvalPolicy !== undefined &&
    !["interactive", "autoApprove", "autoDeny", "harnessManaged"].includes(options.approvalPolicy)) {
    invalid("Unknown Approval Policy");
  }
  if (options.turnRetryPolicy !== undefined) validateTurnRetryPolicy(options.turnRetryPolicy);
  if (options.createWorkspaceIfMissing !== undefined && typeof options.createWorkspaceIfMissing !== "boolean") invalid("createWorkspaceIfMissing must be boolean");
}

function validateTurnRetryPolicy(policy: unknown): asserts policy is TurnRetryPolicy {
  if (!isPlainObject(policy)) invalid("Turn Retry Policy must be an object");
  assertKnownKeys(policy, ["maxRetries"]);
  if (!Number.isSafeInteger(policy.maxRetries) || (policy.maxRetries as number) < 0 || (policy.maxRetries as number) > 10) {
    invalid("Turn Retry Policy maxRetries must be an integer from 0 through 10");
  }
}

function validateListSessionsOptions(options: ListSessionsOptions): void {
  if (!isPlainObject(options)) invalid("listSessions options must be an object");
  assertKnownKeys(options, ["harness", "workspacePath"]);
  if (!isHarnessKind(options.harness)) invalid("Unknown Harness Kind");
  if (typeof options.workspacePath !== "string" || !isAbsolute(options.workspacePath)) invalid("Workspace path must be absolute");
}

function validateSessionReference(reference: SessionReference): void {
  if (!isPlainObject(reference)) invalid("Session Reference must be an object");
  assertKnownKeys(reference, ["harness", "sessionId", "workspacePath"]);
  if (!isHarnessKind(reference.harness)) invalid("Unknown Harness Kind");
  if (typeof reference.sessionId !== "string" || reference.sessionId.length === 0) invalid("Session ID must be non-empty");
  if (typeof reference.workspacePath !== "string" || !isAbsolute(reference.workspacePath)) invalid("Session Workspace path must be absolute");
}

async function prepareResumeWorkspace(workspacePath: string, createIfMissing: boolean): Promise<string> {
  try {
    const metadata = await stat(workspacePath);
    if (!metadata.isDirectory()) throw new Error("path is not a directory");
  } catch (error) {
    if (!createIfMissing) {
      throw new MuhaError({ code: "WORKSPACE_NOT_FOUND", message: "Session Workspace does not exist", workspacePath });
    }
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  }
  return realpath(workspacePath);
}

async function canonicalizeListWorkspace(workspacePath: string): Promise<string> {
  try {
    const metadata = await stat(workspacePath);
    if (!metadata.isDirectory()) return normalize(workspacePath);
    return await realpath(workspacePath);
  } catch {
    return normalize(workspacePath);
  }
}

function normalizeAdapterCommandError(
  error: unknown,
  harness: HarnessKind,
  operation: HarnessErrorData["operation"],
): MuhaError {
  if (error instanceof MuhaError) return error;
  if (isErrorData(error, "HARNESS_ERROR") || isErrorData(error, "ADAPTER_PROTOCOL_ERROR")) {
    return new MuhaError(error);
  }
  return new MuhaError(asHarnessError(error, harness, operation));
}

function normalizeResumeSessionError(
  error: unknown,
  reference: SessionReference,
): MuhaError {
  const data = error instanceof MuhaError ? error.data : error;
  if (
    isErrorData(data, "HARNESS_ERROR") &&
    data.nativeCode === "session_not_found"
  ) {
    return new MuhaError({
      code: "SESSION_NOT_FOUND",
      message: "Native Session was not found",
      harness: reference.harness,
      sessionId: reference.sessionId,
    });
  }
  return normalizeAdapterCommandError(error, reference.harness, "resumeSession");
}

function validateConfig(
  config: MuhaRuntimeConfig,
): readonly OfficialHarnessRegistration[] {
  if (!isPlainObject(config)) invalid("Runtime config must be an object");
  assertKnownKeys(config, [
    "harnesses",
    "dataDir",
    "maxQueuedEventsPerTurn",
    "maxQueuedEventBytesPerTurn",
  ]);
  if (!Array.isArray(config.harnesses) || config.harnesses.length === 0) {
    invalid("Runtime config requires at least one Harness Registration");
  }
  if (config.dataDir !== undefined && !isAbsolute(config.dataDir)) {
    invalid("Runtime dataDir must be absolute");
  }
  validatePositiveSafeInteger(
    config.maxQueuedEventsPerTurn,
    "maxQueuedEventsPerTurn",
  );
  validatePositiveSafeInteger(
    config.maxQueuedEventBytesPerTurn,
    "maxQueuedEventBytesPerTurn",
  );

  const registrations = config.harnesses.map((registration) => {
    const value = readOfficialHarnessRegistration(registration);
    if (!value || !isHarnessKind(value.kind)) {
      invalid("Runtime config contains an invalid Harness Registration");
    }
    return value;
  });
  const kinds = new Set<HarnessKind>();
  for (const registration of registrations) {
    if (kinds.has(registration.kind)) {
      invalid(`Duplicate Harness Registration: ${registration.kind}`);
    }
    kinds.add(registration.kind);
  }
  return registrations;
}

function validatePositiveSafeInteger(
  value: number | undefined,
  name: string,
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    invalid(`${name} must be a positive safe integer`);
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  knownKeys: readonly string[],
): void {
  const known = new Set(knownKeys);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) invalid(`Unknown Runtime config field: ${key}`);
  }
}

function assertOnlyOptionKeys(
  value: Record<string, unknown>,
  knownKeys: readonly string[],
  description: string,
): void {
  const known = new Set(knownKeys);
  if (Object.keys(value).some((key) => !known.has(key))) {
    invalid(`${description} contains an unknown field`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isPlainObject(error) && error.code === code;
}

function invalid(message: string): never {
  throw new MuhaError({ code: "INVALID_INPUT", message });
}

function acquireRuntimeGuard(): object {
  const guardedGlobal = globalThis as GuardedGlobal;
  if (guardedGlobal[runtimeGuard]) {
    throw new MuhaError({
      code: "RUNTIME_ALREADY_ACTIVE",
      message: "This process already has a live Muha Runtime",
    });
  }
  const token = {};
  guardedGlobal[runtimeGuard] = { token };
  return token;
}

function releaseRuntimeGuard(token: object): void {
  const guardedGlobal = globalThis as GuardedGlobal;
  if (guardedGlobal[runtimeGuard]?.token === token) {
    delete guardedGlobal[runtimeGuard];
  }
}

function asHarnessError(
  error: unknown,
  harness: HarnessKind,
  operation: HarnessErrorData["operation"],
): HarnessErrorData {
  if (isErrorData(error, "HARNESS_ERROR")) return error;
  return {
    code: "HARNESS_ERROR",
    message: `Harness ${operation} failed`,
    harness,
    operation,
  };
}

function asEventStoreError(
  error: unknown,
  operation: EventStoreErrorData["operation"],
): EventStoreErrorData {
  if (isErrorData(error, "EVENT_STORE_ERROR")) return error;
  return {
    code: "EVENT_STORE_ERROR",
    message: `Diagnostic Event Store ${operation} failed`,
    operation,
  };
}

function isErrorData<Code extends MuhaErrorData["code"]>(
  error: unknown,
  code: Code,
): error is Extract<MuhaErrorData, { code: Code }> {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
