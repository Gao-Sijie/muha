import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const controlledPath = [fakeHarnessBin, dirname(process.execPath)].join(delimiter);

for (const scenario of ["early-exit", "unready", "bad-ready", "bad-token", "ws-reject"]) {
  test(`Kimi ${scenario} fails initialization without exposing process control output`, async () => {
    const root = await mkdtemp(join(tmpdir(), `muha-kimi-${scenario}-`));
    let unexpectedRuntime;
    try {
      await assert.rejects(
        createMuhaRuntime({
          harnesses: [kimiAdapter({
            env: { PATH: controlledPath, MUHA_FAKE_KIMI_SCENARIO: scenario },
            startupTimeoutMs: 120,
            shutdownTimeoutMs: 120,
          })],
          dataDir: join(root, "diagnostics"),
        }).then((runtime) => {
          unexpectedRuntime = runtime;
          return runtime;
        }),
        (error) => {
          assert.ok(error instanceof MuhaError);
          assert.equal(error.data.code, "RUNTIME_INITIALIZATION_FAILED");
          const serialized = JSON.stringify(error.data);
          assert.equal(serialized.includes("fake-kimi-server-token"), false);
          assert.equal(serialized.includes("Kimi server:"), false);
          assert.equal(serialized.includes("ordinary Kimi"), false);
          return true;
        },
      );
    } finally {
      await unexpectedRuntime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Kimi accepts the current Local ready line without dropping legacy compatibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-kimi-current-ready-"));
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [kimiAdapter({
        env: { PATH: controlledPath, MUHA_FAKE_KIMI_SCENARIO: "current-ready" },
        startupTimeoutMs: 200,
        shutdownTimeoutMs: 200,
      })],
      dataDir: join(root, "diagnostics"),
    });
    assert.equal(runtime.status, "active");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi bounded close forcefully reclaims an unresponsive server", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-kimi-unresponsive-close-"));
  const workspace = join(root, "workspace");
  const pidFile = join(root, "kimi.pid");
  let runtime;
  try {
    await mkdir(workspace);
    runtime = await createMuhaRuntime({
      harnesses: [kimiAdapter({
        env: {
          PATH: controlledPath,
          MUHA_FAKE_KIMI_SCENARIO: "ignore-term",
          MUHA_FAKE_PID_FILE: pidFile,
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 50,
      })],
      dataDir: join(root, "diagnostics"),
    });
    const session = await runtime.createSession({ harness: "kimi", workspacePath: workspace });
    await session.close();
    const pid = Number(await readFile(pidFile, "utf8"));
    await runtime.close();
    runtime = undefined;
    await assertPathEventuallyMissing(`/proc/${pid}`);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function assertPathEventuallyMissing(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.fail(`${path} still exists`);
}
