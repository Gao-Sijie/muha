// Historical v1 combined-route contract. Retained for archaeology; not OpenCode v2 acceptance evidence.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";
import { createOfficialHarnessRegistration, readOfficialHarnessRegistration } from "../../packages/core/dist/internal.js";

test("OpenCode combined execution keeps native Question, tool values and whole-Turn usage behind ACP", { timeout: 15000 }, async () => {
  const { OpenCodeAcpProcess } = await import("../../packages/opencode-adapter/dist/opencode-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-combined-"));
  const base = readOfficialHarnessRegistration(openCodeAdapter());
  const registration = createOfficialHarnessRegistration("opencode", { shutdownTimeoutMs: 1500 }, base.capabilities, base.workspaceConfigurator,
    (options, context) => new OpenCodeAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/opencode-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root, model: "fixture/model", approvalPolicy: "interactive" });
    assert.equal(session.reference.route, "combined");
    for (const text of ["first", "second"]) {
      const turn = await session.startTurn([{ type: "text", text }]);
      const events = [];
      for await (const event of turn) {
        events.push(event);
        if (event.type === "question.requested") {
          const tool = events.find(event => event.type === "tool.started");
          assert.ok(tool, "native Question must follow its ACP tool start");
          assert.equal(event.toolCallId, tool.toolCallId);
          const question = event.questions[0];
          await turn.respondToQuestion(event.requestId, { action: "answer", answers: [{ questionId: question.questionId, kind: "options", optionIds: [question.options[0].optionId] }] });
        }
      }
      const result = await turn.result;
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(result.message.text, "Staging");
      assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 8, reasoningTokens: 3, cachedInputTokens: 12 });
      const tools = events.filter(event => event.type === "tool.started");
      assert.equal(tools.length, 1);
      assert.equal(tools[0].toolName, "question");
      assert.deepEqual(tools[0].input, { question: "Choose" });
      assert.equal(events.find(event => event.type === "tool.completed").output, "Staging");
      assert.equal(events.filter(event => event.type === "question.resolved").length, 1);
    }
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("combined startup timeout also bounds the attached native health handshake", { timeout: 4000 }, async () => {
  const { OpenCodeAcpProcess } = await import("../../packages/opencode-adapter/dist/opencode-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-health-stall-"));
  const base = readOfficialHarnessRegistration(openCodeAdapter());
  let adapter;
  const registration = createOfficialHarnessRegistration("opencode", { env: { MUHA_FAKE_OPENCODE_COMBINED_SCENARIO: "native-health-stall" }, startupTimeoutMs: 300, shutdownTimeoutMs: 500 }, base.capabilities, base.workspaceConfigurator,
    (options, context) => adapter = new OpenCodeAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/opencode-combined.mjs")] }));
  const pending = createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  const outcome = pending.then(runtime => ({ runtime }), error => ({ error }));
  try {
    const result = await Promise.race([outcome, delay(1200).then(() => ({ hung: true }))]);
    assert.equal(result.error?.data?.code, "RUNTIME_INITIALIZATION_FAILED");
  } finally {
    await adapter?.close();
    const result = await outcome;
    await result.runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode combined preserves native empty-final-message failure after a denied tool", { timeout: 5000 }, async () => {
  const { OpenCodeAcpProcess } = await import("../../packages/opencode-adapter/dist/opencode-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-denied-empty-"));
  const base = readOfficialHarnessRegistration(openCodeAdapter());
  const registration = createOfficialHarnessRegistration("opencode", {
    env: { MUHA_FAKE_OPENCODE_COMBINED_SCENARIO: "denied-empty-final" }, shutdownTimeoutMs: 1000,
  }, base.capabilities, base.workspaceConfigurator, (options, context) =>
    new OpenCodeAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/opencode-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root, approvalPolicy: "interactive" });
    const turn = await session.startTurn([{ type: "text", text: "Deny the attempted tool" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "approval.requested") await turn.respondToApproval(event.requestId, "deny");
    }
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.equal(result.error.nativeCode, "empty_final_message");
    assert.equal(events.filter(event => event.type === "approval.resolved" && event.outcome === "deny").length, 1);
    assert.equal(events.filter(event => event.type === "tool.completed" && event.isError).length, 1);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, reasoningTokens: 2, cachedInputTokens: 4 });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("OpenCode prompt RPC failure waits for committed native error and accumulated usage", { timeout: 5000 }, async () => {
  const { OpenCodeAcpProcess } = await import("../../packages/opencode-adapter/dist/opencode-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-error-barrier-"));
  const base = readOfficialHarnessRegistration(openCodeAdapter());
  const registration = createOfficialHarnessRegistration("opencode", {
    env: { MUHA_FAKE_OPENCODE_COMBINED_SCENARIO: "rpc-error-before-native-idle" }, shutdownTimeoutMs: 500,
  }, base.capabilities, base.workspaceConfigurator, (options, context) =>
    new OpenCodeAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/opencode-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root });
    const turn = await session.startTurn([{ type: "text", text: "fail after consuming tokens" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.nativeCode, "APIError");
    assert.equal(result.error.retryable, true);
    assert.equal(result.error.message, "native retryable failure");
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, reasoningTokens: 2, cachedInputTokens: 4 });
    assert.equal(events.filter(event => event.type === "turn.failed").length, 1);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("an explicit native Reference stays on the native execution path of the combined Adapter", { timeout: 5000 }, async () => {
  const { OpenCodeAcpProcess } = await import("../../packages/opencode-adapter/dist/opencode-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-native-route-"));
  const options = { env: { PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter), MUHA_FAKE_OPENCODE_SESSIONS_FILE: join(root, "sessions.json") } };
  let runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter(options)], dataDir: join(root, "data") });
  try {
    const original = await runtime.createSession({ harness: "opencode", workspacePath: root });
    const reference = JSON.parse(JSON.stringify(original.reference));
    const first = await original.startTurn([{ type: "text", text: "native history" }]);
    for await (const _ of first) {}
    assert.equal((await first.result).status, "completed");
    await runtime.close();
    const base = readOfficialHarnessRegistration(openCodeAdapter());
    const registration = createOfficialHarnessRegistration("opencode", options, base.capabilities, base.workspaceConfigurator,
      (snapshot, context) => new OpenCodeAcpProcess(snapshot, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/opencode-combined.mjs")] }));
    runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
    const resumed = await runtime.resumeSession({ reference, approvalPolicy: "autoApprove" });
    assert.deepEqual(resumed.reference, reference);
    assert.equal(resumed.reference.route, "native");
    const next = await resumed.startTurn([{ type: "text", text: "still native" }]);
    for await (const _ of next) {}
    assert.equal((await next.result).status, "completed");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("native observer loss preempts a Question waiting for its missing ACP Tool", { timeout: 4000 }, async () => {
  const { OpenCodeAcpProcess } = await import("../../packages/opencode-adapter/dist/opencode-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-combined-loss-"));
  const base = readOfficialHarnessRegistration(openCodeAdapter());
  const registration = createOfficialHarnessRegistration("opencode", { env: { MUHA_FAKE_OPENCODE_COMBINED_SCENARIO: "stream-loss-before-tool" }, shutdownTimeoutMs: 500 }, base.capabilities, base.workspaceConfigurator,
    (options, context) => new OpenCodeAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/opencode-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root });
    const turn = await session.startTurn([{ type: "text", text: "lose observer" }]);
    const drained = (async () => { for await (const _ of turn) {} return turn.result; })();
    const result = await Promise.race([drained, delay(750).then(() => ({ status: "hung" }))]);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("OpenCode combined autoApprove covers its native descendants once, without authorizing peer Sessions", { timeout: 4000 }, async () => {
  const { OpenCodeAcpProcess } = await import("../../packages/opencode-adapter/dist/opencode-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-combined-tree-"));
  const base = readOfficialHarnessRegistration(openCodeAdapter());
  const registration = createOfficialHarnessRegistration("opencode", { env: { MUHA_FAKE_OPENCODE_COMBINED_SCENARIO: "descendants" }, shutdownTimeoutMs: 500 }, base.capabilities, base.workspaceConfigurator,
    (options, context) => new OpenCodeAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/opencode-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root, approvalPolicy: "autoApprove" });
    const turn = await session.startTurn([{ type: "text", text: "descendants" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "question.requested") await turn.respondToQuestion(event.requestId, { action: "dismiss" });
    }
    assert.equal((await turn.result).status, "completed");
    assert.equal(events.filter(event => event.type === "approval.requested").length, 1);
    assert.equal(events.filter(event => event.type === "approval.resolved" && event.source === "policy").length, 1);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
