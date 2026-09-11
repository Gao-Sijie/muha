import type {
  HarnessCapabilities,
  HarnessRegistration,
  OfficialAdapterOptions,
} from "@muha-sdk/core";
import {
  composeWorkspaceConfigurator,
  createOfficialHarnessRegistration,
  createSkillsCliPlanner,
} from "@muha-sdk/core/internal";
import { KimiProcess } from "./kimi-process.js";
import { planKimiMcpServer } from "./workspace-configurator.js";

const capabilities = Object.freeze({
  sessionListing: true,
  imageInput: true,
  approvalPolicies: Object.freeze(["interactive", "autoApprove", "autoDeny"]),
  turnQuestions: true,
  workspaceSkills: true,
  workspaceMcp: true,
  model: Object.freeze({
    selectionAt: Object.freeze(["createSession", "resumeSession", "idleSession"] as const),
    observation: "selectedOnly",
  }),
  effort: Object.freeze({
    selectionAt: Object.freeze(["createSession", "resumeSession", "idleSession"] as const),
    observation: "selectedOnly",
    requiresKnownModel: true,
  }),
  assistantMessageStreaming: true,
  assistantReasoningStreaming: true,
  toolEvents: true,
  turnUsage: true,
} as const satisfies HarnessCapabilities);

export type { OfficialAdapterOptions } from "@muha-sdk/core";

const workspaceConfigurator = composeWorkspaceConfigurator({
  planSkill: createSkillsCliPlanner("kimi-code-cli"),
  planMcpServer: planKimiMcpServer,
});

export function kimiAdapter(
  options: OfficialAdapterOptions = {},
): HarnessRegistration {
  return createOfficialHarnessRegistration(
    "kimi",
    options,
    capabilities,
    workspaceConfigurator,
    (snapshot, context) => new KimiProcess(snapshot, context),
  );
}
