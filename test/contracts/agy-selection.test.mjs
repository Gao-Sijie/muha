import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { agyAdapter } from "@muha-sdk/agy-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

test("AGY rejects an explicit native selection error while keeping the Runtime and other Session usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-selection-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  let runtime;
  try {
    runtime = await createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter({
      env: { HOME: join(root, "home"), PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter) },
      startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
    })] });
    const session = await runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "harnessManaged", model: "fake-opus" });
    await assert.rejects(runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "harnessManaged", model: "invalid-model" }),
      error => error.data?.code === "HARNESS_ERROR" && error.data.operation === "createSession");
    assert.equal(runtime.status, "active");
    assert.equal(session.model, "fake-opus");
    assert.equal((await (await session.startTurn([{ type: "text", text: "Continue." }])).result).status, "completed");
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
