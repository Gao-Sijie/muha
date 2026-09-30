import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createMuhaRuntime } from "@muha-sdk/core";
import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createOfficialHarnessRegistration, readOfficialHarnessRegistration } from "../../packages/core/dist/internal.js";
import { acpOptions, controlledCodexAdapter, controlledOpenCodeAdapter } from "../fixtures/acp-harness/options.mjs";

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("helper-loss outcome did not settle")), 2500);
    })]);
  } finally { clearTimeout(timer); }
}

function endpoint(root, name, scenario) {
  const processFile = join(root, `${name}-processes.jsonl`);
  const evidenceFile = join(root, `${name}-protocol.json`);
  const options = acpOptions(scenario, {
    MUHA_FAKE_ACP_PROCESS_FILE: processFile,
    MUHA_FAKE_ACP_EVIDENCE_FILE: evidenceFile,
    MUHA_FAKE_ACP_HOLD_STDIO: "1",
  });
  options.args.push(`--test-owner=${root}`);
  return { options, processFile, evidenceFile };
}

async function processes(endpoint) {
  const text = await readFile(endpoint.processFile, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text.trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function receivedRequest(endpoint, method) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const evidence = await readFile(endpoint.evidenceFile, "utf8").then(text => {
      try { return JSON.parse(text); } catch { return undefined; }
    }, () => undefined);
    if (evidence?.requests.some(request => request.method === method)) return;
    await delay(10);
  }
  throw new Error(`fixture did not receive ${method}`);
}

async function signalOwned(pid, root, signal) {
  const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  if (!command) return false;
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && command.includes("acp-agent.mjs") && command.includes(`--test-owner=${root}`),
    "only this test's recorded endpoint or helper may be signalled");
  try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  return true;
}

async function rescue(root, endpoints) {
  for (const endpoint of endpoints) for (const { nativePid, helperPid } of await processes(endpoint)) {
    // Only fixture rescue, never counted as product reclamation evidence.
    await signalOwned(nativePid, root, "SIGKILL");
    await signalOwned(helperPid, root, "SIGTERM");
  }
}

function observe(turn, requestType) {
  let resolveRequested;
  const requested = new Promise(resolve => { resolveRequested = resolve; });
  const completed = (async () => {
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === requestType) resolveRequested(event);
    }
    return { events, result: await turn.result };
  })();
  return { requested, completed };
}

