import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Kimi applies auto before creating a usable Session and replaces it on resume", async () => {
  const fixture = await createFixture("mode-switch", "normal");
  let session;
  try {
    session = await fixture.runtime.createSession({ harness: "kimi", workspacePath: fixture.workspace, approvalPolicy: "autoApprove" });
    let evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.deepEqual(evidence.profiles, [{ sessionId: session.reference.sessionId, permissionMode: "auto" }]);
    assert.deepEqual(evidence.prompts, []);
    const reference = session.reference;
    for (const policy of ["autoApprove", "interactive", "autoDeny"]) {
      if (policy !== "autoApprove") session = await fixture.runtime.resumeSession({ reference, approvalPolicy: policy });
      const turn = await session.startTurn([{ type: "text", text: "Run with the selected mode." }]);
      const events = [];
      for await (const event of turn) events.push(event);
      assert.equal((await turn.result).status, "completed");
      assert.equal(events.some(({ type }) => type.startsWith("approval.")), false);
      await session.close();
    }
    evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.deepEqual(evidence.profiles.map(({ permissionMode }) => permissionMode), ["auto", "manual", "manual"]);
    assert.deepEqual(evidence.prompts.map(({ permissionMode }) => permissionMode), ["auto", "manual", "manual"]);
  } finally {
    await session?.close();
    await fixture.close();
  }
});

for (const operation of ["createSession", "resumeSession"]) {
  test(`Kimi ${operation} rejects a failed auto profile without submitting a prompt`, async () => {
    const fixture = await createFixture("profile-failure", "profile-reject-auto");
    let session;
    try {
      let reference;
      if (operation === "resumeSession") {
        session = await fixture.runtime.createSession({ harness: "kimi", workspacePath: fixture.workspace });
        reference = session.reference;
        await session.close();
      }
      await assert.rejects(
        operation === "createSession"
          ? fixture.runtime.createSession({ harness: "kimi", workspacePath: fixture.workspace, approvalPolicy: "autoApprove" })
          : fixture.runtime.resumeSession({ reference, approvalPolicy: "autoApprove" }),
        (error) => error instanceof MuhaError && error.data.code === "HARNESS_ERROR" && error.data.operation === operation,
      );
      const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
      assert.deepEqual(evidence.prompts, []);
    } finally {
      await session?.close();
      await fixture.close();
    }
  });
}

