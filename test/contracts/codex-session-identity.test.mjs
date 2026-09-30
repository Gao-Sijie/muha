import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Codex resume waits through an explicit native closing rejection without replacing the Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-resume-closing-"));
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({ env: {
        PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
        MUHA_FAKE_CODEX_SCENARIO: "resume-closing",
        MUHA_FAKE_NATIVE_SESSIONS_FILE: join(root, "native-sessions.json"),
      }, startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000 })],
      dataDir: join(root, "diagnostics"),
    });
    const session = await runtime.createSession({ harness: "codex", workspacePath: root, approvalPolicy: "autoApprove" });
    const reference = session.reference;
    await session.close();
    const resumed = await runtime.resumeSession({ reference, approvalPolicy: "autoDeny" });
    assert.deepEqual(resumed.reference, reference);
    assert.equal((await runtime.listSessions({ harness: "codex", workspacePath: root })).length, 1);
    await resumed.close();
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime close preempts Codex resume waiting for native unload", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-unload-close-"));
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({ env: {
        PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
        MUHA_FAKE_CODEX_SCENARIO: "resume-closing-forever",
        MUHA_FAKE_NATIVE_SESSIONS_FILE: join(root, "native-sessions.json"),
      }, startupTimeoutMs: 2_000, shutdownTimeoutMs: 200 })],
      dataDir: join(root, "diagnostics"),
    });
    const session = await runtime.createSession({ harness: "codex", workspacePath: root });
    const reference = session.reference;
    await session.close();
    const resuming = runtime.resumeSession({ reference });
    const outcome = resuming.then(() => "unexpectedly resumed", (error) => error.data?.code);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.close();
    assert.equal(await outcome, "RUNTIME_CLOSED");
    assert.equal(runtime.status, "closed");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Sessions remain native, listable, resumable, and model-selectable", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-session-identity-"));
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  const missingWorkspace = join(root, "missing-workspace");
  const nativeSessionsFile = join(root, "codex-native-sessions.json");
  const turnRequestFile = join(root, "turn-request.json");
  const dataDir = join(root, "diagnostics");
  let runtime;
  let session;

  await mkdir(workspace);
  await mkdir(otherWorkspace);
  const canonicalWorkspace = await realpath(workspace);
  const canonicalOtherWorkspace = await realpath(otherWorkspace);
  await writeFile(
    nativeSessionsFile,
    JSON.stringify([
      {
        id: "thread_external_1",
        workspacePath: canonicalWorkspace,
        title: "External one",
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_100,
        model: "fake-default",
      },
      {
        id: "thread_external_2",
        workspacePath: canonicalWorkspace,
        createdAt: 1_700_000_200,
        updatedAt: 1_700_000_200,
      },
      { id: "thread_other", workspacePath: canonicalOtherWorkspace },
      { id: "thread_missing", workspacePath: missingWorkspace },
    ]),
  );

  const createRuntime = () =>
    createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_NATIVE_SESSIONS_FILE: nativeSessionsFile,
            MUHA_FAKE_TURN_REQUEST_FILE: turnRequestFile,
            MUHA_FAKE_TURN_DELAY_MS: "50",
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir,
    });

  try {
    runtime = await createRuntime();
    const listed = await runtime.listSessions({
      harness: "codex",
      workspacePath: canonicalWorkspace,
    });
    assert.deepEqual(listed, [
      {
        reference: {
          harness: "codex",
          sessionId: "thread_external_1",
          workspacePath: canonicalWorkspace,
          route: "native",
        },
        title: "External one",
        createdAt: "2023-11-14T22:13:20.000Z",
        updatedAt: "2023-11-14T22:15:00.000Z",
      },
      {
        reference: {
          harness: "codex",
          sessionId: "thread_external_2",
          workspacePath: canonicalWorkspace,
          route: "native",
        },
        createdAt: "2023-11-14T22:16:40.000Z",
        updatedAt: "2023-11-14T22:16:40.000Z",
      },
    ]);

    session = await runtime.resumeSession({ reference: listed[0].reference });
    assert.deepEqual(session.reference, listed[0].reference);
    assert.equal(session.model, "fake-default");
    await assert.rejects(
      session.setModel("not-in-native-catalog"),
      (error) => error instanceof MuhaError && error.data.code === "HARNESS_ERROR",
    );
    assert.equal(session.model, "fake-default");
    await session.setModel("fake-high");
    assert.equal(session.model, "fake-high");
    const turn = await session.startTurn([{ type: "text", text: "Use the selected model." }]);
    assert.deepEqual(session.status, { status: "running", turnId: turn.turnId });
    await assert.rejects(
      session.setModel("fake-default"),
      (error) => error instanceof MuhaError && error.data.code === "SESSION_BUSY",
    );
    await turn.result;
    assert.equal(JSON.parse(await readFile(turnRequestFile, "utf8")).model, "fake-high");
    await session.close();
    await session.close();
    await assert.rejects(
      session.setModel("fake-default"),
      (error) => error instanceof MuhaError && error.data.code === "SESSION_CLOSED",
    );
    await runtime.close();
    runtime = undefined;

    runtime = await createRuntime();
    session = await runtime.resumeSession({ reference: listed[0].reference });
    assert.equal(session.model, "fake-high");
    await session.close();

    const missingReference = {
      route: "native",
      harness: "codex",
      sessionId: "thread_missing",
      workspacePath: missingWorkspace,
    };
    const listedMissing = await runtime.listSessions({
      harness: "codex",
      workspacePath: missingWorkspace,
    });
    assert.deepEqual(listedMissing.map(({ reference }) => reference), [
      missingReference,
    ]);
    await assert.rejects(
      runtime.resumeSession({ reference: missingReference }),
      (error) => error instanceof MuhaError && error.data.code === "WORKSPACE_NOT_FOUND",
    );
    await assert.rejects(access(missingWorkspace));
    session = await runtime.resumeSession({
      reference: missingReference,
      createWorkspaceIfMissing: true,
    });
    await access(missingWorkspace);
    assert.deepEqual(session.reference, {
      ...missingReference,
      route: "native",
    });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
