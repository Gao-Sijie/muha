declare const harnessRegistrationBrand: unique symbol;

export type { HarnessKind } from "./harness-catalog.js";

export interface OfficialAdapterOptions {
  /** Overrides for the native Harness process environment only. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface HarnessRegistration {
  readonly [harnessRegistrationBrand]: true;
}

export type {
  CapabilityObservation,
  CapabilityOperation,
  EffortCapability,
  HarnessCapabilities,
  HarnessCapabilityPath,
  ModelCapability,
  SessionSelectionPoint,
} from "./capabilities.js";

export type { HarnessIntegrationRoute } from "./session.js";
export {
  parseSessionReference,
  serializeSessionReference,
  createSessionReference,
  referenceRoute,
  HARNESS_INTEGRATION_ROUTES,
} from "./reference.js";

export {
  MuhaError,
  type DataDirLockedErrorData,
  type EventStoreErrorData,
  type HarnessErrorData,
  type InvalidSessionReferenceErrorData,
  type McpConfigurationErrorData,
  type MuhaErrorData,
  type RuntimeCloseFailedErrorData,
  type RuntimeInitializationFailedErrorData,
  type SessionNotFoundErrorData,
  type SkillConfigurationErrorData,
  type UnsupportedCapabilityErrorData,
  type UnsupportedRouteErrorData,
} from "./errors.js";
export {
  createMuhaRuntime,
  type MuhaRuntime,
  type MuhaRuntimeConfig,
  type ConfigureWorkspaceOptions,
  type ConfigureWorkspaceResult,
  type CreateSessionOptions,
  type ResumeSessionOptions,
  type ListSessionsOptions,
  type McpServerConfig,
  type RuntimeTermination,
  type SkillSource,
  type WorkspaceConfigurationAttempt,
} from "./runtime.js";
export type {
  AgentSession,
  AgentSessionStatus,
  ApprovalDecision,
  ApprovalPolicy,
  QuestionAnswer,
  QuestionCondition,
  QuestionInput,
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
  QuestionValue,
  AssistantMessage,
  ImageMediaType,
  ImageTurnContentPart,
  CompletedTurnResult,
  FailedTurnResult,
  InterruptedTurnResult,
  JsonValue,
  SessionReference,
  ListedSession,
  TextTurnContentPart,
  TurnContentPart,
  TurnEvent,
  TurnHandle,
  TurnInput,
  TurnFailure,
  TurnInterruptionReason,
  TurnResult,
  TurnRetryPolicy,
  TurnUsage,
} from "./session.js";
