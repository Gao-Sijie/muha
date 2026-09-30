import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import {
  composeWorkspaceConfigurator,
  createAddMcpPlanner,
  createOfficialHarnessRegistration,
  createSkillsCliPlanner,
  installRuntimeSchedulerForTesting,
} from "@muha-sdk/core/internal";
import { FULL_HARNESS_CAPABILITIES } from "../support/full-harness-capabilities.mjs";
import { controlledOpenCodeAdapter, acpOptions } from "../fixtures/acp-harness/options.mjs";

const oneHourMs = 60 * 60 * 1_000;
const workspaceConfigurator = composeWorkspaceConfigurator({
  planSkill: createSkillsCliPlanner("codex"),
  planMcpServer: createAddMcpPlanner("codex"),
});

test("shared transport leaves post-startup control deadlines to Core's fatal one-hour watchdog", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-watchdog-"));
  const scheduler = new FakeScheduler();
  const restoreScheduler = installRuntimeSchedulerForTesting(scheduler);
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [controlledOpenCodeAdapter({ acp: { ...acpOptions("stall-create"), startupTimeoutMs: 200 } })],
      dataDir: join(root, "diagnostics"),
    });
    const creating = runtime.createSession({ harness: "opencode", workspacePath: root });
    void creating.catch(() => {});
    await scheduler.waitForTimers(1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await promiseState(creating), "pending", "startup deadline must not reject an ordinary control request");
    scheduler.advanceBy(oneHourMs - 1);
    assert.equal(await promiseState(creating), "pending");
    scheduler.advanceBy(1);
    await assert.rejects(creating, (error) => error.data?.code === "HARNESS_ERROR" && error.data.operation === "createSession");
    assert.equal((await runtime.termination).reason, "fatal");
    assert.equal(runtime.status, "closed");
    assert.equal(scheduler.timerCount, 0);
  } finally {
    await runtime?.close();
    restoreScheduler();
    await rm(root, { recursive: true, force: true });
  }
});

test("a control watchdog rejects with HARNESS_ERROR and fatally closes the Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-control-watchdog-"));
  const workspace = join(root, "workspace");
  const scheduler = new FakeScheduler();
  const restoreScheduler = installRuntimeSchedulerForTesting(scheduler);
  let runtime;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [hangingRegistration("createSession")],
      dataDir: join(root, "diagnostics"),
    });
    const creating = runtime.createSession({ harness: "codex", workspacePath: workspace });
    void creating.catch(() => undefined);
    await scheduler.waitForTimers(1);
    scheduler.advanceBy(oneHourMs - 1);
    assert.equal(await promiseState(creating), "pending");
    scheduler.advanceBy(1);

    await assert.rejects(creating, (error) =>
      error instanceof MuhaError &&
      error.data.code === "HARNESS_ERROR" &&
      error.data.operation === "createSession");
    const termination = await runtime.termination;
    assert.equal(termination.reason, "fatal");
    assert.equal(termination.error.code, "HARNESS_ERROR");
    assert.equal(termination.error.operation, "createSession");
    assert.equal(runtime.status, "closed");
    assert.equal(scheduler.timerCount, 0);
  } finally {
    await runtime?.close().catch(() => undefined);
    restoreScheduler();
    await rm(root, { recursive: true, force: true });
  }
});

