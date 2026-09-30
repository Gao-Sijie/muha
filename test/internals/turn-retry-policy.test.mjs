import assert from "node:assert/strict";
import test from "node:test";

import { CoreAgentSession } from "../../packages/core/dist/session.js";
import { FULL_HARNESS_CAPABILITIES } from "../support/full-harness-capabilities.mjs";

const workspacePath = "/tmp/muha-turn-retry-policy-test";

test("an opted-in Session retries an eligible accepted Turn as one public Turn", async () => {
  let starts = 0;
  const inputs = [];
  const session = createSession({
    maxRetries: 1,
    startTurn: async (input) => {
      inputs.push(input);
      starts += 1;
      return starts === 1
        ? failedTurn({ nativeCode: "CERTIFICATE_VERIFY_FAILED" })
        : completedTurn("recovered");
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "recover" }]);
  const events = await collect(turn);
  const result = await turn.result;

  assert.equal(starts, 2);
  assert.deepEqual(inputs, [
    [{ type: "text", text: "recover" }],
    [{ type: "text", text: "recover" }],
  ]);
  assert.equal(events.filter(({ type }) => type === "turn.started").length, 1);
  assert.deepEqual(
    events.filter(({ type }) => type === "turn.retrying").map(({ retryNumber, maxRetries, error }) => ({
      retryNumber,
      maxRetries,
      nativeCode: error.nativeCode,
    })),
    [{ retryNumber: 1, maxRetries: 1, nativeCode: "CERTIFICATE_VERIFY_FAILED" }],
  );
  assert.equal(events.at(-1).type, "turn.completed");
  assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_, index) => index + 1));
  assert.equal(result.status, "completed");
  assert.equal(result.message.text, "recovered");
  assert.equal(new Set(events.map(({ turnId }) => turnId)).size, 1);
  assert.equal(events.at(-1).turnId, result.turnId);
});

test("the default Session policy and retryable false preserve immediate failure", async () => {
  for (const { policy, retryable } of [
    { policy: undefined, retryable: undefined },
    { policy: { maxRetries: 0 }, retryable: undefined },
    { policy: { maxRetries: 3 }, retryable: false },
  ]) {
    let starts = 0;
    const session = createSession({
      ...(policy === undefined ? {} : policy),
      startTurn: async () => {
        starts += 1;
        return failedTurn({ retryable });
      },
    });

    const turn = await session.startTurn([{ type: "text", text: "fail" }]);
    const events = await collect(turn);

    assert.equal(starts, 1);
    assert.equal(events.some(({ type }) => type === "turn.retrying"), false);
    assert.equal((await turn.result).status, "failed");
  }
});

test("retry budget covers fail, fail, then succeed", async () => {
  let starts = 0;
  const inputs = [];
  const session = createSession({
    maxRetries: 2,
    startTurn: async (input) => {
      inputs.push(input);
      starts += 1;
      return starts < 3 ? failedTurn({ nativeCode: `TLS_${starts}` }) : completedTurn("recovered");
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "recover twice" }]);
  const events = await collect(turn);

  assert.equal(starts, 3);
  assert.deepEqual(inputs, Array.from({ length: 3 }, () => [{ type: "text", text: "recover twice" }]));
  assert.equal(events.filter(({ type }) => type === "turn.started").length, 1);
  assert.deepEqual(
    events.filter(({ type }) => type === "turn.retrying").map(({ retryNumber }) => retryNumber),
    [1, 2],
  );
  assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_, index) => index + 1));
  assert.equal(new Set(events.map(({ turnId }) => turnId)).size, 1);
  const result = await turn.result;
  assert.equal(result.status, "completed");
  assert.equal(result.message.text, "recovered");
  assert.equal(events.at(-1).turnId, result.turnId);
});

test("the initial Turn command rejection is never retried", async () => {
  let starts = 0;
  let waits = 0;
  const session = createSession({
    maxRetries: 3,
    sleepBeforeRetry: async () => {
      waits += 1;
    },
    startTurn: async () => {
      starts += 1;
      throw harnessFailure();
    },
  });

  await assert.rejects(session.startTurn([{ type: "text", text: "reject" }]));
  assert.equal(starts, 1);
  assert.equal(waits, 0);
});

