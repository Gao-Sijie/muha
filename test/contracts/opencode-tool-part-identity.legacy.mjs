// Historical v1 Tool-part contract. Retained for archaeology; v2 Tool identity has separate coverage.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("OpenCode keeps reused call IDs distinct across Assistant Messages", async () => {
  const fixture = await createFixture("reused-tool-call-id");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
      approvalPolicy: "interactive",
    });
    const turn = await session.startTurn([{ type: "text", text: "Run both tools." }]);
    const iterator = turn[Symbol.asyncIterator]();
    const events = [];

    const approval = await readUntil(iterator, events, "approval.requested", turn);
    const startedTools = events.filter(({ type }) => type === "tool.started");
    assert.equal(startedTools.length, 2);
    assert.notEqual(startedTools[0].toolCallId, startedTools[1].toolCallId);
    assert.equal(approval.toolCallId, startedTools[1].toolCallId);
    await turn.respondToApproval(approval.requestId, "allowOnce");

    const question = await readUntil(iterator, events, "question.requested", turn);
    assert.equal(question.toolCallId, startedTools[1].toolCallId);
    await turn.respondToQuestion(question.requestId, {
      action: "answer",
      answers: [{
        questionId: question.questions[0].questionId,
        kind: "options",
        optionIds: [question.questions[0].options[0].optionId],
      }],
    });

    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    const completedTools = events.filter(({ type }) => type === "tool.completed");
    assert.deepEqual(
      completedTools.map(({ toolCallId }) => toolCallId),
      startedTools.map(({ toolCallId }) => toolCallId),
    );
    assert.equal(events.filter(({ type }) => type === "assistant.message.completed").length, 2);
    assert.equal(events.at(-1).type, "turn.completed");
    assert.equal((await turn.result).status, "completed");
  } finally {
    await session?.close();
    await fixture.close();
  }
});

for (const [scenario, message] of [
  ["completed-tool-update", "OpenCode updated a completed Tool Call"],
  ["tool-part-identity-drift", "OpenCode Tool Part identity changed"],
  ["ambiguous-tool-reference", "OpenCode reused a Tool Call id within one Assistant Message"],
]) {
  test(`OpenCode rejects ${scenario}`, async () => {
    const fixture = await createFixture(scenario);
    let session;
    try {
      session = await fixture.runtime.createSession({
        harness: "opencode",
        workspacePath: fixture.workspace,
      });
      const turn = await session.startTurn([{ type: "text", text: "Run the invalid flow." }]);
      const events = [];
      for await (const event of turn) events.push(event);
      const result = await turn.result;
      assert.equal(events.at(-1).type, "turn.failed");
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
      assert.equal(result.error.message, message);
    } finally {
      await session?.close();
      await fixture.close();
    }
  });
}

test("OpenCode emits unresolved and pending Tool interactions without a Tool Call identity", async () => {
  const fixture = await createFixture("early-tool-interactions");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
      approvalPolicy: "interactive",
    });
    const turn = await session.startTurn([{ type: "text", text: "Run early interactions." }]);
    const iterator = turn[Symbol.asyncIterator]();
    const events = [];
    const approval = await readUntil(iterator, events, "approval.requested", turn);
    assert.equal(approval.toolCallId, undefined);
    await turn.respondToApproval(approval.requestId, "allowOnce");
    const question = await readUntil(iterator, events, "question.requested", turn);
    assert.equal(question.toolCallId, undefined);
    await turn.respondToQuestion(question.requestId, { action: "dismiss" });
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    assert.equal(events.filter(({ type }) => type === "tool.started").length, 1);
    assert.equal(events.filter(({ type }) => type === "tool.completed").length, 1);
    assert.equal(events.at(-1).type, "turn.completed");
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("OpenCode reconciles duplicate pending, running, and terminal snapshots", async () => {
  const fixture = await createFixture("duplicate-tool-snapshots");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    const turn = await session.startTurn([{ type: "text", text: "Run duplicate snapshots." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal(events.filter(({ type }) => type === "tool.started").length, 1);
    assert.equal(events.filter(({ type }) => type === "tool.updated").length, 1);
    assert.equal(events.filter(({ type }) => type === "tool.completed").length, 1);
    assert.equal(events.at(-1).type, "turn.completed");
  } finally {
    await session?.close();
    await fixture.close();
  }
});

async function readUntil(iterator, events, type, turn) {
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      assert.fail(`Turn ended before ${type}: ${JSON.stringify({
        eventTypes: events.map((event) => event.type),
        result: await turn.result,
      })}`);
    }
    events.push(next.value);
    if (next.value.type === type) return next.value;
  }
}

async function createFixture(scenario) {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-tool-identity-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({
    harnesses: [openCodeAdapter({
      env: {
        PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
        MUHA_FAKE_OPENCODE_SCENARIO: scenario,
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    })],
    dataDir: join(root, "diagnostics"),
  });
  return {
    runtime,
    workspace,
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
