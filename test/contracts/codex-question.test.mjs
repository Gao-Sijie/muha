import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Codex maps request_user_input Questions and caller answers losslessly", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-question-"));
  const workspace = join(root, "workspace");
  const responseFile = join(root, "question-response.json");
  let runtime;
  let session;
  try {
    await mkdir(workspace);
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({
        env: {
          PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_TURN_SCENARIO: "question",
          MUHA_FAKE_QUESTION_RESPONSE_FILE: responseFile,
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "Ask me." }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type !== "question.requested") continue;
      assert.equal(event.toolCallId, undefined);
      assert.deepEqual(
        event.questions.map(({ header, question, input }) => ({
          header,
          question,
          kind: input.kind,
          options: input.options?.map(({ label, description }) => ({ label, description })),
          allowCustom: input.allowCustom,
        })),
        [
          {
            header: "Target",
            question: "Choose a target",
            options: [
              { label: "Staging", description: "Use staging" },
              { label: "Production", description: "Use production" },
            ],
            kind: "select",
            allowCustom: false,
          },
          {
            header: "Details",
            question: "Add details",
            kind: "text",
            options: undefined,
            allowCustom: undefined,
          },
          {
            header: "Optional",
            question: "Skip this question",
            options: [
              { label: "Yes", description: "Continue" },
              { label: "No", description: "Stop" },
            ],
            kind: "select",
            allowCustom: false,
          },
        ],
      );
      await turn.respondToQuestion(event.requestId, {
        action: "answer",
        answers: [
          {
            questionId: event.questions[0].questionId,
            kind: "selection",
            optionIds: [event.questions[0].input.options[1].optionId],
            customValues: [],
          },
          {
            questionId: event.questions[1].questionId,
            kind: "text",
            text: "Ship after checks",
          },
          {
            questionId: event.questions[2].questionId,
            kind: "skipped",
          },
        ],
      });
    }

    assert.equal((await turn.result).status, "completed");
    const requested = events.find(({ type }) => type === "question.requested");
    const resolved = events.find(({ type }) => type === "question.resolved");
    assert.equal(resolved.requestId, requested.requestId);
    assert.equal(resolved.outcome, "answered");
    assert.equal(resolved.source, "caller");
    assert.deepEqual(JSON.parse(await readFile(responseFile, "utf8")), {
      answers: {
        target: { answers: ["Production"] },
        details: { answers: ["Ship after checks"] },
        optional: { answers: [] },
      },
    });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex fails closed instead of exposing a native secret Question lossily", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-secret-question-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  try {
    await mkdir(workspace);
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({
        env: {
          PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_TURN_SCENARIO: "question-secret",
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "Ask secretly." }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "question.requested") {
        await turn.respondToQuestion(event.requestId, { action: "dismiss" });
      }
    }
    const result = await turn.result;
    assert.equal(events.some(({ type }) => type === "question.requested"), false);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
