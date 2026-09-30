import type {
  HarnessRegistration,
  OfficialAdapterOptions,
} from "./index.js";
import { MuhaError } from "./errors.js";
import type { HarnessErrorData } from "./errors.js";
import type { HarnessIntegrationRoute } from "./reference.js";
import {
  isHarnessKind,
  type HarnessKind,
} from "./harness-catalog.js";
import type { WorkspaceConfigurator } from "./workspace-configurator.js";
import {
  isFrozenHarnessCapabilities,
  snapshotHarnessCapabilities,
  type HarnessCapabilities,
} from "./capabilities.js";

export {
  OFFICIAL_HARNESS_KINDS,
  isHarnessKind,
  type HarnessKind,
} from "./harness-catalog.js";

export { AcpSessionDriver } from "./acp/driver.js";
export { AcpConnection } from "./acp/connection.js";
export type {
  AcpRouteOptions,
  AcpHarnessBehavior,
  AcpSessionIdentity,
  AcpTurnSupplement,
  AcpQuestionMapping,
  AcpQuestionRequest,
} from "./acp/types.js";

export {
  installRuntimeSchedulerForTesting,
  type RuntimeScheduler,
} from "./scheduler.js";

export {
  composeWorkspaceConfigurator,
  createAddMcpPlanner,
  createSkillsCliPlanner,
  type AdapterMcpConfigurationInput,
  type AdapterSkillConfigurationInput,
  type WorkspaceConfigurator,
  type WorkspaceMcpPlanner,
  type WorkspaceSkillPlanner,
  type WorkspaceWorkerInvocation,
} from "./workspace-configurator.js";

export type {
  HarnessIntegrationRoute,
  SessionReference,
} from "./reference.js";
export {
  createSessionReference,
  parseSessionReference,
  serializeSessionReference,
  referenceRoute,
  HARNESS_INTEGRATION_ROUTES,
} from "./reference.js";

const registrationMarker = Symbol.for("@muha-sdk/core/HarnessRegistration");

export interface OfficialHarnessRegistration {
  readonly [registrationMarker]: true;
  readonly kind: HarnessKind;
  readonly options: OfficialAdapterOptions;
  readonly capabilities: HarnessCapabilities;
  readonly workspaceConfigurator: WorkspaceConfigurator;
  readonly create: (context: LiveHarnessAdapterContext) => LiveHarnessAdapter;
}

export interface LiveHarnessAdapterContext {
  recordNativeEvent(harness: HarnessKind, payload: unknown): Promise<void>;
  reportFatalError(error: HarnessErrorData, affectedSessions?: readonly AdapterSession[]): void;
}

export interface AdapterCreateSessionOptions {
  readonly workspacePath: string;
  readonly model?: string;
  readonly effort?: string;
  readonly approvalPolicy: "interactive" | "autoApprove" | "autoDeny" | "harnessManaged";
}

export interface AdapterSession {
  readonly nativeSessionId: string;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly closed: boolean;
  startTurn(input: readonly AdapterTurnInput[]): Promise<AdapterTurn>;
  setModel(model: string): Promise<void>;
  setEffort(effort: string): Promise<void>;
  close(): Promise<void>;
}

export interface AdapterResumeSessionOptions extends AdapterCreateSessionOptions {
  readonly nativeSessionId: string;
  readonly route?: HarnessIntegrationRoute;
}

