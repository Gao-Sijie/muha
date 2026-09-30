export const OFFICIAL_HARNESS_KINDS = Object.freeze([
  "codex",
  "opencode",
  "kimi",
  "pi",
  "agy",
] as const);

export type HarnessKind = (typeof OFFICIAL_HARNESS_KINDS)[number];

const officialHarnessKinds = new Set<unknown>(OFFICIAL_HARNESS_KINDS);

export function isHarnessKind(value: unknown): value is HarnessKind {
  return officialHarnessKinds.has(value);
}
