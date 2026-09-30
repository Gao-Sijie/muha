import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Codex recovers a missing Tool completion from authoritative thread/read state", async () => {
  const execution = await runScenario("recover-missing-tool");
  try {
    const { events, result } = execution;
    assert.deepEqual(events.map(({ type }) => type), [
      "turn.started",
      "tool.started",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed",
      "tool.completed",
      "turn.completed",
    ]);
    assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6, 7]);
    const started = events[1];
    const recovered = events[5];
    assert.equal(recovered.toolCallId, started.toolCallId);
    assert.deepEqual(started.input, { command: "printf recovered", cwd: started.input.cwd });
    assert.deepEqual(recovered.output, {
      aggregatedOutput: "recovered",
      exitCode: 0,
      durationMs: 5,
      status: "completed",
    });
    assert.equal(recovered.isError, false);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.message, events[4].message);
    assert.deepEqual(result.message, { id: events[2].messageId, text: "Done." });
    assert.equal(events.at(-1).type, "turn.completed");
    assert.equal(result.usage, undefined);

    const database = new DatabaseSync(
      join(execution.dataDir, "diagnostic-events.sqlite"),
      { readOnly: true },
    );
    try {
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM core_event_records").get().count,
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await execution.close();
  }
});

for (const scenario of [
  ["recover-thread-read-fails", "thread/read recovery failed"],
  ["recover-omits-item", "omits the unfinished Tool Call"],
  ["recover-item-running", "is still running"],
  ["recover-item-unmappable", "cannot map"],
]) {
  test(`${scenario[0]} becomes exactly one durable Codex protocol Turn failure`, async () => {
    const execution = await runScenario(scenario[0]);
    try {
      const { events, result } = execution;
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
      assert.equal(events.at(-1).type, "turn.failed");
      assert.deepEqual(events.at(-1).error, result.error);
      assert.match(result.error.message, new RegExp(scenario[1]));
      assert.equal(
        events.filter(({ type }) =>
          ["turn.completed", "turn.failed", "turn.interrupted"].includes(type)).length,
        1,
      );
      assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_, index) => index + 1));
      const database = new DatabaseSync(
        join(execution.dataDir, "diagnostic-events.sqlite"),
        { readOnly: true },
      );
      try {
        assert.equal(
          database.prepare("SELECT count(*) AS count FROM core_event_records").get().count,
          1,
        );
      } finally {
        database.close();
      }
    } finally {
      await execution.close();
    }
  });
}

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
            MUHA_FAKE_NATIVE_SESSIONS_FILE: join(root, "native-sessions.json"),
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
