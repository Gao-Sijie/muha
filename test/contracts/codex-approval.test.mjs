import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("interactive Codex Approval resolves once with a caller one-shot decision", async () => {
  const fixture = await createFixture("approval");
  try {
    assert.deepEqual(
      JSON.parse(await readFile(fixture.sessionRequestFile, "utf8")),
      {
        cwd: fixture.workspace,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    );
    const turn = await fixture.session.startTurn([{ type: "text", text: "request approval" }]);
    await assert.rejects(
      turn.respondToApproval("unknown", "allowOnce"),
      interactionCode("TURN_INTERACTION_NOT_FOUND"),
    );
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "approval.requested") {
        assert.equal(event.title, "Approve command execution");
        assert.equal(typeof event.toolCallId, "string");
        assert.deepEqual(event.details, {
          command: "echo approved",
          cwd: fixture.workspace,
          networkApprovalContext: null,
        });
        await assert.rejects(
          turn.respondToApproval(event.requestId, "allowForSession"),
          (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
        );
        await turn.respondToApproval(event.requestId, "allowOnce");
      }
    }
    assert.equal((await turn.result).status, "completed");
    const requested = events.find(({ type }) => type === "approval.requested");
    const resolved = events.find(({ type }) => type === "approval.resolved");
    assert.deepEqual(resolved, {
      type: "approval.resolved",
      turnId: turn.turnId,
      sequence: resolved.sequence,
      timestamp: resolved.timestamp,
      requestId: requested.requestId,
      outcome: "allowOnce",
      source: "caller",
    });
    await assert.rejects(
      turn.respondToApproval(requested.requestId, "deny"),
      interactionCode("TURN_INTERACTION_ALREADY_RESOLVED"),
    );
    assert.equal(await readFile(fixture.decisionFile, "utf8"), "accept");
  } finally {
    await fixture.close();
  }
});

test("Codex file-change and turn-scoped permissions Approvals retain portable details", async () => {
  for (const [scenario, title, expectedDetails, expectedNative] of [
    [
      "approval-file",
      "Approve file changes",
      { grantRoot: "/tmp/fixture-grant" },
      "accept",
    ],
    [
      "approval-permissions",
      "Approve requested permissions",
      {
        cwd: undefined,
        permissions: {
          network: { host: "example.com" },
          fileSystem: { read: ["/tmp/fixture-read"] },
        },
      },
      JSON.stringify({
        permissions: {
          network: { host: "example.com" },
          fileSystem: { read: ["/tmp/fixture-read"] },
        },
        scope: "turn",
      }),
    ],
  ]) {
    const fixture = await createFixture(scenario);
    try {
      const turn = await fixture.session.startTurn([{ type: "text", text: scenario }]);
      let requested;
      for await (const event of turn) {
        if (event.type === "approval.requested") {
          requested = event;
          await turn.respondToApproval(event.requestId, "allowOnce");
        }
      }
      assert.equal(requested.title, title);
      if (scenario === "approval-permissions") {
        assert.equal(requested.details.cwd, fixture.workspace);
        assert.deepEqual(requested.details.permissions, expectedDetails.permissions);
      } else {
        assert.deepEqual(requested.details, expectedDetails);
      }
      assert.equal(await readFile(fixture.decisionFile, "utf8"), expectedNative);
    } finally {
      await fixture.close();
    }
  }
});