test("retry preserves prior activity and reports cumulative usage", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 1,
    startTurn: async () => {
      starts += 1;
      return starts === 1
        ? failedTurn({ usage: { inputTokens: 2, outputTokens: 3 }, text: "partial" })
        : completedTurn("done", { inputTokens: 5, outputTokens: 7 });
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "aggregate" }]);
  const events = await collect(turn);
  const usageEvents = events.filter(({ type }) => type === "usage.updated");

  assert.equal(events.filter(({ type }) => type === "assistant.message.completed").length, 2);
  assert.deepEqual(usageEvents.at(-1).usage, { inputTokens: 7, outputTokens: 10 });
  assert.deepEqual(events.at(-1).usage, { inputTokens: 7, outputTokens: 10 });
  assert.deepEqual((await turn.result).usage, { inputTokens: 7, outputTokens: 10 });
});

test("attempt-local identifiers can repeat while public activity and resolved interactions remain", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 1,
    startTurn: async () => {
      starts += 1;
      if (starts === 1) {
        return nativeTurn(async function* () {
          yield { type: "turn.started" };
          yield { type: "assistant.message.started", nativeMessageId: "same-message" };
          yield { type: "assistant.reasoning.delta", nativeMessageId: "same-message", delta: "thinking" };
          yield { type: "assistant.message.completed", nativeMessageId: "same-message", text: "partial" };
          yield { type: "tool.started", nativeToolCallId: "same-tool", toolName: "shell", input: {} };
          yield { type: "tool.completed", nativeToolCallId: "same-tool", output: null, isError: false };
          yield { type: "approval.requested", nativeRequestId: "same-approval", title: "Approve" };
          yield { type: "approval.invalidated", nativeRequestId: "same-approval" };
          yield { type: "turn.failed", error: harnessFailure() };
        });
      }
      return nativeTurn(async function* () {
        yield { type: "turn.started" };
        yield { type: "assistant.message.started", nativeMessageId: "same-message" };
        yield { type: "assistant.message.completed", nativeMessageId: "same-message", text: "done" };
        yield { type: "tool.started", nativeToolCallId: "same-tool", toolName: "shell", input: {} };
        yield { type: "tool.completed", nativeToolCallId: "same-tool", output: null, isError: false };
        yield { type: "turn.completed" };
      });
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "activity" }]);
  const events = await collect(turn);

  assert.equal(events.filter(({ type }) => type === "assistant.reasoning.delta").length, 1);
  assert.equal(events.filter(({ type }) => type === "approval.resolved").length, 1);
  assert.equal(new Set(events.filter(({ type }) => type === "assistant.message.started").map(({ messageId }) => messageId)).size, 2);
  assert.equal(new Set(events.filter(({ type }) => type === "tool.started").map(({ toolCallId }) => toolCallId)).size, 2);
  assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_, index) => index + 1));
  assert.equal((await turn.result).status, "completed");
});

test("a final failure reports usage accumulated across attempts without double-counting snapshots", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 1,
    startTurn: async () => {
      starts += 1;
      return nativeTurn(async function* () {
        yield { type: "turn.started" };
        yield { type: "usage.updated", usage: { inputTokens: starts } };
        yield { type: "usage.updated", usage: { inputTokens: starts + 1 } };
        yield { type: "turn.failed", error: harnessFailure() };
      });
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "final failure" }]);
  const events = await collect(turn);
  const result = await turn.result;

  assert.equal(result.status, "failed");
  assert.deepEqual(result.usage, { inputTokens: 5 });
  assert.deepEqual(events.at(-1).usage, { inputTokens: 5 });
});

test("each public Turn receives a fresh retry budget", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 1,
    startTurn: async () => {
      starts += 1;
      return starts % 2 === 1 ? failedTurn() : completedTurn(`done-${starts / 2}`);
    },
  });

  for (const text of ["first", "second"]) {
    const turn = await session.startTurn([{ type: "text", text }]);
    const events = await collect(turn);
    assert.equal(events.filter(({ type }) => type === "turn.retrying").length, 1);
    assert.equal((await turn.result).status, "completed");
  }
  assert.equal(starts, 4);
});

