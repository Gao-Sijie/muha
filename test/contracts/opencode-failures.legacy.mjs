// Historical v1 HTTP failure contract. Retained for archaeology; v2 failures have separate coverage.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const controlledPath = [fakeHarnessBin, dirname(process.execPath)].join(delimiter);

test("a missing OpenCode command fails initialization and releases the Runtime guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-missing-opencode-contract-"));
  const emptyBin = join(root, "empty-bin");
  await mkdir(emptyBin);

  try {
    await assert.rejects(
      createMuhaRuntime({
        harnesses: [openCodeAdapter({
          env: { PATH: emptyBin },
          startupTimeoutMs: 100,
          shutdownTimeoutMs: 100,
        })],
        dataDir: join(root, "failed-diagnostics"),
      }),
      (error) => {
        assert.equal(error instanceof MuhaError, true);
        assert.equal(error.data.code, "RUNTIME_INITIALIZATION_FAILED");
        assert.equal(error.data.initializationFailures.length, 1);
        assert.deepEqual(error.data.rollbackFailures, []);
        assert.equal(error.data.initializationFailures[0].harness, "opencode");
        assert.equal(error.data.initializationFailures[0].operation, "initialize");
        assert.equal(error.data.initializationFailures[0].stage, "spawn");
        assert.equal(error.data.initializationFailures[0].command, "opencode");
        return true;
      },
    );

    const recovered = await createMuhaRuntime({
      harnesses: [registration()],
      dataDir: join(root, "recovered-diagnostics"),
    });
    await recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const failureCase of [
  { scenario: "early-exit", expectedStage: "ready" },
  { scenario: "unready", expectedStage: "ready" },
  { scenario: "bad-ready-line", expectedStage: "ready" },
  { scenario: "health-malformed", expectedStage: "handshake" },
  { scenario: "health-unhealthy", expectedStage: "handshake" },
]) {
  test(`OpenCode ${failureCase.scenario} fails with structured initialization data`, async () => {
    const root = await mkdtemp(join(tmpdir(), `muha-opencode-${failureCase.scenario}-`));
    try {
      await assert.rejects(
        createMuhaRuntime({
          harnesses: [registration({
            MUHA_FAKE_OPENCODE_SCENARIO: failureCase.scenario,
          }, ["unready", "bad-ready-line"].includes(failureCase.scenario) ? 100 : 5_000)],
          dataDir: join(root, "diagnostics"),
        }),
        (error) => {
          assert.equal(error instanceof MuhaError, true);
          assert.equal(error.data.code, "RUNTIME_INITIALIZATION_FAILED");
          const [failure] = error.data.initializationFailures;
          assert.equal(failure.code, "HARNESS_ERROR");
          assert.equal(failure.harness, "opencode");
          assert.equal(failure.operation, "initialize");
          assert.equal(failure.command, "opencode");
          assert.equal(failure.stage, failureCase.expectedStage);
          assert.equal(JSON.stringify(error.data).includes("caller-password"), false);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a malformed OpenCode create response remains an Adapter protocol error", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-malformed-create-"));
  const workspace = join(root, "workspace");
  let runtime;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({ MUHA_FAKE_OPENCODE_SCENARIO: "create-malformed" })],
      dataDir: join(root, "diagnostics"),
    });
    await assert.rejects(
      runtime.createSession({ harness: "opencode", workspacePath: workspace }),
      (error) => {
        assert.equal(error instanceof MuhaError, true);
        assert.deepEqual(error.data, {
          code: "ADAPTER_PROTOCOL_ERROR",
          message: "OpenCode Session id must be a non-empty string",
          harness: "opencode",
        });
        return true;
      },
    );
    assert.equal(runtime.status, "active");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected OpenCode prompt returns no accepted Turn Handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-rejected-turn-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({ MUHA_FAKE_OPENCODE_SCENARIO: "prompt-reject" })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      turnRetryPolicy: { maxRetries: 1 },
    });
    await assert.rejects(
      session.startTurn([{ type: "text", text: "Reject this." }]),
      (error) => {
        assert.equal(error instanceof MuhaError, true);
        assert.deepEqual(error.data, {
          code: "HARNESS_ERROR",
          message: "OpenCode rejected startTurn",
          harness: "opencode",
          operation: "startTurn",
          command: "opencode",
          nativeCode: "http_400",
        });
        return true;
      },
    );
    assert.deepEqual(session.status, { status: "idle" });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode treats a reasoning-only final as a structured Turn failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-empty-final-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({ MUHA_FAKE_OPENCODE_SCENARIO: "reasoning-only" })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "Return only reasoning." }]);
    const events = [];
    for await (const event of turn) events.push(event);

    assert.equal(events.some(({ type }) => type === "assistant.reasoning.delta"), true);
    assert.equal(events.find(({ type }) => type === "assistant.message.completed").message.text, "");
    assert.equal(events.at(-1).type, "turn.failed");
    assert.equal(events.some(({ type }) => type === "turn.completed"), false);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.deepEqual(result.error, {
      code: "HARNESS_ERROR",
      message: "OpenCode Turn ended with an empty final message",
      harness: "opencode",
      operation: "startTurn",
      command: "opencode",
      nativeCode: "empty_final_message",
    });
    assert.equal("retryable" in result.error, false);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode treats a whitespace-only final as a structured Turn failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-whitespace-final-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({ MUHA_FAKE_OPENCODE_SCENARIO: "whitespace-final" })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "Return whitespace." }]);
    for await (const _event of turn) {
      // Drain the accepted Turn.
    }

    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.equal(result.error.nativeCode, "empty_final_message");
    assert.equal("retryable" in result.error, false);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ignores an empty intermediate Assistant Message when the final is non-empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-empty-intermediate-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({ MUHA_FAKE_OPENCODE_SCENARIO: "empty-intermediate" })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "Use a tool, then answer." }]);
    const events = [];
    for await (const event of turn) events.push(event);

    const completed = events.filter(({ type }) => type === "assistant.message.completed");
    assert.deepEqual(completed.map(({ message }) => message.text), ["", "Hello from OpenCode."]);
    assert.equal((await turn.result).status, "completed");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode classifies an empty final after a non-empty intermediate message as a failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-empty-final-after-intermediate-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({ MUHA_FAKE_OPENCODE_SCENARIO: "nonempty-intermediate-empty-final" })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "Finish after the intermediate message." }]);
    const events = [];
    for await (const event of turn) events.push(event);

    const completed = events.filter(({ type }) => type === "assistant.message.completed");
    assert.deepEqual(completed.map(({ message }) => message.text), ["Intermediate.", ""]);
    assert.equal((await turn.result).status, "failed");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode preserves an explicit native retryable true classification", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-native-retryable-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({ MUHA_FAKE_OPENCODE_SCENARIO: "session-error-retryable" })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "Classify natively." }]);
    for await (const _event of turn) {
      // Drain the accepted Turn.
    }
    assert.equal((await turn.result).status, "failed");
    assert.equal((await turn.result).error.retryable, true);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted OpenCode Turn preserves safe native failure diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-native-turn-failure-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({ MUHA_FAKE_OPENCODE_SCENARIO: "session-error" })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      turnRetryPolicy: { maxRetries: 1 },
    });
    const turn = await session.startTurn([{ type: "text", text: "Fail natively." }]);
    for await (const _event of turn) {
      // Drain the accepted Turn.
    }
    assert.deepEqual((await turn.result).error, {
      code: "HARNESS_ERROR",
      message: "OpenCode Turn failed: Invalid API Key",
      harness: "opencode",
      operation: "startTurn",
      command: "opencode",
      nativeCode: "APIError",
      retryable: false,
    });
    assert.equal(JSON.stringify(await turn.result).includes("sensitive body"), false);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an opted-in OpenCode Session recovers a TLS-shaped native Turn failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-transient-tls-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({
        MUHA_FAKE_OPENCODE_SCENARIO: "transient-tls",
        MUHA_FAKE_OPENCODE_TLS_FAILURES: "1",
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      turnRetryPolicy: { maxRetries: 1 },
    });
    const turn = await session.startTurn([{ type: "text", text: "Recover from TLS." }]);
    const events = [];
    for await (const event of turn) events.push(event);

    assert.equal(events.filter(({ type }) => type === "turn.started").length, 1);
    assert.deepEqual(
      events.filter(({ type }) => type === "turn.retrying").map(({ retryNumber, maxRetries, error }) => ({
        retryNumber,
        maxRetries,
        code: error.code,
        nativeCode: error.nativeCode,
        message: error.message,
        retryable: error.retryable,
      })),
      [{
        retryNumber: 1,
        maxRetries: 1,
        code: "HARNESS_ERROR",
        nativeCode: "UnknownError",
        message: "OpenCode Turn failed: unknown certificate verification error",
        retryable: undefined,
      }],
    );
    assert.equal(events.at(-1).type, "turn.completed");
    assert.equal((await turn.result).status, "completed");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an opted-in OpenCode Session recovers an empty final within one public Turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-empty-final-retry-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({
        MUHA_FAKE_OPENCODE_SCENARIO: "empty-final-then-text",
        MUHA_FAKE_OPENCODE_EMPTY_FINAL_FAILURES: "1",
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      turnRetryPolicy: { maxRetries: 1 },
    });
    const turn = await session.startTurn([{ type: "text", text: "Recover this final." }]);
    const events = [];
    for await (const event of turn) events.push(event);

    assert.deepEqual(
      events.filter(({ type }) => type === "turn.retrying").map(({ retryNumber, maxRetries, error }) => ({
        retryNumber,
        maxRetries,
        code: error.code,
        nativeCode: error.nativeCode,
        retryable: error.retryable,
      })),
      [{
        retryNumber: 1,
        maxRetries: 1,
        code: "HARNESS_ERROR",
        nativeCode: "empty_final_message",
        retryable: undefined,
      }],
    );
    assert.equal(events.at(-1).type, "turn.completed");
    assert.equal((await turn.result).status, "completed");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an opted-in OpenCode Session preserves empty-final diagnostics when retries are exhausted", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-empty-final-exhausted-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration({
        MUHA_FAKE_OPENCODE_SCENARIO: "empty-final-then-text",
        MUHA_FAKE_OPENCODE_EMPTY_FINAL_FAILURES: "2",
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      turnRetryPolicy: { maxRetries: 1 },
    });
    const turn = await session.startTurn([{ type: "text", text: "Keep the empty final." }]);
    const events = [];
    for await (const event of turn) events.push(event);

    assert.equal(events.filter(({ type }) => type === "turn.retrying").length, 1);
    assert.equal(events.at(-1).type, "turn.failed");
    assert.deepEqual((await turn.result).error, {
      code: "HARNESS_ERROR",
      message: "OpenCode Turn ended with an empty final message",
      harness: "opencode",
      operation: "startTurn",
      command: "opencode",
      nativeCode: "empty_final_message",
    });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function registration(extraEnv = {}, startupTimeoutMs = 2_000) {
  return openCodeAdapter({
    env: {
      PATH: controlledPath,
      OPENCODE_SERVER_USERNAME: "caller-username",
      OPENCODE_SERVER_PASSWORD: "caller-password",
      ...extraEnv,
    },
    startupTimeoutMs,
    shutdownTimeoutMs: 200,
  });
}
