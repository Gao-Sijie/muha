// Historical v1 SSE contract. Retained for archaeology; v2 stream behavior has separate coverage.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("an idle OpenCode Workspace stream reconnects before accepting the next Turn", async () => {
  const fixture = await createFixture("idle-disconnect");
  let session;
  let turn;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    await waitForEvidence(fixture.evidenceFile, ({ streamDisconnects }) => streamDisconnects === 1);

    turn = await session.startTurn([{ type: "text", text: "Reconnect first." }]);
    const result = await withDeadline(turn.result, 1_000, "reconnected Turn did not finish");
    assert.equal(result.status, "completed");

    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.equal(evidence.streamConnections, 2);
    assert.equal(evidence.unauthorizedRequests, 0);
    assert.equal(
      evidence.requests
        .filter(({ path }) => path !== "/global/health")
        .every(({ directory }) => directory === fixture.workspace),
      true,
    );
  } finally {
    if (turn && (await Promise.race([
      turn.result.then(() => true),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 20)),
    ])) === false) {
      await turn.interrupt();
    }
    await session?.close();
    await fixture.close();
  }
});

test("an active OpenCode stream disconnect fails closed without rebinding the native Session", async () => {
  const fixture = await createFixture("active-disconnect");
  let session;
  let resumed;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    const reference = session.reference;
    const turn = await session.startTurn([{ type: "text", text: "Disconnect while waiting." }]);
    const events = [];
    for await (const event of turn) events.push(event);

    const approval = events.find(({ type }) => type === "approval.requested");
    const question = events.find(({ type }) => type === "question.requested");
    assert.ok(approval);
    assert.ok(question);
    assert.deepEqual(
      events.filter(({ type }) => type === "approval.resolved").map(({ requestId, outcome, source }) => ({
        requestId,
        outcome,
        source,
      })),
      [{ requestId: approval.requestId, outcome: "invalidated", source: "turn" }],
    );
    assert.deepEqual(
      events.filter(({ type }) => type === "question.resolved").map(({ requestId, outcome, source }) => ({
        requestId,
        outcome,
        source,
      })),
      [{ requestId: question.requestId, outcome: "invalidated", source: "turn" }],
    );
    const terminal = events.at(-1);
    assert.equal(terminal.type, "turn.failed");
    assert.equal(terminal.error.code, "ADAPTER_PROTOCOL_ERROR");
    assert.equal((await turn.result).status, "failed");
    assert.deepEqual(session.status, { status: "closed" });
    await assert.rejects(
      session.startTurn([{ type: "text", text: "This handle is closed." }]),
      (error) => error instanceof MuhaError && error.data.code === "SESSION_CLOSED",
    );

    const evidence = await waitForEvidence(fixture.evidenceFile, ({ aborts }) => aborts.length === 1);
    assert.deepEqual(evidence.aborts, [{ sessionID: reference.sessionId }]);
    assert.equal(
      evidence.requests.some(({ path }) => path === `/session/${reference.sessionId}/message`),
      false,
    );
    assert.equal(evidence.requests.some(({ path }) => path === "/global/event"), false);
    const diagnostics = new DatabaseSync(
      join(fixture.runtime.dataDir, "diagnostic-events.sqlite"),
      { readOnly: true },
    );
    try {
      const payloads = diagnostics.prepare(
        "SELECT payload_json FROM native_event_records WHERE harness = 'opencode'",
      ).all().map(({ payload_json }) => payload_json).join("\n");
      assert.equal(payloads.includes("authorization"), false);
      assert.equal(payloads.includes("Basic "), false);
      assert.equal(payloads.includes("opencode:"), false);
    } finally {
      diagnostics.close();
    }
    resumed = await fixture.runtime.resumeSession({ reference });
    assert.deepEqual(resumed.reference, reference);
    assert.deepEqual(resumed.status, { status: "idle" });
  } finally {
    await resumed?.close();
    await session?.close();
    await fixture.close();
  }
});