test("a retry start rejection stays inside the accepted public Turn and consumes budget", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 2,
    startTurn: async () => {
      starts += 1;
      if (starts === 1) return failedTurn({ nativeCode: "TLS_FIRST" });
      if (starts === 2) {
        throw {
          code: "HARNESS_ERROR",
          message: "retry command rejected",
          harness: "opencode",
          operation: "startTurn",
          nativeCode: "TLS_REJECTED",
        };
      }
      return completedTurn("third attempt");
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "retry rejection" }]);
  const events = await collect(turn);

  assert.deepEqual(
    events.filter(({ type }) => type === "turn.retrying").map(({ retryNumber, error }) => ({
      retryNumber,
      nativeCode: error.nativeCode,
    })),
    [
      { retryNumber: 1, nativeCode: "TLS_FIRST" },
      { retryNumber: 2, nativeCode: "TLS_REJECTED" },
    ],
  );
  assert.equal(starts, 3);
  assert.equal((await turn.result).status, "completed");
});

test("an Adapter protocol rejection while starting a retry attempt is never retried", async () => {
  let starts = 0;
  const records = [];
  const session = createSession({
    maxRetries: 3,
    records,
    startTurn: async () => {
      starts += 1;
      if (starts === 1) return failedTurn();
      throw {
        code: "ADAPTER_PROTOCOL_ERROR",
        message: "malformed retry response",
        harness: "opencode",
        secret: "must not escape",
      };
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "protocol" }]);
  const events = await collect(turn);
  const result = await turn.result;

  assert.equal(starts, 2);
  assert.equal(events.filter(({ type }) => type === "turn.retrying").length, 1);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, {
    code: "ADAPTER_PROTOCOL_ERROR",
    message: "malformed retry response",
    harness: "opencode",
  });
  assert.equal(records.at(-1).type, "turn.failed");
  assert.equal(records.at(-1).error.code, "ADAPTER_PROTOCOL_ERROR");
});

for (const invalidFailure of [
  { ...harnessFailure(), operation: "initialize" },
  { ...harnessFailure(), retryable: "false" },
  { ...harnessFailure(), nativeCode: 525 },
]) {
  test(`a malformed retry start failure becomes a protocol failure: ${JSON.stringify(invalidFailure)}`, async () => {
    let starts = 0;
    const session = createSession({
      maxRetries: 2,
      startTurn: async () => {
        starts += 1;
        if (starts === 1) return failedTurn();
        if (starts === 2) throw invalidFailure;
        return completedTurn("must not run");
      },
    });

    const turn = await session.startTurn([{ type: "text", text: "invalid retry failure" }]);
    const events = await collect(turn);
    const result = await turn.result;

    assert.equal(starts, 2);
    assert.equal(events.filter(({ type }) => type === "turn.retrying").length, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
  });
}

test("a non-Turn Harness failure is not retry-eligible", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 2,
    startTurn: async () => {
      starts += 1;
      return failedTurn({ operation: "initialize" });
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "wrong operation" }]);
  const events = await collect(turn);

  assert.equal(starts, 1);
  assert.equal(events.some(({ type }) => type === "turn.retrying"), false);
  assert.equal((await turn.result).status, "failed");
});

test("an unresolved Approval vetoes retry", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 2,
    startTurn: async () => {
      starts += 1;
      return nativeTurn(async function* () {
        yield { type: "turn.started" };
        yield {
          type: "approval.requested",
          nativeRequestId: "approval",
          title: "Approve",
        };
        yield {
          type: "turn.failed",
          error: harnessFailure(),
        };
      });
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "approval" }]);
  const events = await collect(turn);

  assert.equal(starts, 1);
  assert.equal(events.some(({ type }) => type === "turn.retrying"), false);
  assert.deepEqual(
    events.filter(({ type }) => type === "approval.resolved").map(({ outcome, source }) => ({ outcome, source })),
    [{ outcome: "invalidated", source: "turn" }],
  );
  assert.equal((await turn.result).status, "failed");
});

