import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { agyAdapter } from "@muha-sdk/agy-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

test("AGY missing CLI rejects Runtime initialization without crashing the consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-missing-"));
  try {
    await assert.rejects(createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter({
      env: { PATH: root }, startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000,
    })] }), error => error.data?.code === "RUNTIME_INITIALIZATION_FAILED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AGY cleanup failure closes Runtime, settles its Turn, and aggregates a Harness shutdown failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-cleanup-failure-"));
  let runtime, guard;
  try {
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    runtime = await createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter({
      env: { HOME: join(root, "home"), PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter) },
      startupTimeoutMs: 2_000, shutdownTimeoutMs: 500,
    })] });
    const session = await runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "harnessManaged" });
    const turn = await session.startTurn([{ type: "text", text: "Wait without tools." }]);
    const cliPid = Number(await readFile(join(workspacePath, `${session.reference.sessionId}.pid`), "utf8"));
    const status = await readFile(`/proc/${cliPid}/status`, "utf8");
    const helperPid = Number(/^PPid:\s+(\d+)/mu.exec(status)[1]);
    process.kill(helperPid, "SIGSTOP");
    await assert.rejects(turn.interrupt(), error => error.data?.code === "RUNTIME_CLOSED");
    const result = await Promise.race([turn.result, new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error("cleanup failure left Turn pending")), 2_000);
    })]);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.equal((await runtime.termination).reason, "fatal");
    assert.equal(runtime.status, "closed");
    await assert.rejects(runtime.close(), error => error.data?.code === "RUNTIME_CLOSE_FAILED" &&
      error.data.failures.some(failure => failure.harness === "agy" && failure.operation === "closeHarness"));
  } finally {
    clearTimeout(guard);
    await runtime?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("AGY process loss fails its Turn, interrupts other Sessions, and irreversibly closes Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-fatal-"));
  let runtime;
  try {
    runtime = await createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter({
      env: { HOME: join(root, "home"), PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter) },
      startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
    })] });
    const workspaces = [join(root, "first"), join(root, "second")];
    const sessions = [];
    const turns = [];
    for (const workspacePath of workspaces) {
      await mkdir(workspacePath);
      sessions.push(await runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "autoApprove" }));
      turns.push(await sessions.at(-1).startTurn([{ type: "text", text: "Keep working until interrupted." }]));
    }
    const pid = Number(await readFile(join(workspaces[0], `${sessions[0].reference.sessionId}.pid`), "utf8"));
    process.kill(pid, "SIGKILL");
    const failed = await turns[0].result;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "HARNESS_ERROR");
    const other = await turns[1].result;
    assert.equal(other.status, "interrupted");
    assert.equal(other.reason, "runtimeClosed");
    const termination = await runtime.termination;
    assert.equal(termination.reason, "fatal");
    assert.equal(runtime.status, "closed");
    for (const session of sessions) assert.deepEqual(session.status, { status: "closed" });
  } finally {
    try { await runtime?.close(); }
    catch (error) { assert.fail(JSON.stringify(error.data)); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("AGY interruption stops detached work and the same Session handle can continue its native history", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-interrupt-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, "source.txt"), "evidence");
  let runtime;
  try {
    runtime = await createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter({
      env: { HOME: join(root, "home"), PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter) },
      startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
    })] });
    const session = await runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "autoApprove" });
    const reference = structuredClone(session.reference);
    await (await session.startTurn([{ type: "text", text: "Read workspace." }])).result;
    const turn = await session.startTurn([{ type: "text", text: "Keep working until interrupted." }]);
    const heartbeat = join(workspacePath, "heartbeat.txt");
    const deadline = Date.now() + 2_000;
    while (!(await readFile(heartbeat, "utf8").catch(() => ""))) {
      assert.ok(Date.now() < deadline, "native detached work must start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await turn.interrupt();
    assert.equal((await turn.result).status, "interrupted");
    const stopped = await readFile(heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await readFile(heartbeat, "utf8"), stopped);
    let timer;
    const next = await Promise.race([
      session.startTurn([{ type: "text", text: "Recall my previous input." }]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("same handle did not accept its next Turn")), 2_000); }),
    ]).finally(() => clearTimeout(timer));
    assert.equal((await next.result).message.text, "Keep working until interrupted.");
    assert.deepEqual(session.reference, reference);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
