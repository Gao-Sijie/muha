import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agyAdapter } from "@muha-sdk/agy-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const base = resolve(".scratch/agy-native-qualification");
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, "adapter-"));
const workspacePath = join(root, "workspace");
await mkdir(workspacePath);
const report = { root, model: "claude-opus-4-6-thinking", version: execFileSync("agy", ["--version"], { encoding: "utf8" }).trim(),
  startedAt: new Date().toISOString(), checks: [], failures: [] };
let runtime;
async function finish(turn) {
  for await (const _event of turn) { /* Drain the public backlog. */ }
  return turn.result;
}
console.log(JSON.stringify({ evidence: root }));
try {
  runtime = await createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter({ startupTimeoutMs: 60_000, shutdownTimeoutMs: 10_000 })] });
  report.checks.push("native readiness");
  console.log("Native readiness passed");
  const session = await runtime.createSession({ harness: "agy", workspacePath,
    model: report.model, approvalPolicy: "autoApprove" });
  const reference = structuredClone(session.reference);
  report.reference = reference;
  const turn = await session.startTurn([{ type: "text", text: "Reply with exactly MUHA_AGY_ADAPTER_READY. Do not use tools." }]);
  const result = await finish(turn);
  assert.equal(result.status, "completed");
  assert.equal(result.message.text.trim(), "MUHA_AGY_ADAPTER_READY");
  report.checks.push("public text Turn");
  await session.close();
  const resumed = await runtime.resumeSession({ reference, model: report.model, approvalPolicy: "autoApprove" });
  assert.deepEqual(resumed.reference, reference);
  const recall = await resumed.startTurn([{ type: "text", text: "Repeat the exact marker I asked you to reply with in my previous message. Do not use tools." }]);
  assert.equal((await finish(recall)).message.text.trim(), "MUHA_AGY_ADAPTER_READY");
  report.checks.push("public known-reference resume and history");
  const heartbeat = join(workspacePath, "heartbeat.txt");
  const program = `import time; from pathlib import Path; p=Path(${JSON.stringify(heartbeat)}); end=time.time()+180\nwhile time.time()<end:\n p.write_text(str(time.time())); time.sleep(0.1)`;
  const command = `python3 -c '${program.replaceAll("'", "'\\''")}'`;
  const working = await resumed.startTurn([{ type: "text", text:
    `Use run_command to execute exactly this command and wait until it finishes. Do not change the loop duration or use another file tool:\n${command}` }]);
  const interruptedResult = finish(working);
  const deadline = Date.now() + 90_000;
  while (!(await readFile(heartbeat, "utf8").catch(() => ""))) {
    assert.ok(Date.now() < deadline, "external qualification guard: real tool heartbeat did not start");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await working.interrupt();
  assert.equal((await interruptedResult).status, "interrupted");
  const stopped = await readFile(heartbeat, "utf8");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await readFile(heartbeat, "utf8"), stopped);
  const continued = await resumed.startTurn([{ type: "text", text:
    "Repeat the exact MUHA_AGY_ marker I asked for at the start of this conversation. Do not use tools." }]);
  const continuation = await finish(continued);
  assert.equal(continuation.status, "completed");
  assert.equal(continuation.message.text.trim(), "MUHA_AGY_ADAPTER_READY");
  assert.deepEqual(resumed.reference, reference);
  report.checks.push("public interrupt stops real tool writes and the same handle continues original history");
} catch (error) {
  report.failures.push(error?.data ?? { message: String(error), stack: error?.stack });
  process.exitCode = 1;
} finally {
  try { await runtime?.close(); } catch (error) { report.failures.push(error?.data ?? { message: String(error) }); process.exitCode = 1; }
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
