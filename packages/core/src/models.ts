import { MuhaError } from "./errors.js";
import type { HarnessKind } from "./harness-catalog.js";

/** A chat model reported as selectable by the native Harness, not an inference guarantee. */
export interface HarnessModelInfo {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly supportedEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

/** Validate the Adapter boundary and retain only public, JSON-safe catalog fields. */
export function snapshotHarnessModels(harness: HarnessKind, value: unknown): readonly HarnessModelInfo[] {
  const fail = (): never => { throw new MuhaError({
    code: "ADAPTER_PROTOCOL_ERROR", harness, message: "Harness returned an invalid or conflicting Model catalog",
  }); };
  const identifier = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.trim() === value && !/[\r\n\t\0]/u.test(value);
  if (!Array.isArray(value)) return fail();
  const models = new Map<string, HarnessModelInfo>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !identifier(entry.id)) return fail();
    if (entry.name !== undefined && typeof entry.name !== "string") return fail();
    if (entry.description !== undefined && typeof entry.description !== "string") return fail();
    if (entry.supportedEfforts !== undefined && (!Array.isArray(entry.supportedEfforts) ||
        !entry.supportedEfforts.every(identifier) || new Set(entry.supportedEfforts).size !== entry.supportedEfforts.length)) return fail();
    if (entry.defaultEffort !== undefined && (!identifier(entry.defaultEffort) ||
        (entry.supportedEfforts !== undefined && !entry.supportedEfforts.includes(entry.defaultEffort)))) return fail();
    const model: HarnessModelInfo = Object.freeze({
      id: entry.id,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.supportedEfforts === undefined ? {} : { supportedEfforts: Object.freeze([...entry.supportedEfforts]) }),
      ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort }),
    });
    const previous = models.get(model.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(model)) return fail();
    models.set(model.id, model);
  }
  return Object.freeze([...models.values()]);
}
