import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Core validates and sequences rich Codex Assistant, Tool, Usage, and terminal events", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-rich-events-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;

  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_TURN_SCENARIO: "rich",
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "Exercise events." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;

    assert.deepEqual(events.map(({ type }) => type), [
      "turn.started",
      "assistant.message.started",
      "assistant.reasoning.delta",
      "tool.started",
      "tool.started",
      "tool.updated",
      "tool.updated",
      "tool.completed",
      "tool.completed",
      "usage.updated",
      "usage.updated",
      "assistant.message.delta",
      "assistant.message.completed",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed",
      "turn.completed",
    ]);
    assert.deepEqual(events.map(({ sequence }) => sequence), Array.from({ length: 17 }, (_, index) => index + 1));

    const firstMessageId = events[1].messageId;
    assert.equal(events[2].messageId, firstMessageId);
    assert.equal(events[2].delta, "Thinking.");
    assert.equal(events[11].messageId, firstMessageId);
    assert.equal(events[12].message.id, firstMessageId);
    assert.equal(events[12].message.text, "Interim.");
    assert.notEqual(events[13].messageId, firstMessageId);
    assert.equal(events[15].message.id, events[13].messageId);

    const commandId = events[3].toolCallId;
    const mcpId = events[4].toolCallId;
    assert.deepEqual(events[3], {
      type: "tool.started",
      turnId: turn.turnId,
      sequence: 4,
      timestamp: events[3].timestamp,
      toolCallId: commandId,
      toolName: "commandExecution",
      input: { command: "printf hi", cwd: session.reference.workspacePath },
    });
    assert.deepEqual(events[4].input, { query: "muha" });
    assert.equal(events[4].toolName, "demo.lookup");
    assert.equal(events[5].toolCallId, commandId);
    assert.deepEqual(events[5].update, { outputDelta: "hi" });
    assert.equal(events[6].toolCallId, mcpId);
    assert.deepEqual(events[6].update, { message: "looking" });
    assert.deepEqual(events[7].output, {
      aggregatedOutput: "hi",
      exitCode: 0,
      durationMs: 3,
      status: "completed",
    });
    assert.equal(events[7].isError, false);
    assert.equal(events[8].isError, true);
    assert.deepEqual(events[8].output, { message: "lookup failed" });

    assert.deepEqual(events[9].usage, {
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 3,
      reasoningTokens: 1,
    });
    const finalUsage = {
      inputTokens: 9,
      outputTokens: 4,
      cachedInputTokens: 3,
      reasoningTokens: 1,
    };
    assert.deepEqual(events[10].usage, finalUsage);
    assert.deepEqual(events[16].usage, finalUsage);
    assert.deepEqual(result, {
      status: "completed",
      turnId: turn.turnId,
      message: events[15].message,
      usage: finalUsage,
    });
    for (const event of events) {
      assert.equal(Number.isNaN(Date.parse(event.timestamp)), false);
      assert.equal("nativeId" in event, false);
      assert.equal("harness" in event, false);
      assert.equal("workspacePath" in event, false);
    }
    const database = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM core_event_records").get().count,
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  "protocol-no-message",
  "protocol-assistant-delta-without-start",
  "protocol-assistant-duplicate-completion",
  "protocol-tool-completion-without-start",
]) {
  test(`${scenario} becomes one durable Adapter protocol Turn failure`, async () => {
    const { events, result, dataDir, close } = await runScenario(scenario);
    try {
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
      assert.equal(events.at(-1).type, "turn.failed");
      assert.deepEqual(events.at(-1).error, result.error);
      assert.equal(
        events.filter(({ type }) => ["turn.completed", "turn.failed", "turn.interrupted"].includes(type)).length,
        1,
      );
      assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_, index) => index + 1));
      const database = new DatabaseSync(join(dataDir, "diagnostic-events.sqlite"), { readOnly: true });
      try {
        assert.equal(
          database.prepare("SELECT count(*) AS count FROM core_event_records").get().count,
          1,
        );
      } finally {
        database.close();
      }
    } finally {
      await close();
    }
  });
}

test("native Codex failed and interrupted terminals remain distinct values", async () => {
  for (const [scenario, status] of [["native-failed", "failed"], ["native-interrupted", "interrupted"]]) {
    const execution = await runScenario(scenario);
    try {
      assert.equal(execution.result.status, status);
      assert.equal(execution.events.at(-1).type, `turn.${status}`);
      if (status === "failed") assert.equal(execution.result.error.code, "HARNESS_ERROR");
      else assert.equal(execution.result.reason, "harness");
    } finally {
      await execution.close();
    }
  }
});

test("Codex ignores thread notifications that precede or belong outside the accepted Turn", async () => {
  const execution = await runScenario("background-usage-before-start");
  try {
    assert.equal(execution.result.status, "completed");
    assert.deepEqual(execution.events.map(({ type }) => type), [
      "turn.started",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.delta",
      "assistant.message.completed",
      "turn.completed",
    ]);
  } finally {
    await execution.close();
  }
});

async function runScenario(scenario) {
  const root = await mkdtemp(join(tmpdir(), `muha-codex-${scenario}-`));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_TURN_SCENARIO: scenario,
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: scenario }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    return {
      events,
      result,
      dataDir: runtime.dataDir,
      close: async () => {
        await session.close();
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
