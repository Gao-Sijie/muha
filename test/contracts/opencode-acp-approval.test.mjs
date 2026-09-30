// T15 — OpenCode ACP route: Approval policy enforcement, one-shot replies,
// native denial honesty, invalidation on terminal, and policy re-application.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import { controlledOpenCodeAdapter as openCodeAdapter } from "../fixtures/acp-harness/options.mjs";
import { acpOptions } from "../fixtures/acp-harness/options.mjs";

test("OpenCode ACP route surfaces an Approval Request and applies a one-shot decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-approve-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("approval") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace, approvalPolicy: "interactive" });
    const turn = await session.startTurn([{ type: "text", text: "run tests" }]);
    const approvals = [];
    for await (const event of turn) {
      if (event.type === "approval.requested") {
        approvals.push(event);
        await turn.respondToApproval(event.requestId, "allowOnce");
      }
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "approved");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].title, "Bash: npm test");
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route applies an explicit deny and never fabricates success", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-deny-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("approval-deny") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace, approvalPolicy: "interactive" });
    const turn = await session.startTurn([{ type: "text", text: "run tests" }]);
    let answered = false;
    for await (const event of turn) {
      if (event.type === "approval.requested") {
        answered = true;
        await turn.respondToApproval(event.requestId, "deny");
      }
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "declined");
    assert.equal(answered, true);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route invalidates pending Approvals when the Turn settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-race-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("permission-race") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace, approvalPolicy: "interactive" });
    const turn = await session.startTurn([{ type: "text", text: "go" }]);
    const events = [];
    let approvalRequestId;
    for await (const event of turn) {
      events.push(event);
      if (event.type === "approval.requested") approvalRequestId = event.requestId;
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");
    // The pending Approval is settled by the terminal Turn with an invalidated
    // outcome; it is not left hanging and cannot be answered afterwards.
    assert.ok(events.some((e) => e.type === "approval.resolved" && e.outcome === "invalidated"));
    await assert.rejects(
      turn.respondToApproval(approvalRequestId, "allowOnce"),
      (error) => error.data?.code === "TURN_INTERACTION_INVALIDATED",
    );
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route re-applies the current policy on create and resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-policy-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("approval") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace, approvalPolicy: "interactive" });
    const reference = session.reference;
    await session.close();
    session = undefined;

    // Resuming with autoApprove applies the current policy: Core answers the
    // remaining Approval Request itself without the caller replying.
    session = await runtime.resumeSession({ reference, approvalPolicy: "autoApprove" });
    const turn = await session.startTurn([{ type: "text", text: "run tests" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.ok(events.some((e) => e.type === "approval.requested"));
    assert.ok(events.some((e) => e.type === "approval.resolved" && e.outcome === "allowOnce"));
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route late/unknown Approval replies fail without side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-unknown-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("approval") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace, approvalPolicy: "interactive" });
    const turn = await session.startTurn([{ type: "text", text: "go" }]);
    for await (const event of turn) {
      if (event.type === "approval.requested") await turn.respondToApproval(event.requestId, "allowOnce");
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");
    await assert.rejects(
      turn.respondToApproval("perm_does_not_exist", "allowOnce"),
      (error) => error.data?.code === "TURN_INTERACTION_NOT_FOUND" || error.data?.code === "TURN_INTERACTION_INVALIDATED",
    );
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