test("resumeSession replaces YOLO with its own Approval Policy without changing the Workspace", async () => {
  const fixture = await createFixture("approval", "autoApprove");
  let resumed;
  try {
    const reference = fixture.session.reference;
    await fixture.session.close();
    resumed = await fixture.runtime.resumeSession({ reference, approvalPolicy: "autoDeny" });
    const turn = await resumed.startTurn([{ type: "text", text: "deny after resume" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const resolved = events.find(({ type }) => type === "approval.resolved");
    assert.equal(resolved.outcome, "deny");
    assert.equal(resolved.source, "policy");
    assert.equal(await readFile(fixture.decisionFile, "utf8"), "decline");
    assert.deepEqual(
      JSON.parse(await readFile(fixture.sessionRequestFile, "utf8")),
      {
        threadId: reference.sessionId,
        cwd: reference.workspacePath,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    );
    assert.deepEqual(await readdir(fixture.workspace), []);
  } finally {
    await resumed?.close();
    await fixture.close();
  }
});

test("Codex rejects a Session when the native response did not apply YOLO", async () => {
  let fixture;
  try {
    await assert.rejects(async () => { fixture = await createFixture("wrong-permission-mode", "autoApprove"); },
      (error) => error instanceof MuhaError && error.data.code === "ADAPTER_PROTOCOL_ERROR");
  } finally {
    await fixture?.close();
  }
});

test("closing one Codex handle does not unload another live handle of the same native Session", async () => {
  const fixture = await createFixture("approval", "autoApprove");
  let second;
  let resumed;
  try {
    const reference = fixture.session.reference;
    second = await fixture.runtime.resumeSession({ reference, approvalPolicy: "autoApprove" });
    await fixture.session.close();
    await assert.rejects(
      fixture.runtime.resumeSession({ reference, approvalPolicy: "autoDeny" }),
      (error) => error instanceof MuhaError && error.data.code === "ADAPTER_PROTOCOL_ERROR",
    );
    await second.close();
    resumed = await fixture.runtime.resumeSession({ reference, approvalPolicy: "autoDeny" });
    const turn = await resumed.startTurn([{ type: "text", text: "deny after the last handle closes" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.ok(events.some((event) => event.type === "approval.resolved" && event.outcome === "deny"));
  } finally {
    await second?.close();
    await resumed?.close();
    await fixture.close();
  }
});

for (const [policy, outcome, nativeDecision] of [
  ["autoApprove", "allowOnce", "accept"],
  ["autoDeny", "deny", "decline"],
]) {
  test(`${policy} still surfaces a policy-sourced one-shot Approval lifecycle`, async () => {
    const fixture = await createFixture("approval", policy);
    try {
      const turn = await fixture.session.startTurn([{ type: "text", text: policy }]);
      const events = [];
      for await (const event of turn) events.push(event);
      const requestedIndex = events.findIndex(({ type }) => type === "approval.requested");
      const resolvedIndex = events.findIndex(({ type }) => type === "approval.resolved");
      assert.equal(requestedIndex >= 0, true);
      assert.equal(resolvedIndex, requestedIndex + 1);
      assert.equal(events[resolvedIndex].outcome, outcome);
      assert.equal(events[resolvedIndex].source, "policy");
      assert.equal(await readFile(fixture.decisionFile, "utf8"), nativeDecision);
      const nativeOptions = JSON.parse(await readFile(fixture.sessionRequestFile, "utf8"));
      assert.equal(nativeOptions.approvalPolicy, policy === "autoApprove" ? "never" : "on-request");
      assert.equal(nativeOptions.sandbox, policy === "autoApprove" ? "danger-full-access" : "workspace-write");
      assert.deepEqual(await readdir(fixture.workspace), []);
    } finally {
      await fixture.close();
    }
  });
}

for (const [scenario, source] of [
  ["approval-invalidated-by-turn", "turn"],
  ["approval-invalidated-by-harness", "harness"],
]) {
  test(`${scenario} has one invalidation winner before terminal`, async () => {
    const fixture = await createFixture(scenario);
    try {
      const turn = await fixture.session.startTurn([{ type: "text", text: scenario }]);
      const events = [];
      for await (const event of turn) events.push(event);
      const requested = events.find(({ type }) => type === "approval.requested");
      const resolved = events.filter(({ type }) => type === "approval.resolved");
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].requestId, requested.requestId);
      assert.equal(resolved[0].outcome, "invalidated");
      assert.equal(resolved[0].source, source);
      assert.equal(events.at(-1).type.startsWith("turn."), true);
      await assert.rejects(
        turn.respondToApproval(requested.requestId, "allowOnce"),
        interactionCode("TURN_INTERACTION_INVALIDATED"),
      );
    } finally {
      await fixture.close();
    }
  });
}

function interactionCode(code) {
  return (error) =>
    error instanceof MuhaError &&
    error.data.code === code &&
    error.data.interaction === "approval";
}

async function createFixture(scenario, approvalPolicy) {
  const root = await mkdtemp(join(tmpdir(), `muha-codex-${scenario}-`));
  const workspace = join(root, "workspace");
  const decisionFile = join(root, "decision");
  const sessionRequestFile = join(root, "session-request.json");
  const nativeSessionsFile = join(root, "native-sessions.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_TURN_SCENARIO: scenario,
            MUHA_FAKE_APPROVAL_DECISION_FILE: decisionFile,
            MUHA_FAKE_SESSION_REQUEST_FILE: sessionRequestFile,
            MUHA_FAKE_NATIVE_SESSIONS_FILE: nativeSessionsFile,
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({
      harness: "codex",
      workspacePath: workspace,
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    });
    return {
      workspace,
      decisionFile,
      sessionRequestFile,
      runtime,
      session,
      close: async () => {
        await session.close();
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