for (const boundary of ["watchdog", "runtime-close"]) {
  test(`ACP interruption awaiting native terminal is preempted by ${boundary}`, { timeout: 3000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "muha-acp-cancel-bound-"));
    const scheduler = new FakeScheduler();
    const restoreScheduler = installRuntimeSchedulerForTesting(scheduler);
    let runtime;
    try {
      runtime = await createMuhaRuntime({
        harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("stall-cancel") })],
        dataDir: join(root, "diagnostics"),
      });
      const session = await runtime.createSession({ harness: "opencode", workspacePath: root });
      const turn = await session.startTurn([{ type: "text", text: "await native cancellation" }]);
      const interrupting = turn.interrupt();
      void interrupting.catch(() => {});
      await scheduler.waitForTimers(1);
      scheduler.advanceBy(oneHourMs - 1);
      assert.equal(await promiseState(interrupting), "pending");
      if (boundary === "watchdog") {
        scheduler.advanceBy(1);
        await assert.rejects(interrupting, error => error.data?.code === "HARNESS_ERROR" && error.data.operation === "interruptTurn");
        assert.equal((await runtime.termination).reason, "fatal");
      } else {
        const closing = runtime.close();
        await assert.rejects(interrupting, error => error.data?.code === "RUNTIME_CLOSED");
        await closing;
        assert.equal((await turn.result).status, "interrupted");
        assert.equal((await turn.result).reason, "runtimeClosed");
      }
      assert.equal(runtime.status, "closed");
      assert.equal(scheduler.timerCount, 0);
    } finally {
      await runtime?.close();
      restoreScheduler();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Runtime close immediately preempts an unacknowledged Turn acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-control-preemption-"));
  const workspace = join(root, "workspace");
  const scheduler = new FakeScheduler();
  const restoreScheduler = installRuntimeSchedulerForTesting(scheduler);
  let runtime;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [hangingRegistration("startTurn")],
      dataDir: join(root, "diagnostics"),
    });
    const session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const starting = session.startTurn([{ type: "text", text: "never acknowledge" }]);
    await scheduler.waitForTimers(1);

    const closing = runtime.close();
    await assert.rejects(starting, (error) =>
      error instanceof MuhaError && error.data.code === "RUNTIME_CLOSED");
    await closing;
    assert.equal(runtime.status, "closed");
    assert.deepEqual(session.status, { status: "closed" });
    assert.equal(scheduler.timerCount, 0);
  } finally {
    await runtime?.close().catch(() => undefined);
    restoreScheduler();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Workspace Skill attempt uses the fake hour bound locally without closing Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-workspace-watchdog-"));
  const workspace = join(root, "workspace");
  const source = join(workspace, "source");
  const skill = join(source, "slow-skill");
  const scheduler = new FakeScheduler();
  const restoreScheduler = installRuntimeSchedulerForTesting(scheduler);
  let runtime;
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: slow-skill\ndescription: fixture\n---\n\nfixture\n",
  );
  try {
    runtime = await createMuhaRuntime({
      harnesses: [hangingRegistration(undefined)],
      dataDir: join(root, "diagnostics"),
    });
    const configuring = runtime.configureWorkspace({
      workspacePath: workspace,
      skills: [{ source: "./source" }],
    });
    await scheduler.waitForTimers(1);
    scheduler.advanceBy(oneHourMs);
    const result = await configuring;

    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].status, "failed");
    assert.equal(result.attempts[0].error.code, "SKILL_CONFIGURATION_FAILED");
    assert.equal(runtime.status, "active");
    assert.equal(await promiseState(runtime.termination), "pending");
  } finally {
    await runtime?.close().catch(() => undefined);
    restoreScheduler();
    await rm(root, { recursive: true, force: true });
  }
});

test("every remaining Harness acknowledgement boundary uses the same fake hour watchdog", async (t) => {
  for (const operation of [
    "resumeSession",
    "listSessions",
    "setModel",
    "startTurn",
    "interruptTurn",
    "respondToApproval",
    "respondToQuestion",
  ]) {
    await t.test(operation, () => assertOperationTimesOut(operation));
  }
});

