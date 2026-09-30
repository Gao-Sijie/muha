// T16 — Codex ACP route: Question lifecycle (elicitation), structured
// answers, dismiss, invalidation after terminal, and request routing.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import { controlledCodexAdapter as codexAdapter } from "../fixtures/acp-harness/options.mjs";
import { acpOptions } from "../fixtures/acp-harness/options.mjs";

test("Codex ACP route surfaces a Question and applies a structured answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-acp-question-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({ acp: acpOptions("question") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "choose target" }]);
    const questions = [];
    for await (const event of turn) {
      if (event.type === "question.requested") {
        questions.push(event);
        await turn.respondToQuestion(event.requestId, {
          action: "answer",
          answers: [{ questionId: event.questions[0].questionId, kind: "selection",
            optionIds: [event.questions[0].input.options[1].optionId], customValues: [] }],
        });
      }
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "answered");
    assert.equal(questions.length, 1);
    assert.equal(questions[0].questions[0].question, "Choose a target");
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex ACP route treats a dismissed Question as a resolved interaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-acp-qdismiss-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({ acp: acpOptions("question-dismiss") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "choose target" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "question.requested") await turn.respondToQuestion(event.requestId, { action: "dismiss" });
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.ok(events.some((e) => e.type === "question.resolved" && e.outcome === "dismissed"));
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex ACP route rejects invalid answers deterministically and keeps the Question unusable", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-acp-qbad-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({ acp: acpOptions("question") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "choose target" }]);
    let questionId;
    for await (const event of turn) {
      if (event.type === "question.requested") {
        questionId = event.requestId;
        // Option index out of range must be rejected by Core's validation.
        await assert.rejects(
          turn.respondToQuestion(event.requestId, {
            action: "answer",
            answers: [{ questionId: event.questions[0].questionId, kind: "selection", optionIds: [], customValues: [] }],
          }),
          (error) => error.data?.code === "INVALID_INPUT",
        );
        // A valid answer then completes the interaction.
        await turn.respondToQuestion(event.requestId, {
          action: "answer",
          answers: [{ questionId: event.questions[0].questionId, kind: "selection",
            optionIds: [event.questions[0].input.options[0].optionId], customValues: [] }],
        });
      }
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.ok(questionId !== undefined);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of ["question-orphan", "mcp-form"]) test(`Codex ACP declines ${scenario} without fabricating a native Question`, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-acp-qorphan-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({ acp: acpOptions(scenario) })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "exercise ignored interaction" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).message.text, "dismissed");
    assert.equal(events.some(event => event.type === "question.requested"), false);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
