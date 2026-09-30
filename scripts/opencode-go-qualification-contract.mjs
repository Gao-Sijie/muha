export const qualificationTimeoutMs = 360_000;

export function isOpenCodeGoModel(model) {
  return typeof model === "string" && /^opencode-go\/[^\s/][^\s]*$/.test(model);
}

export function emptyQualificationMetrics() {
  return {
    assistantMessages: 0,
    toolStarts: 0,
    toolCompletions: 0,
    approvalRequests: 0,
    questions: 0,
    toolErrors: 0,
    taskTestsPassed: null,
    nativeCallIdReused: null,
    toolConcurrency: false,
  };
}
