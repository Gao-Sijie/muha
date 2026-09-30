import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { createOfficialHarnessRegistration } from "@muha-sdk/core/internal";
import { FULL_HARNESS_CAPABILITIES } from "../support/full-harness-capabilities.mjs";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("all Harnesses initialize concurrently and initialization/rollback failures retain Registration order", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-runtime-atomic-init-"));
  const started = [];
  const closed = [];
  try {
    const registrations = [
      registration("codex", 30, started, closed, { initializeFails: true, closeFails: true }),
      registration("opencode", 5, started, closed, { initializeFails: true }),
      registration("kimi", 20, started, closed, { closeFails: true }),
    ];
    await assert.rejects(
      createMuhaRuntime({ harnesses: registrations, dataDir: join(root, "diagnostics") }),
      (error) => {
        assert.ok(error instanceof MuhaError);
        assert.equal(error.data.code, "RUNTIME_INITIALIZATION_FAILED");
        if (error.data.code !== "RUNTIME_INITIALIZATION_FAILED") return false;
        assert.deepEqual(error.data.initializationFailures.map(({ harness }) => harness), [
          "codex",
          "opencode",
        ]);
        assert.deepEqual(error.data.rollbackFailures.map(({ harness }) => harness), [
          "codex",
          "kimi",
        ]);
        return true;
      },
    );
    assert.deepEqual(new Set(started), new Set(["codex", "opencode", "kimi"]));
    assert.deepEqual(new Set(closed), new Set(["codex", "opencode", "kimi"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one Adapter fatal loss fails its Turns and closes other Harness Turns as runtimeClosed", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-runtime-adapter-fatal-"));
  const workspace = join(root, "workspace");
  const contexts = new Map();
  let runtime;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [heldRegistration("codex", contexts), heldRegistration("opencode", contexts)],
      dataDir: join(root, "diagnostics"),
    });
    const [codexSession, openCodeSession] = await Promise.all([
      runtime.createSession({ harness: "codex", workspacePath: workspace }),
      runtime.createSession({ harness: "opencode", workspacePath: workspace }),
    ]);
    const [codexTurn, openCodeTurn] = await Promise.all([
      codexSession.startTurn([{ type: "text", text: "hold" }]),
      openCodeSession.startTurn([{ type: "text", text: "hold" }]),
    ]);
    const codexIterator = codexTurn[Symbol.asyncIterator]();
    const openCodeIterator = openCodeTurn[Symbol.asyncIterator]();
    assert.equal((await codexIterator.next()).value.type, "turn.started");
    assert.equal((await openCodeIterator.next()).value.type, "turn.started");

    contexts.get("codex").reportFatalError({
      code: "HARNESS_ERROR",
      message: "Codex process exited",
      harness: "codex",
      operation: "startTurn",
      command: "codex",
      exitCode: 9,
      signal: null,
    });

    const [codexResult, openCodeResult, termination] = await Promise.all([
      codexTurn.result,
      openCodeTurn.result,
      runtime.termination,
    ]);
    assert.equal(codexResult.status, "failed");
    assert.equal(codexResult.error.code, "HARNESS_ERROR");
    assert.equal(openCodeResult.status, "interrupted");
    assert.equal(openCodeResult.reason, "runtimeClosed");
    assert.equal(termination.reason, "fatal");
    assert.equal(termination.error.code, "HARNESS_ERROR");
    assert.equal(runtime.status, "closed");
    assert.deepEqual(codexSession.status, { status: "closed" });
    assert.deepEqual(openCodeSession.status, { status: "closed" });
  } finally {
    await runtime?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unexpected exit of an official Adapter-owned process closes the whole Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-runtime-process-fatal-"));
  const workspace = join(root, "workspace");
  let runtime;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_TURN_SCENARIO: "held-exit-process",
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
        heldRegistration("opencode", new Map()),
      ],
      dataDir: join(root, "diagnostics"),
    });
    const [codexSession, openCodeSession] = await Promise.all([
      runtime.createSession({ harness: "codex", workspacePath: workspace }),
      runtime.createSession({ harness: "opencode", workspacePath: workspace }),
    ]);
    const [codexTurn, openCodeTurn] = await Promise.all([
      codexSession.startTurn([{ type: "text", text: "exit" }]),
      openCodeSession.startTurn([{ type: "text", text: "hold" }]),
    ]);

    const [codexResult, openCodeResult, termination] = await Promise.all([
      codexTurn.result,
      openCodeTurn.result,
      runtime.termination,
    ]);
    assert.equal(codexResult.status, "failed");
    assert.equal(codexResult.error.code, "HARNESS_ERROR");
    assert.equal(codexResult.error.exitCode, 23);
    assert.equal(openCodeResult.status, "interrupted");
    assert.equal(openCodeResult.reason, "runtimeClosed");
    assert.equal(termination.reason, "fatal");
    assert.equal(termination.error.harness, "codex");
    assert.equal(runtime.status, "closed");
  } finally {
    await runtime?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("close aggregates residual failures deterministically and permanently closes every handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-runtime-close-failures-"));
  const workspace = join(root, "workspace");
  let runtime;
  let recovered;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        failingCloseRegistration("codex", 20),
        failingCloseRegistration("opencode", 0),
      ],
      dataDir: join(root, "diagnostics"),
    });
    const sessions = await Promise.all([
      runtime.createSession({ harness: "codex", workspacePath: workspace }),
      runtime.createSession({ harness: "opencode", workspacePath: workspace }),
    ]);

    const closing = runtime.close();
    assert.equal(runtime.close(), closing);
    await assert.rejects(closing, (error) => {
      assert.ok(error instanceof MuhaError);
      assert.equal(error.data.code, "RUNTIME_CLOSE_FAILED");
      if (error.data.code !== "RUNTIME_CLOSE_FAILED") return false;
      assert.deepEqual(
        error.data.failures.map(({ harness, operation }) => [harness, operation]),
        [
          ["codex", "closeSession"],
          ["opencode", "closeSession"],
          ["codex", "closeHarness"],
          ["opencode", "closeHarness"],
        ],
      );
      return true;
    });
    assert.equal(runtime.status, "closed");
    assert.deepEqual(sessions.map(({ status }) => status), [
      { status: "closed" },
      { status: "closed" },
    ]);
    const termination = await runtime.termination;
    assert.equal(termination.reason, "callerClosed");
    assert.equal(termination.closeError?.code, "RUNTIME_CLOSE_FAILED");

    recovered = await createMuhaRuntime({
      harnesses: [registration("kimi", 0, [], [], {})],
      dataDir: join(root, "recovered"),
    });
  } finally {
    await recovered?.close();
    await runtime?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function registration(kind, delay, started, closed, options) {
  return createOfficialHarnessRegistration(kind, {}, FULL_HARNESS_CAPABILITIES, unusedWorkspaceConfigurator, () => ({
    kind,
    async initialize() {
      started.push(kind);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (options.initializeFails) throw new Error(`${kind} init`);
    },
    async createSession() { throw new Error("unused"); },
    async resumeSession() { throw new Error("unused"); },
    async listSessions() { return []; },
    async close() {
      closed.push(kind);
      if (options.closeFails) throw new Error(`${kind} close`);
    },
  }));
}

function heldRegistration(kind, contexts) {
  let nextId = 1;
  return createOfficialHarnessRegistration(
    kind,
    {},
    FULL_HARNESS_CAPABILITIES,
    unusedWorkspaceConfigurator,
    (_options, context) => ({
    kind,
    async initialize() { contexts.set(kind, context); },
    async createSession() { return heldSession(kind, nextId++); },
    async resumeSession() { throw new Error("unused"); },
    async listSessions() { return []; },
    async close() {},
    }),
  );
}

function failingCloseRegistration(kind, createDelayMs) {
  let nextId = 1;
  return createOfficialHarnessRegistration(kind, {}, FULL_HARNESS_CAPABILITIES, unusedWorkspaceConfigurator, () => ({
    kind,
    async initialize() {},
    async createSession() {
      await new Promise((resolve) => setTimeout(resolve, createDelayMs));
      return {
        nativeSessionId: `${kind}-${nextId++}`,
        model: undefined,
        closed: false,
        async startTurn() { throw new Error("unused"); },
        async setModel() {},
        async close() { throw new Error(`${kind} Session close`); },
      };
    },
    async resumeSession() { throw new Error("unused"); },
    async listSessions() { return []; },
    async close() { throw new Error(`${kind} Adapter close`); },
  }));
}

const unusedWorkspaceConfigurator = Object.freeze({
  planSkill: unusedPlan,
  planMcpServer: unusedPlan,
});

function unusedPlan() {
  return Object.freeze({ entrypoint: "/unused.js", args: Object.freeze([]) });
}

function heldSession(kind, id) {
  const releases = new Set();
  let closed = false;
  return {
    nativeSessionId: `${kind}-${id}`,
    model: undefined,
    get closed() { return closed; },
    async startTurn() {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      releases.add(release);
      return {
        nativeTurnId: `${kind}-turn-${id}`,
        async *[Symbol.asyncIterator]() {
          yield { type: "turn.started" };
          await held;
        },
        async interrupt() { release(); },
        async respondToApproval() {},
        async respondToQuestion() {},
      };
    },
    async setModel() {},
    async close() {
      closed = true;
      for (const release of releases) release();
      releases.clear();
    },
  };
}
