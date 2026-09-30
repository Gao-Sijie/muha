import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

import {
  emptyQualificationMetrics,
  isOpenCodeGoModel,
} from "./opencode-go-qualification-contract.mjs";

const model = process.argv[2];
if (isMain()) {
  if (!isOpenCodeGoModel(model)) {
    process.exitCode = 64;
  } else {
    const result = await qualify(model);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

function isMain() {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

async function qualify(selectedModel) {
  const startedAt = Date.now();
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-go-tools-"));
  const workspace = join(root, "workspace");
  const fixture = new URL("../test/fixtures/opencode-go-tool-stress", import.meta.url);
  let runtime;
  let session;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await session?.close().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  const terminate = () => {
    void cleanup().finally(() => process.exit(143));
  };
  process.once("SIGTERM", terminate);
  try {
    await cp(fixture, workspace, { recursive: true });
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter()],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      model: selectedModel,
      approvalPolicy: "interactive",
      turnRetryPolicy: { maxRetries: 0 },
    });
    let turn;
    try {
      turn = await session.startTurn([{
        type: "text",
        text: [
          "Read TASK.md and repair this project autonomously.",
          "Use tools iteratively: run tests, inspect each relevant module, edit production code, and rerun checks.",
          "Do not use the network or add dependencies. If you cannot finish, report what remains.",
        ].join("\n"),
      }]);
    } catch (error) {
      if (!(error instanceof MuhaError)) throw error;
      return commandFailure(error.data, Date.now() - startedAt);
    }
    const observation = await observeTurn(turn);
    observation.metrics.taskTestsPassed = runFixtureTests(workspace);
    return classify(observation, Date.now() - startedAt);
  } catch (error) {
    if (!(error instanceof MuhaError)) throw error;
    return commandFailure(error.data, Date.now() - startedAt);
  } finally {
    process.off("SIGTERM", terminate);
    await cleanup();
  }
}

export async function observeTurn(turn) {
  const assistantMessages = new Set();
  const activeMessages = new Set();
  const tools = new Map();
  const toolMessages = new Set();
  const pendingApprovals = new Set();
  const pendingQuestions = new Set();
  const violations = [];
  const metrics = emptyQualificationMetrics();
  let activeToolCount = 0;
  let terminalType;
  let lastEventType;

  for await (const event of turn) {
    lastEventType = event.type;
    if (terminalType !== undefined) violations.push("event_after_terminal");
    if (event.type === "assistant.message.started") {
      if (assistantMessages.has(event.messageId)) violations.push("duplicate_assistant_start");
      assistantMessages.add(event.messageId);
      activeMessages.add(event.messageId);
    } else if (event.type === "assistant.message.completed") {
      if (!activeMessages.delete(event.message.id)) violations.push("assistant_completion_without_start");
    } else if (event.type === "tool.started") {
      if (tools.has(event.toolCallId)) violations.push("duplicate_tool_start");
      const messageId = [...activeMessages].at(-1);
      if (messageId === undefined) violations.push("tool_without_assistant_message");
      else toolMessages.add(messageId);
      if (activeToolCount > 0) metrics.toolConcurrency = true;
      activeToolCount += 1;
      tools.set(event.toolCallId, { completed: false });
      metrics.toolStarts += 1;
    } else if (event.type === "tool.updated") {
      if (!tools.has(event.toolCallId) || tools.get(event.toolCallId).completed) {
        violations.push("tool_update_without_active_start");
      }
    } else if (event.type === "tool.completed") {
      const tool = tools.get(event.toolCallId);
      if (!tool || tool.completed) violations.push("tool_completion_without_active_start");
      else {
        tool.completed = true;
        activeToolCount -= 1;
      }
      metrics.toolCompletions += 1;
      if (event.isError) metrics.toolErrors += 1;
    } else if (event.type === "approval.requested") {
      if (pendingApprovals.has(event.requestId)) violations.push("duplicate_approval_request");
      if (event.toolCallId !== undefined && !tools.has(event.toolCallId)) {
        violations.push("approval_unknown_tool");
      }
      pendingApprovals.add(event.requestId);
      metrics.approvalRequests += 1;
      await turn.respondToApproval(event.requestId, "allowOnce");
    } else if (event.type === "approval.resolved") {
      if (!pendingApprovals.delete(event.requestId)) violations.push("approval_resolution_without_request");
    } else if (event.type === "question.requested") {
      if (pendingQuestions.has(event.requestId)) violations.push("duplicate_question_request");
      if (event.toolCallId !== undefined && !tools.has(event.toolCallId)) {
        violations.push("question_unknown_tool");
      }
      pendingQuestions.add(event.requestId);
      metrics.questions += 1;
      await turn.respondToQuestion(event.requestId, { action: "dismiss" });
    } else if (event.type === "question.resolved") {
      if (!pendingQuestions.delete(event.requestId)) violations.push("question_resolution_without_request");
    } else if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) {
      if (terminalType !== undefined) violations.push("duplicate_terminal");
      terminalType = event.type;
    }
  }

  metrics.assistantMessages = assistantMessages.size;
  if ([...tools.values()].some(({ completed }) => !completed)) violations.push("missing_tool_completion");
  if (activeMessages.size > 0) violations.push("missing_assistant_completion");
  if (pendingApprovals.size > 0) violations.push("missing_approval_resolution");
  if (pendingQuestions.size > 0) violations.push("missing_question_resolution");
  if (terminalType !== lastEventType) violations.push("terminal_not_last");
  return {
    result: await turn.result,
    terminalType,
    toolMessageCount: toolMessages.size,
    violations,
    metrics,
  };
}

