import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agyAdapter } from "@muha-sdk/agy-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const base = resolve(".scratch/agy-native-qualification");
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, "policy-crash-"));
const workspacePath = join(root, "workspace");
await mkdir(workspacePath);
const model = "claude-opus-4-6-thinking";
const report = { root, model, version: execFileSync("agy", ["--version"], { encoding: "utf8" }).trim(),
  checks: [], turns: [], failures: [] };
console.log(JSON.stringify({ evidence: root }));
let runtime;
async function execute(session, name) {
  const turn = await session.startTurn([{ type: "text", text:
    `Use only run_command to execute exactly: printf MUHA_POLICY_PROOF > '${name}'\nDo not use another tool, change permissions, or retry a denied command. Briefly report the outcome.` }]);
  const events = [];
  for await (const event of turn) events.push(event);
  const result = await turn.result;
  report.turns.push({ result, events });
  assert.equal(events.some(event => event.type.startsWith("approval.")), false);
  return result;
}
async function children(pid) {
  return (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/u).filter(Boolean).map(Number);
}
try {
  runtime = await createMuhaRuntime({ dataDir: join(root, "before"), harnesses: [agyAdapter()] });
  let session = await runtime.createSession({ harness: "agy", workspacePath, model, approvalPolicy: "autoApprove" });
  const reference = structuredClone(session.reference);
  report.reference = reference;
  assert.equal((await execute(session, "allowed.txt")).status, "completed");
  assert.equal(await readFile(join(workspacePath, "allowed.txt"), "utf8"), "MUHA_POLICY_PROOF");
  report.checks.push("autoApprove performs an ordinary command write before native crash");
  // Qualification-only fault injection: identify a direct child of this
  // process, then its sole native CLI. This is not Adapter reclamation logic.
  const owned = [];
  for (const pid of await children(process.pid)) {
    const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    if (args.includes(workspacePath) && args[0].endsWith("/agy-supervisor")) owned.push(pid);
  }
  assert.equal(owned.length, 1);
  const native = await children(owned[0]);
  assert.equal(native.length, 1, "the idle qualification CLI has no tool process");
  report.faultTarget = { helperPid: owned[0], nativePid: native[0] };
  process.kill(native[0], "SIGKILL");
  assert.equal((await runtime.termination).reason, "fatal");
  assert.equal(runtime.status, "closed");
  await runtime.close();
  runtime = await createMuhaRuntime({ dataDir: join(root, "after"), harnesses: [agyAdapter()] });
  session = await runtime.resumeSession({ reference, model, approvalPolicy: "harnessManaged" });
  await execute(session, "denied-after-crash.txt");
  assert.deepEqual(session.reference, reference);
  await assert.rejects(access(join(workspacePath, "denied-after-crash.txt")), error => error.code === "ENOENT");
  assert.ok(report.turns.at(-1).events.some(event => event.type === "tool.completed" && event.isError));
  report.checks.push("explicit same-ID resume after fatal crash restores native baseline permissions");
} catch (error) {
  report.failures.push(error?.data ?? { message: String(error), stack: error?.stack });
  process.exitCode = 1;
} finally {
  try { await runtime?.close(); }
  catch (error) { report.failures.push(error?.data ?? { message: String(error) }); process.exitCode = 1; }
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ root, checks: report.checks, failures: report.failures }));
}
