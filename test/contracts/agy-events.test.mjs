import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { agyAdapter } from "@muha-sdk/agy-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

async function fixture(scenario, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-events-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const runtime = await createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter({
    env: { HOME: join(root, "home"), PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
      MUHA_FAKE_AGY_SCENARIO: scenario }, startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
  })] });
  const session = await runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "harnessManaged", ...options });
  return { session, runtime, workspacePath, async close() { try { await runtime.close(); } finally { await rm(root, { recursive: true, force: true }); } } };
}

test("AGY retains identical incremental text, ignores repeated completion, and returns its final explicit message", async () => {
  const f = await fixture("messages");
  try {
    const turn = await f.session.startTurn([{ type: "text", text: "Show progress and then finish." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.deepEqual(events.filter(event => event.type === "assistant.message.completed").map(event => event.message.text), ["haha!", "final"]);
    assert.equal((await turn.result).message.text, "final");
    assert.deepEqual(events.filter(event => /^turn\.(completed|failed|interrupted)$/u.test(event.type)).map(event => event.type), ["turn.completed"]);
  } finally { await f.close(); }
});

test("AGY late events from a completed Turn cannot accept or complete the next Turn", async () => {
  const f = await fixture("late-turn-events");
  try {
    assert.equal((await (await f.session.startTurn([{ type: "text", text: "first" }])).result).message.text, "first");
    const turn = await f.session.startTurn([{ type: "text", text: "second" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "second");
    assert.deepEqual(events.filter(event => event.type === "assistant.message.completed").map(event => event.message.text), ["second"]);
    assert.equal(events.filter(event => event.type === "turn.started").length, 1);
  } finally { await f.close(); }
});

test("AGY native print timeout fails instead of returning its partial SUCCESS as completed", async () => {
  const f = await fixture("partial-timeout");
  try {
    const turn = await f.session.startTurn([{ type: "text", text: "Continue beyond the native bound." }]);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.equal(result.error.nativeCode, "timeout");
    assert.match(result.error.message, /native 60 minute print timeout/u);
    assert.equal(result.error.retryable, false);
    assert.equal(f.runtime.status, "active");
  } finally { await f.close(); }
});

test("AGY native timeout before next input acceptance is not discarded as a duplicate previous result", async () => {
  const f = await fixture("timeout-before-next-input");
  let guard;
  try {
    assert.equal((await (await f.session.startTurn([{ type: "text", text: "first" }])).result).status, "completed");
    await assert.rejects(Promise.race([
      f.session.startTurn([{ type: "text", text: "second" }]),
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("native timeout was ignored")), 2_000); }),
    ]), error => error.data?.code === "HARNESS_ERROR" && error.data?.nativeCode === "timeout");
  } finally { clearTimeout(guard); await f.close(); }
});

for (const scenario of ["unfinished-message", "missing-message"]) {
test(`AGY ${scenario} fails and stops native execution instead of returning progress as final`, async () => {
  const f = await fixture(scenario);
  try {
    const turn = await f.session.startTurn([{ type: "text", text: "Finish the answer." }]);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
    const heartbeat = join(f.workspacePath, "unfinished-heartbeat.txt");
    const stopped = await readFile(heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await readFile(heartbeat, "utf8"), stopped, "protocol failure must stop native execution before it settles");
  } finally { await f.close(); }
});
}

for (const scenario of ["malformed-output", "oversized-output"]) {
  test(`AGY ${scenario} terminates the Turn and closes Runtime without crashing the consumer`, async () => {
    const f = await fixture(scenario);
    try {
      const turn = await f.session.startTurn([{ type: "text", text: "Read the response." }]);
      const result = await turn.result;
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "HARNESS_ERROR");
      assert.equal((await f.runtime.termination).reason, "fatal");
      assert.equal(f.runtime.status, "closed");
    } finally { await f.close(); }
  });
}