export interface AdapterListedSession {
  readonly nativeSessionId: string;
  readonly workspacePath: string;
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface AdapterTextInput {
  readonly type: "text";
  readonly text: string;
}

export interface AdapterImageInput {
  readonly type: "image";
  readonly source:
    | { readonly type: "file"; readonly path: string }
    | {
        readonly type: "base64";
        readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
        readonly data: string;
      };
}

export type AdapterTurnInput = AdapterTextInput | AdapterImageInput;

export type AdapterTurnEvent =
  | { readonly type: "adapter.protocolError"; readonly message: string }
  | { readonly type: "turn.started" }
  | {
      readonly type: "assistant.message.started";
      readonly nativeMessageId: string;
    }
  | {
      readonly type: "assistant.message.delta";
      readonly nativeMessageId: string;
      readonly delta: string;
    }
  | {
      readonly type: "assistant.reasoning.delta";
      readonly nativeMessageId: string;
      readonly delta: string;
    }
  | {
      readonly type: "assistant.message.completed";
      readonly nativeMessageId: string;
      readonly text: string;
    }
  | {
      readonly type: "tool.started";
      readonly nativeToolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool.updated";
      readonly nativeToolCallId: string;
      readonly update: unknown;
    }
  | {
      readonly type: "tool.completed";
      readonly nativeToolCallId: string;
      readonly output: unknown;
      readonly isError: boolean;
    }
  | {
      readonly type: "usage.updated";
      readonly usage: AdapterTurnUsage;
    }
  | {
      readonly type: "approval.requested";
      readonly nativeRequestId: string;
      readonly title: string;
      readonly description?: string;
      readonly nativeToolCallId?: string;
      readonly details?: unknown;
    }
  | {
      readonly type: "approval.invalidated";
      readonly nativeRequestId: string;
    }
  | {
      readonly type: "question.requested";
      readonly nativeRequestId: string;
      readonly questions: readonly AdapterQuestionItem[];
      readonly nativeToolCallId?: string;
      readonly description?: string;
    }
  | {
      readonly type: "question.answered";
      readonly nativeRequestId: string;
      readonly answers: readonly AdapterQuestionAnswer[];
    }
  | {
      readonly type: "question.dismissed" | "question.invalidated";
      readonly nativeRequestId: string;
    }
  | { readonly type: "turn.completed" }
  | { readonly type: "turn.failed"; readonly error: HarnessErrorData }
  | { readonly type: "turn.interrupted" };

export interface AdapterTurnUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

export interface AdapterQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface AdapterLegacyQuestionItem {
  readonly header?: string;
  readonly question: string;
  readonly description?: string;
  readonly options: readonly AdapterQuestionOption[];
  readonly multiple: boolean;
  readonly allowCustom: boolean;
}

export type AdapterQuestionInput =
  | {
      readonly kind: "select" | "multiselect";
      readonly options: readonly (AdapterQuestionOption & { readonly value: string })[];
      readonly allowCustom: boolean;
      readonly maxCustomItems?: number;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly format?: "email" | "uri" | "date" | "date-time";
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
      readonly placeholder?: string;
    }
  | {
      readonly kind: "text";
      readonly format?: "email" | "uri" | "date" | "date-time";
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
      readonly placeholder?: string;
    }
  | { readonly kind: "number"; readonly integer: boolean; readonly minimum?: number; readonly maximum?: number }
  | { readonly kind: "boolean" }
  | { readonly kind: "external"; readonly url: string };

export interface AdapterTypedQuestionItem {
  readonly header?: string;
  readonly question: string;
  readonly description?: string;
  readonly input: AdapterQuestionInput;
  readonly required: boolean;
  readonly hidden: boolean;
  readonly defaultValue?: string | number | boolean | readonly string[];
  readonly when?: readonly {
    readonly questionIndex: number;
    readonly op: "eq" | "neq";
    readonly value: string | number | boolean;
  }[];
}

export type AdapterQuestionItem = AdapterLegacyQuestionItem | AdapterTypedQuestionItem;

export type AdapterQuestionAnswer =
  | { readonly questionIndex: number; readonly kind: "options"; readonly optionIndexes: readonly number[] }
  | { readonly questionIndex: number; readonly kind: "custom"; readonly text: string }
  | {
      readonly questionIndex: number;
      readonly kind: "optionsWithCustom";
      readonly optionIndexes: readonly number[];
      readonly text: string;
    }
  | { readonly questionIndex: number; readonly kind: "skipped" }
  | { readonly questionIndex: number; readonly kind: "selection"; readonly optionIndexes: readonly number[]; readonly customValues: readonly string[] }
  | { readonly questionIndex: number; readonly kind: "text"; readonly text: string }
  | { readonly questionIndex: number; readonly kind: "number"; readonly value: number }
  | { readonly questionIndex: number; readonly kind: "boolean"; readonly value: boolean }
  | { readonly questionIndex: number; readonly kind: "externalAcknowledged" }
  | { readonly questionIndex: number; readonly kind: "useDefault" };

export type AdapterQuestionResponse =
  | { readonly action: "answer"; readonly answers: readonly AdapterQuestionAnswer[] }
  | { readonly action: "dismiss" };

export interface AdapterTurn extends AsyncIterable<AdapterTurnEvent> {
  readonly nativeTurnId: string;
  interrupt(): Promise<void>;
  respondToApproval(
    nativeRequestId: string,
    decision: "allowOnce" | "deny",
  ): Promise<void>;
  respondToQuestion(
    nativeRequestId: string,
    response: AdapterQuestionResponse,
  ): Promise<void>;
}

export interface LiveHarnessAdapter {
  readonly kind: HarnessKind;
  /**
   * The Harness Integration Route this Adapter instance fulfills behavior
   * through. Existing native adapters declare "native"; an internal-test-bound
   * ACP driver declares "acp". References must carry a compatible route.
   */
  readonly route: HarnessIntegrationRoute;
  /** Proven explicit Reference routes only; never failure-driven fallback. */
  readonly resumeRoutes?: readonly HarnessIntegrationRoute[];
  initialize(): Promise<void>;
  createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession>;
  resumeSession(options: AdapterResumeSessionOptions): Promise<AdapterSession>;
  listSessions(workspacePath: string): Promise<readonly AdapterListedSession[]>;
  close(): Promise<void>;
}

export function createOfficialHarnessRegistration(
  kind: HarnessKind,
  options: OfficialAdapterOptions,
  capabilities: HarnessCapabilities,
  workspaceConfigurator: WorkspaceConfigurator,
  create: (
    snapshot: OfficialAdapterOptions,
    context: LiveHarnessAdapterContext,
  ) => LiveHarnessAdapter,
): HarnessRegistration {
  if (!isHarnessKind(kind)) invalid("Unknown Harness Kind");
  validateOfficialAdapterOptions(options);
  if (!isFrozenHarnessCapabilities(capabilities)) {
    invalid("Official Adapter Capability Profile must be deeply frozen");
  }
  let capabilitySnapshot: HarnessCapabilities;
  try {
    capabilitySnapshot = snapshotHarnessCapabilities(capabilities);
  } catch (error) {
    invalid(error instanceof Error ? error.message : "Official Adapter requires valid Capabilities");
  }
  validateWorkspaceConfigurator(workspaceConfigurator);
  const snapshot: OfficialAdapterOptions = Object.freeze({
    ...options,
    ...(options.env ? { env: Object.freeze({ ...options.env }) } : {}),
  });
  return Object.freeze({
    [registrationMarker]: true,
    kind,
    options: snapshot,
    capabilities: capabilitySnapshot,
    workspaceConfigurator: Object.freeze({
      planSkill: workspaceConfigurator.planSkill,
      planMcpServer: workspaceConfigurator.planMcpServer,
    }),
    create: (context: LiveHarnessAdapterContext) => create(snapshot, context),
  }) as unknown as HarnessRegistration;
}

function validateWorkspaceConfigurator(
  configurator: WorkspaceConfigurator,
): void {
  if (!isWorkspaceConfigurator(configurator)) {
    invalid("Official Adapter requires a Workspace Configurator");
  }
}

function isWorkspaceConfigurator(value: unknown): value is WorkspaceConfigurator {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as WorkspaceConfigurator).planSkill === "function" &&
    typeof (value as WorkspaceConfigurator).planMcpServer === "function"
  );
}