export function classify(observation, durationMs) {
  const { result, terminalType, toolMessageCount, violations, metrics } = observation;
  const expectedTerminal = result.status === "completed"
    ? "turn.completed"
    : result.status === "failed"
      ? "turn.failed"
      : "turn.interrupted";
  if (terminalType !== expectedTerminal) violations.push("event_result_mismatch");
  if (result.status === "failed" && result.error.code === "ADAPTER_PROTOCOL_ERROR") {
    return { classification: "FAIL", category: "adapter_protocol_error", durationMs, metrics };
  }
  if (violations.length > 0) {
    return {
      classification: "FAIL",
      category: violations.includes("event_result_mismatch")
        ? "event_result_mismatch"
        : "lifecycle_invalid",
      durationMs,
      metrics,
    };
  }
  if (result.status === "failed") {
    return turnFailure(result.error, durationMs, metrics);
  }
  if (result.status === "interrupted") {
    return { classification: "INCONCLUSIVE", category: "turn_interrupted", durationMs, metrics };
  }
  if (metrics.toolCompletions < 2 || toolMessageCount < 2) {
    return { classification: "INCONCLUSIVE", category: "insufficient_tool_activity", durationMs, metrics };
  }
  return { classification: "PASS", durationMs, metrics };
}

function turnFailure(error, durationMs, metrics) {
  if (error.code !== "HARNESS_ERROR") {
    return { classification: "FAIL", category: "lifecycle_invalid", durationMs, metrics };
  }
  return {
    classification: "INCONCLUSIVE",
    category: "harness_error",
    durationMs,
    metrics,
    failure: {
      code: "HARNESS_ERROR",
      operation: "startTurn",
      retryable: error.operation === "startTurn" && error.retryable === true,
    },
  };
}

function commandFailure(error, durationMs) {
  const metrics = emptyQualificationMetrics();
  if (error?.code === "HARNESS_ERROR" && error.operation === "startTurn") {
    return turnFailure(error, durationMs, metrics);
  }
  return { classification: "INCONCLUSIVE", category: "harness_error", durationMs, metrics };
}

function runFixtureTests(workspace) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", join(workspace, "test", "pipeline.test.mjs")], {
    cwd: workspace,
    encoding: "utf8",
    env: environment,
    stdio: "ignore",
  });
  return result.status === 0;
}
