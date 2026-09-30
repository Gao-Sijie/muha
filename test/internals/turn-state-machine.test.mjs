import assert from "node:assert/strict";
import test from "node:test";

import { MuhaError } from "@muha-sdk/core";
import { CoreAgentSession } from "../../packages/core/dist/session.js";
import { FULL_HARNESS_CAPABILITIES } from "../support/full-harness-capabilities.mjs";

test("Core terminates non-JSON-safe Adapter Tool values without rejecting result", async () => {
  const cycle = {};
  cycle.self = cycle;
  const values = [undefined, 1n, () => undefined, Number.NaN, Number.POSITIVE_INFINITY, cycle];

  for (const value of values) {
    const coreRecords = [];
    const adapterSession = {
      nativeSessionId: "internal-session",
      model: undefined,
      async startTurn() {
        return {
          nativeTurnId: "internal-turn",
          async *[Symbol.asyncIterator]() {
            yield { type: "turn.started" };
            yield { type: "usage.updated", usage: { inputTokens: 1 } };
            yield {
              type: "tool.started",
              nativeToolCallId: "unsafe-tool",
              toolName: "unsafe",
              input: value,
            };
            yield { type: "turn.completed" };
          },
        };
      },
      async setModel() {},
      async close() {},
    };
    const session = new CoreAgentSession(
      "codex",
      "/tmp/muha-internal-test-only",
      adapterSession,
      "interactive",
      FULL_HARNESS_CAPABILITIES,
      async (record) => coreRecords.push(record),
    );
    const turn = await session.startTurn([{ type: "text", text: "test" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
    assert.deepEqual(result.usage, { inputTokens: 1 });
    assert.equal(events.at(-1).type, "turn.failed");
    assert.deepEqual(events.at(-1).usage, { inputTokens: 1 });
    assert.equal(coreRecords.length, 1);
  }
});

test("a rejected Approval response remains retryable and does not decide the Turn terminal", async () => {
  let attempts = 0;
  let releaseTurn;
  const continueTurn = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  const adapterSession = approvalAdapterSession({
    async respondToApproval(_requestId, decision) {
      attempts += 1;
      assert.equal(decision, "allowOnce");
      if (attempts === 1) {
        throw {
          code: "HARNESS_ERROR",
          message: "fixture rejected the response",
          harness: "codex",
          operation: "respondToApproval",
        };
      }
      releaseTurn();
    },
    continueTurn,
  });
  const session = new CoreAgentSession(
    "codex",
    "/tmp/muha-internal-test-only",
    adapterSession,
    "interactive",
    FULL_HARNESS_CAPABILITIES,
    async () => {},
  );
  const turn = await session.startTurn([{ type: "text", text: "test" }]);
  const iterator = turn[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "turn.started");
  assert.equal((await iterator.next()).value.type, "tool.started");
  const requested = (await iterator.next()).value;
  assert.equal(requested.type, "approval.requested");
  await assert.rejects(
    turn.respondToApproval(requested.requestId, "allowOnce"),
    (error) => error instanceof MuhaError && error.data.code === "HARNESS_ERROR",
  );
  let settled = false;
  void turn.result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  await turn.respondToApproval(requested.requestId, "allowOnce");
  const remaining = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    remaining.push(next.value);
  }
  assert.equal(attempts, 2);
  assert.equal(remaining.filter(({ type }) => type === "approval.resolved").length, 1);
  assert.equal((await turn.result).status, "completed");
});

test("a Harness invalidation wins an in-flight caller Approval race exactly once", async () => {
  let releaseInvalidation;
  let resolveNativeResponse;
  const invalidate = new Promise((resolve) => {
    releaseInvalidation = resolve;
  });
  const nativeResponse = new Promise((resolve) => {
    resolveNativeResponse = resolve;
  });
  const adapterSession = approvalAdapterSession({
    respondToApproval: () => nativeResponse,
    continueTurn: invalidate,
    invalidate: true,
  });
  const session = new CoreAgentSession(
    "codex",
    "/tmp/muha-internal-test-only",
    adapterSession,
    "interactive",
    FULL_HARNESS_CAPABILITIES,
    async () => {},
  );
  const turn = await session.startTurn([{ type: "text", text: "test" }]);
  const iterator = turn[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  const requested = (await iterator.next()).value;
  const callerResponse = turn.respondToApproval(requested.requestId, "allowOnce");
  releaseInvalidation();
  const resolution = (await iterator.next()).value;
  assert.equal(resolution.type, "approval.resolved");
  assert.equal(resolution.outcome, "invalidated");
  assert.equal(resolution.source, "harness");
  resolveNativeResponse();
  await assert.rejects(
    callerResponse,
    (error) => error instanceof MuhaError && error.data.code === "TURN_INTERACTION_INVALIDATED",
  );
  const terminal = (await iterator.next()).value;
  assert.equal(terminal.type, "turn.failed");
  assert.equal((await iterator.next()).done, true);
});

test("structured Questions validate complete answers and resolve without a timer", async () => {
  let releaseTurn;
  let observedResponse;
  const continueTurn = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  const coreRecords = [];
  const session = new CoreAgentSession(
    "opencode",
    "/tmp/muha-internal-test-only",
    questionAdapterSession({
      continueTurn,
      async respondToQuestion(_nativeRequestId, response) {
        observedResponse = response;
        releaseTurn();
      },
    }),
    "interactive",
    FULL_HARNESS_CAPABILITIES,
    async (record) => coreRecords.push(record),
  );
  const turn = await session.startTurn([{ type: "text", text: "test" }]);
  const iterator = turn[Symbol.asyncIterator]();
  await iterator.next();
  const tool = (await iterator.next()).value;
  const requested = (await iterator.next()).value;
  assert.equal(requested.type, "question.requested");
  assert.equal(requested.toolCallId, tool.toolCallId);
  assert.match(requested.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(requested.questions.length, 4);
  assert.equal(new Set(requested.questions.map(({ questionId }) => questionId)).size, 4);
  assert.equal(
    new Set(requested.questions.flatMap(({ input }) => input.options?.map(({ optionId }) => optionId) ?? [])).size,
    4,
  );

  let settled = false;
  void turn.result.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);

  await assert.rejects(
    turn.respondToQuestion("unknown", { action: "dismiss" }),
    (error) =>
      error instanceof MuhaError &&
      error.data.code === "TURN_INTERACTION_NOT_FOUND" &&
      error.data.interaction === "question",
  );
  await assert.rejects(
    turn.respondToQuestion(requested.requestId, {
      action: "answer",
      answers: [{ questionId: requested.questions[0].questionId, kind: "skipped" }],
    }),
    (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
  );

  const [single, multi, custom, skipped] = requested.questions;
  const invalidResponses = [
    {
      action: "answer",
      answers: [
        { questionId: single.questionId, kind: "selection", optionIds: ["foreign"], customValues: [] },
        { questionId: multi.questionId, kind: "skipped" },
        { questionId: custom.questionId, kind: "skipped" },
        { questionId: skipped.questionId, kind: "skipped" },
      ],
    },
    {
      action: "answer",
      answers: [
        { questionId: single.questionId, kind: "selection",
          optionIds: [single.input.options[0].optionId, single.input.options[0].optionId], customValues: [] },
        { questionId: multi.questionId, kind: "skipped" },
        { questionId: custom.questionId, kind: "skipped" },
        { questionId: skipped.questionId, kind: "skipped" },
      ],
    },
    {
      action: "answer",
      answers: [
        { questionId: single.questionId, kind: "selection", optionIds: [], customValues: ["not allowed"] },
        { questionId: multi.questionId, kind: "skipped" },
        { questionId: custom.questionId, kind: "skipped" },
        { questionId: skipped.questionId, kind: "skipped" },
      ],
    },
    {
      action: "answer",
      answers: [
        { questionId: single.questionId, kind: "skipped" },
        { questionId: multi.questionId, kind: "selection",
          optionIds: [multi.input.options[0].optionId], customValues: [""] },
        { questionId: custom.questionId, kind: "skipped" },
        { questionId: skipped.questionId, kind: "skipped" },
      ],
    },
  ];
  for (const [index, invalidResponse] of invalidResponses.entries()) {
    await assert.rejects(
      turn.respondToQuestion(requested.requestId, invalidResponse),
      (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
      `invalid response ${index}`,
    );
  }
  const response = {
    action: "answer",
    answers: [
      { questionId: skipped.questionId, kind: "skipped" },
      { questionId: custom.questionId, kind: "text", text: "typed" },
      {
        questionId: multi.questionId,
        kind: "selection",
        optionIds: [multi.input.options[1].optionId, multi.input.options[0].optionId],
        customValues: ["other"],
      },
      { questionId: single.questionId, kind: "selection", optionIds: [single.input.options[0].optionId], customValues: [] },
    ],
  };
  await turn.respondToQuestion(requested.requestId, response);
  assert.deepEqual(observedResponse, {
    action: "answer",
    answers: [
      { questionIndex: 0, kind: "options", optionIndexes: [0] },
      { questionIndex: 1, kind: "optionsWithCustom", optionIndexes: [1, 0], text: "other" },
      { questionIndex: 2, kind: "custom", text: "typed" },
      { questionIndex: 3, kind: "skipped" },
    ],
  });
  const resolved = (await iterator.next()).value;
  assert.equal(resolved.type, "question.resolved");
  assert.equal(resolved.outcome, "answered");
  assert.equal(resolved.source, "caller");
  assert.deepEqual(resolved.answers.map(({ questionId }) => questionId),
    requested.questions.map(({ questionId }) => questionId));
  await assert.rejects(
    turn.respondToQuestion(requested.requestId, { action: "dismiss" }),
    (error) =>
      error instanceof MuhaError &&
      error.data.code === "TURN_INTERACTION_ALREADY_RESOLVED" &&
      error.data.interaction === "question",
  );
  for await (const _event of { [Symbol.asyncIterator]: () => iterator }) {
    // Drain the terminal sequence.
  }
  assert.equal((await turn.result).status, "completed");
  assert.equal(coreRecords.some(({ type }) => type === "question.resolved"), true);
});

test("pending Questions invalidate before terminal and native dismiss wins a caller race", async () => {
  let releaseTurn;
  const continueTurn = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  let resolveNativeResponse;
  const nativeResponse = new Promise((resolve) => {
    resolveNativeResponse = resolve;
  });
  const session = new CoreAgentSession(
    "opencode",
    "/tmp/muha-internal-test-only",
    questionAdapterSession({
      continueTurn,
      nativeResolution: { type: "question.dismissed", nativeRequestId: "native-question" },
      respondToQuestion: () => nativeResponse,
    }),
    "interactive",
    FULL_HARNESS_CAPABILITIES,
    async () => {},
  );
  const turn = await session.startTurn([{ type: "text", text: "test" }]);
  const iterator = turn[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  const requested = (await iterator.next()).value;
  const caller = turn.respondToQuestion(requested.requestId, { action: "dismiss" });
  releaseTurn();
  const resolved = (await iterator.next()).value;
  assert.deepEqual(
    { type: resolved.type, outcome: resolved.outcome, source: resolved.source },
    { type: "question.resolved", outcome: "dismissed", source: "harness" },
  );
  resolveNativeResponse();
  await assert.rejects(
    caller,
    (error) => error instanceof MuhaError && error.data.code === "TURN_INTERACTION_ALREADY_RESOLVED",
  );
  for await (const _event of { [Symbol.asyncIterator]: () => iterator }) {
    // Drain the terminal sequence.
  }
});

test("a pending Question is invalidated before terminal and remains non-actionable", async () => {
  let releaseTurn;
  const continueTurn = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  const session = new CoreAgentSession(
    "opencode",
    "/tmp/muha-internal-test-only",
    questionAdapterSession({
      continueTurn,
      async respondToQuestion() {},
    }),
    "interactive",
    FULL_HARNESS_CAPABILITIES,
    async () => {},
  );
  const turn = await session.startTurn([{ type: "text", text: "test" }]);
  const iterator = turn[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  const requested = (await iterator.next()).value;
  releaseTurn();
  const invalidated = (await iterator.next()).value;
  assert.deepEqual(
    { type: invalidated.type, outcome: invalidated.outcome, source: invalidated.source },
    { type: "tool.completed", outcome: undefined, source: undefined },
  );
  const assistantStarted = (await iterator.next()).value;
  assert.equal(assistantStarted.type, "assistant.message.started");
  const assistantCompleted = (await iterator.next()).value;
  assert.equal(assistantCompleted.type, "assistant.message.completed");
  const resolution = (await iterator.next()).value;
  assert.deepEqual(
    { type: resolution.type, outcome: resolution.outcome, source: resolution.source },
    { type: "question.resolved", outcome: "invalidated", source: "turn" },
  );
  assert.equal((await iterator.next()).value.type, "turn.completed");
  await assert.rejects(
    turn.respondToQuestion(requested.requestId, { action: "dismiss" }),
    (error) =>
      error instanceof MuhaError &&
      error.data.code === "TURN_INTERACTION_INVALIDATED" &&
      error.data.interaction === "question",
  );
});

function approvalAdapterSession({ respondToApproval, continueTurn, invalidate = false }) {
  return {
    nativeSessionId: "internal-session",
    model: undefined,
    async startTurn() {
      return {
        nativeTurnId: "internal-turn",
        respondToApproval,
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "turn.started" };
          yield {
            type: "tool.started",
            nativeToolCallId: "native-tool",
            toolName: "commandExecution",
            input: { command: "true" },
          };
          yield {
            type: "approval.requested",
            nativeRequestId: "native-approval",
            nativeToolCallId: "native-tool",
            title: "Approve command execution",
          };
          await continueTurn;
          if (invalidate) {
            yield { type: "approval.invalidated", nativeRequestId: "native-approval" };
            yield {
              type: "turn.failed",
              error: {
                code: "HARNESS_ERROR",
                message: "fixture terminal",
                harness: "codex",
                operation: "startTurn",
              },
            };
            return;
          }
          yield {
            type: "tool.completed",
            nativeToolCallId: "native-tool",
            output: null,
            isError: false,
          };
          yield { type: "assistant.message.started", nativeMessageId: "native-message" };
          yield {
            type: "assistant.message.completed",
            nativeMessageId: "native-message",
            text: "done",
          };
          yield { type: "turn.completed" };
        },
      };
    },
    async setModel() {},
    async close() {},
  };
}

function questionAdapterSession({ respondToQuestion, continueTurn, nativeResolution }) {
  return {
    nativeSessionId: "internal-session",
    model: undefined,
    async startTurn() {
      return {
        nativeTurnId: "internal-turn",
        async respondToApproval() {},
        respondToQuestion,
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          yield { type: "turn.started" };
          yield {
            type: "tool.started",
            nativeToolCallId: "native-tool",
            toolName: "question",
            input: {},
          };
          yield {
            type: "question.requested",
            nativeRequestId: "native-question",
            nativeToolCallId: "native-tool",
            questions: [
              {
                header: "One",
                question: "Pick one",
                options: [{ label: "A" }],
                multiple: false,
                allowCustom: false,
              },
              {
                question: "Pick several",
                description: "Multiple choices",
                options: [{ label: "B" }, { label: "C", description: "third" }],
                multiple: true,
                allowCustom: true,
              },
              { question: "Type", options: [], multiple: false, allowCustom: true },
              { question: "Skip", options: [{ label: "D" }], multiple: false, allowCustom: false },
            ],
          };
          await continueTurn;
          if (nativeResolution) yield nativeResolution;
          yield {
            type: "tool.completed",
            nativeToolCallId: "native-tool",
            output: null,
            isError: false,
          };
          yield { type: "assistant.message.started", nativeMessageId: "native-message" };
          yield { type: "assistant.message.completed", nativeMessageId: "native-message", text: "done" };
          yield { type: "turn.completed" };
        },
      };
    },
    async setModel() {},
    async close() {},
  };
}
