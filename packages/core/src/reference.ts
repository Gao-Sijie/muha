// One closed Session Reference format (ADR-0135). Never infer or migrate a route.
import { isAbsolute } from "node:path";
import { isHarnessKind, type HarnessKind } from "./harness-catalog.js";
import { invalidSessionReference } from "./errors.js";

export type HarnessIntegrationRoute = "native" | "acp" | "combined";

export const HARNESS_INTEGRATION_ROUTES = Object.freeze([
  "native",
  "acp",
  "combined",
] as const);

export interface SessionReference {
  readonly harness: HarnessKind;
  readonly sessionId: string;
  readonly workspacePath: string;
  /** Muha-selected integration identity, retained for native Session resumption. */
  readonly route: HarnessIntegrationRoute;
}

export function isHarnessIntegrationRoute(value: unknown): value is HarnessIntegrationRoute {
  return typeof value === "string" && (HARNESS_INTEGRATION_ROUTES as readonly string[]).includes(value);
}

export function assertValidRoute(route: unknown): asserts route is HarnessIntegrationRoute {
  if (!isHarnessIntegrationRoute(route)) {
    throw invalidSessionReference("Session Reference route must be one of native/acp/combined", "unknown-route");
  }
}

function requireField(reference: Record<string, unknown>, key: string, reason: string): string {
  const value = reference[key];
  if (!Object.hasOwn(reference, key) || typeof value !== "string" || value.length === 0) {
    throw invalidSessionReference(`Session Reference field "${key}" must be a non-empty string`, reason);
  }
  return value;
}

/**
 * Validate the single JSON-safe Reference format. Retired formats and extra
 * fields are rejected, never upgraded or silently stripped. Returns a frozen
 * snapshot so asynchronous resume cannot observe a caller mutation.
 */
export function parseSessionReference(value: unknown): SessionReference {
  if (typeof value !== "object" || value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw invalidSessionReference("Session Reference must be a plain object", "not-an-object");
  }
  const record = value as Record<string, unknown>;
  const keys = ["harness", "sessionId", "workspacePath", "route"];
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !keys.includes(key)) {
      throw invalidSessionReference("Session Reference contains an unknown field", "unknown-field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw invalidSessionReference("Session Reference fields must be JSON data properties", "invalid-field");
    }
  }
  const harness = requireField(record, "harness", "missing-harness");
  const sessionId = requireField(record, "sessionId", "missing-session-id");
  const workspacePath = requireField(record, "workspacePath", "missing-workspace-path");
  if (!isHarnessKind(harness)) {
    throw invalidSessionReference(`Unknown Harness Kind: ${harness}`, "unknown-harness");
  }
  if (!isAbsolute(workspacePath)) {
    throw invalidSessionReference("Session Reference workspacePath must be absolute", "non-absolute-workspace");
  }
  const route = record.route;
  if (!Object.hasOwn(record, "route") || !isHarnessIntegrationRoute(route)) {
    throw invalidSessionReference("Session Reference route must be one of native/acp/combined", "unknown-route");
  }
  return Object.freeze({
    harness,
    sessionId,
    workspacePath,
    route,
  });
}

/**
 * Build the same validated Reference shape accepted by every public entrypoint.
 */
export function createSessionReference(
  harness: HarnessKind,
  sessionId: string,
  workspacePath: string,
  route: HarnessIntegrationRoute,
): SessionReference {
  return parseSessionReference({ harness, sessionId, workspacePath, route });
}

/**
 * JSON-safe serialization that round-trips through parseSessionReference.
 */
export function serializeSessionReference(reference: SessionReference): string {
  return JSON.stringify(parseSessionReference(reference));
}

/**
 * Read the explicit Muha route only after validating the complete Reference.
 */
export function referenceRoute(reference: SessionReference): HarnessIntegrationRoute {
  return parseSessionReference(reference).route;
}