test("an unresolved Question vetoes retry", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 1,
    startTurn: async () => {
      starts += 1;
      return nativeTurn(async function* () {
        yield { type: "turn.started" };
        yield {
          type: "question.requested",
          nativeRequestId: "question",
          questions: [{ question: "Choose", options: [{ label: "A" }], multiple: false, allowCustom: false }],
        };
        yield { type: "turn.failed", error: harnessFailure() };
      });
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "question" }]);
  const events = await collect(turn);

  assert.equal(starts, 1);
  assert.equal(events.some(({ type }) => type === "turn.retrying"), false);
  assert.deepEqual(
    events.filter(({ type }) => type === "question.resolved").map(({ outcome, source }) => ({ outcome, source })),
    [{ outcome: "invalidated", source: "turn" }],
  );
});

for (const interaction of ["approval", "question"]) {
  test(`a resolving ${interaction} vetoes retry`, async () => {
    let starts = 0;
    const emitFailure = deferred();
    const responseStarted = deferred();
    const responseAcknowledged = deferred();
    const session = createSession({
      maxRetries: 1,
      startTurn: async () => {
        starts += 1;
        return nativeTurn(
          async function* () {
            yield { type: "turn.started" };
            if (interaction === "approval") {
              yield { type: "approval.requested", nativeRequestId: "native-request", title: "Approve" };
            } else {
              yield {
                type: "question.requested",
                nativeRequestId: "native-request",
                questions: [{ question: "Choose", options: [{ label: "A" }], multiple: false, allowCustom: false }],
              };
            }
            await emitFailure.promise;
            yield { type: "turn.failed", error: harnessFailure() };
          },
          {
            respondToApproval: async () => {
              responseStarted.resolve();
              await responseAcknowledged.promise;
            },
            respondToQuestion: async () => {
              responseStarted.resolve();
              await responseAcknowledged.promise;
            },
          },
        );
      },
    });

    const turn = await session.startTurn([{ type: "text", text: `resolving ${interaction}` }]);
    const iterator = turn[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, "turn.started");
    const requested = (await iterator.next()).value;
    const response = interaction === "approval"
      ? turn.respondToApproval(requested.requestId, "allowOnce")
      : turn.respondToQuestion(requested.requestId, { action: "dismiss" });
    await responseStarted.promise;
    emitFailure.resolve();
    const remaining = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    responseAcknowledged.resolve();
    await assert.rejects(response, ({ data }) => data?.code === "TURN_INTERACTION_INVALIDATED");

    assert.equal(starts, 1);
    assert.equal(remaining.some(({ type }) => type === "turn.retrying"), false);
    assert.equal((await turn.result).status, "failed");
  });
}

for (const interaction of ["approval", "question"]) {
  test(`a resolved ${interaction} does not veto retry`, async () => {
    let starts = 0;
    const emitFailure = deferred();
    const session = createSession({
      maxRetries: 1,
      startTurn: async () => {
        starts += 1;
        if (starts > 1) return completedTurn("recovered after interaction");
        return nativeTurn(
          async function* () {
            yield { type: "turn.started" };
            if (interaction === "approval") {
              yield { type: "approval.requested", nativeRequestId: "native-request", title: "Approve" };
            } else {
              yield {
                type: "question.requested",
                nativeRequestId: "native-request",
                questions: [{ question: "Choose", options: [{ label: "A" }], multiple: false, allowCustom: false }],
              };
            }
            await emitFailure.promise;
            yield { type: "turn.failed", error: harnessFailure() };
          },
        );
      },
    });

    const turn = await session.startTurn([{ type: "text", text: `resolved ${interaction}` }]);
    const iterator = turn[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, "turn.started");
    const requested = (await iterator.next()).value;
    if (interaction === "approval") {
      await turn.respondToApproval(requested.requestId, "allowOnce");
    } else {
      await turn.respondToQuestion(requested.requestId, { action: "dismiss" });
    }
    emitFailure.resolve();
    const remaining = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }

    assert.equal(starts, 2);
    assert.equal(remaining.filter(({ type }) => type === `${interaction}.resolved`).length, 1);
    assert.equal(remaining.filter(({ type }) => type === "turn.retrying").length, 1);
    assert.equal((await turn.result).status, "completed");
  });
}

