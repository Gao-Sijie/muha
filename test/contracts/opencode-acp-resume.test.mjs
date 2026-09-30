// T13 — OpenCode ACP route: resume with references, session list, model/effort
// selection and history isolation through the controlled MABC endpoint.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError, createSessionReference } from "@muha-sdk/core";
import { controlledOpenCodeAdapter as openCodeAdapter } from "../fixtures/acp-harness/options.mjs";
import { acpOptions, collectTurn } from "../fixtures/acp-harness/options.mjs";

async function startRuntime(t, scenario = "normal", sessionsFile) {
  const root = await mkdtemp(join(tmpdir(), `muha-opencode-acp-${t}-`));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({
    harnesses: [openCodeAdapter({ acp: acpOptions(scenario, sessionsFile === undefined ? {} : { MUHA_FAKE_ACP_SESSIONS_FILE: sessionsFile }) })],
    dataDir: join(root, "diagnostics"),
  });
  return { root, workspace, runtime };
}

test("OpenCode ACP route resumes the same native Session by its explicit route reference after close", async () => {
  const { root, workspace, runtime } = await startRuntime("resume");
  let session;
  let reference;
  try {
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace, approvalPolicy: "interactive" });
    reference = session.reference;
    await session.close();
    session = undefined;

    // New Runtime, new ACP connection: the agent service owns the Session.
    const resumed = await runtime.resumeSession({ reference, approvalPolicy: "interactive" });
    assert.equal(resumed.reference.sessionId, reference.sessionId);
    assert.equal(resumed.reference.route, "acp");
    assert.equal(resumed.reference.workspacePath, reference.workspacePath);
    const turn = await resumed.startTurn([{ type: "text", text: "continue" }]);
    const { result, events } = await collectTurn(turn);
    assert.equal(result.status, "completed");
    assert.match(events.map((e) => e.type).join("|"), /assistant.message.completed/);
    await resumed.close();
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route rejects unknown Session identities without replacement", async () => {
  const { root, workspace, runtime } = await startRuntime("missing");
  try {
    const reference = createSessionReference("opencode", "acp_ses_does_not_exist", workspace, "acp");
    await assert.rejects(
      runtime.resumeSession({ reference }),
      (error) => error instanceof MuhaError && error.data.code === "SESSION_NOT_FOUND",
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP listing refuses a malformed next cursor instead of silently truncating native Sessions", async () => {
  const { root, workspace, runtime } = await startRuntime("bad-cursor", "invalid-list-cursor");
  try {
    await assert.rejects(runtime.listSessions({ harness: "opencode", workspacePath: workspace }), error => error.data?.code === "ADAPTER_PROTOCOL_ERROR");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("OpenCode ACP route listSessions returns native-owned, workspace-scoped entries", async () => {
  const { root, workspace, runtime } = await startRuntime("list");
  let first;
  let second;
  try {
    first = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    second = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const listed = await runtime.listSessions({ harness: "opencode", workspacePath: workspace });
    assert.equal(listed.length, 2);
    for (const entry of listed) {
      assert.equal(entry.reference.route, "acp");
      assert.equal(entry.reference.workspacePath, workspace);
    }
    assert.equal(new Set(listed.map((e) => e.reference.sessionId)).size, 2);
  } finally {
    await first?.close();
    await second?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route model/effort selections are applied and validated at each operation point", async () => {
  const { root, workspace, runtime } = await startRuntime("selection");
  let session;
  try {
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      model: "opencode-go/deepseek-v4.1-flash",
      effort: "high",
    });
    assert.equal(session.model, "opencode-go/deepseek-v4.1-flash");
    assert.equal(session.effort, "high");
    await session.setModel("opencode-go/deepseek-v4.1-flash");
    assert.equal(session.model, "opencode-go/deepseek-v4.1-flash");

    // Invalid native selection is rejected without switching models.
    await assert.rejects(
      session.setModel("invalid/not-a-model"),
      (error) => error instanceof MuhaError && error.data.code === "HARNESS_ERROR" && error.data.nativeCode === "-32602",
    );
    assert.equal(session.model, "opencode-go/deepseek-v4.1-flash");
    await session.setEffort("low");
    assert.equal(session.effort, "low");
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route keeps resumed history out of new Turns (no replay into the new Turn)", async () => {
  const { root, workspace, runtime } = await startRuntime("history");
  let session;
  try {
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const first = await session.startTurn([{ type: "text", text: "first input" }]);
    const { events: firstEvents } = await collectTurn(first);
    const firstFinal = firstEvents.filter((e) => e.type === "assistant.message.completed")[0]?.message?.text;
    assert.match(firstFinal, /first input/);

    const second = await session.startTurn([{ type: "text", text: "second input" }]);
    const { events: secondEvents } = await collectTurn(second);
    // The second Turn's events must only carry the second input's content; the
    // controlled endpoint never replays history into a new prompt.
    const finals = secondEvents.filter((e) => e.type === "assistant.message.completed");
    assert.equal(finals.length, 1);
    assert.match(finals[0].message.text, /second input/);
    assert.doesNotMatch(finals[0].message.text, /first input/);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
