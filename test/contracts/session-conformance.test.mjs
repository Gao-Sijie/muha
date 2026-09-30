import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { createConformanceProfiles } from "../support/official-harness-profiles.mjs";
import { piConformance } from "../support/pi-conformance.mjs";
import { agyConformance } from "../support/agy-conformance.mjs";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const fakeOpenCodeV2Bin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");
const controlledPath = [fakeHarnessBin, dirname(process.execPath)].join(delimiter);

const profiles = createConformanceProfiles({
  agy: {
    primaryId: "agy-external-child", missingId: "agy-missing", initialModel: undefined, nextModel: "fake-high",
    seed: (workspace, missingWorkspace) => [
      { id: "agy-external-child", workspacePath: workspace },
      { id: "agy-missing", workspacePath: missingWorkspace },
    ],
    options: async (sessionsFile, t) => (await agyConformance(t, { sessionsFile })).options,
  },
  pi: {
    primaryId: "pi-external-1", missingId: "pi-missing", initialModel: "controlled/controlled", nextModel: "controlled/next",
    seed: (workspace, missingWorkspace) => [
      { id: "pi-external-1", workspacePath: workspace, title: "External one", updatedAt: 1700000100000 },
      { id: "pi-external-2", workspacePath: workspace, updatedAt: 1700000000000 },
      { id: "pi-missing", workspacePath: missingWorkspace, updatedAt: 1700000000000 },
    ],
    options: async (sessionsFile, t) => (await piConformance(t, { sessionsFile })).options,
  },
  codex: {
    primaryId: "thread_external_1",
    missingId: "thread_missing",
    initialModel: "fake-default",
    nextModel: "fake-high",
    seed: (workspace, missingWorkspace) => [
      {
        id: "thread_external_1",
        workspacePath: workspace,
        title: "External one",
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_100,
        model: "fake-default",
      },
      { id: "thread_external_2", workspacePath: workspace },
      { id: "thread_missing", workspacePath: missingWorkspace },
    ],
    options: (sessionsFile) => ({
      env: {
        PATH: controlledPath,
        MUHA_FAKE_NATIVE_SESSIONS_FILE: sessionsFile,
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
  },
  opencode: {
    primaryId: "ses_external_1",
    missingId: "ses_missing",
    initialModel: "opencode-go/deepseek-v4.1-flash",
    nextModel: "opencode-go/other",
    seed: (workspace, missingWorkspace) => [
      {
        id: "ses_external_1",
        directory: workspace,
        title: "External one",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
        model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      },
      { id: "ses_external_2", directory: workspace },
      { id: "ses_missing", directory: missingWorkspace },
    ],
    options: (sessionsFile) => ({
      env: {
        PATH: [fakeOpenCodeV2Bin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_SESSIONS_FILE: sessionsFile,
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
  },
  kimi: {
    primaryId: "session_external_1",
    missingId: "session_missing",
    initialModel: "fake-default",
    nextModel: "fake-high",
    seed: (workspace, missingWorkspace) => [
      {
        id: "session_external_1",
        workspacePath: workspace,
        title: "External one",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
        model: "fake-default",
      },
      { id: "session_external_2", workspacePath: workspace },
      { id: "session_missing", workspacePath: missingWorkspace },
    ],
    options: (sessionsFile) => ({
      env: {
        PATH: controlledPath,
        MUHA_FAKE_KIMI_SESSIONS_FILE: sessionsFile,
        MUHA_FAKE_KIMI_PAGE_SIZE: "1",
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
  },
});

for (const profile of profiles) {
  test(`${profile.harness} satisfies the native Session Core Conformance`, async t => {
    const root = await mkdtemp(join(tmpdir(), `muha-${profile.harness}-session-conformance-`));
    const workspace = join(root, "workspace");
    const missingWorkspace = join(root, "missing-workspace");
    const sessionsFile = join(root, "native-sessions.json");
    let runtime;
    let session;

    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    await writeFile(
      sessionsFile,
      JSON.stringify(profile.seed(canonicalWorkspace, missingWorkspace)),
    );

    try {
      runtime = await createMuhaRuntime({
        harnesses: [profile.registration(await profile.options(sessionsFile, t))],
        dataDir: join(root, "diagnostics"),
      });
      const capabilities = runtime.getHarnessCapabilities(profile.harness);
      const approvalPolicy = capabilities.approvalPolicies[0];
      const reference = { harness: profile.harness, sessionId: profile.primaryId, workspacePath: canonicalWorkspace, route: "native" };
      const expectedReference = reference;
      const idleModel = capabilities.model.selectionAt.includes("idleSession");
      if (capabilities.sessionListing) {
        const listed = await runtime.listSessions({
        harness: profile.harness,
        workspacePath: canonicalWorkspace,
      });
      assert.equal(listed.length, 2);
      assert.deepEqual(listed[0], {
        reference: {
          harness: profile.harness,
          sessionId: profile.primaryId,
          workspacePath: canonicalWorkspace,
          route: "native",
        },
        title: "External one",
        createdAt: "2023-11-14T22:13:20.000Z",
        updatedAt: "2023-11-14T22:15:00.000Z",
      });
      assert.equal("title" in listed[1], false);
        assert.deepEqual(listed[0].reference, expectedReference);
      } else {
        await assert.rejects(runtime.listSessions({ harness: profile.harness, workspacePath: canonicalWorkspace }),
          error => error.data?.code === "UNSUPPORTED_CAPABILITY" && error.data.capability === "sessionListing");
      }

      session = await runtime.resumeSession({
        reference,
        approvalPolicy,
        turnRetryPolicy: { maxRetries: 10 },
      });
      assert.deepEqual(session.reference, expectedReference);
      assert.equal(session.model, profile.initialModel);
      if (idleModel) {
        await session.setModel(profile.nextModel);
        assert.equal(session.model, profile.nextModel);
      } else {
        await assert.rejects(session.setModel(profile.nextModel), error => error.data?.code === "UNSUPPORTED_CAPABILITY");
        assert.equal(session.model, profile.initialModel);
      }
      const turn = await session.startTurn([{ type: "text", text: "Persist the selected model." }]);
      await assert.rejects(
        session.setModel(profile.nextModel),
        (error) => error instanceof MuhaError && error.data.code === "SESSION_BUSY",
      );
      assert.equal((await turn.result).status, "completed");
      await session.close();

      for (const maxRetries of [-1, 1.5, 11]) {
        await assert.rejects(
          runtime.resumeSession({
            reference,
            approvalPolicy,
            turnRetryPolicy: { maxRetries },
          }),
          (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
        );
      }
      await assert.rejects(
        session.setModel(profile.nextModel),
        (error) => error instanceof MuhaError && error.data.code === "SESSION_CLOSED",
      );

      session = await runtime.resumeSession({ reference, approvalPolicy });
      assert.equal(session.model, idleModel ? profile.nextModel : profile.initialModel);
      await session.close();

      const absentReference = {
        route: "native",
        harness: profile.harness,
        sessionId: `${profile.missingId}_absent`,
        workspacePath: canonicalWorkspace,
      };
      await assert.rejects(
        runtime.resumeSession({ reference: absentReference, approvalPolicy }),
        (error) =>
          error instanceof MuhaError &&
          error.data.code === "SESSION_NOT_FOUND" &&
          error.data.harness === profile.harness &&
          error.data.sessionId === absentReference.sessionId,
      );

      const missingReference = {
        route: "native",
        harness: profile.harness,
        sessionId: profile.missingId,
        workspacePath: missingWorkspace,
      };
      await assert.rejects(
        runtime.resumeSession({ reference: missingReference, approvalPolicy }),
        (error) => error instanceof MuhaError && error.data.code === "WORKSPACE_NOT_FOUND",
      );
      await assert.rejects(access(missingWorkspace));
      session = await runtime.resumeSession({
        reference: missingReference,
        approvalPolicy,
        createWorkspaceIfMissing: true,
      });
      assert.deepEqual(session.reference, {
        harness: missingReference.harness,
        sessionId: missingReference.sessionId,
        workspacePath: missingReference.workspacePath,
        route: "native",
      });
      await access(missingWorkspace);
      await session.close();
    } finally {
      await session?.close();
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
