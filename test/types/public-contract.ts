import { codexAdapter } from "@muha-sdk/codex-adapter";
import type {
  AgentSession,
  ApprovalPolicy,
  CapabilityOperation,
  EffortCapability,
  HarnessCapabilities,
  HarnessCapabilityPath,
  HarnessKind,
  HarnessRegistration,
  McpServerConfig,
  ModelCapability,
  MuhaErrorData,
  MuhaRuntime,
  SessionSelectionPoint,
  SessionReference,
  OfficialAdapterOptions,
  UnsupportedCapabilityErrorData,
  WorkspaceConfigurationAttempt,
  TurnEvent,
  TurnResult,
} from "@muha-sdk/core";
import { createMuhaRuntime } from "@muha-sdk/core";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;

type ExpectedHarnessKinds = "codex" | "opencode" | "kimi" | "pi" | "agy";
type ExpectedApprovalPolicies =
  | "interactive"
  | "autoApprove"
  | "autoDeny"
  | "harnessManaged";
type ExpectedTurnEventKinds =
  | "turn.started"
  | "turn.retrying"
  | "assistant.message.started"
  | "assistant.message.delta"
  | "assistant.reasoning.delta"
  | "assistant.message.completed"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "usage.updated"
  | "approval.requested"
  | "approval.resolved"
  | "question.requested"
  | "question.resolved"
  | "turn.completed"
  | "turn.failed"
  | "turn.interrupted";
type ExpectedErrorCodes =
  | "INVALID_INPUT"
  | "UNSUPPORTED_PLATFORM"
  | "UNSUPPORTED_RUNTIME"
  | "RUNTIME_ALREADY_ACTIVE"
  | "RUNTIME_CLOSED"
  | "RUNTIME_INITIALIZATION_FAILED"
  | "RUNTIME_CLOSE_FAILED"
  | "DATA_DIR_LOCKED"
  | "HARNESS_NOT_ENABLED"
  | "UNSUPPORTED_CAPABILITY"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_IO_ERROR"
  | "SKILL_CONFIGURATION_FAILED"
  | "MCP_CONFIGURATION_FAILED"
  | "SESSION_NOT_FOUND"
  | "INVALID_SESSION_REFERENCE"
  | "UNSUPPORTED_ROUTE"
  | "SESSION_CLOSED"
  | "SESSION_BUSY"
  | "TURN_EVENT_STREAM_ALREADY_CLAIMED"
  | "TURN_INTERACTION_NOT_FOUND"
  | "TURN_INTERACTION_ALREADY_RESOLVED"
  | "TURN_INTERACTION_INVALIDATED"
  | "HARNESS_ERROR"
  | "ADAPTER_PROTOCOL_ERROR"
  | "EVENT_STORE_ERROR"
  | "TURN_EVENT_BACKPRESSURE"
  | "TURN_EVENT_TOO_LARGE";

type HarnessKindsAreClosed = Assert<Equal<HarnessKind, ExpectedHarnessKinds>>;
type OfficialOptionsAreClosed = Assert<Equal<keyof OfficialAdapterOptions, "env" | "startupTimeoutMs" | "shutdownTimeoutMs">>;
type ReferenceFieldsAreExact = Assert<Equal<keyof SessionReference, "harness" | "sessionId" | "workspacePath" | "route">>;
type ReferenceRouteIsRequired = Assert<Equal<SessionReference["route"], "native" | "acp" | "combined">>;
// @ts-expect-error Retired three-field references are not supported.
const retiredReference: SessionReference = { harness: "codex", sessionId: "s", workspacePath: "/tmp" };
// @ts-expect-error There is no public Reference format marker.
const versionedReference: SessionReference = { harness: "codex", sessionId: "s", workspacePath: "/tmp", route: "native", formatVersion: 2 };
type ApprovalPoliciesAreClosed = Assert<Equal<ApprovalPolicy, ExpectedApprovalPolicies>>;
type SelectionPointsAreClosed = Assert<Equal<
  SessionSelectionPoint,
  "createSession" | "resumeSession" | "idleSession"
>>;
type CapabilityOperationsAreClosed = Assert<Equal<
  CapabilityOperation,
  | "configureWorkspace"
  | "createSession"
  | "resumeSession"
  | "listSessions"
  | "setModel"
  | "setEffort"
  | "startTurn"
>>;
type CapabilityPathsAreClosed = Assert<Equal<
  HarnessCapabilityPath,
  | "sessionListing"
  | "imageInput"
  | `approvalPolicy.${ExpectedApprovalPolicies}`
  | "turnQuestions"
  | "workspaceSkills"
  | "workspaceMcp"
  | `model.selectionAt.${SessionSelectionPoint}`
  | "model.effectiveObservation"
  | `effort.selectionAt.${SessionSelectionPoint}`
  | "effort.effectiveObservation"
  | "assistantMessageStreaming"
  | "assistantReasoningStreaming"
  | "toolEvents"
  | "turnUsage"