for (const scenario of ["json-log", "repeated-init"]) {
  test(`AGY rejects ${scenario} instead of silently waiting or changing native identity`, async () => {
    const f = await fixture(scenario);
    let guard;
    try {
      const turn = await f.session.startTurn([{ type: "text", text: "Read the response." }]);
      const result = await Promise.race([turn.result, new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error("invalid native output was silently ignored")), 2_000);
      })]);
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "HARNESS_ERROR");
      assert.equal((await f.runtime.termination).reason, "fatal");
      const db = new DatabaseSync(join(dirname(f.workspacePath), "diagnostics/diagnostic-events.sqlite"), { readOnly: true });
      try {
        const records = db.prepare("SELECT payload_json FROM native_event_records WHERE harness = 'agy'").all().map(row => JSON.parse(row.payload_json));
        assert.equal(records.some(event => event.level === "info"), false, "process logs are not Native Events");
        assert.ok(records.some(event => event.event === "step_update" && event.step_update.step_type === "user_input"));
      } finally { db.close(); }
    } finally { clearTimeout(guard); await f.close(); }
  });
}

test("AGY reports native tool output and result-only denial without inventing public approvals", async () => {
  const f = await fixture("tools");
  try {
    const turn = await f.session.startTurn([{ type: "text", text: "Read then run the command." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const starts = events.filter(event => event.type === "tool.started");
    assert.deepEqual(starts.map(event => event.toolName), ["view_file", "run_command"]);
    const completed = events.filter(event => event.type === "tool.completed");
    assert.equal(completed.length, 2);
    assert.equal(completed[0].toolCallId, starts[0].toolCallId);
    assert.equal(completed[0].output, "native file contents");
    assert.equal(completed[0].isError, false);
    assert.equal(completed[1].toolCallId, starts[1].toolCallId);
    assert.equal(completed[1].isError, true);
    assert.deepEqual(completed[1].output, { denied_actions: [{ action: "command", display_name: "RunCommand" }] });
    assert.ok(events.some(event => event.type === "tool.updated"));
    assert.equal(events.some(event => event.type.startsWith("approval.")), false);
    assert.equal((await turn.result).status, "completed");
  } finally { await f.close(); }
});

test("AGY fails ambiguous same-name tool denials without publishing a false tool success", async () => {
  const f = await fixture("ambiguous-denials");
  try {
    const turn = await f.session.startTurn([{ type: "text", text: "Run two commands." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal(events.filter(event => event.type === "tool.started").length, 2);
    assert.equal(events.some(event => event.type === "tool.completed" && !event.isError), false);
    assert.equal(events.some(event => event.type.startsWith("approval.")), false);
    assert.equal((await turn.result).error.code, "ADAPTER_PROTOCOL_ERROR");
  } finally { await f.close(); }
});

test("AGY usage replaces per-step snapshots and excludes previous native Session usage after resume", async () => {
  const f = await fixture("usage");
  try {
    const reference = f.session.reference;
    const first = await f.session.startTurn([{ type: "text", text: "Use two steps." }]);
    assert.deepEqual((await first.result).usage, { inputTokens: 105, outputTokens: 12, cachedInputTokens: 300, reasoningTokens: 2 });
    await f.session.close();
    const resumed = await f.runtime.resumeSession({ reference, approvalPolicy: "harnessManaged" });
    const turn = await resumed.startTurn([{ type: "text", text: "Only count this Turn." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.deepEqual((await turn.result).usage, { inputTokens: 105, outputTokens: 12, cachedInputTokens: 300, reasoningTokens: 2 });
    assert.ok(events.some(event => event.type === "usage.updated"));
  } finally { await f.close(); }
});

test("AGY does not invent retryability for an unclassified native ERROR even when retries are enabled", async () => {
  const f = await fixture("native-error-exit", { turnRetryPolicy: { maxRetries: 2 } });
  try {
    const turn = await f.session.startTurn([{ type: "text", text: "Attempt the work." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.equal(result.error.nativeCode, "ERROR");
    assert.equal(result.error.retryable, false);
    assert.equal(events.some(event => event.type === "turn.retrying"), false);
    assert.equal(events.filter(event => event.type === "turn.started").length, 1);
    assert.equal((await f.runtime.termination).reason, "fatal");
  } finally { await f.close(); }
});
