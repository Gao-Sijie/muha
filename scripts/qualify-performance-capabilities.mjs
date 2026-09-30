import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createMuhaRuntime } from "@muha-sdk/core";
import { qualificationProfileFor, qualificationTurnRetryPolicy } from "./real-harness-profiles.mjs";
import { trustKimiQualificationWorkspace } from "./kimi-qualification-trust.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [harness, mode, ...extra] = process.argv.slice(2);
  const profile = qualificationProfileFor(harness);
  const key = profile && `MUHA_QUALIFY_${harness.toUpperCase()}_MODEL`;
  if (!profile || extra.length || !["--approval", "--skills", "--mcp"].includes(mode)) {
    process.stderr.write("Specify one explicit Harness (codex|opencode|kimi|agy|pi) and --approval, --skills, or --mcp.\n");
    process.exitCode = 2;
  } else if (process.env[key] !== profile.qualificationModel) {
    process.stderr.write(`${key} must equal ${profile.qualificationModel}.\n`);
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await qualifyCapabilities(profile, mode))}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ status: "FAIL", harness, mode,
        code: error?.data?.code ?? error?.code ?? "UNKNOWN" })}\n`);
      process.exitCode = 1;
    }
  }
}

export function assertApprovalEvidence({ events, result }, { policy, allowed, harness, nativePermissions }) {
  assert.equal(events.filter(event => /^turn\.(completed|failed|interrupted)$/.test(event.type)).length, 1);
  const requests = events.filter(event => event.type === "approval.requested");
  const resolutions = events.filter(event => event.type === "approval.resolved");
  assert.deepEqual(requests.map(event => event.requestId).sort(), resolutions.map(event => event.requestId).sort());
  // v2 removes wholly denied tools before model inference. Require independent
  // native rule evidence: an empty event stream alone is merely NOT_TRIGGERED.
  if (harness === "opencode" && policy === "autoDeny" && !allowed &&
      JSON.stringify(nativePermissions) === JSON.stringify([{ action: "*", resource: "*", effect: "deny" }]) &&
      !events.some(event => event.type === "tool.started")) {
    assert.equal(result.status, "completed");
    assert.equal(requests.length, 0);
    return;
  }
  assert.ok(events.some(event => event.type === "tool.started"), "model must actually attempt a native Tool");
  if (allowed) {
    assert.equal(result.status, "completed");
    assert.ok(events.some(event => event.type === "tool.completed" && !event.isError));
  } else {
    assert.ok(events.some(event => event.type === "tool.completed" && event.isError) ||
      resolutions.some(event => event.outcome === "deny"), "must observe a native denial, not model refusal");
  }
  if (policy === "interactive") {
    assert.ok(requests.length > 0, "interactive probe did not trigger a public Approval Request");
    assert.ok(resolutions.every(event => event.source === "caller" && event.outcome === (allowed ? "allowOnce" : "deny")));
  } else if (policy === "autoDeny") {
    assert.ok(resolutions.every(event => event.source === "policy" && event.outcome === "deny"));
  } else if (policy === "harnessManaged") {
    assert.equal(requests.length, 0, "harnessManaged must not fabricate public approvals");
  }
}

export function assertMcpEvidence({ events, result }, receipts) {
  assert.equal(result.status, "completed");
  assert.equal(receipts.length, 1, "MCP server must actually observe one tools/call");
  const started = new Set(events.filter(event => event.type === "tool.started").map(event => event.toolCallId));
  assert.ok(events.some(event => event.type === "tool.completed" && !event.isError &&
    started.has(event.toolCallId) && JSON.stringify(event.output)?.includes(receipts[0].proof)),
  "successful public Tool result must contain the server-generated proof");
}

// Qualification-only L2 inspection of the recorded inbound v2 rule event. This
// is not a public database API or a dependency of the product Adapter.
function recordedOpenCodePermissions(root, sessionId) {
  const db = new DatabaseSync(join(root, "diagnostics", "diagnostic-events.sqlite"), { readOnly: true });
  try {
    for (const row of db.prepare("SELECT payload_json FROM native_event_records WHERE harness = 'opencode' ORDER BY record_id DESC").all()) {
      const event = JSON.parse(row.payload_json);
      if (event.type === "session.permissions" && event.data?.sessionID === sessionId) return event.data.permissions;
    }
  } finally { db.close(); }
}

export async function qualifyCapabilities(profile, mode) {
  const root = await mkdtemp(join(tmpdir(), `muha-pf-${profile.harness}-`));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(join(root, "outside"));
  const git = args => spawnSync("git", args, { encoding: "utf8", timeout: 10_000 });
  const revision = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]);
  const version = profile.command && spawnSync(profile.command, ["--version"], { encoding: "utf8", timeout: 30_000 });
  const evidence = { status: "FAIL", harness: profile.harness, mode, model: profile.qualificationModel,
    sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
    sourceDirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
    harnessVersion: version?.status === 0 ? version.stdout.trim() : null, root, observations: [] };
  let runtime, session, revokeFixtureTrust;
  const terminate = () => { process.exitCode = 1; void runtime?.close(); };
  process.once("SIGTERM", terminate);
  try {
    if (profile.harness === "kimi" && mode === "--mcp") {
      revokeFixtureTrust = await trustKimiQualificationWorkspace(root, workspace);
      evidence.nativeFixtureTrust = "explicit-owned-workspace-only";
    }
    runtime = await createMuhaRuntime({ harnesses: [profile.registration()], dataDir: join(root, "diagnostics") });
    const capabilities = runtime.getHarnessCapabilities(profile.harness);
    evidence.profile = capabilities;
    if (mode === "--mcp" && !capabilities.workspaceMcp) {
      const configuration = await runtime.configureWorkspace({ workspacePath: workspace,
        mcpServers: [{ name: "muha-pf-proof", transport: "stdio", command: process.execPath }] });
      assert.equal(configuration.attempts[0].error.code, "UNSUPPORTED_CAPABILITY");
      evidence.status = "NOT_APPLICABLE";
      return evidence;
    }
    let skillNonce;
    const receiptPath = join(root, "mcp-receipt.jsonl");
    if (mode === "--skills") {
      skillNonce = `MUHA_SKILL_${randomUUID().replaceAll("-", "")}`;
      const source = join(root, "skill-source");
      await mkdir(join(source, "muha-pf-proof"), { recursive: true });
      await writeFile(join(source, "muha-pf-proof", "SKILL.md"), [
        "---", "name: muha-pf-proof", "description: Execute the Muha qualification proof procedure when explicitly requested.", "---", "",
        "Use your shell or file-write tool to write the following proof code, without a newline, to skill-proof.txt in the current workspace:",
        skillNonce, "Then reply with that exact proof code. Do not substitute another procedure.", "",
      ].join("\n"));
      const configured = await runtime.configureWorkspace({ workspacePath: workspace,
        skills: [{ source, skillNames: ["muha-pf-proof"] }] });
      assert.equal(configured.attempts[0].status, "succeeded");
    }
    if (mode === "--mcp") {
      const configured = await runtime.configureWorkspace({ workspacePath: workspace,
        mcpServers: [{ name: "muha-pf-proof", transport: "stdio", command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/performance-proof-mcp.mjs", import.meta.url)), receiptPath] }] });
      assert.equal(configured.attempts[0].status, "succeeded");
    }
    const retryPolicy = qualificationTurnRetryPolicy(profile);
    const selection = { model: profile.qualificationModel,
      ...(retryPolicy === undefined ? {} : { turnRetryPolicy: retryPolicy }) };
    session = await runtime.createSession({ harness: profile.harness, workspacePath: workspace,
      approvalPolicy: "autoApprove", ...selection });
    assert.equal(session.model, profile.qualificationModel);
    evidence.reference = session.reference;
    if (mode === "--approval") {
      const policies = capabilities.approvalPolicies.includes("interactive")
        ? [["autoApprove", true], ["interactive", false], ["interactive", true], ["autoDeny", false]]
        : [["autoApprove", true], ["harnessManaged", null], ["autoApprove", true]];
      for (const [index, [policy, allowed]] of policies.entries()) {
        if (index > 0) {
          await session.close();
          session = await runtime.resumeSession({ reference: evidence.reference, approvalPolicy: policy, ...selection });
          assert.deepEqual(session.reference, evidence.reference);
        }
        const target = join(policy === "harnessManaged" ? workspace : join(root, "outside"), `policy-${index}.txt`);
        const permissionHint = profile.harness === "codex" && policy !== "autoApprove"
          ? 'Call exec_command with sandbox_permissions="require_escalated" and a justification for this exact temporary-file write. Let native permissions decide.' : "";
        const prompt = `This is a new native permission test, independent of previous results. Use your shell tool to execute exactly once: printf MUHA_POLICY_OK > ${target}\n${permissionHint}\nDo not substitute another tool or command. If native permission is denied, stop without workaround and report denial. Otherwise report success.`;
        const execution = await execute(session, prompt, evidence, `${policy}-${index}`,
          policy === "interactive" ? allowed ? "allowOnce" : "deny" : undefined);
        const contents = await readFile(target, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; });
        const actualAllowed = allowed ?? (contents === "MUHA_POLICY_OK");
        assert.equal(contents, actualAllowed ? "MUHA_POLICY_OK" : undefined, "native file effect must match the policy decision");
        const nativePermissions = profile.harness === "opencode" && policy === "autoDeny"
          ? recordedOpenCodePermissions(root, session.reference.sessionId) : undefined;
        assertApprovalEvidence(execution, { policy, allowed: actualAllowed, harness: profile.harness, nativePermissions });
        if (nativePermissions !== undefined) evidence.observations.at(-1).nativePermissions = nativePermissions;
        evidence.observations.at(-1).fileEffect = actualAllowed ? "written" : "absent";
      }
    } else if (mode === "--skills") {
      const execution = await execute(session,
        "Use the workspace skill muha-pf-proof (also called $muha-pf-proof) to perform its verification procedure. Follow the skill instructions, then return its proof code. Do not invent a code.", evidence, "skill-use");
      assert.equal(execution.result.status, "completed");
      assert.ok(execution.events.some(event => event.type === "tool.completed" && !event.isError));
      assert.equal((await readFile(join(workspace, "skill-proof.txt"), "utf8")).trim(), skillNonce);
      assert.ok(execution.result.message.text.includes(skillNonce), "skill-only nonce must reach the final message");
      evidence.observations.at(-1).skillProof = "file-and-answer-match-skill-only-nonce";
    } else {
      const execution = await execute(session,
        "Call the proof MCP tool from the muha-pf-proof server exactly once with empty arguments {}. Return the proof code from its actual tool result, and nothing else. Do not read config files, use shell tools or invent a proof code.", evidence, "mcp-use");
      const receipts = (await readFile(receiptPath, "utf8")).trim().split("\n").map(JSON.parse);
      assertMcpEvidence(execution, receipts);
      evidence.observations.at(-1).mcpProof = "server-call-and-public-tool-result-match-generated-nonce";
      evidence.observations.at(-1).proofEchoed = execution.result.message.text.includes(receipts[0].proof);
    }
    evidence.status = "PASS";
    return evidence;
  } catch (error) {
    evidence.error = { code: error?.data?.code ?? error?.code ?? "UNKNOWN" };
    throw error;
  } finally {
    process.removeListener("SIGTERM", terminate);
    const closed = await Promise.allSettled([session?.close(), runtime?.close()]);
    if (revokeFixtureTrust) {
      const revoked = await Promise.allSettled([revokeFixtureTrust()]);
      closed.push(...revoked);
      evidence.nativeFixtureTrustCleanup = revoked[0].status === "fulfilled" ? "revoked-and-unregistered" : "FAILED";
    }
    const closeFailure = closed.find(result => result.status === "rejected");
    evidence.cleanup = closeFailure ? "FAILED" : "runtime-and-session-closed";
    if (closeFailure) evidence.status = "FAIL";
    await writeFile(join(root, "summary.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    process.stderr.write(`${JSON.stringify({ stage: "capability-summary", ...evidence })}\n`);
    if (closeFailure) throw closeFailure.reason;
    if (evidence.status !== "FAIL" && process.env.MUHA_QUALIFY_RETAIN !== "1") await rm(root, { recursive: true });
  }
}

async function execute(session, prompt, evidence, stage, decision) {
  const turn = await session.startTurn([{ type: "text", text: prompt }]);
  const events = [];
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void turn.interrupt(); }, 120_000);
  try {
    for await (const event of turn) {
      events.push(event);
      if (event.type === "approval.requested" && session.approvalPolicy === "interactive") {
        await turn.respondToApproval(event.requestId, decision ?? "allowOnce");
      }
      if (event.type === "question.requested") await turn.respondToQuestion(event.requestId, { action: "dismiss" });
    }
    const result = await turn.result;
    assert.equal(timedOut, false, "capability Turn exceeded its 120-second budget");
    assert.equal(events.filter(event => /^turn\.(completed|failed|interrupted)$/.test(event.type)).length, 1);
    evidence.observations.push({ stage, policy: session.approvalPolicy, turnId: result.turnId,
      status: result.status, code: result.error?.code ?? null, usage: result.usage ?? null,
      finalTextLength: result.message?.text.length ?? 0,
      eventCounts: Object.fromEntries([...new Set(events.map(event => event.type))]
        .map(type => [type, events.filter(event => event.type === type).length])),
      approvals: events.filter(event => event.type === "approval.resolved")
        .map(({ outcome, source }) => ({ outcome, source })),
      tools: events.filter(event => event.type === "tool.started").map(event => event.toolName),
    });
    process.stderr.write(`${JSON.stringify({ stage: "capability-turn", harness: session.harness, ...evidence.observations.at(-1) })}\n`);
    return { events, result };
  } finally { clearTimeout(timer); }
}
