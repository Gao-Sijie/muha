import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Turn Handle is single-consumer and result does not consume its events", async () => {
  const fixture = await createFixture("default");
  try {
    const turn = await fixture.session.startTurn([{ type: "text", text: "complete" }]);
    const result = await turn.result;
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal(events.at(-1).type, "turn.completed");
    assert.equal(result.status, "completed");
    assert.throws(
      () => turn[Symbol.asyncIterator](),
      (error) => error instanceof MuhaError && error.data.code === "TURN_EVENT_STREAM_ALREADY_CLAIMED",
    );

    const early = await fixture.session.startTurn([{ type: "text", text: "leave early" }]);
    for await (const _event of early) break;
    assert.equal((await early.result).status, "completed");
    await assert.rejects(access(fixture.interruptCountFile));
  } finally {
    await fixture.close();
  }
});

test("concurrent startTurn has one native winner and no hidden Harness queue", async () => {
  const fixture = await createFixture("held", { acceptDelayMs: 50 });
  try {
    const firstPromise = fixture.session.startTurn([{ type: "text", text: "first" }]);
    await assert.rejects(
      fixture.session.startTurn([{ type: "text", text: "second" }]),
      (error) => error instanceof MuhaError && error.data.code === "SESSION_BUSY",
    );
    const first = await firstPromise;
    assert.deepEqual(fixture.session.status, { status: "running", turnId: first.turnId });
    assert.equal(await readFile(fixture.turnCountFile, "utf8"), "1");
    await first.interrupt();
    assert.equal((await first.result).reason, "caller");
    assert.deepEqual(fixture.session.status, { status: "idle" });
  } finally {
    await fixture.close();
  }
});

test("caller interrupt is idempotent and wins an accepted held Turn", async () => {
  const fixture = await createFixture("held");
  try {
    const turn = await fixture.session.startTurn([{ type: "text", text: "hold" }]);
    await Promise.all([turn.interrupt(), turn.interrupt(), turn.interrupt()]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.deepEqual(events.at(-1), {
      type: "turn.interrupted",
      turnId: turn.turnId,
      sequence: 2,
      timestamp: events.at(-1).timestamp,
      reason: "caller",
    });
    assert.deepEqual(await turn.result, {
      status: "interrupted",
      turnId: turn.turnId,
      reason: "caller",
    });
    assert.equal(await readFile(fixture.interruptCountFile, "utf8"), "1");
  } finally {
    await fixture.close();
  }
});

test("a rejected interrupt command does not decide the accepted Turn", async () => {
  const fixture = await createFixture("held-interrupt-rejected");
  try {
    const turn = await fixture.session.startTurn([{ type: "text", text: "reject interrupt" }]);
    await assert.rejects(
      turn.interrupt(),
      (error) =>
        error instanceof MuhaError &&
        error.data.code === "HARNESS_ERROR" &&
        error.data.nativeCode === "interrupt_rejected",
    );
    assert.deepEqual(fixture.session.status, { status: "running", turnId: turn.turnId });
    await fixture.session.close();
    assert.equal((await turn.result).reason, "sessionClosed");
    assert.equal(await readFile(fixture.interruptCountFile, "utf8"), "1");
  } finally {
    await fixture.close();
  }
});

test("Session close and Runtime close assign their own interruption reasons", async () => {
  const sessionFixture = await createFixture("held", { persistNativeSession: true });
  try {
    const turn = await sessionFixture.session.startTurn([{ type: "text", text: "session close" }]);
    await sessionFixture.session.close();
    assert.equal((await turn.result).reason, "sessionClosed");
    assert.deepEqual(sessionFixture.session.status, { status: "closed" });
    assert.equal(JSON.parse(await readFile(sessionFixture.nativeSessionsFile, "utf8")).length, 1);
  } finally {
    await sessionFixture.close();
  }

  const runtimeFixture = await createFixture("held");
  try {
    const turn = await runtimeFixture.session.startTurn([{ type: "text", text: "runtime close" }]);
    await runtimeFixture.runtime.close();
    assert.equal((await turn.result).reason, "runtimeClosed");
    assert.equal(runtimeFixture.runtime.status, "closed");
  } finally {
    await runtimeFixture.close();
  }
});

async function createFixture(
  scenario,
  { acceptDelayMs, persistNativeSession = false } = {},
) {
  const root = await mkdtemp(join(tmpdir(), `muha-turn-control-${scenario}-`));
  const workspace = join(root, "workspace");
  const interruptCountFile = join(root, "interrupt-count");
  const turnCountFile = join(root, "turn-count");
  const nativeSessionsFile = join(root, "native-sessions.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_TURN_SCENARIO: scenario,
            MUHA_FAKE_INTERRUPT_COUNT_FILE: interruptCountFile,
            MUHA_FAKE_TURN_REQUEST_COUNT_FILE: turnCountFile,
            ...(acceptDelayMs === undefined ? {} : { MUHA_FAKE_TURN_ACCEPT_DELAY_MS: String(acceptDelayMs) }),
            ...(persistNativeSession ? { MUHA_FAKE_NATIVE_SESSIONS_FILE: nativeSessionsFile } : {}),
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    return {
      root,
      runtime,
      session,
      interruptCountFile,
      turnCountFile,
      nativeSessionsFile,
      close: async () => {
        await session.close();
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
