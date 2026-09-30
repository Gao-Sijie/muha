import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { controlledPi, completedTurn } from "./support/controlled-pi.mjs";

test("Pi recovers missing finish_reason within one Turn when the caller enables two retries", async t => {
  const fixture = await controlledPi(t, (_request, response, number) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: `stream-${number}`, object: "chat.completion.chunk", created: 1, model: "controlled",
      choices: [{ index: 0, delta: { role: "assistant", content: number < 3 ? "Partial answer" : "Recovered." },
        finish_reason: number < 3 ? null : "stop" }],
      ...(number < 3 ? {} : { usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }) })}\n\ndata: [DONE]\n\n`);
  });
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove", turnRetryPolicy: { maxRetries: 2 } });
  const reference = session.reference;
  const { result, events } = await completedTurn(session, "Recover the incomplete stream");
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.message.text, "Recovered.");
  assert.equal(fixture.requests.length, 3);
  assert.deepEqual(session.reference, reference);
  assert.deepEqual([...new Set(events.map(event => event.turnId))], [result.turnId]);
  assert.equal(events.filter(event => event.type === "turn.started").length, 1);
  const retries = events.filter(event => event.type === "turn.retrying");
  assert.deepEqual(retries.map(({ retryNumber, maxRetries }) => ({ retryNumber, maxRetries })), [
    { retryNumber: 1, maxRetries: 2 }, { retryNumber: 2, maxRetries: 2 },
  ]);
  for (const retry of retries) {
    assert.equal(retry.error.code, "HARNESS_ERROR");
    assert.match(retry.error.message, /Stream ended without finish_reason/);
  }
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 5, cachedInputTokens: 0 });
  assert.deepEqual(events.filter(event => /^turn\.(completed|failed|interrupted)$/.test(event.type)).map(event => event.type), ["turn.completed"]);
});

for (const maxRetries of [undefined, 2]) {
  test(`Pi missing finish_reason stops after ${maxRetries === undefined ? "the default single attempt" : "two caller-enabled retries"}`, async t => {
    const fixture = await controlledPi(t, (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "incomplete", object: "chat.completion.chunk", created: 1, model: "controlled",
        choices: [{ index: 0, delta: { role: "assistant", content: "Partial answer" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
    });
    const runtime = await fixture.runtime();
    const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
      model: "controlled/controlled", approvalPolicy: "autoApprove",
      ...(maxRetries === undefined ? {} : { turnRetryPolicy: { maxRetries } }) });
    const { result, events } = await completedTurn(session, "Stop when the retry budget is exhausted");
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.match(result.error.message, /Stream ended without finish_reason/);
    assert.equal(fixture.requests.length, maxRetries === undefined ? 1 : 3);
    assert.deepEqual(events.filter(event => event.type === "turn.retrying").map(event => event.retryNumber),
      maxRetries === undefined ? [] : [1, 2]);
    assert.deepEqual(events.filter(event => /^turn\.(completed|failed|interrupted)$/.test(event.type)).map(event => event.type), ["turn.failed"]);
  });
}

test("Pi leaves whole-execution retries to the Core Turn budget", async t => {
  const fixture = await controlledPi(t, (_request, response, number) => {
    if (number === 1) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "controlled attempt failure", type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "retried", object: "chat.completion.chunk", created: 1, model: "controlled",
      choices: [{ index: 0, delta: { role: "assistant", content: "Recovered." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove", turnRetryPolicy: { maxRetries: 1 } });
  const { result, events } = await completedTurn(session, "Try once more after failure");
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.message.text, "Recovered.");
  assert.equal(fixture.requests.length, 2);
  assert.equal(events.filter(e => e.type === "turn.retrying").length, 1);
  assert.deepEqual(events.filter(e => ["turn.completed", "turn.failed", "turn.interrupted"].includes(e.type)).map(e => e.type), ["turn.completed"]);
});

test("Pi exhausts one Core budget per Turn even when native persistent retry is enabled", async t => {
  const fixture = await controlledPi(t, (_request, response) => {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "permanent model rejection", type: "invalid_request_error" } }));
  });
  await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 5 } }));
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove", turnRetryPolicy: { maxRetries: 1 } });
  for (let iteration = 0; iteration < 2; iteration++) {
    const { result, events } = await completedTurn(session, "Reject this model request");
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.equal(events.filter(event => event.type === "turn.retrying").length, 1);
    assert.deepEqual(events.filter(event => /^turn\.(completed|failed|interrupted)$/.test(event.type)).map(event => event.type), ["turn.failed"]);
    assert.equal(fixture.requests.length, (iteration + 1) * 2);
  }
});