test("OpenCode cannot lose a disconnect between stream readiness and Turn acceptance", async () => {
  const fixture = await createFixture("accept-race-disconnect");
  let session;
  let turn;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    await waitForEvidence(fixture.evidenceFile, ({ streamDisconnects }) => streamDisconnects === 1);

    turn = await session.startTurn([{ type: "text", text: "Do not lose the disconnect." }]);
    const result = await withDeadline(turn.result, 1_000, "disconnect was lost before Turn acceptance");
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
    assert.deepEqual(session.status, { status: "closed" });
    const evidence = await waitForEvidence(fixture.evidenceFile, ({ aborts }) => aborts.length === 1);
    assert.equal(evidence.streamConnections, 2);
  } finally {
    if (turn && (await Promise.race([
      turn.result.then(() => true),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 20)),
    ])) === false) {
      await turn.interrupt();
    }
    await session?.close();
    await fixture.close();
  }
});

test("OpenCode shares and reference-counts one routed stream per canonical Workspace", async () => {
  const fixture = await createFixture("normal");
  const otherWorkspace = join(fixture.root, "other-workspace");
  const sessions = [];
  await mkdir(otherWorkspace);
  try {
    const first = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    const second = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    const other = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: otherWorkspace,
    });
    sessions.push(first, second, other);

    let evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.deepEqual(streamCountsByDirectory(evidence), {
      [fixture.workspace]: 1,
      [otherWorkspace]: 1,
    });

    const [firstTurn, secondTurn] = await Promise.all([
      first.startTurn([{ type: "text", text: "First Session." }]),
      second.startTurn([{ type: "text", text: "Second Session." }]),
    ]);
    const [firstResult, secondResult] = await Promise.all([firstTurn.result, secondTurn.result]);
    assert.equal(firstResult.status, "completed");
    assert.equal(secondResult.status, "completed");
    assert.notEqual(firstTurn.turnId, secondTurn.turnId);

    await first.close();
    const retainedTurn = await second.startTurn([{ type: "text", text: "Keep shared stream." }]);
    assert.equal((await retainedTurn.result).status, "completed");
    evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.equal(streamCountsByDirectory(evidence)[fixture.workspace], 1);

    await second.close();
    const replacement = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    sessions.push(replacement);
    evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.equal(streamCountsByDirectory(evidence)[fixture.workspace], 2);
    assert.equal(evidence.unauthorizedRequests, 0);
  } finally {
    await Promise.allSettled(sessions.map((session) => session.close()));
    await fixture.close();
  }
});

test("an idle OpenCode stream reconnects before accepting a model change", async () => {
  const fixture = await createFixture("idle-disconnect");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    await waitForEvidence(fixture.evidenceFile, ({ streamDisconnects }) => streamDisconnects === 1);

    await session.setModel("fake-provider/fake-high");
    assert.equal(session.model, "fake-provider/fake-high");
    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.equal(evidence.streamConnections, 2);
  } finally {
    await session?.close();
    await fixture.close();
  }
});

for (const selection of ["model", "effort"]) {
test(`OpenCode reconnects when the stream is lost during ${selection} validation`, async t => {
  const fetch = globalThis.fetch;
  let releaseDisconnected;
  const disconnected = new Promise(resolve => { releaseDisconnected = resolve; });
  let selecting = false;
  // Keep the real HTTP/SSE transport. Hold only the provider response until
  // its concurrent stream failure reaches the client's body reader.
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const response = await fetch(input, init);
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/event") {
      const body = response.body;
      return { status: response.status, body: (async function* () {
        try { yield* body; }
        finally { releaseDisconnected(); }
      })() };
    }
    if (pathname === "/provider" && selecting) await disconnected;
    return response;
  });
  const fixture = await createFixture("selection-disconnect");
  let session;
  try {
    session = await fixture.runtime.createSession({ harness: "opencode", workspacePath: fixture.workspace,
      ...(selection === "effort" ? { model: "fake-provider/fake-high" } : {}) });
    selecting = true;
    if (selection === "model") await session.setModel("fake-provider/fake-high");
    else await session.setEffort("max");
    assert.equal(session.model, "fake-provider/fake-high");
    if (selection === "effort") assert.equal(session.effort, "max");
    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.equal(evidence.streamConnections, 2);
    assert.equal(evidence.streamDisconnects, 1);
  } finally {
    await session?.close();
    await fixture.close();
  }
});
}