test("usage aggregation tolerates attempts without usage and different token fields", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 2,
    startTurn: async () => {
      starts += 1;
      if (starts === 1) return failedTurn({ usage: { inputTokens: 2, cachedInputTokens: 1 } });
      if (starts === 2) return failedTurn();
      return completedTurn("usage recovered", { outputTokens: 4, reasoningTokens: 3 });
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "mixed usage" }]);
  const events = await collect(turn);
  const expected = { inputTokens: 2, outputTokens: 4, cachedInputTokens: 1, reasoningTokens: 3 };

  assert.equal(starts, 3);
  assert.deepEqual(events.at(-1).usage, expected);
  assert.deepEqual((await turn.result).usage, expected);
});

test("protocol failures and stream loss are never retried", async () => {
  for (const terminal of [
    async function* () {
      yield { type: "turn.started" };
      yield { type: "adapter.protocolError", message: "invalid native event" };
    },
    async function* () {
      yield { type: "turn.started" };
    },
  ]) {
    let starts = 0;
    const session = createSession({
      maxRetries: 2,
      startTurn: async () => {
        starts += 1;
        return nativeTurn(terminal);
      },
    });
    const turn = await session.startTurn([{ type: "text", text: "protocol" }]);
    const events = await collect(turn);

    assert.equal(starts, 1);
    assert.equal(events.some(({ type }) => type === "turn.retrying"), false);
    assert.equal((await turn.result).error.code, "ADAPTER_PROTOCOL_ERROR");
  }
});

test("an Event Store failure while recording retry provenance is authoritative", async () => {
  let starts = 0;
  const session = createSession({
    maxRetries: 2,
    recordCoreEvent: async (record) => {
      if (record.type === "turn.retrying") throw new Error("store unavailable");
    },
    startTurn: async () => {
      starts += 1;
      return failedTurn();
    },
  });
  const turn = await session.startTurn([{ type: "text", text: "store" }]);
  const events = await collect(turn);

  assert.equal(starts, 1);
  assert.equal(events.some(({ type }) => type === "turn.retrying"), false);
  assert.equal((await turn.result).error.code, "EVENT_STORE_ERROR");
});

for (const { name, turnQueueLimits, expectedCode } of [
  {
    name: "backpressure",
    turnQueueLimits: { maxEvents: 1, maxBytes: 1024 * 1024 },
    expectedCode: "TURN_EVENT_BACKPRESSURE",
  },
  {
    name: "oversize",
    turnQueueLimits: { maxEvents: 100, maxBytes: 250 },
    expectedCode: "TURN_EVENT_TOO_LARGE",
  },
]) {
  test(`turn.retrying itself remains subject to ${name} protection`, async () => {
    let starts = 0;
    const session = createSession({
      maxRetries: 1,
      turnQueueLimits,
      startTurn: async () => {
        starts += 1;
        return failedTurn();
      },
    });
    const turn = await session.startTurn([{ type: "text", text: name }]);
    const result = await turn.result;
    const events = await collect(turn);

    assert.equal(starts, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, expectedCode);
    assert.equal(events.at(-1).error.code, expectedCode);
  });
}

test("retry policy is snapshotted and retry provenance is recorded before bounded jittered waits", async () => {
  let starts = 0;
  const delays = [];
  const records = [];
  const policy = { maxRetries: 5 };
  const session = createSession({
    retryPolicy: policy,
    records,
    retryJitter: () => 0.5,
    sleepBeforeRetry: async (delayMs) => {
      assert.equal(records.at(-1).type, "turn.retrying");
      delays.push(delayMs);
    },
    startTurn: async () => {
      starts += 1;
      if (starts === 1) return failedTurn();
      if (starts < 6) throw harnessFailure();
      return completedTurn("eventually");
    },
  });
  policy.maxRetries = 0;

  const turn = await session.startTurn([{ type: "text", text: "backoff" }]);
  await collect(turn);

  assert.deepEqual(delays, [563, 1_125, 2_250, 4_500, 5_000]);
  assert.equal(records.filter(({ type }) => type === "turn.retrying").length, 5);
  assert.equal((await turn.result).status, "completed");
});

