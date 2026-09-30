import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import { createOfficialHarnessRegistration, readOfficialHarnessRegistration } from "@muha-sdk/core/internal";
import { createConformanceProfiles } from "../support/official-harness-profiles.mjs";
import { piConformance } from "../support/pi-conformance.mjs";
import { agyConformance } from "../support/agy-conformance.mjs";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const fakeOpenCodeV2Bin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");
const controlledPath = [fakeHarnessBin, dirname(process.execPath)].join(delimiter);

const profiles = createConformanceProfiles({
  agy: { options: async t => (await agyConformance(t, { scenario: "rich" })).options },
  pi: { options: async t => (await piConformance(t, { rich: true })).options },
  codex: {
    options: () => ({
      env: { PATH: controlledPath, MUHA_FAKE_TURN_SCENARIO: "rich" },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
  },
  opencode: {
    options: () => ({
      env: { PATH: [fakeOpenCodeV2Bin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_REASONING: "on", MUHA_V2_TOOL: "success",
        MUHA_V2_PERMISSION: "ask", MUHA_V2_FORM: "multi" },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
  },
  kimi: {
    options: () => ({
      env: { PATH: controlledPath, MUHA_FAKE_KIMI_SCENARIO: "rich" },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
  },
});

// Exercise the same public Conformance path without interactive/Question support.
// Keep the real Adapter and native protocol fixture; only narrow its declaration.
const autonomousProfile = {
  ...profiles[0],
  label: "native autonomous path",
  registration(options) {
    const native = readOfficialHarnessRegistration(profiles[0].registration(options));
    return createOfficialHarnessRegistration(
      native.kind, options,
      Object.freeze({ ...native.capabilities, approvalPolicies: Object.freeze(["autoApprove"]), turnQuestions: false }),
      native.workspaceConfigurator,
      (_options, context) => native.create(context),
    );
  },
};

for (const profile of [...profiles, autonomousProfile]) {
  test(`${profile.label ?? profile.harness} satisfies the rich Turn Core Conformance`, async t => {
    const root = await mkdtemp(join(tmpdir(), `muha-${profile.harness}-rich-conformance-`));
    const workspace = join(root, "workspace");
    let runtime;
    let session;
    await mkdir(workspace);
    try {
      runtime = await createMuhaRuntime({
        harnesses: [profile.registration(await profile.options(t))],
        dataDir: join(root, "diagnostics"),
      });
      const capabilities = runtime.getHarnessCapabilities(profile.harness);
      for (const approvalPolicy of ["interactive", "autoApprove", "autoDeny", "harnessManaged"]) {
        if (!capabilities.approvalPolicies.includes(approvalPolicy)) {
          await assert.rejects(
            runtime.createSession({ harness: profile.harness, workspacePath: workspace, approvalPolicy }),
            (error) => error.data?.code === "UNSUPPORTED_CAPABILITY"
              && error.data.capability === `approvalPolicy.${approvalPolicy}`,
          );
        }
      }
      session = await runtime.createSession({
        harness: profile.harness,
        workspacePath: workspace,
        approvalPolicy: capabilities.approvalPolicies.includes("interactive")
          ? "interactive"
          : capabilities.approvalPolicies[0],
      });
      const turn = await session.startTurn([{ type: "text", text: "Exercise rich events." }]);
      const events = [];
      for await (const event of turn) {
        events.push(event);
        if (event.type === "approval.requested") {
          await turn.respondToApproval(event.requestId, "allowOnce");
        }
        if (event.type === "question.requested") {
          await turn.respondToQuestion(event.requestId, { action: "dismiss" });
        }
      }
      const result = await turn.result;

      assert.equal(events[0].type, "turn.started");
      assert.deepEqual(
        events.map(({ sequence }) => sequence),
        events.map((_event, index) => index + 1),
      );
      for (const event of events) {
        assert.equal(event.turnId, turn.turnId);
        assert.equal(Number.isNaN(Date.parse(event.timestamp)), false);
        assert.equal("nativeId" in event, false);
        assert.equal("harness" in event, false);
        assert.equal("workspacePath" in event, false);
      }

      assertLifecyclePairs(events, "assistant.message.started", "assistant.message.completed", "messageId", "message");
      if (capabilities.toolEvents) {
        assertLifecyclePairs(events, "tool.started", "tool.completed", "toolCallId");
      }
      assertInteractionPairs(events, "approval");
      assertInteractionPairs(events, "question");
      if (!capabilities.turnQuestions) {
        assert.equal(events.some(({ type }) => type.startsWith("question.")), false);
      }
      if (profile === autonomousProfile) {
        assert.equal(events.some(({ type }) => type.startsWith("approval.")), false);
      }
      if (capabilities.assistantMessageStreaming) {
        assert.ok(events.some(({ type }) => type === "assistant.message.delta"));
      }
      if (capabilities.assistantReasoningStreaming) {
        assert.ok(events.some(({ type }) => type === "assistant.reasoning.delta"));
      }
      if (capabilities.toolEvents) {
        assert.ok(events.some(({ type }) => type === "tool.started"));
      }

      const terminals = events.filter(({ type }) =>
        type === "turn.completed" || type === "turn.failed" || type === "turn.interrupted");
      assert.equal(terminals.length, 1);
      assert.equal(events.at(-1), terminals[0]);
      assert.equal(result.status, terminals[0].type.slice("turn.".length));
      assert.equal(result.status, "completed");
      assert.equal(result.turnId, turn.turnId);
      if (result.status === "completed") assert.deepEqual(result.message, terminals[0].message);

      const usageEvents = events.filter(({ type }) => type === "usage.updated");
      if (capabilities.turnUsage) assert.ok(usageEvents.length > 0);
      for (const { usage } of usageEvents) {
        for (const count of Object.values(usage)) {
          assert.equal(Number.isSafeInteger(count) && count >= 0, true);
        }
      }
      if (usageEvents.length > 0) {
        assert.deepEqual(result.usage, usageEvents.at(-1).usage);
      }
    } finally {
      await session?.close();
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

function assertLifecyclePairs(events, startedType, completedType, idField, completedValueField) {
  const starts = events.filter(({ type }) => type === startedType);
  const completions = events.filter(({ type }) => type === completedType);
  assert.ok(starts.length > 0);
  assert.equal(completions.length, starts.length);
  const startedIds = new Set(starts.map((event) => event[idField]));
  for (const event of completions) {
    const id = completedValueField === undefined
      ? event[idField]
      : event[completedValueField].id;
    assert.equal(startedIds.delete(id), true);
  }
  assert.equal(startedIds.size, 0);
}

function assertInteractionPairs(events, interaction) {
  const requests = events.filter(({ type }) => type === `${interaction}.requested`);
  const resolutions = events.filter(({ type }) => type === `${interaction}.resolved`);
  assert.equal(resolutions.length, requests.length);
  const requestIds = new Set(requests.map(({ requestId }) => requestId));
  for (const { requestId } of resolutions) assert.equal(requestIds.delete(requestId), true);
  assert.equal(requestIds.size, 0);
}
