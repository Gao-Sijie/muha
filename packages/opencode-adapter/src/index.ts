import type {
  HarnessCapabilities,
  HarnessRegistration,
  OfficialAdapterOptions,
} from "@muha-sdk/core";
import { fileURLToPath } from "node:url";
import {
  composeWorkspaceConfigurator,
  createOfficialHarnessRegistration,
  createSkillsCliPlanner,
} from "@muha-sdk/core/internal";
import { OpenCodeProcess } from "./opencode-process.js";

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
  planSkill: createSkillsCliPlanner("opencode"),
  planMcpServer: (input) => ({
    entrypoint: fileURLToPath(new URL("./workspace-mcp-v2-worker.js", import.meta.url)),
    args: [],
    stdin: JSON.stringify(input),
  }),
});

export function openCodeAdapter(
  options: OfficialAdapterOptions = {},
): HarnessRegistration {
  return createOfficialHarnessRegistration(
    "opencode",
    options,
    capabilities,
    workspaceConfigurator,
    (snapshot, context) => new OpenCodeProcess(snapshot, context),
  );
}
