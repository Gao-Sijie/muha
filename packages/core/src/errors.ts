import type { HarnessKind } from "./index.js";
import type { CapabilityOperation, HarnessCapabilityPath } from "./capabilities.js";

export interface InvalidInputErrorData {
  readonly code: "INVALID_INPUT";
  readonly message: string;
}

export interface UnsupportedRuntimeErrorData {
  readonly code: "UNSUPPORTED_RUNTIME";
  readonly message: string;
  readonly runtime: "node";
  readonly version: string;
  readonly supportedRange: ">=22.20.0";
}

export interface UnsupportedPlatformErrorData {
  readonly code: "UNSUPPORTED_PLATFORM";
  readonly message: string;
  readonly platform: string;
  readonly architecture: string;
  readonly libc: string;
}

export interface RuntimeAlreadyActiveErrorData {
  readonly code: "RUNTIME_ALREADY_ACTIVE";
  readonly message: string;
}

export interface RuntimeClosedErrorData {
  readonly code: "RUNTIME_CLOSED";
  readonly message: string;
}

export interface HarnessNotEnabledErrorData {
  readonly code: "HARNESS_NOT_ENABLED";
  readonly message: string;
  readonly harness: HarnessKind;
}

export interface UnsupportedCapabilityErrorData {
  readonly code: "UNSUPPORTED_CAPABILITY";
  readonly message: string;
  readonly harness: HarnessKind;
  readonly capability: HarnessCapabilityPath;
  readonly operation: CapabilityOperation;
}

export interface DataDirLockedErrorData {
  readonly code: "DATA_DIR_LOCKED";
  readonly message: string;
  readonly dataDir: string;
}

export interface WorkspaceNotFoundErrorData {
  readonly code: "WORKSPACE_NOT_FOUND";
  readonly message: string;
  readonly workspacePath: string;
}

export interface WorkspaceIoErrorData {
  readonly code: "WORKSPACE_IO_ERROR";
  readonly message: string;
}

export interface SkillConfigurationErrorData {
  readonly code: "SKILL_CONFIGURATION_FAILED";
  readonly message: string;
}

export interface McpConfigurationErrorData {
  readonly code: "MCP_CONFIGURATION_FAILED";
  readonly message: string;
}

export interface SessionClosedErrorData {
  readonly code: "SESSION_CLOSED";
  readonly message: string;
}

export interface SessionNotFoundErrorData {
  readonly code: "SESSION_NOT_FOUND";
  readonly message: string;
  readonly harness: HarnessKind;
  readonly sessionId: string;
}

export interface SessionBusyErrorData {
  readonly code: "SESSION_BUSY";
  readonly message: string;
}

export interface TurnEventStreamAlreadyClaimedErrorData {
  readonly code: "TURN_EVENT_STREAM_ALREADY_CLAIMED";
  readonly message: string;
}

export interface AdapterProtocolErrorData {
  readonly code: "ADAPTER_PROTOCOL_ERROR";
  readonly message: string;
  readonly harness: HarnessKind;
}

export interface TurnInteractionNotFoundErrorData {
  readonly code: "TURN_INTERACTION_NOT_FOUND";
  readonly message: string;
  readonly interaction: "approval" | "question";
  readonly requestId: string;
}

export interface TurnInteractionAlreadyResolvedErrorData {
  readonly code: "TURN_INTERACTION_ALREADY_RESOLVED";
  readonly message: string;
  readonly interaction: "approval" | "question";
  readonly requestId: string;
}

export interface TurnInteractionInvalidatedErrorData {
  readonly code: "TURN_INTERACTION_INVALIDATED";
  readonly message: string;
  readonly interaction: "approval" | "question";
  readonly requestId: string;
}

export interface TurnEventBackpressureErrorData {
  readonly code: "TURN_EVENT_BACKPRESSURE";
  readonly message: string;
}

export interface TurnEventTooLargeErrorData {
  readonly code: "TURN_EVENT_TOO_LARGE";
  readonly message: string;
}

export interface HarnessErrorData {
  readonly code: "HARNESS_ERROR";
  readonly message: string;
  readonly harness: HarnessKind;
  readonly operation:
    | "initialize"
    | "createSession"
    | "resumeSession"
    | "listSessions"
    | "setModel"
    | "setEffort"
    | "startTurn"
    | "interruptTurn"
    | "respondToApproval"
    | "respondToQuestion"
    | "closeSession"
    | "closeHarness";
  readonly command?: string;
  readonly stage?: "spawn" | "handshake" | "ready" | "shutdown";
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly retryable?: boolean;
  readonly nativeCode?: string;
}

export interface EventStoreErrorData {
  readonly code: "EVENT_STORE_ERROR";
  readonly message: string;
  readonly operation: "open" | "write" | "commit" | "close";
}

export interface RuntimeInitializationFailedErrorData {
  readonly code: "RUNTIME_INITIALIZATION_FAILED";
  readonly message: string;
  readonly initializationFailures: readonly (
    | HarnessErrorData
    | EventStoreErrorData
  )[];
  readonly rollbackFailures: readonly (HarnessErrorData | EventStoreErrorData)[];
}

export interface RuntimeCloseFailedErrorData {
  readonly code: "RUNTIME_CLOSE_FAILED";
  readonly message: string;
  readonly failures: readonly (HarnessErrorData | EventStoreErrorData)[];
}

export type MuhaErrorData =
  | InvalidInputErrorData
  | UnsupportedRuntimeErrorData
  | UnsupportedPlatformErrorData
  | RuntimeAlreadyActiveErrorData
  | RuntimeClosedErrorData
  | DataDirLockedErrorData
  | HarnessNotEnabledErrorData
  | UnsupportedCapabilityErrorData
  | WorkspaceNotFoundErrorData
  | WorkspaceIoErrorData
  | SkillConfigurationErrorData
  | McpConfigurationErrorData
  | SessionNotFoundErrorData
  | SessionClosedErrorData
  | SessionBusyErrorData
  | TurnEventStreamAlreadyClaimedErrorData
  | AdapterProtocolErrorData
  | TurnInteractionNotFoundErrorData
  | TurnInteractionAlreadyResolvedErrorData
  | TurnInteractionInvalidatedErrorData
  | TurnEventBackpressureErrorData
  | TurnEventTooLargeErrorData
  | HarnessErrorData
  | EventStoreErrorData
  | RuntimeInitializationFailedErrorData
  | RuntimeCloseFailedErrorData;

export class MuhaError extends Error {
  readonly data: MuhaErrorData;

  constructor(data: MuhaErrorData) {
    super(data.message);
    this.name = "MuhaError";
    this.data = data;
  }
}

export function unsupportedCapabilityError(
  harness: HarnessKind,
  capability: HarnessCapabilityPath,
  operation: CapabilityOperation,
): MuhaError {
  return new MuhaError(unsupportedCapabilityErrorData(harness, capability, operation));
}

export function unsupportedCapabilityErrorData(
  harness: HarnessKind,
  capability: HarnessCapabilityPath,
  operation: CapabilityOperation,
): UnsupportedCapabilityErrorData {
  return Object.freeze({
    code: "UNSUPPORTED_CAPABILITY",
    message: `Harness ${harness} does not support ${capability}`,
    harness,
    capability,
    operation,
  });
}
