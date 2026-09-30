export const FULL_HARNESS_CAPABILITIES = Object.freeze({
  sessionListing: true,
  imageInput: true,
  approvalPolicies: Object.freeze(["interactive", "autoApprove", "autoDeny"]),
  turnQuestions: true,
  workspaceSkills: true,
  workspaceMcp: true,
  model: Object.freeze({
    selectionAt: Object.freeze(["createSession", "resumeSession", "idleSession"]),
    observation: "effective",
  }),
  effort: Object.freeze({
    selectionAt: Object.freeze(["createSession", "resumeSession", "idleSession"]),
    observation: "selectedOnly",
    requiresKnownModel: false,
  }),
  assistantMessageStreaming: true,
  assistantReasoningStreaming: true,
  toolEvents: true,
  turnUsage: true,
});
