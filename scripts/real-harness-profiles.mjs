import { codexAdapter } from "@muha-sdk/codex-adapter";
import { OFFICIAL_HARNESS_KINDS } from "@muha-sdk/core/internal";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";
import { piAdapter } from "@muha-sdk/pi-adapter";
import { agyAdapter } from "@muha-sdk/agy-adapter";

const profiles = Object.freeze([
  Object.freeze({ harness: "codex", command: "codex", registration: codexAdapter,
    qualificationModel: "gpt-5.6-luna", qualificationEffort: "low", qualificationIdleEffort: "medium" }),
  Object.freeze({
    harness: "opencode",
    command: "opencode",
    registration: openCodeAdapter,
    qualificationModel: "opencode-go/deepseek-v4.1-flash",
    qualificationEffort: "high",
    qualificationIdleEffort: "low",
  }),
  Object.freeze({ harness: "kimi", command: "kimi", registration: kimiAdapter,
    qualificationModel: "deepseek/deepseek-flash", qualificationEffort: "low", qualificationIdleEffort: "high" }),
  Object.freeze({ harness: "pi", registration: piAdapter,
    qualificationModel: "opencode-go/deepseek-v4.1-flash",
    qualificationImageModel: "opencode-go/qwen3.8-flash", qualificationEffort: "low", qualificationIdleEffort: "high" }),
  Object.freeze({ harness: "agy", command: "agy", registration: agyAdapter,
    qualificationModel: "claude-sonnet-4-6", qualificationEffort: null }),
]);
const byKind = new Map(profiles.map((profile) => [profile.harness, profile]));

export const REAL_HARNESS_QUALIFICATION_PROFILES = Object.freeze(
  OFFICIAL_HARNESS_KINDS.map((kind) => byKind.get(kind)),
);

export function qualificationProfileFor(value) {
  return typeof value === "string" ? byKind.get(value) : undefined;
}

export function qualificationModelForMode(profile, mode) {
  return mode === "--image" ? profile.qualificationImageModel ?? profile.qualificationModel : profile.qualificationModel;
}

export function qualificationTurnRetryPolicy(profile) {
  return profile.harness === "pi" ? { maxRetries: 3 } : undefined;
}
