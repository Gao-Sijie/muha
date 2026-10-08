import assert from "node:assert/strict";
import {
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
import { kimiAdapter } from "@muha-sdk/kimi-adapter";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";
import { createConformanceProfiles } from "../support/official-harness-profiles.mjs";
import { piConformance } from "../support/pi-conformance.mjs";
import { agyConformance } from "../support/agy-conformance.mjs";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const fakeOpenCodeV2Bin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");
const controlledPath = [fakeHarnessBin, dirname(process.execPath)].join(delimiter);

function isError(error, code) {
  return error instanceof MuhaError && error.data.code === code;
}

async function lastTurnSubmission(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

const piFixtures = new Map();
const profiles = createConformanceProfiles({
  agy: {
    initialModel: undefined, effortModel: "fake-high", supportedEffort: "high", unsupportedEffort: "extreme",
    defaultEffort: undefined, minimalModel: "fake-opus", missingModel: "invalid-model",
    evidence: root => join(root, "agy-submission.json"),
    options: async (root, t) => (await agyConformance(t, { root, evidenceFile: join(root, "agy-submission.json") })).options,
    submission: async path => JSON.parse(await readFile(path, "utf8")).effort,
  },
  pi: {
    initialModel: "controlled/controlled", effortModel: "controlled/next", supportedEffort: "high",
    unsupportedEffort: "extreme", defaultEffort: "medium", minimalModel: "controlled/minimal",
    // Pi 1.x reselecting the model restores its native default thinking level.
    missingModel: "controlled/missing", restoredEffort: "high", implicitSubmission: "medium",
    evidence: root => root,
    options: async (root, t) => {
      const fixture = await piConformance(t);
      piFixtures.set(root, fixture);
      t.after(() => piFixtures.delete(root));
      return fixture.options;
    },
    submission: async root => piFixtures.get(root).requests.at(-1)?.reasoning_effort,
  },
  codex: {
    initialModel: "fake-default",
    effortModel: "fake-high",
    supportedEffort: "high",
    unsupportedEffort: "low",
    defaultEffort: "medium",
    minimalModel: "fake-minimal",
    missingModel: "not-in-native-catalog",
    evidence: (root) => join(root, "turn-request.json"),
    options: (root) => ({
      env: {
        PATH: controlledPath,
        MUHA_FAKE_NATIVE_SESSIONS_FILE: join(root, "sessions.json"),
        MUHA_FAKE_TURN_REQUEST_FILE: join(root, "turn-request.json"),
        MUHA_FAKE_TURN_ACCEPT_DELAY_MS: "120",
        MUHA_FAKE_MODEL_LIST_DELAY_MS: "120",
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
    submission: async (evidencePath) => {
      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      return evidence.effort;
    },
  },
  kimi: {
    initialModel: "fake-default",
    effortModel: "fake-high",
    supportedEffort: "low",
    unsupportedEffort: "extreme",
    defaultEffort: undefined,
    minimalModel: "fake-default",
    missingModel: "not-in-native-catalog",
    evidence: (root) => join(root, "evidence.json"),
    options: (root) => ({
      env: {
        PATH: controlledPath,
        MUHA_FAKE_KIMI_EVIDENCE_FILE: join(root, "evidence.json"),
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
    submission: async (evidencePath) => {
      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      return evidence.prompts.at(-1)?.thinking ?? undefined;
    },
  },
  opencode: {
    initialModel: "opencode-go/deepseek-v4.1-flash",
    effortModel: "opencode-go/deepseek-v4.1-flash",
    supportedEffort: "high",
    unsupportedEffort: "turbo",
    defaultEffort: undefined,
    restoredEffort: "high",
    minimalModel: "opencode-go/minimal",
    missingModel: "opencode-go/not-in-catalog",
    evidence: (root) => join(root, "evidence.json"),
    options: (root) => ({
      env: {
        PATH: [fakeOpenCodeV2Bin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_EVIDENCE_FILE: join(root, "evidence.json"),
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
    submission: async (evidencePath) => {
      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      return evidence.prompts.at(-1)?.model?.variant ?? undefined;
    },
  },
});

for (const profile of profiles) {
  test(`${profile.harness} carries the common Harness Effort next-Turn selection`, async t => {
    const root = await mkdtemp(join(tmpdir(), `muha-effort-${profile.harness}-`));
    const workspace = join(root, "workspace");
    const evidencePath = profile.evidence(root);
    let runtime;
    let session;
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);

    const submission = async () => profile.submission(evidencePath);

    try {
      runtime = await createMuhaRuntime({
        harnesses: [profile.registration(await profile.options(root, t))],
        dataDir: join(root, "diagnostics"),
      });
      const capabilities = runtime.getHarnessCapabilities(profile.harness);
      const approvalPolicy = capabilities.approvalPolicies[0];
      const idleSelections = capabilities.effort.selectionAt.includes("idleSession");

      // Creation with an explicit Effort exposes it and submits it exactly.
      session = await runtime.createSession({
        harness: profile.harness,
        approvalPolicy,
        workspacePath: canonicalWorkspace,
        model: profile.effortModel,
        effort: profile.supportedEffort,
      });
      assert.equal(session.effort, profile.supportedEffort);
      let turn = await session.startTurn([{ type: "text", text: "First Turn with Effort." }]);
      await turn.result;
      assert.equal(await submission(), profile.supportedEffort);
      assert.equal(session.effort, profile.supportedEffort);

      // Subsequent Turns keep the selected Effort without re-selection.
      turn = await session.startTurn([{ type: "text", text: "Second Turn with Effort." }]);
      await turn.result;
      assert.equal(await submission(), profile.supportedEffort);

      // Idle-only setEffort changes only subsequent Turns.
      if (idleSelections) await session.setEffort(profile.supportedEffort);
      else await assert.rejects(session.setEffort(profile.supportedEffort), error => isError(error, "UNSUPPORTED_CAPABILITY"));
      assert.equal(session.effort, profile.supportedEffort);
      const reference = session.reference;
      await session.close();
      session = undefined;

      // Effective observation may expose a native restored value even when
      // this caller does not explicitly select a new Effort.
      const resumed = await runtime.resumeSession({ reference, approvalPolicy });
      assert.equal(resumed.effort, profile.restoredEffort);
      await resumed.close();
      const resumedWithEffort = await runtime.resumeSession({
        reference,
        approvalPolicy,
        effort: profile.supportedEffort,
      });
      assert.equal(resumedWithEffort.effort, profile.supportedEffort);
      await resumedWithEffort.close();
      session = await runtime.resumeSession({
        reference,
        approvalPolicy,
        model: profile.effortModel,
      });
      assert.equal(session.effort, profile.restoredEffort);

      // Failed native selection retains the previous Model and Effort.
      if (idleSelections) {
      await session.setEffort(profile.supportedEffort);
      await assert.rejects(
        session.setEffort(profile.unsupportedEffort),
        (error) =>
          isError(error, "HARNESS_ERROR") &&
          error.data.operation === "setEffort",
      );
      assert.equal(session.effort, profile.supportedEffort);
      turn = await session.startTurn([{ type: "text", text: "After failed Effort." }]);
      await turn.result;
      assert.equal(await submission(), profile.supportedEffort);

      // A successful Model change clears the Effort.
      await session.setModel(profile.effortModel);
      assert.equal(session.effort, undefined);
      turn = await session.startTurn([{ type: "text", text: "Model changed, Effort cleared." }]);
      await turn.result;
      assert.equal(await submission(), profile.implicitSubmission);

      // A failed Model change retains both prior selections.
      await session.setEffort(profile.supportedEffort);
      await assert.rejects(
        session.setModel(profile.missingModel),
        (error) => isError(error, "HARNESS_ERROR"),
      );
      assert.equal(session.model, profile.effortModel);
      assert.equal(session.effort, profile.supportedEffort);
      } else {
        await assert.rejects(session.setEffort(profile.supportedEffort), error => isError(error, "UNSUPPORTED_CAPABILITY"));
        await assert.rejects(session.setModel(profile.effortModel), error => isError(error, "UNSUPPORTED_CAPABILITY"));
        assert.equal(session.model, profile.effortModel);
        assert.equal(session.effort, undefined);
      }
      await session.close();
      session = undefined;

      // Invalid Effort input fails before any native side effect.
      for (const invalidEffort of [42, "", "   ", " padded", "padded "]) {
        await assert.rejects(
          runtime.createSession({
            harness: profile.harness,
            approvalPolicy,
            workspacePath: canonicalWorkspace,
            model: profile.effortModel,
            effort: invalidEffort,
          }),
          (error) => isError(error, "INVALID_INPUT"),
        );
        await assert.rejects(
          runtime.resumeSession({
            reference,
            approvalPolicy,
            effort: invalidEffort,
          }),
          (error) => isError(error, "INVALID_INPUT"),
        );
      }

      // Unsupported native values fail with HARNESS_ERROR at creation.
      await assert.rejects(
        runtime.createSession({
          harness: profile.harness,
          approvalPolicy,
          workspacePath: canonicalWorkspace,
          model: profile.effortModel,
          effort: profile.unsupportedEffort,
        }),
        (error) =>
          isError(error, "HARNESS_ERROR") &&
          error.data.operation === "createSession",
      );

      // Resumption attributes native Effort validation to resumeSession.
      await assert.rejects(
        runtime.resumeSession({
          reference,
          approvalPolicy,
          model: profile.effortModel,
          effort: profile.unsupportedEffort,
        }),
        (error) =>
          isError(error, "HARNESS_ERROR") &&
          error.data.operation === "resumeSession",
      );

      // A model without native Effort metadata rejects explicit Effort.
      await assert.rejects(
        runtime.createSession({
          harness: profile.harness,
          approvalPolicy,
          workspacePath: canonicalWorkspace,
          model: profile.minimalModel,
          effort: profile.supportedEffort,
        }),
        (error) => isError(error, "HARNESS_ERROR"),
      );
    } finally {
      await session?.close();
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Effort without an explicit Model depends on native resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-effort-default-model-"));
  const workspace = join(root, "workspace");
  const evidencePath = join(root, "turn-request.json");
  let runtime;
  let session;
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({
        env: {
          PATH: controlledPath,
          MUHA_FAKE_TURN_REQUEST_FILE: evidencePath,
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });

    // Codex resolves the native default Model, so Effort validation succeeds.
    session = await runtime.createSession({
      harness: "codex",
      workspacePath: canonicalWorkspace,
      effort: "medium",
    });
    assert.equal(session.effort, "medium");
    assert.equal(session.model, "fake-default");
    const turn = await session.startTurn([{ type: "text", text: "Default Model Effort." }]);
    await turn.result;
    const request = await lastTurnSubmission(evidencePath);
    assert.equal(request.effort, "medium");
    assert.equal(request.model, "fake-default");
    await session.close();
    session = undefined;
    await runtime.close();
    runtime = undefined;

    // Kimi and OpenCode cannot resolve the effective Model yet, so Effort fails.
    const unresolvable = [
      {
        harness: "kimi",
        registration: kimiAdapter({
          env: { PATH: controlledPath },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      },
      {
        harness: "opencode",
        registration: openCodeAdapter({
          env: { PATH: [fakeOpenCodeV2Bin, dirname(process.execPath)].join(delimiter) },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      },
    ];
    for (const candidate of unresolvable) {
      runtime = await createMuhaRuntime({
        harnesses: [candidate.registration],
        dataDir: join(root, `diagnostics-${candidate.harness}`),
      });
      await assert.rejects(
        runtime.createSession({
          harness: candidate.harness,
          workspacePath: canonicalWorkspace,
          effort: "low",
        }),
        (error) =>
          isError(error, "HARNESS_ERROR") &&
          error.data.nativeCode === "model_unresolved",
      );
      await runtime.close();
      runtime = undefined;
    }
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Effort selection shares the Session busy, closed, and race contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-effort-races-"));
  const workspace = join(root, "workspace");
  const evidencePath = join(root, "turn-request.json");
  const codexSessionsFile = join(root, "sessions.json");
  let runtime;
  let session;
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  await writeFile(codexSessionsFile, JSON.stringify([]));

  const createRuntime = () => createMuhaRuntime({
    harnesses: [codexAdapter({
      env: {
        PATH: controlledPath,
        MUHA_FAKE_NATIVE_SESSIONS_FILE: codexSessionsFile,
        MUHA_FAKE_TURN_REQUEST_FILE: evidencePath,
        MUHA_FAKE_TURN_ACCEPT_DELAY_MS: "150",
        MUHA_FAKE_MODEL_LIST_DELAY_MS: "150",
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    })],
    dataDir: join(root, "diagnostics"),
  });

  try {
    runtime = await createRuntime();
    session = await runtime.createSession({
      harness: "codex",
      workspacePath: canonicalWorkspace,
      model: "fake-high",
    });

    // While startTurn acceptance is pending, selection commands are rejected.
    const pendingTurn = session.startTurn([{ type: "text", text: "Pending acceptance." }]);
    await assert.rejects(
      session.setModel("fake-default"),
      (error) => isError(error, "SESSION_BUSY"),
    );
    await assert.rejects(
      session.setEffort("high"),
      (error) => isError(error, "SESSION_BUSY"),
    );
    await pendingTurn;
    const acceptedEvidence = await readFile(evidencePath, "utf8");
    assert.ok(acceptedEvidence.length > 0);
    let turn = await session.startTurn([{ type: "text", text: "Finish previous Turn." }]);
    await turn.result;

    // While Model-selection acceptance is pending, startTurn and other
    // selection commands are rejected, and exactly one operation wins.
    const pendingModel = session.setModel("fake-default");
    await assert.rejects(
      session.startTurn([{ type: "text", text: "Rejected during Model selection." }]),
      (error) => isError(error, "SESSION_BUSY"),
    );
    await assert.rejects(
      session.setEffort("high"),
      (error) => isError(error, "SESSION_BUSY"),
    );
    await pendingModel;
    assert.equal(session.model, "fake-default");

    // While Effort-selection acceptance is pending, startTurn is rejected.
    const pendingEffort = session.setEffort("medium");
    await assert.rejects(
      session.startTurn([{ type: "text", text: "Rejected during Effort selection." }]),
      (error) => isError(error, "SESSION_BUSY"),
    );
    await pendingEffort;
    assert.equal(session.effort, "medium");

    // The accepted Turn observes the winning deterministic pair.
    turn = await session.startTurn([{ type: "text", text: "Winning pair." }]);
    await turn.result;
    const request = await lastTurnSubmission(evidencePath);
    assert.equal(request.model, "fake-default");
    assert.equal(request.effort, "medium");

    // Active Turns reject Effort changes.
    const active = await session.startTurn([{ type: "text", text: "Active Turn." }]);
    await assert.rejects(
      session.setEffort("high"),
      (error) => isError(error, "SESSION_BUSY"),
    );
    await active.result;

    // Closed Sessions reject Effort changes with the existing semantics.
    await session.close();
    await assert.rejects(
      session.setEffort("high"),
      (error) => isError(error, "SESSION_CLOSED"),
    );
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