test("interrupting retry backoff prevents another native Turn Attempt", async () => {
  let starts = 0;
  let backoffStarted;
  const enteredBackoff = new Promise((resolve) => {
    backoffStarted = resolve;
  });
  const session = createSession({
    maxRetries: 2,
    sleepBeforeRetry: async (_delayMs, signal) => {
      backoffStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    startTurn: async () => {
      starts += 1;
      return failedTurn();
    },
  });

  const turn = await session.startTurn([{ type: "text", text: "interrupt" }]);
  const eventsPromise = collect(turn);
  await enteredBackoff;
  await turn.interrupt();
  const events = await eventsPromise;

  assert.equal(starts, 1);
  assert.equal(events.filter(({ type }) => type === "turn.retrying").length, 1);
  assert.equal(events.at(-1).type, "turn.interrupted");
  assert.equal((await turn.result).status, "interrupted");
});

test("active-attempt interruption remains authoritative over a later native failure", async () => {
  const emitFailure = deferred();
  const failureEmitted = deferred();
  const interruptAcknowledged = deferred();
  const session = createSession({
    maxRetries: 1,
    startTurn: async () => nativeTurn(
      async function* () {
        yield { type: "turn.started" };
        await emitFailure.promise;
        failureEmitted.resolve();
        yield { type: "turn.failed", error: harnessFailure() };
      },
      {
        interrupt: async () => {
          emitFailure.resolve();
          await interruptAcknowledged.promise;
        },
      },
    ),
  });
  const turn = await session.startTurn([{ type: "text", text: "interrupt active attempt" }]);
  const eventsPromise = collect(turn);
  const interruption = turn.interrupt();
  await failureEmitted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  interruptAcknowledged.resolve();
  await interruption;
  const events = await eventsPromise;

  assert.equal(events.some(({ type }) => type === "turn.retrying"), false);
  assert.equal(events.at(-1).type, "turn.interrupted");
  assert.equal(events.at(-1).reason, "caller");
  assert.equal((await turn.result).status, "interrupted");
});

test("a retry-start rejection after interruption cannot add a second terminal record", async () => {
  let starts = 0;
  const retryStartEntered = deferred();
  const rejectRetryStart = deferred();
  const records = [];
  const session = createSession({
    maxRetries: 1,
    records,
    startTurn: async () => {
      starts += 1;
      if (starts === 1) return failedTurn();
      retryStartEntered.resolve();
      return rejectRetryStart.promise;
    },
  });
  const turn = await session.startTurn([{ type: "text", text: "retry start race" }]);
  const eventsPromise = collect(turn);
  await retryStartEntered.promise;
  await turn.interrupt();
  rejectRetryStart.reject(harnessFailure());
  const events = await eventsPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.at(-1).type, "turn.interrupted");
  assert.deepEqual(
    records.filter(({ type }) => type === "turn.failed" || type === "turn.interrupted").map(({ type }) => type),
    ["turn.interrupted"],
  );
});

for (const { action, reason } of [
  { action: (session) => session.close(), reason: "sessionClosed" },
  { action: (session) => session.closeForRuntime(), reason: "runtimeClosed" },
]) {
  test(`${reason} during an active attempt remains authoritative and prevents retry`, async () => {
    let starts = 0;
    const attemptStarted = deferred();
    const emitFailure = deferred();
    const session = createSession({
      maxRetries: 1,
      startTurn: async () => {
        starts += 1;
        return nativeTurn(
          async function* () {
            yield { type: "turn.started" };
            attemptStarted.resolve();
            await emitFailure.promise;
            yield { type: "turn.failed", error: harnessFailure() };
          },
          { interrupt: async () => emitFailure.resolve() },
        );
      },
    });
    const turn = await session.startTurn([{ type: "text", text: reason }]);
    const eventsPromise = collect(turn);
    await attemptStarted.promise;
    await action(session);
    const events = await eventsPromise;

    assert.equal(starts, 1);
    assert.equal(events.some(({ type }) => type === "turn.retrying"), false);
    assert.equal(events.at(-1).type, "turn.interrupted");
    assert.equal(events.at(-1).reason, reason);
  });
}

