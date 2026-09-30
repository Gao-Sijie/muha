import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Kimi aligns volatile deltas per main Agent step with UTF-16 offsets", async () => {
  const fixture = await createFixture("multi-step");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "kimi",
      workspacePath: fixture.workspace,
    });
    const turn = await session.startTurn([{ type: "text", text: "Multi-step." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;

    const deltas = events.filter(({ type }) => type === "assistant.message.delta")
      .map(({ delta }) => delta);
    assert.deepEqual(deltas, [
      "第一步。",
      "ABCDEF",
      "G",
      "HI",
      "中😀",
      "😀尾",
      "legacy",
      "K",
    ]);
    const reasoning = events.filter(({ type }) => type === "assistant.reasoning.delta")
      .map(({ delta }) => delta);
    assert.deepEqual(reasoning, ["计划。", "复盘。", "😀", "结束"]);
    assert.equal(
      events.filter(({ type, delta }) => type === "assistant.message.delta" && delta === "ABCDEF").length,
      1,
    );
    assert.equal(
      events.filter(({ type, delta }) => type === "assistant.reasoning.delta" && delta === "结束").length,
      1,
    );
    for (const event of events) {
      if ("delta" in event) assert.equal(event.delta.includes("subagent"), false);
    }
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "第一步。ABCDEFGHI中😀😀尾legacyK");
    assert.equal(events.at(-1).type, "turn.completed");
    assert.equal(events.at(-1).sequence, events.length);
    assert.deepEqual(events.at(-1).usage, { inputTokens: 8, outputTokens: 6, cachedInputTokens: 2 });
    assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 6, cachedInputTokens: 2 });

    const diagnostics = new DatabaseSync(
      join(fixture.runtime.dataDir, "diagnostic-events.sqlite"),
      { readOnly: true },
    );
    try {
      const nativeTypes = diagnostics.prepare(
        "SELECT payload_json FROM native_event_records WHERE harness = 'kimi' ORDER BY record_id",
      ).all().map(({ payload_json }) => JSON.parse(payload_json)?.type).filter(Boolean);
      assert.equal(nativeTypes.includes("turn.step.started"), true);
      const subagentFrames = diagnostics.prepare(
        "SELECT payload_json FROM native_event_records WHERE harness = 'kimi' AND payload_json LIKE '%subagent-1%'",
      ).all().length;
      assert.ok(subagentFrames > 0, "subagent Native Event Records are retained");
      assert.equal(
        diagnostics.prepare("SELECT count(*) AS count FROM core_event_records").get().count,
        0,
      );
    } finally {
      diagnostics.close();
    }
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("Kimi advances step counters for offset-less legacy deltas", async () => {
  const fixture = await createFixture("legacy-mixed", "legacy-mixed");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "kimi",
      workspacePath: fixture.workspace,
    });
    const turn = await session.startTurn([{ type: "text", text: "Legacy." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.deepEqual(
      events.filter(({ type }) => type === "assistant.message.delta").map(({ delta }) => delta),
      ["hello ", "world", "!"],
    );
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "hello world!");
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("Kimi true same-step forward gap stays one durable protocol Turn failure", async () => {
  const fixture = await createFixture("step-gap", "step-gap");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "kimi",
      workspacePath: fixture.workspace,
    });
    const turn = await session.startTurn([{ type: "text", text: "Gap." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
    assert.equal(events.at(-1).type, "turn.failed");
    assert.deepEqual(events.at(-1).error, result.error);
    assert.match(result.error.message, /has a gap/);
    assert.equal(
      events.filter(({ type }) =>
        ["turn.completed", "turn.failed", "turn.interrupted"].includes(type)).length,
      1,
    );
    assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_, index) => index + 1));
    const diagnostics = new DatabaseSync(
      join(fixture.runtime.dataDir, "diagnostic-events.sqlite"),
      { readOnly: true },
    );
    try {
      assert.equal(
        diagnostics.prepare("SELECT count(*) AS count FROM core_event_records").get().count,
        1,
      );
    } finally {
      diagnostics.close();
    }
  } finally {
    await session?.close();
    await fixture.close();
  }
});

async function createFixture(name, scenario = "multi-step") {
  const root = await mkdtemp(join(tmpdir(), `muha-kimi-${name}-`));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({
    harnesses: [kimiAdapter({
      env: {
        PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
        MUHA_FAKE_KIMI_SCENARIO: scenario,
        MUHA_FAKE_KIMI_EVIDENCE_FILE: evidenceFile,
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    })],
    dataDir: join(root, "diagnostics"),
  });
  return {
    root,
    workspace,
    evidenceFile,
    runtime,
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
