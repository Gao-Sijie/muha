import type {
  HarnessCapabilities,
  HarnessRegistration,
  OfficialAdapterOptions,
} from "@muha-sdk/core";
import {
  composeWorkspaceConfigurator,
  createAddMcpPlanner,
  createOfficialHarnessRegistration,
  createSkillsCliPlanner,
} from "@muha-sdk/core/internal";

import { CodexProcess } from "./codex-process.js";

const capabilities = Object.freeze({
  sessionListing: true,
  imageInput: true,
  approvalPolicies: Object.freeze(["interactive", "autoApprove", "autoDeny"]),
  turnQuestions: true,
  workspaceSkills: true,
  workspaceMcp: true,
  model: Object.freeze({
    selectionAt: Object.freeze(["createSession", "resumeSession", "idleSession"] as const),
    observation: "effective",
  }),
  effort: Object.freeze({
    selectionAt: Object.freeze(["createSession", "resumeSession", "idleSession"] as const),
    observation: "selectedOnly",
    requiresKnownModel: false,
  }),
  assistantMessageStreaming: true,
  assistantReasoningStreaming: true,
  toolEvents: true,
  turnUsage: true,
} as const satisfies HarnessCapabilities);

export type { OfficialAdapterOptions } from "@muha-sdk/core";

const workspaceConfigurator = composeWorkspaceConfigurator({
  planSkill: createSkillsCliPlanner("codex"),
  planMcpServer: createAddMcpPlanner("codex"),
});

export function codexAdapter(
  options: OfficialAdapterOptions = {},
): HarnessRegistration {
  return createOfficialHarnessRegistration(
    "codex",
    options,
    capabilities,
    workspaceConfigurator,
    (snapshot, context) => new CodexProcess(snapshot, context),
  );
}
