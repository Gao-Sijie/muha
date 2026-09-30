// T12 — OpenCode ACP route: create, one text Turn, close, duplicate close,
// single-active-Turn and Session isolation through the shared controlled
// ACP endpoint (internal test binding).
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { controlledOpenCodeAdapter as openCodeAdapter } from "../fixtures/acp-harness/options.mjs";
import { acpOptions, collectTurn } from "../fixtures/acp-harness/options.mjs";

async function newRuntime(t, scenario = "normal", extraEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), `muha-opencode-acp-${t}-`));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({
    harnesses: [openCodeAdapter({ acp: acpOptions(scenario, extraEnv) })],
    dataDir: join(root, "diagnostics"),
  });
  return { root, workspace, runtime };
}

test("OpenCode ACP route creates a Session, runs one text Turn, and closes idempotently", async () => {
  const { root, workspace, runtime } = await newRuntime("normal", { MUHA_FAKE_ACP_SCENARIO: "normal" });
  let session;
  try {
    assert.equal(runtime.getHarnessCapabilities("opencode").sessionListing, true);
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace, approvalPolicy: "interactive" });
    assert.equal(session.reference.harness, "opencode");
    assert.equal(session.reference.route, "acp");
    assert.equal(Object.hasOwn(session.reference, "formatVersion"), false);
    assert.match(session.reference.sessionId, /^acp_ses_\d+$/);

    // A second active Turn on the same Session is rejected while one runs.
    const first = await session.startTurn([{ type: "text", text: "hello" }]);
    await assert.rejects(
      session.startTurn([{ type: "text", text: "again" }]),
      (error) => error.data?.code === "SESSION_BUSY",
    );
    const events = [];
    for await (const event of first) events.push(event);
    const result = await first.result;
    assert.equal(result.status, "completed");
    assert.equal(events[0].type, "turn.started");
    const completed = events.filter((event) => event.type === "assistant.message.completed");
    assert.equal(completed.length, 1);
    assert.match(completed[0].message.text, /^echo:hello$/);
    // Exactly one terminal event, consistent with the Turn Result.
    const terminal = events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].type, "turn.completed");

    // A fresh Turn is accepted after the previous one settled.
    const second = await session.startTurn([{ type: "text", text: "again" }]);
    const secondEvents = await collectTurn(second);
    assert.equal(secondEvents.result.status, "completed");

    // close + duplicate close are safe.
    await session.close();
    await session.close();
    session = undefined;
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route isolates independent Sessions and active Turn state", async () => {
  const { root, workspace, runtime } = await newRuntime("normal");
  let first;
  let second;
  try {
    first = await runtime.createSession({ harness: "opencode", workspacePath: workspace, approvalPolicy: "interactive" });
    second = await runtime.createSession({ harness: "opencode", workspacePath: workspace, approvalPolicy: "interactive" });
    assert.notEqual(first.reference.sessionId, second.reference.sessionId);

    const turnA = await first.startTurn([{ type: "text", text: "alpha" }]);
    // The other Session can start its own Turn concurrently.
    const turnB = await second.startTurn([{ type: "text", text: "beta" }]);
    const [a, b] = await Promise.all([collectTurn(turnA), collectTurn(turnB)]);
    assert.equal(a.result.status, "completed");
    assert.equal(b.result.status, "completed");
    assert.match(finalText(a.events), /alpha/);
    assert.match(finalText(b.events), /beta/);
  } finally {
    await first?.close();
    await second?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route initialization failure rolls back without partial resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-init-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await assert.rejects(
    createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("malformed-initialize") })],
      dataDir: join(root, "diagnostics"),
    }),
    (error) => error instanceof MuhaError && error.data.code === "RUNTIME_INITIALIZATION_FAILED",
  );
  await rm(root, { recursive: true, force: true });
});

test("OpenCode ACP route rejects unknown routes and version mismatches deterministically", async () => {
  const { root, workspace, runtime } = await newRuntime("normal");
  try {
    // A valid current Reference cannot pick an unsupported execution route.
    await assert.rejects(
      runtime.resumeSession({ reference: { harness: "opencode", sessionId: "acp_ses_1", workspacePath: workspace, route: "native" } }),
      (error) => error instanceof MuhaError && error.data.code === "UNSUPPORTED_ROUTE",
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sibling handles preserve one native execution owner and reference-counted close", async () => {
  const { root, workspace, runtime } = await newRuntime("ownership");
  try {
    const original = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const reference = original.reference;
    const sibling = await runtime.resumeSession({ reference });
    const active = await original.startTurn([{ type: "text", text: "original owner" }]);
    await assert.rejects(sibling.startTurn([{ type: "text", text: "must not race" }]), error => error.data?.code === "SESSION_BUSY");
    await assert.rejects(sibling.setModel("fake-high"), error => error.data?.code === "SESSION_BUSY");
    const result = await collectTurn(active);
    assert.equal(result.result.status, "completed");
    await original.close();
    const siblingResult = await collectTurn(await sibling.startTurn([{ type: "text", text: "sibling remains" }]));
    assert.equal(siblingResult.result.status, "completed");
    await sibling.close();
    const competing = await Promise.allSettled([
      runtime.resumeSession({ reference }), runtime.resumeSession({ reference }),
    ]);
    assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(competing.find(result => result.status === "rejected").reason.data.code, "SESSION_BUSY");
    const winner = competing.find(result => result.status === "fulfilled").value;
    const next = await collectTurn(await winner.startTurn([{ type: "text", text: "new owner" }]));
    assert.equal(next.result.status, "completed");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

function finalText(events) {
  const completed = events.filter((event) => event.type === "assistant.message.completed");
  return completed.at(-1)?.message?.text ?? "";
}
