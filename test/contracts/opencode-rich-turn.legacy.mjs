// Historical v1 rich Turn contract. Retained for archaeology; v2 rich Turns have separate coverage.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("OpenCode usage is cumulative over model steps, deduplicated, and reset for each Turn", async () => {
  const fixture = await createFixture("cumulative-usage", "cumulative-usage");
  try {
    const session = await fixture.runtime.createSession({ harness: "opencode", workspacePath: fixture.workspace });
    for (const text of ["first", "second"]) {
      const turn = await session.startTurn([{ type: "text", text }]);
      const updates = [];
      for await (const event of turn) if (event.type === "usage.updated") updates.push(event.usage);
      const result = await turn.result;
      assert.equal(result.status, "completed");
      assert.deepEqual(updates, [
        { inputTokens: 4, outputTokens: 0, reasoningTokens: 2, cachedInputTokens: 0 },
        { inputTokens: 8, outputTokens: 3, reasoningTokens: 2, cachedInputTokens: 1 },
      ]);
      assert.deepEqual(result.usage, updates[1]);
    }
  } finally { await fixture.close(); }
});

test("OpenCode maps Tool, Usage, Approval, and answered Question lifecycles", async () => {
  const fixture = await createFixture("interactive-rich");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
      approvalPolicy: "interactive",
    });
    const turn = await session.startTurn([{ type: "text", text: "Run the rich flow." }]);
    const iterator = turn[Symbol.asyncIterator]();
    const events = [];
    let approval;
    while (!approval) {
      const event = (await iterator.next()).value;
      events.push(event);
      if (event.type === "approval.requested") approval = event;
    }
    assert.equal(approval.title, "OpenCode requests bash permission");
    const tool = events.find(({ type }) => type === "tool.started");
    assert.equal(approval.toolCallId, tool.toolCallId);
    assert.deepEqual(tool.input, { command: "npm test" });
    assert.equal(events.some(({ type }) => type === "tool.updated"), true);
    assert.equal(events.some(({ type, delta }) => type === "assistant.reasoning.delta" && delta === "Thinking."), true);

    await turn.respondToApproval(approval.requestId, "allowOnce");
    let question;
    while (!question) {
      const event = (await iterator.next()).value;
      events.push(event);
      if (event.type === "question.requested") question = event;
    }
    assert.equal(question.toolCallId, tool.toolCallId);
    assert.equal(question.questions.length, 2);
    assert.equal(question.questions[0].multiple, false);
    assert.equal(question.questions[0].allowCustom, true);
    assert.equal(question.questions[1].multiple, true);
    const [target, checks] = question.questions;
    await turn.respondToQuestion(question.requestId, {
      action: "answer",
      answers: [
        { questionId: target.questionId, kind: "options", optionIds: [target.options[0].optionId] },
        {
          questionId: checks.questionId,
          kind: "optionsWithCustom",
          optionIds: [checks.options[1].optionId],
          text: "Lint",
        },
      ],
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    assert.deepEqual(events.map(({ type }) => type), [
      "turn.started",
      "assistant.message.started",
      "assistant.reasoning.delta",
      "tool.started",
      "tool.updated",
      "approval.requested",
      "approval.resolved",
      "question.requested",
      "question.resolved",
      "tool.completed",
      "assistant.message.delta",
      "usage.updated",
      "assistant.message.completed",
      "turn.completed",
    ]);
    assert.deepEqual(events.map(({ sequence }) => sequence),
      Array.from({ length: events.length }, (_value, index) => index + 1));
    assert.deepEqual(events.find(({ type }) => type === "tool.completed"), {
      type: "tool.completed",
      turnId: turn.turnId,
      sequence: 10,
      timestamp: events[9].timestamp,
      toolCallId: tool.toolCallId,
      output: "tests passed",
      isError: false,
    });
    const questionResolved = events.find(({ type }) => type === "question.resolved");
    assert.equal(questionResolved.outcome, "answered");
    assert.equal(questionResolved.source, "caller");
    assert.equal((await turn.result).status, "completed");
    assert.deepEqual((await turn.result).usage, {
      inputTokens: 10,
      outputTokens: 8,
      reasoningTokens: 2,
      cachedInputTokens: 3,
    });

    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.deepEqual(evidence.permissionReplies, [{
      requestId: `per_${session.reference.sessionId}`,
      reply: "once",
    }]);
    assert.equal(evidence.permissionReplies.some(({ reply }) => reply === "always"), false);
    assert.deepEqual(evidence.questionResponses[0], {
      requestId: `que_${session.reference.sessionId}`,
      action: "answer",
      answers: [["Staging"], ["E2E", "Lint"]],
    });

    const diagnostics = new DatabaseSync(join(fixture.runtime.dataDir, "diagnostic-events.sqlite"), {
      readOnly: true,
    });
    try {
      const nativeTypes = diagnostics.prepare(
        "SELECT payload_json FROM native_event_records WHERE harness = 'opencode' ORDER BY record_id",
      ).all().map(({ payload_json }) => JSON.parse(payload_json)?.type).filter(Boolean);
      for (const type of [
        "message.part.delta",
        "permission.asked",
        "permission.replied",
        "question.asked",
        "question.replied",
      ]) assert.equal(nativeTypes.includes(type), true, type);
    } finally {
      diagnostics.close();
    }
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("OpenCode autoDeny sends reject once and a caller can dismiss the Question", async () => {
  const fixture = await createFixture("auto-deny-rich");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
      approvalPolicy: "autoDeny",
    });
    const turn = await session.startTurn([{ type: "text", text: "Deny permission." }]);
    const iterator = turn[Symbol.asyncIterator]();
    const events = [];
    let question;
    while (!question) {
      const event = (await iterator.next()).value;
      events.push(event);
      if (event.type === "question.requested") question = event;
    }
    const approvalResolved = events.find(({ type }) => type === "approval.resolved");
    assert.deepEqual(
      { outcome: approvalResolved.outcome, source: approvalResolved.source },
      { outcome: "deny", source: "policy" },
    );
    await turn.respondToQuestion(question.requestId, { action: "dismiss" });
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    const questionResolved = events.find(({ type }) => type === "question.resolved");
    assert.deepEqual(
      { outcome: questionResolved.outcome, source: questionResolved.source },
      { outcome: "dismissed", source: "caller" },
    );
    assert.equal(events.find(({ type }) => type === "tool.completed").isError, true);
    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.deepEqual(evidence.permissionReplies.map(({ reply }) => reply), ["reject"]);
    assert.deepEqual(evidence.questionResponses.map(({ action }) => action), ["dismiss"]);
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("OpenCode autoApprove sends one one-shot policy decision", async () => {
  const fixture = await createFixture("auto-approve-rich");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
      approvalPolicy: "autoApprove",
    });
    const turn = await session.startTurn([{ type: "text", text: "Approve permission." }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "question.requested") {
        await turn.respondToQuestion(event.requestId, { action: "dismiss" });
      }
    }
    const approvalResolved = events.find(({ type }) => type === "approval.resolved");
    assert.deepEqual(
      { outcome: approvalResolved.outcome, source: approvalResolved.source },
      { outcome: "allowOnce", source: "policy" },
    );
    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.deepEqual(evidence.permissionReplies.map(({ reply }) => reply), ["once"]);
    assert.equal(evidence.permissionReplies.some(({ reply }) => reply === "always"), false);
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("OpenCode auto approves descendants after resume without approving an independent Session", async () => {
  const fixture = await createFixture("descendants", "child-approval");
  let session;
  let peer;
  let turn;
  try {
    session = await fixture.runtime.createSession({ harness: "opencode", workspacePath: fixture.workspace, approvalPolicy: "autoApprove" });
    peer = await fixture.runtime.createSession({ harness: "opencode", workspacePath: fixture.workspace, approvalPolicy: "interactive" });
    const peerTurn = await peer.startTurn([{ type: "text", text: "peer" }]);
    const peerEvents = peerTurn[Symbol.asyncIterator]();
    let peerRequest;
    while (!peerRequest) {
      const event = (await peerEvents.next()).value;
      if (event.type === "approval.requested") peerRequest = event;
    }
    const reference = session.reference;
    for (const resumed of [false, true]) {
      if (resumed) session = await fixture.runtime.resumeSession({ reference, approvalPolicy: "autoApprove" });
      turn = await session.startTurn([{ type: "text", text: "child task" }]);
      let timer;
      try {
        const result = await Promise.race([turn.result,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("child approval remained blocked")), 1500); }),
        ]);
        assert.equal(result.status, "completed");
      } finally { clearTimeout(timer); }
      const events = [];
      for await (const event of turn) events.push(event);
      const request = events.find(({ type }) => type === "approval.requested");
      const resolved = events.filter(({ type }) => type === "approval.resolved");
      assert.equal(request.details.nativeSessionId, `${reference.sessionId}_grandchild`);
      assert.deepEqual(resolved.map(({ requestId, outcome, source }) => ({ requestId, outcome, source })),
        [{ requestId: request.requestId, outcome: "allowOnce", source: "policy" }]);
      const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
      assert.equal(evidence.permissionReplies.some(({ requestId, reply }) =>
        reply === "once" && requestId.startsWith(`perm_${peer.reference.sessionId}_`)), false);
      await session.close();
      if (!resumed) {
        await peerTurn.respondToApproval(peerRequest.requestId, "deny");
        await peerTurn.result;
        await peer.close();
      }
    }
  } finally {
    await turn?.interrupt();
    await session?.close();
    await peer?.close();
    await fixture.close();
  }
});

async function createFixture(name, scenario = "rich") {
  const root = await mkdtemp(join(tmpdir(), `muha-opencode-${name}-`));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({
    harnesses: [openCodeAdapter({
      env: {
        PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
        MUHA_FAKE_OPENCODE_SCENARIO: scenario,
        MUHA_FAKE_OPENCODE_EVIDENCE_FILE: evidenceFile,
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
