import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agyAdapter } from "@muha-sdk/agy-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const base = resolve(".scratch/agy-native-qualification");
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, "workspace-"));
const workspacePath = join(root, "workspace");
await mkdir(workspacePath);
const model = "claude-opus-4-6-thinking";
const report = { root, model, version: execFileSync("agy", ["--version"], { encoding: "utf8" }).trim(),
  startedAt: new Date().toISOString(), checks: [], turns: [], failures: [] };
console.log(JSON.stringify({ evidence: root }));
let runtime;
async function execute(session, text) {
  const turn = await session.startTurn([{ type: "text", text }]);
  const events = [];
  for await (const event of turn) events.push(event);
  const result = await turn.result;
  report.turns.push({ reference: session.reference, events, result });
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(events.some(event => event.type.startsWith("approval.")), false);
  return result;
}
async function command(session, name, allowed) {
  const marker = randomUUID();
  const result = await execute(session,
    `Use only run_command to execute exactly: printf '${marker}' > '${name}'\nDo not use a file edit tool or retry denied commands. Report the outcome.`);
  if (allowed) {
    assert.equal(result.status, "completed");
    assert.equal(await readFile(join(workspacePath, name), "utf8"), marker);
  } else {
    await assert.rejects(access(join(workspacePath, name)), error => error.code === "ENOENT");
    assert.ok(report.turns.at(-1).events.some(event => event.type === "tool.completed" && event.isError));
  }
}
async function install(version) {
  const source = join(workspacePath, `source-${version}`, "muha-agy-proof");
  await mkdir(source, { recursive: true });
  const marker = `RESOURCE_${randomUUID()}`;
  await writeFile(join(source, "SKILL.md"), "---\nname: muha-agy-proof\ndescription: Read a local qualification resource when explicitly requested.\n---\n\nRead payload.txt beside this Skill and report its exact contents.\n");
  await writeFile(join(source, "payload.txt"), marker);
  if (version === 1) await writeFile(join(source, "obsolete.txt"), "obsolete");
  const result = await runtime.configureWorkspace({ workspacePath,
    skills: [{ source: `./source-${version}`, skillNames: ["muha-agy-proof"] }] });
  assert.deepEqual(result.attempts.map(attempt => attempt.status), ["succeeded"]);
  if (version === 2) await assert.rejects(access(join(workspacePath, ".agents/skills/muha-agy-proof/obsolete.txt")), error => error.code === "ENOENT");
  return marker;
}
async function useSkill(session, marker) {
  const result = await execute(session, "Find the installed muha-agy-proof Skill using native Skill discovery, read its payload.txt resource, and follow its instructions. Reply with the resource contents exactly. Do not use the source-* directories.");
  assert.equal(result.status, "completed");
  assert.ok(result.message.text.includes(marker), "the resource marker was never supplied in the prompt");
}
try {
  runtime = await createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter()] });
  let session = await runtime.createSession({ harness: "agy", workspacePath, model, approvalPolicy: "harnessManaged" });
  const reference = structuredClone(session.reference);
  await command(session, "denied-before.txt", false);
  report.checks.push("native baseline command denial");
  await session.close();
  session = await runtime.resumeSession({ reference, model, approvalPolicy: "autoApprove" });
  await command(session, "allowed-after-resume.txt", true);
  report.checks.push("autoApprove resume performs a real command write");
  const marker1 = await install(1);
  const peer = await runtime.createSession({ harness: "agy", workspacePath, model, approvalPolicy: "autoApprove" });
  assert.notEqual(peer.reference.sessionId, reference.sessionId);
  await useSkill(peer, marker1);
  await peer.close();
  await useSkill(session, marker1);
  report.checks.push("independent Projects discover the same physical Workspace Skill and resource");
  await session.close();
  session = await runtime.resumeSession({ reference, model, approvalPolicy: "harnessManaged" });
  await command(session, "denied-after-omit.txt", false);
  report.checks.push("omitting skip-permissions on resume restores the native baseline");
  const marker2 = await install(2);
  assert.deepEqual(session.reference, reference);
  await session.close();
  session = await runtime.resumeSession({ reference, model, approvalPolicy: "autoApprove" });
  await useSkill(session, marker2);
  assert.deepEqual(session.reference, reference);
  report.checks.push("same native Session reads replacement Skill after normal close and resume");
} catch (error) {
  report.failures.push(error?.data ?? { message: String(error), stack: error?.stack });
  process.exitCode = 1;
} finally {
  try { await runtime?.close(); }
  catch (error) { report.failures.push(error?.data ?? { message: String(error) }); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ root, checks: report.checks, failures: report.failures }));
}
