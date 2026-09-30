import { codexAdapter } from "@muha-sdk/codex-adapter";
import { OFFICIAL_HARNESS_KINDS } from "@muha-sdk/core/internal";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";
import { piAdapter } from "@muha-sdk/pi-adapter";
import { agyAdapter } from "@muha-sdk/agy-adapter";

const factories = Object.freeze({
  codex: codexAdapter,
  opencode: openCodeAdapter,
  kimi: kimiAdapter,
  pi: piAdapter,
  agy: agyAdapter,
});

export const OFFICIAL_HARNESS_TEST_PROFILES = Object.freeze(
  OFFICIAL_HARNESS_KINDS.map((harness) => Object.freeze({
    harness,
    registration: factories[harness],
  })),
);

export function createConformanceProfiles(specifications) {
  const keys = Object.keys(specifications);
  const missing = OFFICIAL_HARNESS_KINDS.filter((kind) => !(kind in specifications));
  const unexpected = keys.filter((kind) => !OFFICIAL_HARNESS_KINDS.includes(kind));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Conformance profile coverage mismatch (missing: ${missing.join(", ") || "none"}; ` +
      `unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }
  return Object.freeze(OFFICIAL_HARNESS_TEST_PROFILES.map((profile) => Object.freeze({
    ...profile,
    ...specifications[profile.harness],
  })));
}
