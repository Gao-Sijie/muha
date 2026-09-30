import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { createConformanceProfiles } from "../support/official-harness-profiles.mjs";
import { agyConformance } from "../support/agy-conformance.mjs";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const fakeOpenCodeV2Bin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");
const controlledPath = [fakeHarnessBin, dirname(process.execPath)].join(delimiter);
const allSelectionPoints = ["createSession", "resumeSession", "idleSession"];

const commonCapabilities = {
  sessionListing: true,
  imageInput: true,
  approvalPolicies: ["interactive", "autoApprove", "autoDeny"],
  turnQuestions: true,
  workspaceSkills: true,
  workspaceMcp: true,
  assistantMessageStreaming: true,
  assistantReasoningStreaming: true,
  toolEvents: true,
  turnUsage: true,
};

const profiles = createConformanceProfiles({
  agy: {
    options: async (root, t) => (await agyConformance(t, { root })).options,
    expected: {
      sessionListing: false, imageInput: false, approvalPolicies: ["harnessManaged", "autoApprove"],
      turnQuestions: false, workspaceSkills: true, workspaceMcp: false,
      model: { selectionAt: ["createSession", "resumeSession"], observation: "selectedOnly" },
      effort: { selectionAt: ["createSession", "resumeSession"], observation: "selectedOnly", requiresKnownModel: false },
      assistantMessageStreaming: true, assistantReasoningStreaming: false, toolEvents: true, turnUsage: true,
    },
  },
  pi: {
    options: () => ({ env: { PATH: controlledPath } }),
    expected: {
      ...commonCapabilities, approvalPolicies: ["autoApprove", "harnessManaged"], turnQuestions: false, workspaceMcp: false,
      model: { selectionAt: allSelectionPoints, observation: "effective" },
      effort: { selectionAt: allSelectionPoints, observation: "effective", requiresKnownModel: true },
    },
  },
  codex: {
    options: () => ({ env: { PATH: controlledPath } }),
    expected: {
      ...commonCapabilities,
      model: { selectionAt: allSelectionPoints, observation: "effective" },
      effort: {
        selectionAt: allSelectionPoints,
        observation: "selectedOnly",
        requiresKnownModel: false,
      },
    },
  },
  opencode: {
    options: () => ({ env: { PATH: [fakeOpenCodeV2Bin, dirname(process.execPath)].join(delimiter) } }),
    expected: {
      ...commonCapabilities,
      model: { selectionAt: allSelectionPoints, observation: "selectedOnly" },
      effort: {
        selectionAt: allSelectionPoints,
        observation: "selectedOnly",
        requiresKnownModel: true,
      },
    },
  },
  kimi: {
    options: () => ({ env: { PATH: controlledPath } }),
    expected: {
      ...commonCapabilities,
      model: { selectionAt: allSelectionPoints, observation: "selectedOnly" },
      effort: {
        selectionAt: allSelectionPoints,
        observation: "selectedOnly",
        requiresKnownModel: true,
      },
    },
  },
});

for (const profile of profiles) {
  test(`${profile.harness} exposes its immutable Capability Profile`, async t => {
    const root = await mkdtemp(join(tmpdir(), `muha-${profile.harness}-capabilities-`));
    let runtime;
    try {
      runtime = await createMuhaRuntime({
        harnesses: [profile.registration(await profile.options(root, t))],
        dataDir: join(root, "diagnostics"),
      });
      const capabilities = runtime.getHarnessCapabilities(profile.harness);
      assert.deepEqual(capabilities, profile.expected);
      assert.deepEqual(JSON.parse(JSON.stringify(capabilities)), profile.expected);
      assertDeeplyFrozen(capabilities);
      assert.equal(runtime.getHarnessCapabilities(profile.harness), capabilities);

      await runtime.close();
      assert.equal(runtime.getHarnessCapabilities(profile.harness), capabilities);
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Capability discovery rejects a valid Harness that is not enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-disabled-capability-"));
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [profiles[0].registration(profiles[0].options())],
      dataDir: join(root, "diagnostics"),
    });
    assert.throws(
      () => runtime.getHarnessCapabilities("opencode"),
      (error) =>
        error instanceof MuhaError &&
        error.data.code === "HARNESS_NOT_ENABLED" &&
        error.data.harness === "opencode",
    );
    assert.throws(
      () => runtime.getHarnessCapabilities("unknown-harness"),
      (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
    );
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function assertDeeplyFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object") assertDeeplyFrozen(nested);
  }
}
