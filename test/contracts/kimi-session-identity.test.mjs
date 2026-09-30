import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Kimi resume compares native cwd by canonical Workspace identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-kimi-session-alias-"));
  const workspace = join(root, "workspace");
  const workspaceAlias = join(root, "workspace-alias");
  const sessionsFile = join(root, "sessions.json");
  let runtime;
  let session;
  try {
    await mkdir(workspace);
    await symlink(workspace, workspaceAlias, "dir");
    const canonicalWorkspace = await realpath(workspace);
    await writeFile(sessionsFile, JSON.stringify([{
      id: "session_alias",
      workspacePath: workspaceAlias,
      model: "fake-default",
    }]));
    runtime = await createMuhaRuntime({
      harnesses: [kimiAdapter({
        env: {
          PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_KIMI_SESSIONS_FILE: sessionsFile,
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.resumeSession({
      reference: {
        harness: "kimi",
        sessionId: "session_alias",
        workspacePath: canonicalWorkspace,
        route: "native",
      },
    });
    assert.deepEqual(session.reference, {
      harness: "kimi",
      sessionId: "session_alias",
      workspacePath: canonicalWorkspace,
      route: "native",
    });
    assert.equal(session.model, "fake-default");
    await assert.rejects(
      session.setModel("fake/missing"),
      (error) =>
        error instanceof MuhaError &&
        error.data.code === "HARNESS_ERROR" &&
        error.data.nativeCode === "model_not_found",
    );
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