test("a Workspace MCP attempt uses the fake hour bound locally without closing Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-workspace-mcp-timeout-"));
  const workspace = join(root, "workspace");
  const scheduler = new FakeScheduler();
  const restoreScheduler = installRuntimeSchedulerForTesting(scheduler);
  let runtime;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [hangingRegistration(undefined)],
      dataDir: join(root, "diagnostics"),
    });
    const configuring = runtime.configureWorkspace({
      workspacePath: workspace,
      mcpServers: [
        { name: "timed-out", transport: "stdio", command: "local-mcp" },
        { name: "continued", transport: "stdio", command: "local-mcp" },
      ],
    });
    await scheduler.waitForTimers(1);
    scheduler.advanceBy(oneHourMs);
    const result = await configuring;
    assert.deepEqual(result.attempts.map(({ status }) => status), ["failed", "succeeded"]);
    assert.equal(result.attempts[0].error.code, "MCP_CONFIGURATION_FAILED");
    assert.equal(runtime.status, "active");
    assert.equal(await promiseState(runtime.termination), "pending");
  } finally {
    await runtime?.close().catch(() => undefined);
    restoreScheduler();
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime close preempts Workspace configuration and clears its attempt watchdog", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-workspace-mcp-watchdog-"));
  const workspace = join(root, "workspace");
  const scheduler = new FakeScheduler();
  const restoreScheduler = installRuntimeSchedulerForTesting(scheduler);
  let runtime;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [hangingRegistration(undefined)],
      dataDir: join(root, "diagnostics"),
    });
    const configuring = runtime.configureWorkspace({
      workspacePath: workspace,
      mcpServers: [{ name: "local", transport: "stdio", command: "local-mcp" }],
    });
    await scheduler.waitForTimers(1);
    const closing = runtime.close();
    await assert.rejects(configuring, (error) =>
      error instanceof MuhaError && error.data.code === "RUNTIME_CLOSED");
    await closing;
    assert.equal(runtime.status, "closed");
    assert.equal(scheduler.timerCount, 0);
  } finally {
    await runtime?.close().catch(() => undefined);
    restoreScheduler();
    await rm(root, { recursive: true, force: true });
  }
});