test("an Adapter stream-loss close bypasses a positive retry budget", async () => {
  let starts = 0;
  const attemptStarted = deferred();
  const never = deferred();
  const session = createSession({
    maxRetries: 2,
    startTurn: async () => {
      starts += 1;
      return nativeTurn(async function* () {
        yield { type: "turn.started" };
        attemptStarted.resolve();
        await never.promise;
      });
    },
  });
  const turn = await session.startTurn([{ type: "text", text: "stream loss" }]);
  const eventsPromise = collect(turn);
  await attemptStarted.promise;
  await session.closeForHarnessFailure({
    ...harnessFailure(),
    message: "Workspace event stream disconnected",
    nativeCode: "stream_disconnected",
  });
  const events = await eventsPromise;

  assert.equal(starts, 1);
  assert.equal(events.some(({ type }) => type === "turn.retrying"), false);
  assert.equal((await turn.result).status, "failed");
  assert.equal((await turn.result).error.nativeCode, "stream_disconnected");
});

for (const { action, reason } of [
  { action: (session) => session.close(), reason: "sessionClosed" },
  { action: (session) => session.closeForRuntime(), reason: "runtimeClosed" },
]) {
  test(`${reason} during retry backoff prevents another native Turn Attempt`, async () => {
    let starts = 0;
    let backoffStarted;
    const enteredBackoff = new Promise((resolve) => {
      backoffStarted = resolve;
    });
    const session = createSession({
      maxRetries: 1,
      sleepBeforeRetry: async (_delayMs, signal) => {
        backoffStarted();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      startTurn: async () => {
        starts += 1;
        return failedTurn();
      },
    });
    const turn = await session.startTurn([{ type: "text", text: reason }]);
    const eventsPromise = collect(turn);
    await enteredBackoff;
    await action(session);
    const events = await eventsPromise;

    assert.equal(starts, 1);
    assert.equal(events.at(-1).type, "turn.interrupted");
    assert.equal(events.at(-1).reason, reason);
  });
}

function createSession({
  startTurn,
  maxRetries,
  retryPolicy = { maxRetries: maxRetries ?? 0 },
  records = [],
  recordCoreEvent = async (record) => records.push(record),
  turnQueueLimits,
  sleepBeforeRetry = async () => {},
  retryJitter = () => 0,
}) {
  const adapterSession = {
    nativeSessionId: "native-session",
    model: undefined,
    effort: undefined,
    closed: false,
    startTurn,
    async setModel() {},
    async setEffort() {},
    async close() {},
  };
  return new CoreAgentSession(
    "opencode",
    workspacePath,
    adapterSession,
    "interactive",
    FULL_HARNESS_CAPABILITIES,
    recordCoreEvent,
    turnQueueLimits,
    undefined,
    retryPolicy,
    sleepBeforeRetry,
    retryJitter,
  );
}

function failedTurn({ retryable, nativeCode, operation, usage, text } = {}) {
  return nativeTurn(async function* () {
    yield { type: "turn.started" };
    if (text !== undefined) {
      yield { type: "assistant.message.started", nativeMessageId: "message" };
      yield { type: "assistant.message.completed", nativeMessageId: "message", text };
    }
    if (usage !== undefined) yield { type: "usage.updated", usage };
    yield {
      type: "turn.failed",
      error: {
        ...harnessFailure(),
        ...(operation === undefined ? {} : { operation }),
        ...(retryable === undefined ? {} : { retryable }),
        ...(nativeCode === undefined ? {} : { nativeCode }),
      },
    };
  });
}

function harnessFailure() {
  return {
    code: "HARNESS_ERROR",
    message: "transient native failure",
    harness: "opencode",
    operation: "startTurn",
  };
}

function completedTurn(text, usage) {
  return nativeTurn(async function* () {
    yield { type: "turn.started" };
    yield { type: "assistant.message.started", nativeMessageId: "message" };
    yield { type: "assistant.message.completed", nativeMessageId: "message", text };
    if (usage !== undefined) yield { type: "usage.updated", usage };
    yield { type: "turn.completed" };
  });
}

function nativeTurn(events, overrides = {}) {
  return {
    nativeTurnId: "native-turn",
    async interrupt() {},
    async respondToApproval() {},
    async respondToQuestion() {},
    [Symbol.asyncIterator]: events,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function collect(turn) {
  const events = [];
  for await (const event of turn) events.push(event);
  return events;
}
