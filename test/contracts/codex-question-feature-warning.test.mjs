import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("Codex warns without blocking a Session when the effective Question feature is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-question-feature-warning-"));
  const workspace = join(root, "workspace");
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  let runtime;
  let session;
  let resumed;
  try {
    await mkdir(workspace);
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({
        env: {
          PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_CODEX_QUESTION_FEATURE: "disabled",
          MUHA_FAKE_NATIVE_SESSIONS_FILE: join(root, "native-sessions.json"),
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.reference.workspacePath, workspace);
    assert.equal(warnings.filter(({ code }) => code === "MUHA_CODEX_QUESTION_FEATURE_DISABLED").length, 1);
    const reference = session.reference;
    await session.close();
    resumed = await runtime.resumeSession({ reference });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warnings.filter(({ code }) => code === "MUHA_CODEX_QUESTION_FEATURE_DISABLED").length, 1);
  } finally {
    process.off("warning", onWarning);
    await resumed?.close();
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex rechecks the effective Question feature when a Session is resumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-question-feature-resume-"));
  const workspace = join(root, "workspace");
  const nativeSessionsFile = join(root, "native-sessions.json");
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  let runtime;
  let session;
  try {
    await mkdir(workspace);
    const adapter = (feature) => codexAdapter({
      env: {
        PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
        MUHA_FAKE_CODEX_QUESTION_FEATURE: feature,
        MUHA_FAKE_NATIVE_SESSIONS_FILE: nativeSessionsFile,
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    });
    runtime = await createMuhaRuntime({
      harnesses: [adapter("enabled")],
      dataDir: join(root, "first-diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const reference = session.reference;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warnings.filter(({ code }) => code?.startsWith("MUHA_CODEX_QUESTION_FEATURE_")).length, 0);
    await session.close();
    await runtime.close();

    runtime = await createMuhaRuntime({
      harnesses: [adapter("disabled")],
      dataDir: join(root, "second-diagnostics"),
    });
    session = await runtime.resumeSession({ reference });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(session.reference, reference);
    assert.equal(warnings.filter(({ code }) => code === "MUHA_CODEX_QUESTION_FEATURE_DISABLED").length, 1);
  } finally {
    process.off("warning", onWarning);
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex keeps Session creation nonblocking when feature discovery is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-question-feature-unknown-"));
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({
        env: {
          PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_CODEX_QUESTION_FEATURE: "unavailable",
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: root });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.reference.workspacePath, root);
    assert.equal(warnings.filter(({ code }) => code === "MUHA_CODEX_QUESTION_FEATURE_UNKNOWN").length, 1);
  } finally {
    process.off("warning", onWarning);
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
