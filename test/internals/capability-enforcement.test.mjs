import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { createOfficialHarnessRegistration } from "@muha-sdk/core/internal";
import { FULL_HARNESS_CAPABILITIES } from "../support/full-harness-capabilities.mjs";

const fullCapabilities = FULL_HARNESS_CAPABILITIES;
const workspaceWorker = resolve(import.meta.dirname, "../fixtures/workspace-worker.mjs");

test("unsupported Session listing rejects before Adapter invocation", async () => {
  const fixture = await createFixture({ sessionListing: false });
  try {
    await assert.rejects(
      fixture.runtime.listSessions({ harness: "codex", workspacePath: fixture.workspace }),
      unsupported("sessionListing", "listSessions"),
    );
    assert.equal(fixture.calls.listSessions, 0);
  } finally {
    await fixture.close();
  }
});

test("unsupported image input rejects the complete Turn before acceptance", async () => {
  const fixture = await createFixture({ imageInput: false });
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "codex",
      workspacePath: fixture.workspace,
    });
    const image = {
      type: "image",
      source: {
        type: "base64",
        mediaType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    };
    await assert.rejects(session.startTurn([image]), unsupported("imageInput", "startTurn"));
    await assert.rejects(
      session.startTurn([{ type: "text", text: "keep all" }, image]),
      unsupported("imageInput", "startTurn"),
    );
    assert.equal(fixture.calls.startTurn, 0);
    assert.deepEqual(session.status, { status: "idle" });
  } finally {
    await session?.close();
    await fixture.close();
  }
});

