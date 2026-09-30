import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { controlledPi, completedTurn } from "./support/controlled-pi.mjs";

test("Pi model and effort selections take effect without changing persistent defaults", async t => {
  const fixture = await controlledPi(t);
  const settingsPath = join(fixture.agentDir, "settings.json");
  const original = JSON.stringify({ defaultProvider: "controlled", defaultModel: "controlled",
    defaultThinkingLevel: "low", retry: { enabled: true }, compaction: { enabled: false } });
  await writeFile(settingsPath, original);
  let runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", effort: "medium", approvalPolicy: "autoApprove" });
  assert.equal(session.model, "controlled/controlled");
  assert.equal(session.effort, "medium");
  await session.setModel("controlled/next");
  assert.equal(session.model, "controlled/next");
  assert.equal(session.effort, undefined);
  await session.setEffort("high");
  assert.equal(session.effort, "high");
  assert.equal((await completedTurn(session, "Use the chosen model")).result.status, "completed");
  assert.equal(fixture.requests.at(-1).model, "next");
  const reference = session.reference;
  runtime = await fixture.runtime();
  const restored = await runtime.resumeSession({ reference, model: "controlled/controlled", effort: "low",
    approvalPolicy: "autoApprove" });
  assert.equal(restored.model, "controlled/controlled");
  assert.equal(restored.effort, "low");
  assert.equal((await completedTurn(restored, "Use the resumed selection")).result.status, "completed");
  assert.equal(fixture.requests.at(-1).model, "controlled");
  await runtime.close();
  assert.equal(await readFile(settingsPath, "utf8"), original);
});

test("Pi rejects an explicit model selection changed by a native Session-start extension", async t => {
  const fixture = await controlledPi(t);
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "selection.ts"), `
    export default pi => pi.on("session_start", async (_event, ctx) => {
      await pi.setModel({ ...ctx.model, id: "next", name: "next" });
    });
  `);
  const runtime = await fixture.runtime();
  await assert.rejects(runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" }), error => error.data.code === "HARNESS_ERROR");
  assert.equal(runtime.status, "active");
  assert.equal(fixture.requests.length, 0);
});

test("Pi Session selections stay isolated across shared and separate Workspaces, including rejected setters", async t => {
  const fixture = await controlledPi(t);
  const other = join(fixture.root, "other-workspace");
  await mkdir(other);
  const runtime = await fixture.runtime();
  const sessions = [];
  for (const workspacePath of [fixture.workspace, fixture.workspace, other]) {
    sessions.push(await runtime.createSession({ harness: "pi", workspacePath,
      model: "controlled/controlled", effort: "low", approvalPolicy: "autoApprove" }));
  }
  await sessions[0].setModel("controlled/next");
  await sessions[0].setEffort("high");
  await assert.rejects(sessions[0].setModel("controlled/not-registered"), error => error.data.code === "HARNESS_ERROR");
  await assert.rejects(sessions[0].setEffort("not-an-effort"), error => error.data.code === "HARNESS_ERROR");
  assert.equal(sessions[0].model, "controlled/next");
  assert.equal(sessions[0].effort, "high");
  for (const session of sessions) assert.equal((await completedTurn(session, "Observe actual selection")).result.status, "completed");
  assert.deepEqual(fixture.requests.map(request => request.model), ["next", "controlled", "controlled"]);
  assert.deepEqual(fixture.requests.map(request => request.reasoning_effort), ["high", "low", "low"]);
});
