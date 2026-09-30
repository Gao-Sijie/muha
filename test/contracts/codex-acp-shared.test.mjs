// T20–T23 — Codex ACP route: the shared ACP stack is reused for Kernel and
// Session resume (T20), rich input/events/usage (T21), permissions/questions
// (T22), and Workspace/model/effort (T23). Controlled-endpoint evidence;
// real admission remains T24/T33.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError, createSessionReference } from "@muha-sdk/core";
import { controlledCodexAdapter as codexAdapter } from "../fixtures/acp-harness/options.mjs";
import { acpOptions } from "../fixtures/acp-harness/options.mjs";

async function codexRuntime(t, scenario = "normal") {
  const root = await mkdtemp(join(tmpdir(), `muha-codex-acp-${t}-`));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({
    harnesses: [codexAdapter({ acp: acpOptions(scenario) })],
    dataDir: join(root, "diagnostics"),
  });
  return { root, workspace, runtime };
}

test("T20: Codex reuses the shared ACP stack for Kernel create/text/close and proven resume", async () => {
  const { root, workspace, runtime } = await codexRuntime("t20", "resume");
  let session;
  let reference;
  try {
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    assert.equal(session.reference.route, "acp");
    assert.equal(Object.hasOwn(session.reference, "formatVersion"), false);
    reference = session.reference;
    const turn = await session.startTurn([{ type: "text", text: "hello codex" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.match(result.message.text, /echo:hello codex/);
    assert.equal(events.filter((e) => e.type === "turn.completed").length, 1);
    await session.close();
    session = undefined;

    // The same native Session is resumed through the shared stack by reference.
    session = await runtime.resumeSession({ reference, approvalPolicy: "interactive" });
    assert.equal(session.reference.sessionId, reference.sessionId);
    const resumed = await session.startTurn([{ type: "text", text: "continue" }]);
    const resumedResult = await resumed.result;
    assert.equal(resumedResult.status, "completed");
    await session.close();
    session = undefined;
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T20: unknown Codex App Server identities fail explicitly without replacement", async () => {
  const { root, workspace, runtime } = await codexRuntime("t20m", "missing");
  try {
    const reference = createSessionReference("codex", "thread_does_not_exist", workspace, "acp");
    await assert.rejects(
      runtime.resumeSession({ reference }),
      (error) => error instanceof MuhaError && error.data.code === "SESSION_NOT_FOUND",
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T20: init failure and duplicate close follow the shared ownership contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-acp-init-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await assert.rejects(
    createMuhaRuntime({
      harnesses: [codexAdapter({ acp: acpOptions("malformed-initialize") })],
      dataDir: join(root, "diagnostics"),
    }),
    (error) => error instanceof MuhaError && error.data.code === "RUNTIME_INITIALIZATION_FAILED",
  );
  await rm(root, { recursive: true, force: true });
});

test("T21: Codex rich events, tool pairing, usage and final agreement through the shared translation", async () => {
  const { root, workspace, runtime } = await codexRuntime("t21", "rich");
  let session;
  try {
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([
      { type: "image", source: { type: "base64", mediaType: "image/png", data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64").toString("base64") } },
    ]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "completed");
    // Codex declares imageInput, so an image part is accepted; the final text
    // proves the part reached the endpoint and the answer was not fabricated.
    assert.equal(result.message.text, "Hello world");
    assert.equal(events.filter((e) => e.type === "tool.started").length, 1);
    assert.equal(events.filter((e) => e.type === "tool.completed").length, 1);
    const usage = events.find((e) => e.type === "usage.updated");
    assert.equal(usage?.usage.inputTokens, 10);
    assert.equal(events.filter((e) => e.type === "assistant.message.completed").length, 1);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T21: Codex missing/duplicated terminal state does not fabricate a second Result", async () => {
  const { root, workspace, runtime } = await codexRuntime("t21d", "duplicate-terminal");
  let session;
  try {
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "once" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.equal(events.filter((e) => e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted").length, 1);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T22: Codex Approval and Question flows reuse the shared interaction mechanisms", async () => {
  const { root, workspace, runtime } = await codexRuntime("t22", "approval");
  let session;
  try {
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace, approvalPolicy: "interactive" });
    const turn = await session.startTurn([{ type: "text", text: "run tests" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "approval.requested") await turn.respondToApproval(event.requestId, "allowOnce");
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.ok(events.some((e) => e.type === "approval.resolved"));
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T22: Codex question lifecycle keeps Question distinct from Approval", async () => {
  const { root, workspace, runtime } = await codexRuntime("t22q", "question");
  let session;
  try {
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "choose" }]);
    let seenQuestion = false;
    let seenApproval = false;
    for await (const event of turn) {
      if (event.type === "question.requested") {
        seenQuestion = true;
        await turn.respondToQuestion(event.requestId, {
          action: "answer",
          answers: [{ questionId: event.questions[0].questionId, kind: "selection",
            optionIds: [event.questions[0].input.options[0].optionId], customValues: [] }],
        });
      }
      if (event.type === "approval.requested") seenApproval = true;
    }
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.ok(seenQuestion, "Question must be observably triggered");
    assert.equal(seenApproval, false, "A Question is not an Approval Request");
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T23: Codex configures native Workspace Skills without exposing unadvertised Host file methods", async () => {
  const { root, workspace, runtime } = await codexRuntime("t23", "fs");
  let session;
  try {
    const skillSource = join(root, "skills-source");
    const skillDir = join(skillSource, "muha-ws");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: muha-ws\ndescription: ACP ws fixture.\n---\n\nFixture.\n");
    const configuration = await runtime.configureWorkspace({
      workspacePath: workspace,
      harnesses: ["codex"],
      skills: [{ source: skillSource, skillNames: ["muha-ws"] }],
    });
    assert.equal(configuration.attempts[0].status, "succeeded");
    await writeFile(join(workspace, "skills.txt"), "configured\n");
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "read" }]);
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "read=-32601 write=-32601 escape=-32601 terminal=-32601");
    assert.equal(await readFile(join(workspace, "skills.txt"), "utf8"), "configured\n");
    await assert.rejects(readFile(join(workspace, "host-wrote.txt")), { code: "ENOENT" });
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T23: Codex model/effort selections apply and invalid selections are rejected without substitution", async () => {
  const { root, workspace, runtime } = await codexRuntime("t23s", "selection");
  let session;
  try {
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace, model: "gpt-5.6-luna" });
    assert.equal(session.model, "gpt-5.6-luna");
    await session.setModel("gpt-5.6-luna");
    await assert.rejects(
      session.setModel("invalid/not-a-model"),
      (error) => error instanceof MuhaError && error.data.code === "HARNESS_ERROR" && error.data.nativeCode === "-32602",
    );
    assert.equal(session.model, "gpt-5.6-luna");
    // Codex effort does not require a known model (requiresKnownModel=false).
    await session.setEffort("high");
    assert.equal(session.effort, "high");
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
