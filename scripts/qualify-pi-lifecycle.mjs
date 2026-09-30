import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createMuhaRuntime } from "@muha-sdk/core";
import { piAdapter } from "@muha-sdk/pi-adapter";

const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? "");
const model = process.env.MUHA_QUALIFY_PI_MODEL;
assert.ok(dirname(agentDir) === resolve(tmpdir()) && basename(agentDir).startsWith("muha-pi-no-extensions-") &&
  !(await lstat(agentDir)).isSymbolicLink(), "Run only through with-pi-baseline.mjs lifecycle");
assert.ok(model?.includes("/"), "An explicit native model is required");
const root = await mkdtemp(join(tmpdir(), "muha-pi-real-lifecycle-"));
const workspace = join(root, "workspace"), dataDir = join(root, "diagnostics");
await mkdir(workspace);
let runtime;
const checks = [];
const token = `MUHA_${randomUUID().replaceAll("-", "")}`;
try {
  // A genuine external native SDK consumer creates this history with the real
  // provider. It runs in another process and never imports SDK into Muha's host.
  const loader = new URL("../packages/pi-adapter/dist/sdk-loader.mjs", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    const { loadSdk } = await import(${JSON.stringify(loader)});
    const sdk = await loadSdk(); const models = await sdk.ModelRuntime.create();
    const selected = ${JSON.stringify(model)}; const slash = selected.indexOf("/");
    const model = models.getModel(selected.slice(0, slash), selected.slice(slash + 1));
    if (!model) throw new Error("Native model is unavailable");
    const { session } = await sdk.createAgentSession({ cwd: ${JSON.stringify(workspace)},
      modelRuntime: models, model, sessionManager: sdk.SessionManager.create(${JSON.stringify(workspace)}),
      settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }) });
    try {
      await session.prompt(${JSON.stringify(`Remember ${token}. Reply with that exact token only. Do not use tools.`)});
      const last = session.messages.filter(message => message.role === "assistant").at(-1);
      if (last?.stopReason === "error" || !last?.content.some(part => part.type === "text" && part.text.includes(${JSON.stringify(token)}))) {
        throw new Error("External native model did not complete the history fixture");
      }
      console.log(JSON.stringify({ id: session.sessionId, model: {
        id: model.id, name: model.name, provider: model.provider, api: model.api, baseUrl: model.baseUrl,
        reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow,
        maxTokens: model.maxTokens, cost: model.cost,
      } }));
    } finally { await session.abort(); session.dispose(); }
  `], { env: process.env, timeout: 120000, maxBuffer: 1024 * 1024 });
  const external = JSON.parse(stdout);
  // Register a deliberately unknown model ID against the actual native
  // provider endpoint. No mock server/proxy or synthetic success is used:
  // the provider must reject both Core Attempts, then a valid model must work.
  const modelsPath = join(agentDir, "models.json");
  let configuration = {};
  try {
    configuration = JSON.parse(await readFile(modelsPath, "utf8"));
    if ((await lstat(modelsPath)).isSymbolicLink()) await unlink(modelsPath);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const invalidId = `muha-qualification-unknown-${randomUUID()}`;
  configuration.providers ??= {};
  const provider = configuration.providers[external.model.provider] ??= {};
  provider.baseUrl ??= external.model.baseUrl;
  provider.api ??= external.model.api;
  provider.models = [...(provider.models ?? []), { ...external.model, id: invalidId, name: "Muha nonexistent model qualification" }];
  await writeFile(modelsPath, JSON.stringify(configuration), { mode: 0o600 });
  const settingsPath = join(agentDir, "settings.json");
  const originalSettings = await readFile(settingsPath, "utf8");
  const createRuntime = () => createMuhaRuntime({ harnesses: [piAdapter()], dataDir });
  runtime = await createRuntime();
  const reference = { harness: "pi", sessionId: external.id, workspacePath: workspace };
  assert.ok((await runtime.listSessions({ harness: "pi", workspacePath: workspace })).some(row => row.reference.sessionId === external.id));
  const session = await runtime.resumeSession({ reference, model, approvalPolicy: "autoApprove", turnRetryPolicy: { maxRetries: 1 } });
  const history = await execute(session, "Without tools, repeat the exact MUHA_ token from my previous message.");
  assert.equal(history.result.status, "completed");
  assert.ok(history.result.message.text.includes(token));
  checks.push("external-sdk-real-history-resume");

  await session.setModel(`${external.model.provider}/${invalidId}`);
  const rejected = await execute(session, "Reply OK. Do not call tools.");
  assert.equal(rejected.result.status, "failed");
  assert.equal(rejected.result.error.code, "HARNESS_ERROR");
  assert.equal(rejected.events.filter(event => event.type === "turn.retrying").length, 1);
  assert.match(rejected.result.error.message, /model|not.found|invalid|404/i, "The real provider must reject the nonexistent model");
  checks.push("real-provider-rejection-two-core-attempts");
  await session.setModel(model);
  assert.equal((await execute(session, "Reply RECOVERED only. Do not call tools.")).result.status, "completed");
  checks.push("valid-model-after-exhausted-retry");

  const locked = join(workspace, "native-denied.txt");
  await writeFile(locked, "native permission fixture", { mode: 0o000 });
  const denied = await execute(session, "Use the read tool exactly once for native-denied.txt, then report its result. Do not use other tools, change permissions, or try to bypass a rejection.");
  assert.equal(denied.result.status, "completed");
  assert.ok(denied.events.some(event => event.type === "tool.completed" && event.isError), "The actual native tool must report a rejection");
  assert.equal((await stat(locked)).mode & 0o777, 0);
  await chmod(locked, 0o600);
  assert.equal(await readFile(locked, "utf8"), "native permission fixture");
  checks.push("real-native-tool-permission-rejection-not-bypassed");

  const fault = await session.startTurn([{ type: "text", text: 'Use the bash tool to run exactly the following command, with no other tools:\n```sh\necho "$PPID" > sdk.pid; echo "$$" > group.pid; sleep 60\n```' }]);
  let killed = false;
  for await (const event of fault) {
    if (!killed && event.type === "tool.started" && event.toolName === "bash") {
      const sdkPid = await waitPid(join(workspace, "sdk.pid"));
      const command = await readFile(`/proc/${sdkPid}/cmdline`, "utf8");
      const expectedWorker = new URL("../packages/pi-adapter/dist/sdk-worker.mjs", import.meta.url).pathname;
      assert.ok(command.split("\0").includes(expectedWorker), "Refuse to signal a process not identified as this Adapter's SDK worker");
      process.kill(sdkPid, "SIGKILL");
      killed = true;
    }
  }
  assert.ok(killed, "The model did not start the fault-injection tool");
  assert.equal((await fault.result).status, "failed");
  await runtime.close();
  assert.equal(runtime.status, "closed");
  const groupPid = await waitPid(join(workspace, "group.pid"));
  await assertStopped(groupPid);
  checks.push("real-tool-sdk-loss-runtime-close-and-group-reclamation");
  runtime = await createRuntime();
  const restored = await runtime.resumeSession({ reference, model, approvalPolicy: "autoApprove" });
  const recovered = await execute(restored, "Do not rerun interrupted tools. Without tools, repeat the exact MUHA_ token from the start of this conversation.");
  assert.equal(recovered.result.status, "completed");
  assert.ok(recovered.result.message.text.includes(token));
  await runtime.close();
  assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
  checks.push("explicit-new-runtime-recovery-after-fatal-loss", "persistent-settings-unchanged");
  // This is post-close, unsupported diagnostic inspection for qualification,
  // not a new public store/query interface or a live-reader contract.
  const database = new DatabaseSync(join(dataDir, "diagnostic-events.sqlite"), { readOnly: true });
  const nativeSources = {};
  try {
    const records = database.prepare("SELECT payload_json FROM native_event_records WHERE harness = 'pi' ORDER BY record_id").all();
    const secrets = [];
    const collect = value => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (/^(key|apiKey|access|refresh|token|accessToken|refreshToken)$/i.test(key) && typeof item === "string" && item.length >= 8) secrets.push(item);
        else if (typeof item === "object") collect(item);
      }
    };
    collect(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")));
    assert.ok(secrets.length > 0, "Credential exclusion must check actual native credential values");
    for (const { payload_json: json } of records) {
      assert.equal(secrets.some(secret => json.includes(secret)), false, "Native diagnostic record contains authentication material");
      const record = JSON.parse(json);
      assert.ok(["AgentSession.subscribe", "SessionManager.list", "createAgentSession.modelFallbackMessage",
        "createAgentSession.extensionsResult.errors", "AgentSession.bindExtensions.onError"].includes(record.source));
      nativeSources[record.source] = (nativeSources[record.source] ?? 0) + 1;
    }
    assert.ok(nativeSources["AgentSession.subscribe"] > 0);
    assert.ok(nativeSources["SessionManager.list"] > 0);
    assert.ok(nativeSources["createAgentSession.extensionsResult.errors"] > 0);
  } finally { database.close(); }
  checks.push("post-close-sdk-diagnostic-sources-and-credential-exclusion");
  process.stdout.write(`${JSON.stringify({ harness: "pi", model, checks, nativeSources }, null, 2)}\n`);
} catch (error) {
  // Child-process errors can embed credentials in their captured stderr. Keep
  // this report limited to our assertions and high-level failure identity.
  process.stderr.write(`${JSON.stringify({ checks, failed: error.name, message: error.code === undefined ? error.message : "Native qualification command failed" })}\n`);
  process.exitCode = 1;
} finally {
  await runtime?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

async function execute(session, text) {
  const turn = await session.startTurn([{ type: "text", text }]);
  const events = [];
  for await (const event of turn) events.push(event);
  const result = await turn.result;
  assert.deepEqual(events.filter(event => /^turn\.(completed|failed|interrupted)$/.test(event.type)).map(event => event.type), [`turn.${result.status}`]);
  return { result, events };
}
async function waitPid(path) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try { const pid = Number(await readFile(path, "utf8")); if (Number.isSafeInteger(pid) && pid > 1) return pid; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(20);
  }
  throw new Error("Native tool did not supply its owned process identity");
}
async function assertStopped(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (/^\d+ \(.*\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))) return; }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    await delay(10);
  }
  throw new Error("Owned native tool remained alive after Runtime.close");
}
