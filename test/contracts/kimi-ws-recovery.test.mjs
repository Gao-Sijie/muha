import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Kimi reconnects with a durable cursor, deduplicates replay, and hides transport activity", async () => {
  const fixture = await createFixture("ws-recover");
  let session;
  try {
    session = await fixture.runtime.createSession({ harness: "kimi", workspacePath: fixture.workspace });
    const turn = await session.startTurn([{ type: "text", text: "Recover." }]);
    const events = [];
    for await (const event of turn) events.push(event);

    assert.equal((await turn.result).status, "completed");
    assert.deepEqual(events.map(({ type }) => type), [
      "turn.started",
      "assistant.message.started",
      "assistant.message.delta",
      "usage.updated",
      "assistant.message.completed",
      "turn.completed",
    ]);
    assert.equal(events.find(({ type }) => type === "assistant.message.completed").message.text, "Recovered.");
    assert.equal(events.filter(({ type }) => type === "turn.completed").length, 1);
    assert.equal(events.some(({ type }) => type.includes("connection")), false);

    const evidence = await waitForEvidence(fixture.evidenceFile, ({ subscriptions }) => subscriptions.length === 2);
    assert.equal(evidence.authenticatedWebSockets, 2);
    assert.deepEqual(evidence.subscriptions[1].cursors, {
      [session.reference.sessionId]: { seq: 1, epoch: "fake-epoch" },
    });
  } finally {
    await session?.close();
    await fixture.close();
  }
});

for (const scenario of ["ws-resync", "ws-permanent"]) {
  test(`Kimi ${scenario} fails one active Turn without forging a native terminal`, async () => {
    const fixture = await createFixture(scenario);
    let session;
    try {
      session = await fixture.runtime.createSession({ harness: "kimi", workspacePath: fixture.workspace });
      const turn = await session.startTurn([{ type: "text", text: "Fail closed." }]);
      const events = [];
      for await (const event of turn) events.push(event);

      const terminal = events.filter(({ type }) =>
        type === "turn.completed" || type === "turn.failed" || type === "turn.interrupted");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].type, "turn.failed");
      assert.equal(
        terminal[0].error.code,
        scenario === "ws-resync" ? "ADAPTER_PROTOCOL_ERROR" : "HARNESS_ERROR",
      );
      assert.equal((await turn.result).status, "failed");
      if (scenario === "ws-permanent") {
        const termination = await fixture.runtime.termination;
        assert.equal(termination.reason, "fatal");
        assert.equal(termination.error.code, "HARNESS_ERROR");
      }
      assert.deepEqual(session.status, { status: "closed" });
      await assert.rejects(
        session.startTurn([{ type: "text", text: "Closed." }]),
        (error) => error instanceof MuhaError && error.data.code === "SESSION_CLOSED",
      );
    } finally {
      await session?.close();
      await fixture.close();
    }
  });
}

async function createFixture(scenario) {
  const root = await mkdtemp(join(tmpdir(), `muha-kimi-${scenario}-`));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({
    harnesses: [kimiAdapter({
      env: {
        PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
        MUHA_FAKE_KIMI_SCENARIO: scenario,
        MUHA_FAKE_KIMI_EVIDENCE_FILE: evidenceFile,
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    })],
    dataDir: join(root, "diagnostics"),
  });
  return {
    workspace,
    evidenceFile,
    runtime,
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitForEvidence(path, predicate) {
  const deadline = Date.now() + 1_000;
  for (;;) {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for Kimi evidence");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
