import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { controlledPi, completedTurn, nativePi } from "./support/controlled-pi.mjs";

test("Pi lists native history and resumes its Reference in a new Runtime", async t => {
  const fixture = await controlledPi(t);
  let runtime = await fixture.runtime();
  assert.deepEqual(await runtime.listSessions({ harness: "pi", workspacePath: fixture.workspace }), []);
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  assert.equal((await completedTurn(session, "Remember the word apricot.")).result.status, "completed");
  const reference = JSON.parse(JSON.stringify(session.reference));
  await session.close();
  runtime = await fixture.runtime();
  const listed = await runtime.listSessions({ harness: "pi", workspacePath: fixture.workspace });
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].reference, reference);
  assert.equal(listed[0].title, undefined);
  assert.match(listed[0].createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.match(listed[0].updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const restored = await runtime.resumeSession({ reference, approvalPolicy: "autoApprove" });
  assert.equal((await completedTurn(restored, "What word?")).result.status, "completed");
  assert.ok(JSON.stringify(fixture.requests.at(-1).messages).includes("Remember the word apricot."));
});

test("Pi discovers external native sessions, tolerates damaged records and lists a deleted Workspace", async t => {
  const fixture = await controlledPi(t);
  const external = await nativePi(fixture, `
    const { appendFile } = await import("node:fs/promises");
    const manager = sdk.SessionManager.create(process.argv[1]);
    manager.appendModelChange("controlled", "controlled");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "external apricot" }], timestamp: 1700000000000 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "external answer" }], timestamp: 1700000001000,
      api: "openai-completions", provider: "controlled", model: "controlled", stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    manager.appendSessionInfo("Native name");
    await appendFile(manager.getSessionFile(), '{"type":"message",THIS_IS_CORRUPT}\\n');
    console.log(JSON.stringify({ id: manager.getSessionId() }));
  `);
  const runtime = await fixture.runtime();
  const listed = await runtime.listSessions({ harness: "pi", workspacePath: fixture.workspace });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].reference.sessionId, external.id);
  assert.equal(listed[0].title, "Native name");
  const restored = await runtime.resumeSession({ reference: listed[0].reference, approvalPolicy: "harnessManaged" });
  assert.equal((await completedTurn(restored, "Continue external history")).result.status, "completed");
  assert.ok(JSON.stringify(fixture.requests.at(-1).messages).includes("external apricot"));
  await restored.close();
  await rm(fixture.workspace, { recursive: true });
  assert.equal((await runtime.listSessions({ harness: "pi", workspacePath: fixture.workspace }))[0].reference.sessionId, external.id);
});

test("Pi rejects a missing native Session instead of creating a replacement", async t => {
  const fixture = await controlledPi(t);
  const runtime = await fixture.runtime();
  await assert.rejects(runtime.resumeSession({ reference: { harness: "pi", sessionId: "missing-session",
    workspacePath: fixture.workspace, route: "native" }, approvalPolicy: "autoApprove" }), error => error.data.code === "SESSION_NOT_FOUND");
  assert.deepEqual(await runtime.listSessions({ harness: "pi", workspacePath: fixture.workspace }), []);
});

test("Pi cannot recover a native Session through a different Workspace reference", async t => {
  const fixture = await controlledPi(t);
  const other = join(fixture.root, "other");
  await mkdir(other);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  await completedTurn(session, "Persist a workspace-bound conversation");
  const reference = { ...session.reference, workspacePath: other };
  await session.close();
  await assert.rejects(runtime.resumeSession({ reference, approvalPolicy: "autoApprove" }), error => error.data.code === "SESSION_NOT_FOUND");
  assert.deepEqual(await runtime.listSessions({ harness: "pi", workspacePath: other }), []);
  assert.equal((await runtime.listSessions({ harness: "pi", workspacePath: fixture.workspace })).length, 1);
});

for (const [field, value] of [["id", "../invalid-id"], ["cwd", "relative-workspace"], ["timestamp", "not-a-date"]]) {
  test(`Pi rejects a returned native Session with malformed ${field} as a protocol error`, async t => {
    const fixture = await controlledPi(t);
    const runtime = await fixture.runtime();
    const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
      model: "controlled/controlled", approvalPolicy: "autoApprove" });
    await completedTurn(session, "Persist the native metadata fixture");
    await session.close();
    await nativePi(fixture, `
      const { readFile, writeFile } = await import("node:fs/promises");
      const [row] = await sdk.SessionManager.list(process.argv[1]);
      const lines = (await readFile(row.path, "utf8")).split("\\n");
      const header = JSON.parse(lines[0]); header[${JSON.stringify(field)}] = ${JSON.stringify(value)};
      lines[0] = JSON.stringify(header); await writeFile(row.path, lines.join("\\n"));
      console.log("null");
    `);
    await assert.rejects(runtime.listSessions({ harness: "pi", workspacePath: fixture.workspace }), error => error.data.code === "ADAPTER_PROTOCOL_ERROR");
    assert.equal(runtime.status, "active");
  });
}