test("OpenCode resume compares the native Session directory by canonical Workspace identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-resume-alias-"));
  const workspace = join(root, "workspace");
  const alias = join(root, "workspace-alias");
  const otherWorkspace = join(root, "other-workspace");
  const sessionsFile = join(root, "sessions.json");
  let runtime;
  let session;
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace)]);
  await symlink(workspace, alias, "dir");
  await writeFile(sessionsFile, JSON.stringify([
    { id: "ses_alias", directory: alias },
    { id: "ses_other", directory: otherWorkspace },
  ]));
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: {
          PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_OPENCODE_SCENARIO: "resume-alias",
          MUHA_FAKE_OPENCODE_SESSIONS_FILE: sessionsFile,
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.resumeSession({
      reference: { harness: "opencode", sessionId: "ses_alias", workspacePath: workspace, route: "native" },
    });
    assert.equal(session.reference.workspacePath, workspace);
    await session.close();

    await assert.rejects(
      runtime.resumeSession({
        reference: { harness: "opencode", sessionId: "ses_other", workspacePath: workspace, route: "native" },
      }),
      (error) => error instanceof MuhaError && error.data.code === "ADAPTER_PROTOCOL_ERROR",
    );
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode list filters global and stale native Sessions to the requested Workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-global-list-"));
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  const sessionsFile = join(root, "sessions.json");
  let runtime;
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace)]);
  await writeFile(sessionsFile, JSON.stringify([
    { id: "ses_current", directory: workspace },
    { id: "ses_other", directory: otherWorkspace },
    { id: "ses_stale", directory: join(root, "deleted-workspace") },
  ]));
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: {
          PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_OPENCODE_SCENARIO: "global-list",
          MUHA_FAKE_OPENCODE_SESSIONS_FILE: sessionsFile,
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });

    const listed = await runtime.listSessions({ harness: "opencode", workspacePath: workspace });
    assert.deepEqual(listed.map(({ reference }) => reference.sessionId), ["ses_current"]);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode caller interrupt wins a native abort event that races ahead of its ACK", async () => {
  const fixture = await createFixture("abort-event-race");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    const turn = await session.startTurn([{ type: "text", text: "Run then interrupt." }]);
    let requested = false;
    for await (const event of turn) {
      if (event.type === "tool.started" && !requested) {
        requested = true;
        await turn.interrupt();
      }
    }
    assert.equal(requested, true);
    assert.deepEqual(await turn.result, {
      status: "interrupted",
      turnId: turn.turnId,
      reason: "caller",
    });
  } finally {
    await session?.close();
    await fixture.close();
  }
});

test("OpenCode restores the native terminal when the racing abort command is rejected", async () => {
  const fixture = await createFixture("abort-event-rejected");
  let session;
  try {
    session = await fixture.runtime.createSession({
      harness: "opencode",
      workspacePath: fixture.workspace,
    });
    const turn = await session.startTurn([{ type: "text", text: "Reject interrupt." }]);
    let interruptError;
    for await (const event of turn) {
      if (event.type === "tool.started" && interruptError === undefined) {
        try {
          await turn.interrupt();
        } catch (error) {
          interruptError = error;
        }
      }
    }
    assert.ok(interruptError instanceof MuhaError);
    assert.equal(interruptError.data.code, "HARNESS_ERROR");
    assert.equal(interruptError.data.operation, "interruptTurn");
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.nativeCode, "MessageAbortedError");
  } finally {
    await session?.close();
    await fixture.close();
  }
});

async function createFixture(scenario) {
  const root = await mkdtemp(join(tmpdir(), `muha-opencode-${scenario}-`));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({
    harnesses: [openCodeAdapter({
      env: {
        PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
        MUHA_FAKE_OPENCODE_SCENARIO: scenario,
        MUHA_FAKE_OPENCODE_EVIDENCE_FILE: evidenceFile,
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    })],
    dataDir: join(root, "diagnostics"),
  });
  return {
    root,
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
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const evidence = JSON.parse(await readFile(path, "utf8"));
      if (predicate(evidence)) return evidence;
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail("timed out waiting for Fake OpenCode evidence");
}

async function withDeadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function streamCountsByDirectory(evidence) {
  return Object.fromEntries(
    evidence.requests
      .filter(({ path }) => path === "/event")
      .reduce((counts, { directory }) => {
        counts.set(directory, (counts.get(directory) ?? 0) + 1);
        return counts;
      }, new Map()),
  );
}
