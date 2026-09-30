import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AcpConnection } from "../../packages/core/dist/acp/connection.js";
import { AcpOwnedProcess } from "../../packages/core/dist/acp/owned-process.js";

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("helper death reports ownership loss even while native descendants hold stdout open", { timeout: 4000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-helper-loss-"));
  const pidsFile = join(root, "pids.json");
  const losses = [];
  const owned = new AcpOwnedProcess(process.execPath,
    [new URL("../fixtures/acp-owned-process.mjs", import.meta.url).pathname],
    { ...process.env, MUHA_TEST_OWNED_PIDS: pidsFile }, 150, message => losses.push(message));
  let pids = [];
  try {
    for (let i = 0; i < 100 && !pids.length; i++) {
      pids = await readFile(pidsFile, "utf8").then(JSON.parse, () => []);
      if (!pids.length) await delay(10);
    }
    assert.equal(pids.length, 3);
    const exited = once(owned.child, "exit");
    owned.child.kill("SIGKILL");
    await exited;
    assert.ok(losses.length > 0, "loss notification must not wait for descendant-held stdio to close");
    await assert.rejects(owned.close(), /cleanup|supervisor/i);
    assert.ok(owned.child.stdin.destroyed && owned.child.stdout.destroyed && owned.child.stderr.destroyed,
      "failed cleanup must release the consumer's pipe handles without claiming descendant reclamation");
  } finally {
    // This test asserts failure reporting, not successful cleanup on helper
    // loss. Rescue only the isolated fixture PIDs, leaves before parents.
    for (const pid of [...pids].reverse()) {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
      if (command.includes("acp-owned-process.mjs")) { process.kill(pid, "SIGKILL"); await delay(25); }
    }
    await owned.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP close reaps SIGTERM-resistant descendants, is repeatable, and preserves unrelated processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-ownership-"));
  const pidsFile = join(root, "owned.json");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const unrelatedExit = once(unrelated, "exit");
  const losses = [];
  const connection = new AcpConnection({
    command: process.execPath, args: [new URL("../fixtures/acp-owned-process.mjs", import.meta.url).pathname],
    env: { MUHA_TEST_OWNED_PIDS: pidsFile }, startupTimeoutMs: 2000, shutdownTimeoutMs: 200,
  }, { onNotification() {}, onLoss: error => losses.push(error) }, { harness: "opencode", command: process.execPath });
  let pids = [];
  try {
    await connection.connect(1);
    pids = JSON.parse(await readFile(pidsFile, "utf8"));
    assert.equal(pids.length, 3);
    assert.ok(pids.every(alive));
    const closes = Promise.all([connection.close(), connection.close()]);
    const settled = await Promise.race([closes.then(() => true), delay(750).then(() => false)]);
    assert.equal(settled, true, "close must force cleanup without first waiting for native exit");
    assert.ok(pids.every(pid => !alive(pid)), "all owned descendants must be reaped before close returns");
    await connection.close();
    assert.ok(alive(unrelated.pid));
    assert.deepEqual(losses, []);
  } finally {
    // Rescue only the explicit fixture PIDs when running the intentionally-red test.
    if (pids.length === 0) pids = await readFile(pidsFile, "utf8").then(JSON.parse, () => []);
    for (const pid of pids.reverse()) if (alive(pid)) process.kill(pid, "SIGKILL");
    await connection.close();
    unrelated.kill("SIGKILL");
    await unrelatedExit;
    await rm(root, { recursive: true, force: true });
  }
});
