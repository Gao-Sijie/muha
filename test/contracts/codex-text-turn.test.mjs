import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("a caller can stream one durable Codex text Turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-turn-contract-"));
  const workspace = join(root, "workspace");
  const workspaceAlias = join(root, "workspace-link");
  const nativeSessionsFile = join(root, "codex-native-sessions.json");
  const turnAcceptedFile = join(root, "codex-turn-accepted");
  let runtime;
  let session;

  await mkdir(workspace);
  await symlink(workspace, workspaceAlias, "dir");

  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_NATIVE_SESSIONS_FILE: nativeSessionsFile,
            MUHA_FAKE_TURN_ACCEPTED_FILE: turnAcceptedFile,
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: join(root, "diagnostics"),
    });

    session = await runtime.createSession({
      harness: "codex",
      workspacePath: workspaceAlias,
    });
    assert.deepEqual(session.reference, {
      harness: "codex",
      sessionId: "thread_fake_1",
      workspacePath: await realpath(workspace),
      route: "native",
    });
    assert.equal(session.model, "fake-default");
    assert.deepEqual(session.status, { status: "idle" });

    const turn = await session.startTurn([
      { type: "text", text: "Say hello." },
    ]);
    await access(turnAcceptedFile);
    assert.match(turn.turnId, /^[0-9a-f-]{36}$/);

    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;

    assert.deepEqual(
      events.map(({ type, sequence }) => [type, sequence]),
      [
        ["turn.started", 1],
        ["assistant.message.started", 2],
        ["assistant.message.delta", 3],
        ["assistant.message.completed", 4],
        ["turn.completed", 5],
      ],
    );
    for (const event of events) {
      assert.equal(event.turnId, turn.turnId);
      assert.equal(Number.isNaN(Date.parse(event.timestamp)), false);
      assert.equal("harness" in event, false);
      assert.equal("workspacePath" in event, false);
      assert.equal("nativeId" in event, false);
    }

    const started = events[1];
    const delta = events[2];
    const messageCompleted = events[3];
    const turnCompleted = events[4];
    assert.equal(delta.messageId, started.messageId);
    assert.equal(delta.delta, "Hello from Codex.");
    assert.deepEqual(messageCompleted.message, {
      id: started.messageId,
      text: "Hello from Codex.",
    });
    assert.deepEqual(turnCompleted.message, messageCompleted.message);
    assert.deepEqual(result, {
      status: "completed",
      turnId: turn.turnId,
      message: messageCompleted.message,
    });
    assert.deepEqual(session.status, { status: "idle" });

    // This is an implementation-level provenance assertion; the SQLite schema
    // remains private and is not a supported caller API.
    const diagnostics = new DatabaseSync(
      join(runtime.dataDir, "diagnostic-events.sqlite"),
      { readOnly: true },
    );
    try {
      const records = diagnostics
        .prepare(
          "SELECT payload_json FROM native_event_records WHERE harness = ? ORDER BY record_id",
        )
        .all("codex")
        .map(({ payload_json }) => JSON.parse(payload_json));
      assert.equal(records.some(({ id, result }) => id === 1 && result), true);
      assert.equal(records.some(({ method }) => method === "turn/started"), true);
      assert.equal(records.some(({ method }) => method === "item/started"), true);
      assert.equal(
        records.filter(({ method }) => method === "item/agentMessage/delta").length,
        2,
      );
      assert.equal(records.some(({ method }) => method === "item/completed"), true);
      assert.equal(records.some(({ method }) => method === "turn/completed"), true);
      assert.equal(
        records.some(({ method }) => ["initialize", "initialized", "turn/start"].includes(method)),
        false,
      );
    } finally {
      diagnostics.close();
    }

    await session.close();
    assert.deepEqual(session.status, { status: "closed" });
    assert.deepEqual(JSON.parse(await readFile(nativeSessionsFile, "utf8")), [
      {
        id: "thread_fake_1",
        workspacePath: await realpath(workspace),
        model: "fake-default",
      },
    ]);
    await runtime.close();
    await access(nativeSessionsFile);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected Codex command returns no accepted Turn Handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-rejected-turn-contract-"));
  const workspace = join(root, "workspace");
  const turnAcceptedFile = join(root, "codex-turn-accepted");
  let runtime;
  let session;

  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_TURN_ACCEPTED_FILE: turnAcceptedFile,
            MUHA_FAKE_TURN_REJECT: "1",
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });

    await assert.rejects(
      session.startTurn([{ type: "text", text: "Reject this." }]),
      (error) => {
        assert.equal(error instanceof MuhaError, true);
        assert.deepEqual(error.data, {
          code: "HARNESS_ERROR",
          message: "Codex rejected startTurn",
          harness: "codex",
          operation: "startTurn",
          command: "codex",
          nativeCode: "fake_rejected",
        });
        return true;
      },
    );
    await assert.rejects(access(turnAcceptedFile));
    assert.deepEqual(session.status, { status: "idle" });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