function validateOfficialAdapterOptions(options: OfficialAdapterOptions): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    invalid("Official Adapter options must be an object");
  }
  const known = new Set(["env", "startupTimeoutMs", "shutdownTimeoutMs"]);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !known.has(key)) invalid(`Unknown Official Adapter option: ${String(key)}`);
  }
  validateTimeout(options.startupTimeoutMs, "startupTimeoutMs");
  validateTimeout(options.shutdownTimeoutMs, "shutdownTimeoutMs");
  if (options.env !== undefined) {
    if (
      typeof options.env !== "object" ||
      options.env === null ||
      Array.isArray(options.env)
    ) {
      invalid("Official Adapter env must be a record");
    }
    for (const value of Object.values(options.env)) {
      if (value !== undefined && typeof value !== "string") {
        invalid("Official Adapter env values must be strings or undefined");
      }
    }
  }
}

function validateTimeout(value: number | undefined, name: string): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    invalid(`${name} must be a positive safe integer`);
  }
}

function invalid(message: string): never {
  throw new MuhaError({ code: "INVALID_INPUT", message });
}

export function readOfficialHarnessRegistration(
  registration: HarnessRegistration,
): OfficialHarnessRegistration | undefined {
  if (
    typeof registration !== "object" ||
    registration === null ||
    !(registrationMarker in registration)
  ) {
    return undefined;
  }

  const candidate = registration as unknown as OfficialHarnessRegistration;
  return (
    candidate[registrationMarker] === true &&
    isHarnessKind(candidate.kind) &&
    typeof candidate.create === "function" &&
    isFrozenHarnessCapabilities(candidate.capabilities) &&
    isWorkspaceConfigurator(candidate.workspaceConfigurator) &&
    Object.isFrozen(candidate) &&
    Object.isFrozen(candidate.workspaceConfigurator)
  ) ? candidate : undefined;
}