test("Turn execution and human-paced Question waiting have no control watchdog", async () => {
  for (const scenario of ["execution", "questionWaiting"]) {
    const root = await mkdtemp(join(tmpdir(), `muha-unbounded-${scenario}-`));
    const workspace = join(root, "workspace");
    const scheduler = new FakeScheduler();
    const restoreScheduler = installRuntimeSchedulerForTesting(scheduler);
    let runtime;
    await mkdir(workspace);
    try {
      runtime = await createMuhaRuntime({
        harnesses: [hangingRegistration(
          scenario === "questionWaiting" ? "questionWaiting" : undefined,
        )],
        dataDir: join(root, "diagnostics"),
      });
      const session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
      const turn = await session.startTurn([{ type: "text", text: scenario }]);
      const events = turn[Symbol.asyncIterator]();
      assert.equal((await events.next()).value.type, "turn.started");
      if (scenario === "questionWaiting") {
        assert.equal((await events.next()).value.type, "question.requested");
      }
      assert.equal(scheduler.timerCount, 0);
      scheduler.advanceBy(oneHourMs * 2);
      assert.equal(await promiseState(turn.result), "pending");
      assert.equal(runtime.status, "active");
      await runtime.close();
      assert.equal((await turn.result).status, "interrupted");
    } finally {
      await runtime?.close().catch(() => undefined);
      restoreScheduler();
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function assertOperationTimesOut(operation) {
  const root = await mkdtemp(join(tmpdir(), `muha-${operation}-watchdog-`));
  const workspace = join(root, "workspace");
  const scheduler = new FakeScheduler();
  const restoreScheduler = installRuntimeSchedulerForTesting(scheduler);
  let runtime;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [hangingRegistration(operation)],
      dataDir: join(root, "diagnostics"),
    });
    let command;
    if (operation === "resumeSession") {
      command = runtime.resumeSession({
        reference: { harness: "codex", sessionId: "native", workspacePath: workspace, route: "native" },
      });
    } else if (operation === "listSessions") {
      command = runtime.listSessions({ harness: "codex", workspacePath: workspace });
    } else {
      const session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
      if (operation === "setModel") {
        command = session.setModel("fake-high");
      } else if (operation === "startTurn") {
        command = session.startTurn([{ type: "text", text: "hang" }]);
      } else {
        const turn = await session.startTurn([{ type: "text", text: operation }]);
        const events = turn[Symbol.asyncIterator]();
        assert.equal((await events.next()).value.type, "turn.started");
        if (operation === "interruptTurn") {
          command = turn.interrupt();
        } else {
          const interaction = (await events.next()).value;
          if (operation === "respondToApproval") {
            assert.equal(interaction.type, "approval.requested");
            command = turn.respondToApproval(interaction.requestId, "allowOnce");
          } else {
            assert.equal(interaction.type, "question.requested");
            command = turn.respondToQuestion(interaction.requestId, { action: "dismiss" });
          }
        }
      }
    }
    await scheduler.waitForTimers(1);
    scheduler.advanceBy(oneHourMs);
    await assert.rejects(command, (error) =>
      error instanceof MuhaError &&
      error.data.code === "HARNESS_ERROR" &&
      error.data.operation === operation);
    const termination = await runtime.termination;
    assert.equal(termination.reason, "fatal");
    assert.equal(termination.error.operation, operation);
  } finally {
    await runtime?.close().catch(() => undefined);
    restoreScheduler();
    await rm(root, { recursive: true, force: true });
  }
}

function hangingRegistration(hangingOperation) {
  let nextSession = 1;
  return createOfficialHarnessRegistration(
    "codex",
    {},
    FULL_HARNESS_CAPABILITIES,
    workspaceConfigurator,
    () => ({
    kind: "codex",
    async initialize() {},
    async createSession() {
      if (hangingOperation === "createSession") return new Promise(() => undefined);
      return adapterSession(nextSession++, hangingOperation);
    },
    async resumeSession() {
      if (hangingOperation === "resumeSession") return new Promise(() => undefined);
      return adapterSession(nextSession++, hangingOperation);
    },
    async listSessions() {
      if (hangingOperation === "listSessions") return new Promise(() => undefined);
      return [];
    },
    async close() {},
    }),
  );
}

function adapterSession(id, hangingOperation) {
  let closed = false;
  let releaseTurn;
  return {
    nativeSessionId: `codex-${id}`,
    model: undefined,
    get closed() { return closed; },
    async startTurn() {
      if (hangingOperation === "startTurn") return new Promise(() => undefined);
      const held = new Promise((resolve) => { releaseTurn = resolve; });
      return {
        nativeTurnId: `turn-${id}`,
        async *[Symbol.asyncIterator]() {
          yield { type: "turn.started" };
          if (hangingOperation === "respondToApproval") {
            yield {
              type: "approval.requested",
              nativeRequestId: "approval-native",
              title: "Approve?",
            };
          }
          if (hangingOperation === "respondToQuestion" || hangingOperation === "questionWaiting") {
            yield {
              type: "question.requested",
              nativeRequestId: "question-native",
              questions: [{
                question: "Continue?",
                options: [{ label: "Yes" }],
                multiple: false,
                allowCustom: false,
              }],
            };
          }
          await held;
        },
        async interrupt() {
          if (hangingOperation === "interruptTurn") return new Promise(() => undefined);
          releaseTurn?.();
        },
        async respondToApproval() {
          if (hangingOperation === "respondToApproval") return new Promise(() => undefined);
        },
        async respondToQuestion() {
          if (hangingOperation === "respondToQuestion") return new Promise(() => undefined);
        },
      };
    },
    async setModel() {
      if (hangingOperation === "setModel") return new Promise(() => undefined);
    },
    async close() { closed = true; releaseTurn?.(); },
  };
}

class FakeScheduler {
  #now = 0;
  #nextId = 1;
  #timers = new Map();
  #waiters = [];

  get timerCount() { return this.#timers.size; }

  setTimeout(callback, delayMs) {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + delayMs, callback });
    for (const waiter of [...this.#waiters]) {
      if (this.timerCount < waiter.count) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    return id;
  }

  clearTimeout(id) { this.#timers.delete(id); }

  advanceBy(delayMs) {
    this.#now += delayMs;
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= this.#now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) return;
      for (const [id, timer] of due) {
        if (!this.#timers.delete(id)) continue;
        timer.callback();
      }
    }
  }

  async waitForTimers(count) {
    if (this.timerCount >= count) return;
    await new Promise((resolve) => this.#waiters.push({ count, resolve }));
  }
}

async function promiseState(promise) {
  return Promise.race([
    promise.then(() => "fulfilled", () => "rejected"),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}
