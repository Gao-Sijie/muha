import type { HarnessCapabilities, HarnessRegistration, OfficialAdapterOptions } from "@muha-sdk/core";
import { createOfficialHarnessRegistration, createSkillsCliPlanner } from "@muha-sdk/core/internal";
import { PiProcess } from "./pi-process.js";

// Stage-four target Profile. The complete suites and real-Harness gates in #85
// must pass before this development package can be formally admitted.
const capabilities = Object.freeze({
  sessionListing: true, imageInput: true,
  approvalPolicies: Object.freeze(["autoApprove", "harnessManaged"] as const),
  turnQuestions: false, workspaceSkills: true, workspaceMcp: false,
  model: Object.freeze({ selectionAt: Object.freeze(["createSession", "resumeSession", "idleSession"] as const), observation: "effective" }),
  effort: Object.freeze({ selectionAt: Object.freeze(["createSession", "resumeSession", "idleSession"] as const), observation: "effective", requiresKnownModel: true }),
  assistantMessageStreaming: true, assistantReasoningStreaming: true, toolEvents: true, turnUsage: true,
} satisfies HarnessCapabilities);

export type { OfficialAdapterOptions } from "@muha-sdk/core";
export function piAdapter(options: OfficialAdapterOptions = {}): HarnessRegistration {
  return createOfficialHarnessRegistration("pi", options, capabilities, {
    planSkill: createSkillsCliPlanner("pi"),
    planMcpServer() { throw new Error("Pi Workspace MCP is not supported"); },
  }, (snapshot, context) => new PiProcess(snapshot, context));
}
