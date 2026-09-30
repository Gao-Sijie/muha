// Shared controlled-endpoint options for the ACP route tests.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexAdapter } from "@muha-sdk/codex-adapter";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";
import { decodeCodexAcpQuestion } from "../../../packages/codex-adapter/dist/acp-question.js";
import {
  AcpSessionDriver, createOfficialHarnessRegistration, readOfficialHarnessRegistration,
} from "../../../packages/core/dist/internal.js";

// Repository-only construction seam, never an official factory option or export.
// These controlled protocol scenarios do not establish real Harness admission.
function bindControlledEndpoint(factory, { acp }) {
  const registration = readOfficialHarnessRegistration(factory());
  return createOfficialHarnessRegistration(
    registration.kind, {}, registration.capabilities, registration.workspaceConfigurator,
    (_options, context) => new AcpSessionDriver(registration.kind, acp, context, {
      effortConfigId: registration.kind === "codex" ? "reasoning_effort" : "effort",
      classifyError: error => error.operation === "resumeSession" && error.nativeCode === "-32001" && error.message === "session_not_found"
        ? { ...error, nativeCode: "session_not_found" } : error,
      ...(registration.kind === "codex" ? { decodeQuestion: decodeCodexAcpQuestion } : {}),
      // This endpoint's fixed one-step usage follows the ACP schema literally.
      // Neither real Codex nor real OpenCode may use this fixture-only mapping:
      // their responses contain the last model step, not cumulative Turn usage.
      openTurn: async () => ({ settle: async result => ({
        ...(result.usage === undefined ? {} : { usage: {
          inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedReadTokens, reasoningTokens: result.usage.thoughtTokens,
        } }),
      }) }),
    }),
  );
}
export const controlledOpenCodeAdapter = (options) => bindControlledEndpoint(openCodeAdapter, options);
export const controlledCodexAdapter = (options) => bindControlledEndpoint(codexAdapter, options);

export const acpAgentPath = join(fileURLToPath(new URL(".", import.meta.url)), "acp-agent.mjs");

export function acpOptions(scenario = "normal", env = {}) {
  return {
    command: process.execPath,
    args: [scenario === "sdk-canonical" ? join(dirname(acpAgentPath), "sdk-agent.mjs") : acpAgentPath],
    env: { MUHA_FAKE_ACP_SCENARIO: scenario, ...env },
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
  };
}

export async function collectTurn(turn) {
  const events = [];
  for await (const event of turn) events.push(event);
  const result = await turn.result;
  return { events, result };
}

export function finalAssistantText(events) {
  const completed = events.filter((event) => event.type === "assistant.message.completed");
  return completed.at(-1)?.message?.text ?? completed.at(-1)?.text;
}

export { dirname, join };
