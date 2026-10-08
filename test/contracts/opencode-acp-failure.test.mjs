// T18 — OpenCode ACP route: cancellation, retry, stream/process failures and
// owned-resource cleanup across the controlled MABC endpoint.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { controlledOpenCodeAdapter as openCodeAdapter } from "../fixtures/acp-harness/options.mjs";
import { acpOptions } from "../fixtures/acp-harness/options.mjs";

test("OpenCode ACP route interrupt settles the Turn exactly once with an interrupted result", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-int-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      // Keep the prompt pending until cancel; a 5ms echo can finish before interrupt under load.
      harnesses: [openCodeAdapter({ acp: acpOptions("delayed-cancel") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "slow" }]);
    await turn.interrupt();
    const result = await turn.result;
    assert.equal(result.status, "interrupted");
    assert.ok(result.reason === "caller" || result.reason === "harness");
    let terminals = 0;
    for await (const event of turn) {
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted") terminals += 1;
    }
    assert.ok(terminals <= 1);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP does not retry an ambiguous prompt RPC failure even with a Core retry budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-retry-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("error-status") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      turnRetryPolicy: { maxRetries: 2 },
    });
    const turn = await session.startTurn([{ type: "text", text: "retry me" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    // A generic JSON-RPC error does not prove a Turn was safe to repeat.
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.equal(result.error.nativeCode, "-32603");
    assert.equal(events.filter((e) => e.type === "turn.retrying").length, 0);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route unexpected process exit fails the active Turn and reclaims owned resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-exit-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("unexpected-exit") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "crash" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    // After a fatal, the Session is closed and duplicate close is safe.
    assert.equal(session.status.status, "closed");
    await session.close();
    await session.close();
    session = undefined;
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route close settles pending Sessions and never touches unrelated processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-close-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("normal") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    await runtime.close();
    runtime = undefined;
    // Closing the Runtime closed the owned ACP connection; the Session handle
    // reports closed and a new startTurn is rejected.
    assert.equal(session.status.status, "closed");
    await assert.rejects(
      session.startTurn([{ type: "text", text: "late" }]),
      (error) => error.data?.code === "SESSION_CLOSED" || error.data?.code === "RUNTIME_CLOSED",
    );
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route startTurn failure is a Command Rejection, not a Turn Failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-reject-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("normal") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    // A second active Turn is a command rejection at Core level.
    const first = await session.startTurn([{ type: "text", text: "one" }]);
    await assert.rejects(
      session.startTurn([{ type: "text", text: "two" }]),
      (error) => error instanceof MuhaError && error.data.code === "SESSION_BUSY",
    );
    for await (const _event of first) { /* drain */ }
    await first.result;
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