for (const lostKind of ["opencode", "codex"]) test(`${lostKind} ACP helper loss fails its Turn, invalidates interactions and irreversibly closes the whole Runtime`, { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-helper-runtime-"));
  const lostInteraction = lostKind === "opencode" ? "approval" : "question";
  const peerInteraction = lostKind === "opencode" ? "question" : "approval";
  const peerKind = lostKind === "opencode" ? "codex" : "opencode";
  const lostFactory = lostKind === "opencode" ? controlledOpenCodeAdapter : controlledCodexAdapter;
  const peerFactory = lostKind === "opencode" ? controlledCodexAdapter : controlledOpenCodeAdapter;
  const lost = endpoint(root, "lost", lostInteraction);
  const peer = endpoint(root, "peer", peerInteraction);
  let runtime;
  try {
    runtime = await createMuhaRuntime({ harnesses: [
      lostFactory({ acp: lost.options }), peerFactory({ acp: peer.options }),
    ], dataDir: join(root, "data") });
    const session = await runtime.createSession({ harness: lostKind, workspacePath: root,
      approvalPolicy: "interactive", turnRetryPolicy: { maxRetries: 2 } });
    const peerSession = await runtime.createSession({ harness: peerKind, workspacePath: root, approvalPolicy: "interactive" });
    const turn = await session.startTurn([{ type: "text", text: "pending permission" }]);
    const peerTurn = await peerSession.startTurn([{ type: "text", text: "pending question" }]);
    const observed = observe(turn, `${lostInteraction}.requested`);
    const peerObserved = observe(peerTurn, `${peerInteraction}.requested`);
    const requests = await bounded(Promise.all([observed.requested, peerObserved.requested]));
    const [{ nativePid, helperPid }] = await processes(lost);
    assert.ok(await signalOwned(helperPid, root, "SIGKILL"));

    // No caller close: helper loss must drive the complete fatal-close path.
    const termination = await bounded(runtime.termination);
    assert.equal(termination.reason, "fatal");
    assert.equal(termination.error.code, "HARNESS_ERROR");
    assert.equal(termination.error.harness, lostKind);
    assert.equal(termination.closeError?.code, "RUNTIME_CLOSE_FAILED");
    assert.ok(termination.closeError.failures.some(error => error.harness === lostKind && error.operation === "closeHarness"));
    assert.equal(runtime.status, "closed");
    assert.equal(session.status.status, "closed");
    assert.equal(peerSession.status.status, "closed");
    const [{ events, result }, peerOutcome] = await bounded(Promise.all([observed.completed, peerObserved.completed]));
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.equal(peerOutcome.result.status, "interrupted");
    assert.equal(peerOutcome.result.reason, "runtimeClosed");
    for (const [stream, type] of [[events, lostInteraction], [peerOutcome.events, peerInteraction]]) {
      assert.equal(stream.filter(event => /^turn\.(completed|failed|interrupted)$/.test(event.type)).length, 1);
      const invalidated = stream.findIndex(event => event.type === `${type}.resolved` && event.outcome === "invalidated");
      assert.ok(invalidated >= 0 && invalidated < stream.length - 1, "interaction must invalidate before the terminal event");
      assert.equal(stream.some(event => event.type === "turn.retrying"), false);
    }
    // Closed Runtime rejects controls before looking up the invalidated request.
    for (const [handle, request] of [[turn, requests[0]], [peerTurn, requests[1]]]) {
      const reply = request.type === "approval.requested"
        ? handle.respondToApproval(request.requestId, "allowOnce")
        : handle.respondToQuestion(request.requestId, { action: "dismiss" });
      await assert.rejects(reply, error => error.data?.code === "RUNTIME_CLOSED");
    }
    await assert.rejects(session.startTurn([{ type: "text", text: "must not execute" }]), error => error.data?.code === "SESSION_CLOSED" || error.data?.code === "RUNTIME_CLOSED");
    await assert.rejects(runtime.createSession({ harness: "opencode", workspacePath: root }), error => error.data?.code === "RUNTIME_CLOSED");
    await assert.rejects(runtime.close(), error => error.data?.code === "RUNTIME_CLOSE_FAILED");
    await assert.rejects(runtime.close(), error => error.data?.code === "RUNTIME_CLOSE_FAILED");
    assert.equal((await processes(lost)).length, 1, "no helper or Harness restart");
    assert.equal((await processes(peer)).length, 1);
    for (const endpoint of [lost, peer]) {
      const evidence = JSON.parse(await readFile(endpoint.evidenceFile, "utf8"));
      assert.equal(evidence.prompts.length, 1, "no cross-route or same-route replay");
    }
    assert.match(await readFile(`/proc/${nativePid}/cmdline`, "utf8"), /acp-agent\.mjs/,
      "fixture must still hold stdio: Runtime termination is not proof of descendant reclamation");
    for (const { nativePid, helperPid } of await processes(peer)) {
      await assert.rejects(readFile(`/proc/${nativePid}/cmdline`), { code: "ENOENT" });
      await assert.rejects(readFile(`/proc/${helperPid}/cmdline`), { code: "ENOENT" });
    }
  } finally {
    await rescue(root, [lost, peer]);
    await runtime?.close().catch(() => {});
    await delay(25);
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP helper loss during initialization rejects promptly and rolls back the peer without claiming cleanup", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-helper-initialize-"));
  const lost = endpoint(root, "lost", "stall-initialize");
  const peer = endpoint(root, "peer", "normal");
  // Failure must be driven by helper loss, not this later startup deadline.
  lost.options.startupTimeoutMs = 5000;
  const initializing = createMuhaRuntime({ harnesses: [
    controlledOpenCodeAdapter({ acp: lost.options }), controlledCodexAdapter({ acp: peer.options }),
  ], dataDir: join(root, "data") }).then(runtime => ({ runtime }), error => ({ error }));
  try {
    await Promise.all([receivedRequest(lost, "initialize"), receivedRequest(peer, "initialize")]);
    const [{ nativePid, helperPid }] = await processes(lost);
    assert.ok(await signalOwned(helperPid, root, "SIGKILL"));
    const outcome = await bounded(initializing);
    assert.equal(outcome.runtime, undefined);
    assert.equal(outcome.error?.data?.code, "RUNTIME_INITIALIZATION_FAILED");
    assert.ok(outcome.error.data.initializationFailures.some(error => error.harness === "opencode"));
    assert.ok(outcome.error.data.rollbackFailures.some(error => error.code === "HARNESS_ERROR" && error.harness === "opencode" && error.operation === "closeHarness"),
      "initialization error must disclose failed descendant cleanup, not an empty successful rollback");
    assert.match(await readFile(`/proc/${nativePid}/cmdline`, "utf8"), /acp-agent\.mjs/);
    for (const { nativePid, helperPid } of await processes(peer)) {
      await assert.rejects(readFile(`/proc/${nativePid}/cmdline`), { code: "ENOENT" });
      await assert.rejects(readFile(`/proc/${helperPid}/cmdline`), { code: "ENOENT" });
    }
    assert.equal((await processes(lost)).length, 1);
    assert.equal((await processes(peer)).length, 1);
    // The failed initialization must release the process-local Runtime guard.
    const next = await createMuhaRuntime({ harnesses: [controlledCodexAdapter({ acp: acpOptions() })], dataDir: join(root, "next") });
    await next.close();
  } finally {
    await rescue(root, [lost, peer]);
    const outcome = await bounded(initializing);
    await outcome.runtime?.close().catch(() => {});
    await delay(25);
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP helper loss settles an unanswered public control without waiting for its watchdog", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-helper-control-"));
  const lost = endpoint(root, "lost", "stall-create");
  let runtime;
  try {
    runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: lost.options })], dataDir: join(root, "data") });
    const creating = runtime.createSession({ harness: "opencode", workspacePath: root })
      .then(session => ({ session }), error => ({ error }));
    await receivedRequest(lost, "session/new");
    const [{ helperPid }] = await processes(lost);
    assert.ok(await signalOwned(helperPid, root, "SIGKILL"));
    const outcome = await bounded(creating);
    assert.equal(outcome.session, undefined);
    assert.equal(outcome.error?.data?.code, "RUNTIME_CLOSED");
    const termination = await bounded(runtime.termination);
    assert.equal(termination.reason, "fatal");
    assert.equal(termination.closeError?.code, "RUNTIME_CLOSE_FAILED");
    assert.equal(runtime.status, "closed");
    assert.equal((await processes(lost)).length, 1);
  } finally {
    await rescue(root, [lost]);
    await runtime?.close().catch(() => {});
    await delay(25);
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP helper loss during caller close stays closed and reports cleanup failure on repeated close", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-helper-close-"));
  const lost = endpoint(root, "lost", "stall-close");
  let runtime;
  try {
    runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: lost.options })], dataDir: join(root, "data") });
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root });
    const closing = runtime.close().then(() => ({ success: true }), error => ({ error }));
    await receivedRequest(lost, "session/close");
    const [{ helperPid }] = await processes(lost);
    assert.ok(await signalOwned(helperPid, root, "SIGKILL"));
    const outcome = await bounded(closing);
    assert.equal(outcome.success, undefined);
    assert.equal(outcome.error?.data?.code, "RUNTIME_CLOSE_FAILED");
    assert.equal(runtime.status, "closed");
    assert.equal(session.status.status, "closed");
    const termination = await runtime.termination;
    assert.equal(termination.reason, "callerClosed");
    assert.equal(termination.closeError?.code, "RUNTIME_CLOSE_FAILED");
    await assert.rejects(runtime.close(), error => error.data?.code === "RUNTIME_CLOSE_FAILED");
    await assert.rejects(runtime.listSessions({ harness: "opencode", workspacePath: root }), error => error.data?.code === "RUNTIME_CLOSED");
  } finally {
    await rescue(root, [lost]);
    await runtime?.close().catch(() => {});
    await delay(25);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex combined helper loss preempts a Tool waiting for its missing native completion", { timeout: 10000 }, async () => {
  const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-acp-helper-native-wait-"));
  const processFile = join(root, "combined-processes.json");
  const nativeFile = join(root, "native.pid");
  const base = readOfficialHarnessRegistration(codexAdapter());
  const registration = createOfficialHarnessRegistration("codex", { env: {
    PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
    MUHA_FAKE_TURN_SCENARIO: "rich", MUHA_FAKE_EXTRA_TOOL: "imageView", MUHA_FAKE_STALL_IMAGE_VIEW: "1", MUHA_FAKE_IGNORE_EOF: "1",
    MUHA_FAKE_COMBINED_PROCESSES: processFile, MUHA_FAKE_PID_FILE: nativeFile,
  }, shutdownTimeoutMs: 1000 }, base.capabilities, base.workspaceConfigurator,
  (options, context) => new CodexAcpProcess(options, context, {
    command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/codex-combined.mjs"), `--test-owner=${root}`],
  }));
  let runtime;
  let db;
  let owned;
  let nativePid;
  try {
    runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
    owned = JSON.parse(await readFile(processFile, "utf8"));
    const session = await runtime.createSession({ harness: "codex", workspacePath: root });
    nativePid = Number(await readFile(nativeFile, "utf8"));
    const turn = await session.startTurn([{ type: "text", text: "view image" }]);
    const observed = observe(turn, "unused");
    db = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"), { readOnly: true });
    const inbound = db.prepare("SELECT count(*) AS n FROM native_event_records WHERE json_extract(payload_json, '$.params.update.toolCallId') = 'native_extra'");
    const deadline = Date.now() + 2500;
    while (inbound.get().n === 0 && Date.now() < deadline) await delay(10);
    assert.equal(inbound.get().n, 1, "ACP Tool must reach the committed mapping barrier before injecting loss");
    assert.equal(runtime.status, "active", "native-completion wait must not itself have failed the Runtime");
    const command = await readFile(`/proc/${owned.helperPid}/cmdline`, "utf8");
    assert.ok(command.includes("acp-supervisor") && command.includes(`--test-owner=${root}`));
    process.kill(owned.helperPid, "SIGKILL");
    const termination = await bounded(runtime.termination);
    assert.match(termination.error?.message ?? "", /ACP ownership helper exited unexpectedly/);
    assert.equal(termination.reason, "fatal");
    assert.equal(termination.error.code, "HARNESS_ERROR");
    assert.equal(termination.closeError?.code, "RUNTIME_CLOSE_FAILED");
    assert.equal(runtime.status, "closed");
    const { result, events } = await bounded(observed.completed);
    const saved = db.prepare("SELECT count(*) AS n FROM native_event_records WHERE json_extract(payload_json, '$.params.update.content.text') = 'QUEUED_AFTER_BLOCKED_TOOL'").get();
    assert.equal(saved.n, 1, "helper-loss preemption must retain every already decoded semantic payload, even when its mapping was queued");
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HARNESS_ERROR");
    assert.equal(events.some(event => event.type === "tool.completed"), false, "missing native completion must not be invented on shutdown");
    assert.equal(events.some(event => event.type === "assistant.message.delta" && event.delta === "QUEUED_AFTER_BLOCKED_TOOL"), false,
      "saving diagnostics after receipt does not authorize semantic delivery after fatal loss");
    assert.equal(events.filter(event => event.type === "turn.failed").length, 1);
  } finally {
    db?.close();
    owned ??= await readFile(processFile, "utf8").then(JSON.parse, () => undefined);
    nativePid ??= await readFile(nativeFile, "utf8").then(Number, () => undefined);
    // Rescue known fixture descendants, validating this run's unique env
    // marker even for the native CLI whose strict argv cannot carry one.
    for (const pid of [nativePid, owned?.observerPid, owned?.bridgePid, owned?.helperPid]) {
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      const env = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
      if (!env) continue;
      assert.ok(env.split("\0").includes(`MUHA_FAKE_COMBINED_PROCESSES=${processFile}`));
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await delay(25);
    }
    await runtime?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
