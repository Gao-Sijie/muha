import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("a PID file is not ready until it contains a valid process ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-pid-file-contract-"));
  const pidFile = join(root, "child.pid");
  try {
    await writeFile(pidFile, "");
    const expectedPid = process.pid;
    const pending = readNumberFileEventually(pidFile);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    await writeFile(pidFile, String(expectedPid));
    assert.equal(await pending, expectedPid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a caller can create and close a Codex-backed Muha Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-runtime-contract-"));
  const actualDataDir = join(root, "diagnostics");
  const dataDirAlias = join(root, "diagnostics-link");
  const pidFile = join(root, "codex.pid");
  const descendantPidFile = join(root, "codex-descendant.pid");
  const descendantMarker = `muha-contract-${root}`;
  let descendantPid;
  const observedListeners = new Map(
    ["SIGINT", "SIGTERM", "beforeExit", "uncaughtException", "unhandledRejection"].map(
      (event) => [event, process.listenerCount(event)],
    ),
  );

  await mkdir(actualDataDir);
  await symlink(actualDataDir, dataDirAlias, "dir");

  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_PID_FILE: pidFile,
            MUHA_FAKE_DESCENDANT_PID_FILE: descendantPidFile,
            MUHA_FAKE_DESCENDANT_MARKER: descendantMarker,
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: dataDirAlias,
    });

    assert.match(
      runtime.runtimeId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(runtime.dataDir, await realpath(actualDataDir));
    assert.deepEqual(runtime.enabledHarnesses, ["codex"]);
    assert.equal(runtime.status, "active");
    assert.equal(
      await Promise.race([
        runtime.termination.then(() => "settled"),
        new Promise((resolvePending) =>
          setTimeout(() => resolvePending("pending"), 20),
        ),
      ]),
      "pending",
    );
    await access(join(actualDataDir, "diagnostic-events.sqlite"));

    const pid = await readNumberFileEventually(pidFile);
    descendantPid = await readNumberFileEventually(descendantPidFile);
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);

    await Promise.all([runtime.close(), runtime.close()]);
    assert.equal(runtime.status, "closed");
    assert.deepEqual(await runtime.termination, { reason: "callerClosed" });
    await assertPathEventuallyMissing(`/proc/${pid}`);
    await assertPathEventuallyMissing(`/proc/${descendantPid}`);

    for (const [event, count] of observedListeners) {
      assert.equal(process.listenerCount(event), count, event);
    }
  } finally {
    await runtime?.close().catch(() => undefined);
    if (Number.isSafeInteger(descendantPid) && descendantPid > 1) {
      try {
        const commandLine = await readFile(`/proc/${descendantPid}/cmdline`, "utf8");
        if (commandLine.includes(descendantMarker)) {
          process.kill(descendantPid, "SIGKILL");
        }
      } catch {
        // The descendant is already gone, which is the required outcome.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid Runtime and Adapter options are rejected before Codex starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-invalid-runtime-contract-"));
  const dataDir = join(root, "must-not-exist");
  const pidFile = join(root, "must-not-start.pid");
  const registration = codexAdapter({
    env: {
      PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
      MUHA_FAKE_PID_FILE: pidFile,
    },
  });
  const invalidInputs = [
    { harnesses: [] },
    { harnesses: [registration, registration] },
    { harnesses: [registration], dataDir: "relative" },
    { harnesses: [registration], maxQueuedEventsPerTurn: 0 },
    { harnesses: [registration], maxQueuedEventBytesPerTurn: 1.5 },
    { harnesses: [registration], dataDir, unknown: true },
  ];

  try {
    for (const input of invalidInputs) {
      await assert.rejects(
        createMuhaRuntime(input),
        (error) =>
          error instanceof MuhaError && error.data.code === "INVALID_INPUT",
      );
    }
    assert.throws(
      () => codexAdapter({ startupTimeoutMs: 0 }),
      (error) =>
        error instanceof MuhaError && error.data.code === "INVALID_INPUT",
    );
    assert.throws(
      () => codexAdapter({ shutdownTimeoutMs: Number.MAX_VALUE }),
      (error) =>
        error instanceof MuhaError && error.data.code === "INVALID_INPUT",
    );
    await assert.rejects(access(dataDir), { code: "ENOENT" });
    await assert.rejects(access(pidFile), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing Codex command rolls back initialization and releases the Runtime guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-missing-codex-contract-"));
  const missingBin = join(root, "empty-bin");
  const failedDataDir = join(root, "failed-diagnostics");
  const recoveredDataDir = join(root, "recovered-diagnostics");
  await mkdir(missingBin);

  try {
    await assert.rejects(
      createMuhaRuntime({
        harnesses: [
          codexAdapter({
            env: { PATH: missingBin },
            startupTimeoutMs: 100,
            shutdownTimeoutMs: 100,
          }),
        ],
        dataDir: failedDataDir,
      }),
      (error) => {
        assert.ok(error instanceof MuhaError);
        assert.equal(error.data.code, "RUNTIME_INITIALIZATION_FAILED");
        if (error.data.code !== "RUNTIME_INITIALIZATION_FAILED") return false;
        assert.equal(error.data.initializationFailures.length, 1);
        assert.deepEqual(error.data.rollbackFailures, []);
        assert.deepEqual(error.data.initializationFailures[0], {
          code: "HARNESS_ERROR",
          message: "Codex spawn failed: spawn codex ENOENT",
          harness: "codex",
          operation: "initialize",
          command: "codex",
          stage: "spawn",
        });
        return true;
      },
    );

    const recovered = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: recoveredDataDir,
    });
    await recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unexecutable, early-exit, and unready Codex commands fail cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muha-failed-codex-contract-"));
  const cases = [
    {
      name: "unexecutable",
      source: "#!/usr/bin/env node\n",
      executable: false,
      expectedStage: "spawn",
    },
    {
      name: "early-exit",
      source:
        '#!/usr/bin/env node\nprocess.stderr.write("SECRET_NATIVE_OUTPUT\\n"); process.exit(42);\n',
      executable: true,
      expectedStage: "ready",
      expectedExitCode: 42,
    },
    {
      name: "unready",
      source:
        '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; writeFileSync(process.env.MUHA_FAKE_PID_FILE, String(process.pid)); setInterval(() => undefined, 1_000);\n',
      executable: true,
      expectedStage: "ready",
      timedOut: true,
    },
  ];

  try {
    for (const failureCase of cases) {
      const bin = join(root, `${failureCase.name}-bin`);
      const command = join(bin, "codex");
      const pidFile = join(root, `${failureCase.name}.pid`);
      await mkdir(bin);
      await writeFile(command, failureCase.source, { mode: 0o644 });
      if (failureCase.executable) await chmod(command, 0o755);

      // Observe the actual spawned PID, not a file written after Node boots.
      // Under load the valid 50 ms deadline may kill it before JS executes.
      const childProcess = (await import("node:child_process")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const originalSpawn = childProcess.spawn;
      let spawnedPid;
      const spy = t.mock.method(childProcess, "spawn", (...args) => {
        const child = originalSpawn(...args);
        if (args[2]?.env?.MUHA_FAKE_PID_FILE === pidFile) spawnedPid = child.pid;
        return child;
      });
      syncBuiltinESMExports();

      try {
      await assert.rejects(
        createMuhaRuntime({
          harnesses: [
            codexAdapter({
              env: {
                PATH: [bin, dirname(process.execPath)].join(delimiter),
                MUHA_FAKE_PID_FILE: pidFile,
              },
              startupTimeoutMs: failureCase.timedOut ? 50 : 2_000,
              shutdownTimeoutMs: 50,
            }),
          ],
          dataDir: join(root, `${failureCase.name}-diagnostics`),
        }),
        (error) => {
          assert.ok(error instanceof MuhaError);
          assert.equal(error.data.code, "RUNTIME_INITIALIZATION_FAILED");
          if (error.data.code !== "RUNTIME_INITIALIZATION_FAILED") return false;
          const [failure] = error.data.initializationFailures;
          assert.equal(failure?.code, "HARNESS_ERROR");
          if (!failure || failure.code !== "HARNESS_ERROR") return false;
          assert.equal(failure.harness, "codex");
          assert.equal(failure.operation, "initialize");
          assert.equal(failure.stage, failureCase.expectedStage);
          assert.equal(failure.exitCode, failureCase.expectedExitCode);
          assert.equal(failure.message.includes("SECRET_NATIVE_OUTPUT"), false);
          assert.deepEqual(error.data.rollbackFailures, []);
          return true;
        },
      );

      if (failureCase.timedOut) {
        assert.ok(Number.isSafeInteger(spawnedPid), "unready native process was spawned");
        await assertPathEventuallyMissing(`/proc/${spawnedPid}`);
      }
      } finally { spy.mock.restore(); syncBuiltinESMExports(); }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default data directory is isolated beneath the process home", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-default-data-contract-"));
  const isolatedHome = join(root, "home");
  await mkdir(isolatedHome);
  const controlledPath = [fakeHarnessBin, dirname(process.execPath)].join(delimiter);
  const program = `
    import { createMuhaRuntime } from "@muha-sdk/core";
    import { codexAdapter } from "@muha-sdk/codex-adapter";
    const runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({
        env: { PATH: process.env.MUHA_FAKE_PATH },
        startupTimeoutMs: 2000,
        shutdownTimeoutMs: 2000,
      })],
    });
    const active = {
      runtimeId: runtime.runtimeId,
      dataDir: runtime.dataDir,
      status: runtime.status,
    };
    await runtime.close();
    process.stdout.write(JSON.stringify({
      ...active,
      closedStatus: runtime.status,
      termination: await runtime.termination,
    }));
  `;

  try {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: isolatedHome,
          MUHA_FAKE_PATH: controlledPath,
        },
        timeout: 5_000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, "active");
    assert.equal(result.closedStatus, "closed");
    assert.deepEqual(result.termination, { reason: "callerClosed" });
    assert.equal(
      result.dataDir,
      join(isolatedHome, ".muha", result.runtimeId),
    );
    await access(join(result.dataDir, "diagnostic-events.sqlite"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only one main-process Runtime is live and close releases its guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-runtime-guard-contract-"));
  const registration = () =>
    codexAdapter({
      env: {
        PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    });
  let active;
  let recovered;

  try {
    active = await createMuhaRuntime({
      harnesses: [registration()],
      dataDir: join(root, "active"),
    });
    await assert.rejects(
      createMuhaRuntime({
        harnesses: [registration()],
        dataDir: join(root, "must-not-open"),
      }),
      (error) =>
        error instanceof MuhaError &&
        error.data.code === "RUNTIME_ALREADY_ACTIVE",
    );
    await assert.rejects(access(join(root, "must-not-open")), { code: "ENOENT" });

    await active.close();
    recovered = await createMuhaRuntime({
      harnesses: [registration()],
      dataDir: join(root, "recovered"),
    });
    assert.equal(recovered.status, "active");
  } finally {
    await recovered?.close();
    await active?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Worker Thread cannot create a Muha Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-worker-runtime-contract-"));
  const program = `
    import { parentPort } from "node:worker_threads";
    import { createMuhaRuntime } from "@muha-sdk/core";
    try {
      await createMuhaRuntime({ harnesses: [] });
      parentPort.postMessage({ code: "unexpected-success" });
    } catch (error) {
      parentPort.postMessage(error.data);
    }
  `;

  try {
    const worker = new Worker(program, { eval: true, type: "module" });
    const data = await new Promise((resolveMessage, rejectMessage) => {
      worker.once("message", resolveMessage);
      worker.once("error", rejectMessage);
    });
    assert.equal(data.code, "UNSUPPORTED_PLATFORM");
    await assert.rejects(access(join(root, "unused")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("close forcefully reclaims an unresponsive ready Codex within its bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-forced-close-contract-"));
  const pidFile = join(root, "unresponsive-codex.pid");
  let runtime;

  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_IGNORE_EOF: "1",
            MUHA_FAKE_PID_FILE: pidFile,
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 25,
        }),
      ],
      dataDir: join(root, "diagnostics"),
    });
    const pid = await readNumberFileEventually(pidFile);
    const startedAt = performance.now();
    const closing = runtime.close();
    assert.equal(runtime.status, "closing");
    await closing;
    assert.ok(performance.now() - startedAt < 1_000);
    assert.equal(runtime.status, "closed");
    assert.deepEqual(await runtime.termination, { reason: "callerClosed" });
    await assertPathEventuallyMissing(`/proc/${pid}`);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported runtime and host observations fail before any Harness starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-host-contract-"));
  const cases = [
    {
      setup:
        'Object.defineProperty(process.versions, "node", { value: "22.19.9" });',
      expectedCode: "UNSUPPORTED_RUNTIME",
    },
    {
      setup:
        'Object.defineProperty(process, "platform", { value: "darwin" });',
      expectedCode: "UNSUPPORTED_PLATFORM",
    },
    {
      setup: 'Object.defineProperty(process, "arch", { value: "arm64" });',
      expectedCode: "UNSUPPORTED_PLATFORM",
    },
    {
      setup:
        'Object.defineProperty(process, "report", { value: { getReport: () => ({ header: {} }) } });',
      expectedCode: "UNSUPPORTED_PLATFORM",
    },
  ];

  try {
    for (const hostCase of cases) {
      const program = `
        ${hostCase.setup}
        const { createMuhaRuntime } = await import("@muha-sdk/core");
        try {
          await createMuhaRuntime({ harnesses: [] });
          process.stdout.write(JSON.stringify({ code: "unexpected-success" }));
        } catch (error) {
          process.stdout.write(JSON.stringify(error.data));
        }
      `;
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", program],
        {
          cwd: resolve(import.meta.dirname, "../.."),
          encoding: "utf8",
          timeout: 2_000,
        },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.equal(JSON.parse(child.stdout).code, hostCase.expectedCode);
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readNumberFileEventually(path) {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      const value = Number(await readFile(path, "utf8"));
      if (Number.isSafeInteger(value) && value > 1) return value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error("PID file did not contain a valid process ID");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

async function assertPathEventuallyMissing(path) {
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      await access(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (Date.now() >= deadline) {
      await assert.rejects(access(path), { code: "ENOENT" });
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}
