import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { agyAdapter } from "@muha-sdk/agy-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const fakeBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("AGY creates an independent Workspace-bound Session and preserves ordered text across Turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-text-"));
  const workspace = join(root, "workspace");
  const alias = join(root, "workspace-alias");
  let runtime;
  await mkdir(workspace);
  await symlink(workspace, alias);
  await writeFile(join(workspace, "source.txt"), "workspace-evidence");
  try {
    runtime = await createMuhaRuntime({
      dataDir: join(root, "diagnostics"),
      harnesses: [agyAdapter({
        env: { HOME: join(root, "native-home"), PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_AGY_EVIDENCE: join(root, "native-arguments.json") },
        startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
      })],
    });
    const session = await runtime.createSession({
      harness: "agy", workspacePath: alias, approvalPolicy: "harnessManaged", model: "fake-opus",
    });
    assert.equal(session.reference.workspacePath, workspace);
    assert.equal(session.model, "fake-opus");
    const turn = await session.startTurn([{ type: "text", text: "Read " }, { type: "text", text: "workspace." }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).message.text, "workspace-evidence");
    assert.equal(JSON.parse(await readFile(join(root, "native-arguments.json"), "utf8")).printTimeout, "60m");
    assert.deepEqual(events.filter(event => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type))
      .map(event => event.type), ["turn.completed"]);
    const followup = await session.startTurn([{ type: "text", text: "Recall my previous input." }]);
    assert.equal((await followup.result).message.text, "Read workspace.");
    const other = await runtime.createSession({ harness: "agy", workspacePath: workspace, approvalPolicy: "harnessManaged" });
    assert.notEqual(other.reference.sessionId, session.reference.sessionId);
    await other.close();
    await session.close();
    assert.deepEqual(session.status, { status: "closed" });
    assert.equal(await readFile(join(workspace, "source.txt"), "utf8"), "workspace-evidence");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