>>;
type TurnEventsAreClosed = Assert<Equal<TurnEvent["type"], ExpectedTurnEventKinds>>;
type ErrorsAreClosed = Assert<Equal<MuhaErrorData["code"], ExpectedErrorCodes>>;
type UnsupportedCapabilityFieldsAreExact = Assert<Equal<
  keyof UnsupportedCapabilityErrorData,
  "code" | "message" | "harness" | "capability" | "operation"
>>;
type WorkspaceFailureCodes = Extract<
  WorkspaceConfigurationAttempt,
  { status: "failed" }
>["error"]["code"];
type WorkspaceFailureUnionIsWidened = Assert<Equal<
  WorkspaceFailureCodes,
  "SKILL_CONFIGURATION_FAILED" | "MCP_CONFIGURATION_FAILED" | "UNSUPPORTED_CAPABILITY"
>>;
type TurnResultsAreValues = Assert<Equal<TurnResult["status"], "completed" | "failed" | "interrupted">>;

declare const registration: HarnessRegistration;
declare const runtime: MuhaRuntime;
declare const session: AgentSession;
declare const capabilities: HarnessCapabilities;
declare const modelCapability: ModelCapability;
declare const effortCapability: EffortCapability;

void createMuhaRuntime({ harnesses: [registration] });
void runtime.getHarnessCapabilities("codex");
void capabilities.approvalPolicies;
void modelCapability.selectionAt;
void effortCapability.requiresKnownModel;
// @ts-expect-error Runtime has no native option passthrough.
void createMuhaRuntime({ harnesses: [registration], reasoningEffort: "high" });
// @ts-expect-error Registration options are closed.
void codexAdapter({ executable: "/tmp/codex" });
// @ts-expect-error Test endpoint injection is not part of the official options.
void codexAdapter({ acp: { command: "codex-acp" } });
// @ts-expect-error Workspace options contain only Workspace configuration fields.
void runtime.configureWorkspace({ workspacePath: "/tmp", approvalPolicy: "interactive" });
// @ts-expect-error Session creation has no system-prompt passthrough.
void runtime.createSession({ harness: "codex", workspacePath: "/tmp", systemPrompt: "x" });
// @ts-expect-error Session creation has no Turn-level timeout passthrough.
void runtime.createSession({ harness: "codex", workspacePath: "/tmp", timeoutMs: 1 });
void runtime.createSession({ harness: "codex", workspacePath: "/tmp", effort: "high" });
void runtime.createSession({
  harness: "codex",
  workspacePath: "/tmp",
  approvalPolicy: "harnessManaged",
});
void runtime.createSession({
  harness: "opencode",
  workspacePath: "/tmp",
  turnRetryPolicy: { maxRetries: 1 },
});
void runtime.resumeSession({
  reference: { harness: "opencode", sessionId: "s", workspacePath: "/tmp", route: "native" },
  turnRetryPolicy: { maxRetries: 10 },
});
// @ts-expect-error Retry backoff is intentionally Core-owned.
void runtime.createSession({ harness: "opencode", workspacePath: "/tmp", turnRetryPolicy: { maxRetries: 1, delayMs: 10 } });
void runtime.resumeSession({
  reference: { harness: "codex", sessionId: "s", workspacePath: "/tmp", route: "native" },
  effort: "high",
  // @ts-expect-error Session resumption cannot replace its Workspace path.
  workspacePath: "/other",
});
// @ts-expect-error Session listing has no pagination passthrough.
void runtime.listSessions({ harness: "codex", workspacePath: "/tmp", limit: 1 });
// @ts-expect-error Turn text parts do not accept Harness-specific fields.
void session.startTurn([{ type: "text", text: "x", reasoningEffort: "high" }]);
// @ts-expect-error Turn input has no Effort option; Effort is a Session selection.
void session.startTurn([{ type: "text", text: "x", effort: "high" }]);

declare const sessionEffort: string | undefined;
void sessionEffort;
declare const setEffort: typeof session.setEffort;
void setEffort;

const portableMcp: McpServerConfig = {
  name: "local",
  transport: "stdio",
  command: "local-mcp",
};
void portableMcp;
const nativeMcp: McpServerConfig = {
  name: "local",
  transport: "stdio",
  command: "local-mcp",
  // @ts-expect-error MCP input has no native timeout passthrough.
  timeout: 1,
};
void nativeMcp;

export type PublicContractAssertions =
  | HarnessKindsAreClosed
  | ApprovalPoliciesAreClosed
  | SelectionPointsAreClosed
  | CapabilityOperationsAreClosed
  | CapabilityPathsAreClosed
  | TurnEventsAreClosed
  | ErrorsAreClosed
  | UnsupportedCapabilityFieldsAreExact
  | WorkspaceFailureUnionIsWidened
  | TurnResultsAreValues
;
