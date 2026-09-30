import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("an unconsumed Turn fails at the event-count bound without result auto-drain", async () => {
  const fixture = await createFixture("burst-alternating", {
    maxQueuedEventsPerTurn: 2,
    maxQueuedEventBytesPerTurn: 1024 * 1024,
  });
  try {
    const turn = await fixture.session.startTurn([{ type: "text", text: "burst" }]);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "TURN_EVENT_BACKPRESSURE");

    const events = [];
    for await (const event of turn) events.push(event);
    assert.deepEqual(events.map(({ type }) => type), [
      "turn.started",
      "assistant.message.started",
      "turn.failed",
    ]);
    assert.equal(events.at(-1).error.code, "TURN_EVENT_BACKPRESSURE");
    assert.equal(events.at(-1).sequence, 3);
    assert.equal(await eventuallyRead(fixture.interruptCountFile), "1");
    const coreRecords = readCoreRecords(fixture.runtime.dataDir);
    assert.equal(
      coreRecords.filter(({ error }) => error?.code === "TURN_EVENT_BACKPRESSURE").length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("a draining consumer succeeds with a one-event backlog budget", async () => {
  const fixture = await createFixture("burst-alternating", {
    maxQueuedEventsPerTurn: 1,
    maxQueuedEventBytesPerTurn: 1024 * 1024,
  }, { turnDelayMs: 25 });
  try {
    const turn = await fixture.session.startTurn([{ type: "text", text: "drain" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).status, "completed");
    assert.equal(events.at(-1).type, "turn.completed");
    assert.equal(events.filter(({ type }) => type.startsWith("turn.") && type !== "turn.started").length, 1);
    assert.deepEqual(
      events.map(({ sequence }) => sequence),
      events.map((_, index) => index + 1),
    );
  } finally {
    await fixture.close();
  }
});

test("adjacent compatible deltas coalesce losslessly without sequence gaps", async () => {
  const fixture = await createFixture("burst-coalescible", {
    maxQueuedEventsPerTurn: 4,
    maxQueuedEventBytesPerTurn: 1024 * 1024,
  });
  try {
    const turn = await fixture.session.startTurn([{ type: "text", text: "coalesce" }]);
    assert.equal((await turn.result).status, "completed");
    const events = [];
    for await (const event of turn) events.push(event);
    assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(events.map(({ type }) => type), [
      "turn.started",
      "assistant.message.started",
      "assistant.message.delta",
      "assistant.message.completed",
      "turn.completed",
    ]);
    assert.equal(events[2].delta, "0123456789");
  } finally {
    await fixture.close();
  }
});

test("coalesced UTF-8 bytes trigger backpressure without truncating accepted deltas", async () => {
  const fixture = await createFixture("burst-coalescible-utf8", {
    maxQueuedEventsPerTurn: 100,
    maxQueuedEventBytesPerTurn: 600,
  });
  try {
    const turn = await fixture.session.startTurn([{ type: "text", text: "byte backlog" }]);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "TURN_EVENT_BACKPRESSURE");
    const events = [];
    for await (const event of turn) events.push(event);
    const deltas = events.filter(({ type }) => type === "assistant.message.delta");
    assert.equal(deltas.length, 1);
    assert.equal("😀".repeat(200).startsWith(deltas[0].delta), true);
    assert.equal(deltas[0].delta.length > 0, true);
    assert.deepEqual(
      events.map(({ sequence }) => sequence),
      events.map((_, index) => index + 1),
    );
    assert.equal(events.at(-1).type, "turn.failed");
  } finally {
    await fixture.close();
  }
});

test("one oversized UTF-8 event fails intact while its full native payload remains durable", async () => {
  const fixture = await createFixture("oversize-delta", {
    maxQueuedEventsPerTurn: 100,
    maxQueuedEventBytesPerTurn: 512,
  }, { turnDelayMs: 25 });
  try {
    const turn = await fixture.session.startTurn([{ type: "text", text: "oversize" }]);
    const iterator = turn[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, "turn.started");
    assert.equal((await iterator.next()).value.type, "assistant.message.started");
    const terminal = (await iterator.next()).value;
    assert.equal(terminal.type, "turn.failed");
    assert.equal(terminal.error.code, "TURN_EVENT_TOO_LARGE");
    assert.equal((await turn.result).error.code, "TURN_EVENT_TOO_LARGE");
    assert.equal((await iterator.next()).done, true);

    const database = new DatabaseSync(
      join(fixture.runtime.dataDir, "diagnostic-events.sqlite"),
      { readOnly: true },
    );
    try {
      const records = database
        .prepare("SELECT payload_json FROM native_event_records ORDER BY record_id")
        .all()
        .map(({ payload_json }) => JSON.parse(payload_json));
      const nativeDelta = records.find(
        ({ method }) => method === "item/agentMessage/delta",
      );
      assert.equal(nativeDelta.params.delta, `oversize-${"😀".repeat(300)}`);
    } finally {
      database.close();
    }
  } finally {
    await fixture.close();
  }
});

async function createFixture(scenario, queueLimits, options = {}) {
  const root = await mkdtemp(join(tmpdir(), `muha-${scenario}-`));
  const workspace = join(root, "workspace");
  const interruptCountFile = join(root, "interrupt-count");
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
            ...(options.turnDelayMs === undefined
              ? {}
              : { MUHA_FAKE_TURN_DELAY_MS: String(options.turnDelayMs) }),
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: join(root, "diagnostics"),
      ...queueLimits,
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    return {
      root,
      runtime,
      session,
      interruptCountFile,
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

function readCoreRecords(dataDir) {
  const database = new DatabaseSync(join(dataDir, "diagnostic-events.sqlite"), {
    readOnly: true,
  });
  try {
    return database
      .prepare("SELECT payload_json FROM core_event_records ORDER BY record_id")
      .all()
      .map(({ payload_json }) => JSON.parse(payload_json));
  } finally {
    database.close();
  }
}

async function eventuallyRead(path) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