for (const policy of ["autoApprove", "harnessManaged"]) {
test(`${policy} supports a native Turn without approvals and does not imply other policies`, async () => {
  const fixture = await createFixture(
    { approvalPolicies: [policy] },
    { turnEvents: [{ type: "turn.started" }, ...completedMessageEvents()] },
  );
  let session;
  try {
    await assert.rejects(
      fixture.runtime.createSession({ harness: "codex", workspacePath: fixture.workspace }),
      unsupported("approvalPolicy.interactive", "createSession"),
    );
    assert.equal(fixture.calls.createSession, 0);

    session = await fixture.runtime.createSession({
      harness: "codex",
      workspacePath: fixture.workspace,
      approvalPolicy: policy,
    });
    assert.equal(fixture.calls.createSession, 1);
    assert.equal(fixture.calls.approvalPolicy, policy);
    const turn = await session.startTurn([{ type: "text", text: "respond" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).status, "completed");
    assert.equal(events.some(({ type }) => type.startsWith("approval.")), false);

    const reference = session.reference;
    await session.close();
    session = undefined;
    await assert.rejects(
      fixture.runtime.resumeSession({ reference }),
      unsupported("approvalPolicy.interactive", "resumeSession"),
    );
    assert.equal(fixture.calls.resumeSession, 0);
    session = await fixture.runtime.resumeSession({
      reference,
      approvalPolicy: policy,
    });
    assert.equal(fixture.calls.resumeSession, 1);
    assert.equal(fixture.calls.approvalPolicy, policy);
  } finally {
    await session?.close();
    await fixture.close();
  }
});
}

test("unsupported Workspace capabilities fail per attempt without running planners", async () => {
  const fixture = await createFixture({ workspaceSkills: false, workspaceMcp: false });
  try {
    const result = await fixture.runtime.configureWorkspace({
      workspacePath: fixture.workspace,
      harnesses: ["codex"],
      skills: [{ source: fixture.root }],
      mcpServers: [{ name: "local", transport: "stdio", command: "local-mcp" }],
    });
    assert.deepEqual(
      result.attempts.map((attempt) => ({
        kind: attempt.kind,
        status: attempt.status,
        code: attempt.error?.code,
        capability: attempt.error?.capability,
      })),
      [
        {
          kind: "skill",
          status: "failed",
          code: "UNSUPPORTED_CAPABILITY",
          capability: "workspaceSkills",
        },
        {
          kind: "mcp",
          status: "failed",
          code: "UNSUPPORTED_CAPABILITY",
          capability: "workspaceMcp",
        },
      ],
    );
  } finally {
    await fixture.close();
  }
});

test("Workspace Capability enforcement preserves mixed Harness/input ordering and partial success", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-capability-matrix-"));
  const workspace = join(root, "workspace");
  const outputPath = join(workspace, "supported-attempts.jsonl");
  let unsupportedPlannerCalls = 0;
  let runtime;
  await mkdir(workspace);
  const unsupportedConfigurator = {
    planSkill() {
      unsupportedPlannerCalls += 1;
      throw new Error("unsupported Skill planner must not run");
    },
    planMcpServer() {
      unsupportedPlannerCalls += 1;
      throw new Error("unsupported MCP planner must not run");
    },
  };
  const supportedConfigurator = {
    planSkill({ source }) {
      return {
        entrypoint: workspaceWorker,
        args: [],
        stdin: JSON.stringify({ outputPath, label: `skill:${source}` }),
      };
    },
    planMcpServer({ server }) {
      return {
        entrypoint: workspaceWorker,
        args: [],
        stdin: JSON.stringify({ outputPath, label: `mcp:${server.name}` }),
      };
    },
  };
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        inertRegistration(
          "codex",
          capabilityProfile({ workspaceSkills: false, workspaceMcp: false }),
          unsupportedConfigurator,
        ),
        inertRegistration("opencode", fullCapabilities, supportedConfigurator),
      ],
      dataDir: join(root, "diagnostics"),
    });
    const result = await runtime.configureWorkspace({
      workspacePath: workspace,
      harnesses: ["codex", "opencode"],
      skills: [{ source: "one" }, { source: "two" }],
      mcpServers: [
        { name: "first", transport: "stdio", command: "first" },
        { name: "second", transport: "stdio", command: "second" },
      ],
    });
    assert.deepEqual(
      result.attempts.map(({ harness, kind, inputIndex, status }) => ({
        harness,
        kind,
        inputIndex,
        status,
      })),
      [
        { harness: "codex", kind: "skill", inputIndex: 0, status: "failed" },
        { harness: "codex", kind: "skill", inputIndex: 1, status: "failed" },
        { harness: "codex", kind: "mcp", inputIndex: 0, status: "failed" },
        { harness: "codex", kind: "mcp", inputIndex: 1, status: "failed" },
        { harness: "opencode", kind: "skill", inputIndex: 0, status: "succeeded" },
        { harness: "opencode", kind: "skill", inputIndex: 1, status: "succeeded" },
        { harness: "opencode", kind: "mcp", inputIndex: 0, status: "succeeded" },
        { harness: "opencode", kind: "mcp", inputIndex: 1, status: "succeeded" },
      ],
    );
    assert.equal(unsupportedPlannerCalls, 0);
    const records = (await readFile(outputPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map(({ label }) => label), [
      "skill:one",
      "skill:two",
      "mcp:first",
      "mcp:second",
    ]);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("model and effort selection are enforced at each operation point", async () => {
  const fixture = await createFixture({
    model: { selectionAt: [] },
    effort: { selectionAt: [] },
  });
  let session;
  try {
    await assert.rejects(
      fixture.runtime.createSession({
        harness: "codex",
        workspacePath: fixture.workspace,
        model: "chosen-model",
      }),
      unsupported("model.selectionAt.createSession", "createSession"),
    );
    await assert.rejects(
      fixture.runtime.createSession({
        harness: "codex",
        workspacePath: fixture.workspace,
        effort: "high",
      }),
      unsupported("effort.selectionAt.createSession", "createSession"),
    );
    assert.equal(fixture.calls.createSession, 0);

    session = await fixture.runtime.createSession({
      harness: "codex",
      workspacePath: fixture.workspace,
    });
    const reference = session.reference;
    await assert.rejects(
      session.setModel("chosen-model"),
      unsupported("model.selectionAt.idleSession", "setModel"),
    );
    await assert.rejects(
      session.setEffort("high"),
      unsupported("effort.selectionAt.idleSession", "setEffort"),
    );
    assert.equal(fixture.calls.setModel, 0);
    assert.equal(fixture.calls.setEffort, 0);
    await session.close();
    session = undefined;

    await assert.rejects(
      fixture.runtime.resumeSession({ reference, model: "chosen-model" }),
      unsupported("model.selectionAt.resumeSession", "resumeSession"),
    );
    await assert.rejects(
      fixture.runtime.resumeSession({ reference, effort: "high" }),
      unsupported("effort.selectionAt.resumeSession", "resumeSession"),
    );
    assert.equal(fixture.calls.resumeSession, 0);
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("a non-streaming Harness still returns the Kernel final Assistant Message", async () => {
  const fixture = await createFixture(
    { assistantMessageStreaming: false },
    {
      turnEvents: [
        { type: "turn.started" },
        {
          type: "assistant.message.completed",
          nativeMessageId: "message-1",
          text: "final only",
        },
        { type: "turn.completed" },
      ],
    },
  );
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "codex",
      workspacePath: fixture.workspace,
    });
    const turn = await session.startTurn([{ type: "text", text: "respond" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.deepEqual(events.map(({ type }) => type), ["turn.started", "turn.completed"]);
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "final only");
    assert.deepEqual(events.at(-1).message, result.message);
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("reasoning streaming is independent from Assistant Message streaming", async () => {
  const fixture = await createFixture(
    { assistantMessageStreaming: false, assistantReasoningStreaming: true },
    {
      turnEvents: [
        { type: "turn.started" },
        {
          type: "assistant.reasoning.delta",
          nativeMessageId: "message-1",
          delta: "native reasoning",
        },
        {
          type: "assistant.message.completed",
          nativeMessageId: "message-1",
          text: "final only",
        },
        { type: "turn.completed" },
      ],
    },
  );
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "codex",
      workspacePath: fixture.workspace,
    });
    const turn = await session.startTurn([{ type: "text", text: "respond" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.deepEqual(events.map(({ type }) => type), [
      "turn.started",
      "assistant.reasoning.delta",
      "turn.completed",
    ]);
    assert.equal(events[1].messageId, result.message.id);
    assert.equal(result.status, "completed");
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("events forbidden by the Harness Capability Profile fail the accepted Turn", async (t) => {
  const cases = [
    {
      name: "message streaming",
      capabilities: { assistantMessageStreaming: false },
      turnEvents: [{ type: "turn.started" }, ...completedMessageEvents()],
    },
    {
      name: "reasoning streaming",
      capabilities: { assistantReasoningStreaming: false },
      turnEvents: [
        { type: "turn.started" },
        { type: "assistant.message.started", nativeMessageId: "message-1" },
        {
          type: "assistant.reasoning.delta",
          nativeMessageId: "message-1",
          delta: "reasoning",
        },
        ...completedMessageEvents({ includeStart: false }),
      ],
    },
    {
      name: "Questions",
      capabilities: { turnQuestions: false },
      turnEvents: [
        { type: "turn.started" },
        {
          type: "question.requested",
          nativeRequestId: "question-1",
          questions: [{
            question: "Choose",
            options: [],
            multiple: false,
            allowCustom: true,
          }],
        },
        { type: "question.dismissed", nativeRequestId: "question-1" },
        ...completedMessageEvents(),
      ],
    },
    {
      name: "Tool Events",
      capabilities: { toolEvents: false },
      turnEvents: [
        { type: "turn.started" },
        {
          type: "tool.started",
          nativeToolCallId: "tool-1",
          toolName: "Read",
          input: {},
        },
        {
          type: "tool.completed",
          nativeToolCallId: "tool-1",
          output: { ok: true },
          isError: false,
        },
        ...completedMessageEvents(),
      ],
    },
    {
      name: "Turn Usage",
      capabilities: { turnUsage: false },
      turnEvents: [
        { type: "turn.started" },
        { type: "usage.updated", usage: { inputTokens: 1 } },
        ...completedMessageEvents(),
      ],
    },
    {
      name: "harness-managed Approval",
      capabilities: { approvalPolicies: ["harnessManaged"] },
      approvalPolicy: "harnessManaged",
      turnEvents: [
        { type: "turn.started" },
        {
          type: "approval.requested",
          nativeRequestId: "approval-1",
          title: "permission",
        },
        ...completedMessageEvents(),
      ],
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = await createFixture(scenario.capabilities, {
        turnEvents: scenario.turnEvents,
      });
      let session;
      try {
        session = await fixture.runtime.createSession({
          harness: "codex",
          workspacePath: fixture.workspace,
          ...(scenario.approvalPolicy === undefined
            ? {}
            : { approvalPolicy: scenario.approvalPolicy }),
        });
        const turn = await session.startTurn([{ type: "text", text: "respond" }]);
        for await (const _event of turn) {
          // Consume the complete public stream.
        }
        const result = await turn.result;
        assert.equal(result.status, "failed");
        assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
        assert.match(result.error.message, /Capability/);
      } finally {
        await session?.close();
        await fixture.close();
      }
    });
  }
});

function completedMessageEvents({ includeStart = true } = {}) {
  return [
    ...(includeStart
      ? [{ type: "assistant.message.started", nativeMessageId: "message-1" }]
      : []),
    {
      type: "assistant.message.completed",
      nativeMessageId: "message-1",
      text: "done",
    },
    { type: "turn.completed" },
  ];
}

async function createFixture(overrides, behavior = {}) {
  const root = await mkdtemp(join(tmpdir(), "muha-capability-enforcement-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const calls = {
    createSession: 0,
    resumeSession: 0,
    listSessions: 0,
    startTurn: 0,
    setModel: 0,
    setEffort: 0,
  };
  const capabilities = deepFreeze({
    ...fullCapabilities,
    ...overrides,
    model: { ...fullCapabilities.model, ...overrides.model },
    effort: { ...fullCapabilities.effort, ...overrides.effort },
  });
  const registration = createOfficialHarnessRegistration(
    "codex",
    {},
    capabilities,
    unusedWorkspaceConfigurator,
    () => ({
      kind: "codex",
      async initialize() {},
      async createSession(options) {
        calls.createSession += 1;
        calls.approvalPolicy = options.approvalPolicy;
        return createAdapterSession(calls, behavior);
      },
      async resumeSession(options) {
        calls.resumeSession += 1;
        calls.approvalPolicy = options.approvalPolicy;
        return createAdapterSession(calls, behavior);
      },
      async listSessions() {
        calls.listSessions += 1;
        return [];
      },
      async close() {},
    }),
  );
  const runtime = await createMuhaRuntime({
    harnesses: [registration],
    dataDir: join(root, "diagnostics"),
  });
  return {
    calls,
    root,
    runtime,
    workspace,
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function createAdapterSession(calls, behavior) {
  let closed = false;
  return {
    nativeSessionId: "native-session",
    model: "fake-model",
    effort: undefined,
    get closed() {
      return closed;
    },
    async startTurn() {
      calls.startTurn += 1;
      const events = behavior.turnEvents;
      if (!events) throw new Error("unsupported Turn reached Adapter");
      return {
        nativeTurnId: `native-turn-${calls.startTurn}`,
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
        async interrupt() {},
        async respondToApproval() {},
        async respondToQuestion() {},
      };
    },
    async setModel() {
      calls.setModel += 1;
    },
    async setEffort() {
      calls.setEffort += 1;
    },
    async close() {
      closed = true;
    },
  };
}

function unsupported(capability, operation) {
  return (error) =>
    error instanceof MuhaError &&
    error.data.code === "UNSUPPORTED_CAPABILITY" &&
    error.data.harness === "codex" &&
    error.data.capability === capability &&
    error.data.operation === operation;
}

function inertRegistration(kind, capabilities, workspaceConfigurator) {
  return createOfficialHarnessRegistration(
    kind,
    {},
    capabilities,
    workspaceConfigurator,
    () => ({
      kind,
      async initialize() {},
      async createSession() { throw new Error("unused"); },
      async resumeSession() { throw new Error("unused"); },
      async listSessions() { return []; },
      async close() {},
    }),
  );
}

function capabilityProfile(overrides) {
  return deepFreeze({
    ...fullCapabilities,
    ...overrides,
    model: { ...fullCapabilities.model, ...overrides.model },
    effort: { ...fullCapabilities.effort, ...overrides.effort },
  });
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object") deepFreeze(nested);
  }
  return Object.freeze(value);
}

const unusedWorkspaceConfigurator = {
  planSkill() {
    throw new Error("unexpected Skill planner call");
  },
  planMcpServer() {
    throw new Error("unexpected MCP planner call");
  },
};