test("Kimi maps Tool, Usage, Approval, and five-kind Question answers", async () => {
  const fixture = await createFixture("interactive");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "kimi",
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
    assert.equal(approval.title, "Kimi requests shell approval");
    assert.equal(approval.description, "Run tests");
    const tool = events.find(({ type }) => type === "tool.started");
    assert.equal(approval.toolCallId, tool.toolCallId);
    assert.deepEqual(tool.input, { command: "npm test" });
    assert.equal(events.some(({ type }) => type === "tool.updated"), true);
    assert.equal(events.some(({ type, delta }) =>
      type === "assistant.reasoning.delta" && delta === "Thinking."), true);

    await turn.respondToApproval(approval.requestId, "allowOnce");
    let question;
    while (!question) {
      const event = (await iterator.next()).value;
      events.push(event);
      if (event.type === "question.requested") question = event;
    }
    const [single, multi, other, multiOther, skipped] = question.questions;
    assert.equal(question.toolCallId, tool.toolCallId);
    assert.equal(single.description, "Choose one target");
    assert.equal(single.input.kind, "select");
    assert.equal(single.input.allowCustom, false);
    assert.equal(multi.input.kind, "multiselect");
    assert.equal(other.input.allowCustom, true);
    assert.equal(multiOther.input.kind, "multiselect");

    await turn.respondToQuestion(question.requestId, {
      action: "answer",
      answers: [
        { questionId: single.questionId, kind: "selection", optionIds: [single.input.options[0].optionId], customValues: [] },
        { questionId: multi.questionId, kind: "selection",
          optionIds: [multi.input.options[0].optionId, multi.input.options[1].optionId], customValues: [] },
        { questionId: other.questionId, kind: "selection", optionIds: [], customValues: ["Custom target"] },
        {
          questionId: multiOther.questionId,
          kind: "selection",
          optionIds: [multiOther.input.options[1].optionId],
          customValues: ["Lint"],
        },
        { questionId: skipped.questionId, kind: "skipped" },
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
    assert.deepEqual(events.find(({ type }) => type === "tool.completed").output, {
      stdout: "tests passed",
    });
    assert.deepEqual((await turn.result).usage, {
      inputTokens: 10,
      outputTokens: 8,
      cachedInputTokens: 3,
    });

    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.equal(evidence.prompts[0].permissionMode, "manual");
    assert.deepEqual(evidence.approvalDecisions, [{
      approvalId: `approval_${session.reference.sessionId}`,
      decision: "approved",
      scope: null,
    }]);
    assert.deepEqual(evidence.questionResponses[0], {
      questionId: `question_${session.reference.sessionId}`,
      action: "answer",
      answers: {
        q_single: { kind: "single", option_id: "single_staging" },
        q_multi: { kind: "multi", option_ids: ["multi_unit", "multi_e2e"] },
        q_other: { kind: "other", text: "Custom target" },
        q_multi_other: {
          kind: "multi_with_other",
          option_ids: ["mo_e2e"],
          other_text: "Lint",
        },
        q_skip: { kind: "skipped" },
      },
    });

    const diagnostics = new DatabaseSync(join(fixture.runtime.dataDir, "diagnostic-events.sqlite"), {
      readOnly: true,
    });
    try {
      const nativeTypes = diagnostics.prepare(
        "SELECT payload_json FROM native_event_records WHERE harness = 'kimi' ORDER BY record_id",
      ).all().map(({ payload_json }) => JSON.parse(payload_json)?.type).filter(Boolean);
      for (const type of [
        "tool.call.delta",
        "permission.approval.requested",
        "tool.progress",
        "event.approval.requested",
        "event.approval.resolved",
        "event.question.requested",
        "event.question.answered",
      ]) assert.equal(nativeTypes.includes(type), true, type);
    } finally {
      diagnostics.close();
    }
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("Kimi autoDeny uses one rejected decision and supports whole-request dismiss", async () => {
  const fixture = await createFixture("auto-deny");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "kimi",
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
    assert.deepEqual(
      events.filter(({ type }) => type === "question.resolved")
        .map(({ outcome, source }) => ({ outcome, source })),
      [{ outcome: "dismissed", source: "caller" }],
    );
    assert.equal(events.find(({ type }) => type === "tool.completed").isError, true);
    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.deepEqual(evidence.approvalDecisions.map(({ decision }) => decision), ["rejected"]);
    assert.deepEqual(evidence.questionResponses.map(({ action }) => action), ["dismiss"]);
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("Kimi autoApprove uses one one-shot approved decision without a Session scope", async () => {
  const fixture = await createFixture("auto-approve");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "kimi",
      workspacePath: fixture.workspace,
      approvalPolicy: "autoApprove",
    });
    const turn = await session.startTurn([{ type: "text", text: "Approve permission." }]);
    const iterator = turn[Symbol.asyncIterator]();
    let question;
    const events = [];
    while (!question) {
      const event = (await iterator.next()).value;
      events.push(event);
      if (event.type === "question.requested") question = event;
    }
    assert.deepEqual(
      events.filter(({ type }) => type === "approval.resolved")
        .map(({ outcome, source }) => ({ outcome, source })),
      [{ outcome: "allowOnce", source: "policy" }],
    );
    await turn.respondToQuestion(question.requestId, { action: "dismiss" });
    await turn.result;
    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.deepEqual(evidence.approvalDecisions, [{
      approvalId: `approval_${session.reference.sessionId}`,
      decision: "approved",
      scope: null,
    }]);
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("Kimi maps an ordinary MCP Tool without negotiating an elicitation capability", async () => {
  const fixture = await createFixture("mcp-tool", "rich-mcp");
  let session;
  try {
    session = await fixture.runtime.createSession({ harness: "kimi", workspacePath: fixture.workspace });
    const turn = await session.startTurn([{ type: "text", text: "Use configured MCP." }]);
    const iterator = turn[Symbol.asyncIterator]();
    let approval;
    const events = [];
    while (!approval) {
      const event = (await iterator.next()).value;
      events.push(event);
      if (event.type === "approval.requested") approval = event;
    }
    assert.equal(events.find(({ type }) => type === "tool.started").toolName,
      "mcp__configured__lookup");
    await turn.respondToApproval(approval.requestId, "allowOnce");
    let question;
    while (!question) {
      const event = (await iterator.next()).value;
      if (event.type === "question.requested") question = event;
    }
    await turn.respondToQuestion(question.requestId, { action: "dismiss" });
    assert.equal((await turn.result).status, "completed");
  } finally {
    await session?.close();
    await fixture.close();
  }
});

async function createFixture(name, scenario = "rich") {
  const root = await mkdtemp(join(tmpdir(), `muha-kimi-${name}-rich-`));
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
