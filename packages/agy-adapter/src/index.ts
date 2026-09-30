import type { HarnessCapabilities, HarnessRegistration, OfficialAdapterOptions } from "@muha-sdk/core";
import { composeWorkspaceConfigurator, createOfficialHarnessRegistration, createSkillsCliPlanner } from "@muha-sdk/core/internal";
import { AgyProcess } from "./agy-process.js";

// Stage-five target declaration; admission additionally requires the complete
// Conformance matrix and real CLI / Orchestrator qualification in #1.
const capabilities = Object.freeze({
  sessionListing: false, imageInput: false,
  approvalPolicies: Object.freeze(["harnessManaged", "autoApprove"] as const),
  turnQuestions: false, workspaceSkills: true, workspaceMcp: false,
  model: Object.freeze({ selectionAt: Object.freeze(["createSession", "resumeSession"] as const), observation: "selectedOnly" }),
  effort: Object.freeze({ selectionAt: Object.freeze(["createSession", "resumeSession"] as const), observation: "selectedOnly", requiresKnownModel: false }),
  assistantMessageStreaming: true, assistantReasoningStreaming: false, toolEvents: true, turnUsage: true,
} satisfies HarnessCapabilities);

export type { OfficialAdapterOptions } from "@muha-sdk/core";
export function agyAdapter(options: OfficialAdapterOptions = {}): HarnessRegistration {
  return createOfficialHarnessRegistration("agy", options, capabilities,
    composeWorkspaceConfigurator({
      planSkill: createSkillsCliPlanner("antigravity-cli"),
      planMcpServer() { throw new Error("AGY Workspace MCP is not supported"); },
    }),
    (snapshot, context) => new AgyProcess(snapshot, context));
}
