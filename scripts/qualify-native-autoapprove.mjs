import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMuhaRuntime } from "@muha-sdk/core";
import { qualificationProfileFor } from "./real-harness-profiles.mjs";

// Opt-in real-model qualification. All requested writes stay under this run's
// isolated root. Keep the evidence; do not publish it or modify native user config.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const profile = qualificationProfileFor(process.argv[2]);
const sessionTreeOnly = process.argv[3] === "--session-tree";
const nativeBoundariesOnly = process.argv[3] === "--native-boundaries";
if (!profile || !(process.argv.length === 3 || (process.argv.length === 4 &&
    ((sessionTreeOnly && profile.harness === "opencode") || (nativeBoundariesOnly && profile.harness === "codex"))))) {
  throw new Error("Usage: node scripts/qualify-native-autoapprove.mjs <codex|kimi|opencode> [--session-tree (OpenCode) | --native-boundaries (Codex)]");
}
await qualifyNativeAutoapprove(profile, { sessionTreeOnly, nativeBoundariesOnly });
}

export async function qualifyNativeAutoapprove(profile, { sessionTreeOnly = false, nativeBoundariesOnly = false } = {}) {
const base = resolve(".cache/native-autoapprove");
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, `${profile.harness}-`));
const workspace = join(root, "workspace");
await mkdir(workspace);
await mkdir(join(root, "outside"));
const evidence = { harness: profile.harness, root, startedAt: new Date().toISOString(), checks: [], turns: [] };
evidence.version = execFileSync(profile.command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const configPaths = {
  codex: [join(homedir(), ".codex/config.toml")],
  kimi: [join(homedir(), ".kimi-code/config.toml")],
  opencode: [join(homedir(), ".config/opencode/opencode.json"), join(homedir(), ".config/opencode/opencode.jsonc")],
}[profile.harness];
const configBefore = await Promise.all(configPaths.map(digest));
let runtime;
let session;
let runNumber = 0;
const model = process.env[`MUHA_QUALIFY_${profile.harness.toUpperCase()}_MODEL`];
const nativeConfig = profile.harness === "opencode" ? join(workspace, "opencode.json") : undefined;
if (nativeConfig) {
  await writeFile(nativeConfig, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { bash: { "*": "ask", "printf MUHA_DENIED*": "deny" } },
  }));
}
const initialConfig = nativeConfig ? await digest(nativeConfig) : undefined;
process.stdout.write(`Evidence: ${root}\n`);
try {
  runtime = await startRuntime();
  session = await runtime.createSession({
    harness: profile.harness, workspacePath: workspace, approvalPolicy: "autoApprove",
    ...(model === undefined ? {} : { model }),
  });
  evidence.reference = session.reference;
  evidence.model = session.model;
  if (sessionTreeOnly) {
    for (const phase of ["created", "resumed"]) {
      if (phase === "resumed") {
        await session.close();
        session = await runtime.resumeSession({ reference: evidence.reference, approvalPolicy: "autoApprove" });
      }
      const target = join(root, "outside", `child-${phase}.txt`);
      const result = await turn(`child-${phase}`,
        `Use your task tool to launch a general subagent. Its only task is to execute exactly this bash command: printf MUHA_CHILD > ${target}. Require it to actually run the command, then return its tool result. Do not execute the command yourself, and do not use any other tools. Wait for the subagent to finish, then reply briefly.`);
      assert.equal(await readFile(target, "utf8"), "MUHA_CHILD");
      assert.ok(result.events.some((event) => event.type === "approval.requested" &&
        typeof event.details?.nativeSessionId === "string" && event.details.nativeSessionId !== session.reference.sessionId),
      "must observe an actual descendant Approval Request");
      evidence.checks.push(`actual-child-approval-${phase}`);
    }
  } else if (nativeBoundariesOnly) {
    const protectedTarget = join(root, "outside/protected.txt");
    await writeFile(protectedTarget, "UNCHANGED", { mode: 0o400 });
    const denied = await turn("native-os-deny",
      `Use your shell tool to run exactly: printf CHANGED > ${protectedTarget}\nDo not chmod, delete, replace or work around the file. Attempt only this command, then report the result.`,
      { allowNativeDenial: true });
    assert.equal(await readFile(protectedTarget, "utf8"), "UNCHANGED");
    assert.equal(denied.events.some(({ type }) => type.startsWith("approval.")), false);
    assert.ok(denied.events.some((event) => event.type === "tool.completed" &&
      (event.isError || /permission denied/i.test(JSON.stringify(event.output)))));
    evidence.checks.push("native-os-deny-without-fabricated-approval");
    await turn("native-question-auto",
      "Use request_user_input to ask me to choose red or blue. This is a test of the structured Question lifecycle. Do not choose for me or use an ordinary text question.",
      { interruptAtQuestion: true });
    evidence.checks.push("native-question-survives-autoapprove");
  } else {
    const nonce = "MUHA_PHASE3_CONTEXT";
    await turn("context", `Remember ${nonce} for later. Reply with exactly ${nonce}; do not use tools.`);
    await writeProbe("auto-create", true);
    await session.close();
    session = await runtime.resumeSession({ reference: evidence.reference, approvalPolicy: "autoApprove" });
    await writeProbe("auto-resume", true);
    await session.close();
    await runtime.close();
    runtime = await startRuntime();
    session = await runtime.resumeSession({ reference: evidence.reference, approvalPolicy: "autoApprove" });
    const remembered = await turn("context-after-restart", "What exact MUHA identifier did I ask you to remember? Reply with it only. Do not use tools.");
    assert.ok(remembered.result.message.text.includes(nonce), "native context must survive Runtime restart");
    evidence.checks.push("context-after-restart");
    for (const policy of ["interactive", "autoDeny"]) {
      await session.close();
      session = await runtime.resumeSession({ reference: evidence.reference, approvalPolicy: policy });
      await writeProbe(`resume-${policy}`, false);
    }
    // Keep two different policies alive in the same Runtime and Workspace.
    await session.close();
    const deniedSession = await runtime.createSession({
      harness: profile.harness, workspacePath: workspace, approvalPolicy: "autoDeny",
      ...(model === undefined ? {} : { model }),
    });
    session = await runtime.createSession({
      harness: profile.harness, workspacePath: workspace, approvalPolicy: "autoApprove",
      ...(model === undefined ? {} : { model }),
    });
    await writeProbe("isolated-auto", true);
    const autonomousSession = session;
    session = deniedSession;
    await writeProbe("isolated-deny", false);
    await autonomousSession.close();
    evidence.checks.push("same-workspace-policy-isolation");
    await session.close();
    session = await runtime.createSession({
      harness: profile.harness, workspacePath: workspace, approvalPolicy: "autoApprove",
      ...(model === undefined ? {} : { model }),
    });
    if (profile.harness === "opencode") {
      const deniedTarget = join(root, "outside/native-deny.txt");
      const denied = await turn("explicit-native-deny",
        `Run exactly this bash command once: printf MUHA_DENIED > ${deniedTarget}\nDo not use another command or tool. If refused, stop and report the refusal.`,
        { allowNativeDenial: true });
      assert.equal(await digest(deniedTarget), null);
      assert.equal(denied.events.some(({ type }) => type.startsWith("approval.")), false);
      assert.ok(denied.events.some((event) => event.type === "tool.completed" && event.isError));
      evidence.checks.push("explicit-native-deny-without-approval");
    }
    const interrupted = await turn("interrupt-active-tool", "Run exactly sleep 30 in your shell tool, then reply done.", { interruptAtTool: true });
    assert.equal(interrupted.result.status, "interrupted");
    await turn("continue-after-interrupt", "Reply CONTINUED only, without tools.");
    evidence.checks.push("interrupt-and-continue");
    const crashReference = session.reference;
    const ownedPids = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
    assert.equal(ownedPids.length, 1, "abnormal-exit probe requires exactly one directly owned Harness process");
    process.kill(ownedPids[0], "SIGKILL");
    await runtime.termination;
    await runtime.close().catch(() => undefined);
    runtime = await startRuntime();
    for (const policy of ["interactive", "autoDeny"]) {
      session = await runtime.resumeSession({ reference: crashReference, approvalPolicy: policy });
      await writeProbe(`after-crash-${policy}`, false);
      await session.close();
    }
    evidence.checks.push("abnormal-native-exit-policy-replacement");
  }
  if (nativeConfig) assert.equal(await digest(nativeConfig), initialConfig, "Workspace permission configuration changed");
  evidence.checks.push("workspace-config-unchanged");
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error?.data ?? { name: error?.name, message: error?.message };
  process.exitCode = 1;
} finally {
  await runtime?.close().catch((error) => { evidence.closeError = error?.data ?? error?.message; process.exitCode = 1; });
  const configAfter = await Promise.all(configPaths.map(digest));
  evidence.userConfigUnchanged = JSON.stringify(configBefore) === JSON.stringify(configAfter);
  if (!evidence.userConfigUnchanged) { evidence.status = "failed"; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(root, "summary.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

async function startRuntime() {
  return createMuhaRuntime({
    harnesses: [profile.registration({ startupTimeoutMs: 60_000, shutdownTimeoutMs: 10_000 })],
    dataDir: join(root, `diagnostics-${++runNumber}`),
  });
}

async function turn(label, prompt, { allowNativeDenial = false, interruptAtTool = false, interruptAtQuestion = false } = {}) {
  process.stdout.write(`Running ${label}\n`);
  const activeSession = session;
  const handle = await activeSession.startTurn([{ type: "text", text: prompt }]);
  const events = [];
  let timedOut = false;
  let interrupted = false;
  let toolStarted = false;
  let questionRequested = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void handle.interrupt().catch(() => runtime.close());
  }, 120_000);
  try {
    for await (const event of handle) {
      events.push(event);
      if (event.type === "tool.started") toolStarted = true;
      if (event.type === "approval.requested" && activeSession.approvalPolicy === "interactive") {
        await handle.respondToApproval(event.requestId, "deny");
      }
      if (event.type === "question.requested") {
        questionRequested = true;
        interrupted = true;
        await handle.interrupt();
      }
      if (interruptAtTool && !interrupted && event.type === "tool.started") {
        interrupted = true;
        await handle.interrupt();
      }
    }
    const result = await handle.result;
    await writeFile(join(root, `${label}.json`), `${JSON.stringify({ events, result }, null, 2)}\n`, { mode: 0o600 });
    evidence.turns.push({ label, status: result.status, timedOut,
      approvals: events.filter((event) => event.type === "approval.resolved").map(({ outcome, source }) => ({ outcome, source })),
      questions: events.filter((event) => event.type === "question.requested").length,
    });
    assert.equal(timedOut, false, `${label} timed out`);
    assert.equal(events.filter((event) => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)).length, 1);
    if (interruptAtTool || interruptAtQuestion) {
      assert.ok(interruptAtTool ? toolStarted : questionRequested, "the requested native interaction must occur before interruption");
      assert.equal(result.status, "interrupted");
    } else if (!(allowNativeDenial && isObservedNativeDenial({ result, events }))) {
      assert.equal(result.status, "completed", `${label}: ${JSON.stringify(result)}`);
    }
    const requests = events.filter((event) => event.type === "approval.requested");
    const resolutions = events.filter((event) => event.type === "approval.resolved");
    assert.deepEqual(requests.map(({ requestId }) => requestId).sort(), resolutions.map(({ requestId }) => requestId).sort());
    return { result, events };
  } finally { clearTimeout(timer); }
}

