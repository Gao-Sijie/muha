import type { ApprovalPolicy } from "./session.js";

/** A lifecycle point at which callers may select a model or effort. */
export type SessionSelectionPoint =
  | "createSession"
  | "resumeSession"
  | "idleSession";

/** How a Session reports a selected value after the native Harness accepts it. */
export type CapabilityObservation = "selectedOnly" | "effective";

/** The public operation rejected when a required Capability is absent. */
export type CapabilityOperation =
  | "configureWorkspace"
  | "createSession"
  | "resumeSession"
  | "listSessions"
  | "setModel"
  | "setEffort"
  | "startTurn";

/** A stable path identifying one independently enforceable Capability. */
export type HarnessCapabilityPath =
  | "sessionListing"
  | "imageInput"
  | `approvalPolicy.${ApprovalPolicy}`
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
  | "turnUsage";

/** Model selection and observation behavior for one Harness. */
export interface ModelCapability {
  /** Lifecycle points at which the model option or setter is supported. */
  readonly selectionAt: readonly SessionSelectionPoint[];
  /** Whether Session state is merely selected or confirmed effective by the Harness. */
  readonly observation: CapabilityObservation;
}

/** Effort selection and observation behavior for one Harness. */
export interface EffortCapability {
  /** Lifecycle points at which the effort option or setter is supported. */
  readonly selectionAt: readonly SessionSelectionPoint[];
  /** Whether Session state is merely selected or confirmed effective by the Harness. */
  readonly observation: CapabilityObservation;
  /** Whether effort validation requires an already known model. */
  readonly requiresKnownModel: boolean;
}

/**
 * The immutable, JSON-safe declaration of variable behavior supported by an
 * enabled official Harness. Core Kernel behavior is deliberately absent.
 */
export interface HarnessCapabilities {
  /** Supports listing native Sessions in a Workspace. */
  readonly sessionListing: boolean;
  /** Accepts image parts in Turn input. */
  readonly imageInput: boolean;
  /** Exact Approval Policies accepted by create and resume. */
  readonly approvalPolicies: readonly [ApprovalPolicy, ...ApprovalPolicy[]];
  /** Supports structured Question request and resolution lifecycles. */
  readonly turnQuestions: boolean;
  /** Supports configuring Workspace Skills. */
  readonly workspaceSkills: boolean;
  /** Supports configuring Workspace MCP servers. */
  readonly workspaceMcp: boolean;
  /** Model selection points and observation semantics. */
  readonly model: ModelCapability;
  /** Effort selection points, observation semantics, and model dependency. */
  readonly effort: EffortCapability;
  /** Emits public Assistant Message lifecycle and delta events. */
  readonly assistantMessageStreaming: boolean;
  /** Emits public Assistant Reasoning delta events. */
  readonly assistantReasoningStreaming: boolean;
  /** Emits public Tool lifecycle and update events. */
  readonly toolEvents: boolean;
  /** Emits cumulative public Turn Usage updates. */
  readonly turnUsage: boolean;
}

const topLevelKeys = Object.freeze([
  "sessionListing",
  "imageInput",
  "approvalPolicies",
  "turnQuestions",
  "workspaceSkills",
  "workspaceMcp",
  "model",
  "effort",
  "assistantMessageStreaming",
  "assistantReasoningStreaming",
  "toolEvents",
  "turnUsage",
] as const);
const approvalPolicies = new Set<ApprovalPolicy>([
  "interactive",
  "autoApprove",
  "autoDeny",
  "harnessManaged",
]);
const selectionPoints = new Set<SessionSelectionPoint>([
  "createSession",
  "resumeSession",
  "idleSession",
]);
const observations = new Set<CapabilityObservation>(["selectedOnly", "effective"]);

export function snapshotHarnessCapabilities(value: HarnessCapabilities): HarnessCapabilities {
  validateCapabilities(value);
  return Object.freeze({
    sessionListing: value.sessionListing,
    imageInput: value.imageInput,
    approvalPolicies: Object.freeze([...value.approvalPolicies]) as readonly [
      ApprovalPolicy,
      ...ApprovalPolicy[],
    ],
    turnQuestions: value.turnQuestions,
    workspaceSkills: value.workspaceSkills,
    workspaceMcp: value.workspaceMcp,
    model: Object.freeze({
      selectionAt: Object.freeze([...value.model.selectionAt]),
      observation: value.model.observation,
    }),
    effort: Object.freeze({
      selectionAt: Object.freeze([...value.effort.selectionAt]),
      observation: value.effort.observation,
      requiresKnownModel: value.effort.requiresKnownModel,
    }),
    assistantMessageStreaming: value.assistantMessageStreaming,
    assistantReasoningStreaming: value.assistantReasoningStreaming,
    toolEvents: value.toolEvents,
    turnUsage: value.turnUsage,
  });
}

export function isFrozenHarnessCapabilities(value: unknown): value is HarnessCapabilities {
  try {
    validateCapabilities(value);
  } catch {
    return false;
  }
  const capabilities = value as HarnessCapabilities;
  return Object.isFrozen(capabilities) &&
    Object.isFrozen(capabilities.approvalPolicies) &&
    Object.isFrozen(capabilities.model) &&
    Object.isFrozen(capabilities.model.selectionAt) &&
    Object.isFrozen(capabilities.effort) &&
    Object.isFrozen(capabilities.effort.selectionAt);
}

function validateCapabilities(value: unknown): asserts value is HarnessCapabilities {
  assertRecord(value, "Harness Capabilities");
  assertExactKeys(value, topLevelKeys, "Harness Capabilities");
  for (const key of [
    "sessionListing",
    "imageInput",
    "turnQuestions",
    "workspaceSkills",
    "workspaceMcp",
    "assistantMessageStreaming",
    "assistantReasoningStreaming",
    "toolEvents",
    "turnUsage",
  ] as const) {
    if (typeof value[key] !== "boolean") throw new TypeError(`${key} must be a boolean`);
  }
  if (!Array.isArray(value.approvalPolicies) || value.approvalPolicies.length === 0) {
    throw new TypeError("approvalPolicies must be a non-empty array");
  }
  assertUniqueKnownValues(value.approvalPolicies, approvalPolicies, "approvalPolicies");
  validateSelectionCapability(value.model, "model");
  validateSelectionCapability(value.effort, "effort");
}

function validateSelectionCapability(
  value: unknown,
  name: "model" | "effort",
): void {
  assertRecord(value, name);
  assertExactKeys(
    value,
    name === "effort"
      ? ["selectionAt", "observation", "requiresKnownModel"]
      : ["selectionAt", "observation"],
    name,
  );
  if (!Array.isArray(value.selectionAt)) throw new TypeError(`${name}.selectionAt must be an array`);
  assertUniqueKnownValues(value.selectionAt, selectionPoints, `${name}.selectionAt`);
  if (!observations.has(value.observation as CapabilityObservation)) {
    throw new TypeError(`${name}.observation is unknown`);
  }
  if (name === "effort" && typeof value.requiresKnownModel !== "boolean") {
    throw new TypeError("effort.requiresKnownModel must be a boolean");
  }
}

function assertUniqueKnownValues<T>(
  values: readonly unknown[],
  allowed: ReadonlySet<T>,
  name: string,
): void {
  const seen = new Set<unknown>();
  for (const value of values) {
    if (!allowed.has(value as T)) throw new TypeError(`${name} contains an unknown value`);
    if (seen.has(value)) throw new TypeError(`${name} contains a duplicate value`);
    seen.add(value);
  }
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) throw new TypeError(`${name} contains unknown field: ${key}`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new TypeError(`${name} is missing field: ${key}`);
  }
}
