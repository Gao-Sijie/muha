// T29/T30 — Kimi offline Session/Reference contract and capability honesty.
// No real model requests; the local native default route stays unchanged and
// unknown identities fail explicitly.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime, createSessionReference, parseSessionReference, serializeSessionReference, referenceRoute } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";
import { delimiter, dirname, resolve } from "node:path";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("T29: Kimi references round-trip and retired references are rejected", () => {
  const legacy = { harness: "kimi", sessionId: "kimi-alias-1", workspacePath: "/tmp/ws" };
  assert.throws(() => parseSessionReference(legacy), (error) => error.data?.code === "INVALID_SESSION_REFERENCE");
  const reference = createSessionReference("kimi", "kimi-session-1", "/tmp/ws", "native");
  assert.equal(referenceRoute(reference), "native");
  assert.deepEqual(parseSessionReference(JSON.parse(serializeSessionReference(reference))), reference);
});

test("T29: Kimi unknown native identities fail with SESSION_NOT_FOUND, never a replacement Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-kimi-ref-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [kimiAdapter({
        env: { PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter) },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    const reference = createSessionReference("kimi", "kimi_session_missing", workspace, "native");
    await assert.rejects(
      runtime.resumeSession({ reference }),
      (error) => error.data?.code === "SESSION_NOT_FOUND",
    );
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T30: Kimi static capability declaration stays honest and executable locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-kimi-cap-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [kimiAdapter({
        env: { PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter) },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    const capabilities = runtime.getHarnessCapabilities("kimi");
    assert.equal(capabilities.sessionListing, true);
    assert.equal(capabilities.imageInput, true);
    assert.deepEqual(capabilities.approvalPolicies, ["interactive", "autoApprove", "autoDeny"]);
    assert.equal(capabilities.turnQuestions, true);
    assert.equal(capabilities.workspaceSkills, true);
    assert.equal(capabilities.workspaceMcp, true);
    assert.equal(capabilities.toolEvents, true);
    assert.equal(capabilities.turnUsage, true);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