async function writeProbe(label, allowed) {
  const target = join(root, "outside", `${label}.txt`);
  const command = `printf MUHA_PHASE3_WRITE > ${target}`;
  const permissionProbe = !allowed && profile.harness === "codex"
    ? '\nThis is a permission-control test: call exec_command with sandbox_permissions="require_escalated" and a justification for this exact temporary-file write. Let the native permission mechanism decide; do not replace the tool call with a prediction of denial.' : '';
  const prompt = `Use your shell tool to execute exactly this command once: ${command}\nDo not use any other tool or command. If permission is denied, stop and report the denial; do not try another method. After the tool result, reply briefly.${permissionProbe}`;
  let result = await turn(label, prompt, { allowNativeDenial: !allowed });
  if (!result.events.some(({ type }) => type === "tool.started" || type === "approval.requested")) {
    // Model refusal to even attempt a tool is not a permissions result. One
    // explicit retry may obtain an actual native decision; otherwise fail.
    result = await turn(`${label}-tool-attempt`,
      `Your previous reply did not attempt the tool. This is a new permission test with a newly selected Session policy; do not infer the result from earlier turns. ${prompt}`,
      { allowNativeDenial: !allowed });
  }
  let contents;
  try { contents = await readFile(target, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.equal(contents, allowed ? "MUHA_PHASE3_WRITE" : undefined, `${label} actual write differs from selected policy`);
  if (!allowed) {
    assert.ok(result.events.some((event) => event.type === "approval.resolved" && event.outcome === "deny") ||
      result.events.some((event) => event.type === "tool.completed" && event.isError), "denial must exercise a native tool or Approval Request");
  }
  if (allowed && profile.harness !== "opencode") {
    assert.equal(result.events.some(({ type }) => type === "approval.requested"), false, "native autonomous execution unexpectedly requested approval");
  }
  if (allowed && profile.harness === "opencode") {
    assert.ok(result.events.some((event) => event.type === "approval.resolved" && event.outcome === "allowOnce" && event.source === "policy"));
  }
  evidence.checks.push(label);
}
}

export function isObservedNativeDenial({ result, events }) {
  if (!events.some(event => event.type === "tool.completed" && event.isError)) return false;
  if (result.status === "failed") return result.error.code === "HARNESS_ERROR";
  // Codex ACP's native reject-once option can be "cancel": its real terminal
  // is interrupted/harness. Do not fabricate completed or accept a caller
  // interrupt, a timeout, or interruption without the observed deny decision.
  return result.status === "interrupted" && result.reason === "harness" &&
    events.some(event => event.type === "approval.resolved" && event.outcome === "deny");
}

async function digest(path) {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
