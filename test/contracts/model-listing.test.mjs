import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { mkdtemp } from "../support/temporary-directory.mjs";
import { createMuhaRuntime, codexAdapter, openCodeAdapter, kimiAdapter, agyAdapter } from "@muha-sdk/muha";
import { agyConformance } from "../support/agy-conformance.mjs";
import { controlledPi } from "../../packages/pi-adapter/test/support/controlled-pi.mjs";

const nativeBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const v2Bin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");
const profiles = [
  { harness: "codex", factory: codexAdapter,
    models: [{ id: "fake-default", model: "fake-default", displayName: "Native model", hidden: true,
      description: "Native description", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" },
      { id: "catalog-second", model: "catalog-second", displayName: null, description: null,
        supportedReasoningEfforts: null, defaultReasoningEffort: null }, { id: "catalog-third", model: "catalog-third" }],
    expected: [{ id: "fake-default", name: "Native model", description: "Native description",
      supportedEfforts: ["high"], defaultEffort: "high" }, { id: "catalog-second" }, { id: "catalog-third" }] },
  { harness: "opencode", factory: openCodeAdapter,
    models: [{ providerID: "opencode-go", id: "catalog/with/slashes", name: "Native model", variants: [{ id: "native-variant" }] }],
    expected: [{ id: "opencode-go/catalog/with/slashes", name: "Native model", supportedEfforts: ["native-variant"] }] },
  { harness: "kimi", factory: kimiAdapter,
    models: [{ model: "turbo", provider: "unused", display_name: "Native model", support_efforts: ["on"], default_effort: "on" },
      { model: "custom/native/model", display_name: null, support_efforts: null, default_effort: null }],
    expected: [{ id: "turbo", name: "Native model", supportedEfforts: ["on"], defaultEffort: "on" }, { id: "custom/native/model" }] },
  { harness: "agy", factory: agyAdapter,
    models: "fake-opus\t原生模型 (Low)\r\nfake-high  Native High\r\n",
    expected: [{ id: "fake-opus", name: "原生模型 (Low)" }, { id: "fake-high", name: "Native High" }] },
];

async function fixture(t, profile, initial = { models: profile.models }) {
  const root = await mkdtemp(join(tmpdir(), "muha-model-list-"));
  const workspace = join(root, "workspace"), file = join(root, "catalog.json");
  await mkdir(workspace);
  await writeFile(file, JSON.stringify(initial));
  const base = profile.harness === "agy" ? (await agyConformance(t, { root })).options : {
    env: { PATH: [profile.harness === "opencode" ? v2Bin : nativeBin, dirname(process.execPath)].join(delimiter) },
  };
  const runtime = await createMuhaRuntime({ harnesses: [profile.factory({
    ...base, env: { ...base.env, MUHA_FAKE_MODEL_CATALOG: file },
  })], dataDir: join(root, "diagnostics") });
  t.after(async () => { try { await runtime.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  return { runtime, workspace, file, root, options: { harness: profile.harness, workspacePath: workspace },
    set: value => writeFile(file, JSON.stringify(value)) };
}

for (const profile of profiles) {
  test(profile.harness + " lists native Model ids through the entry package without changing Session selections", async t => {
    const f = await fixture(t, profile);
    assert.equal(f.runtime.getHarnessCapabilities(profile.harness).model.listing, true);
    const nativeDirectory = join(f.root, "native-home", ".gemini", "antigravity-cli", "conversations");
    const beforeNativeFiles = profile.harness === "agy" ? await readdir(nativeDirectory) : undefined;
    const models = await f.runtime.listModels(f.options);
    if (beforeNativeFiles) assert.deepEqual(await readdir(nativeDirectory), beforeNativeFiles);
    assert.deepEqual(models, profile.expected);
    assert.equal(Object.isFrozen(models), true);
    for (const model of models) {
      assert.equal(Object.isFrozen(model), true);
      if (model.supportedEfforts) assert.equal(Object.isFrozen(model.supportedEfforts), true);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(models)), profile.expected);
    // Catalog ids are accepted unchanged by the existing selection path, without inference.
    const session = await f.runtime.createSession({ ...f.options, model: models[0].id,
      approvalPolicy: f.runtime.getHarnessCapabilities(profile.harness).approvalPolicies[0] });
    const before = { reference: session.reference, model: session.model, effort: session.effort };
    assert.equal(session.model, models[0].id);
    assert.deepEqual(await f.runtime.listModels(f.options), profile.expected);
    assert.deepEqual({ reference: session.reference, model: session.model, effort: session.effort }, before);
    await session.close();
    await f.set({ models: profile.harness === "agy" ? "" : [] });
    assert.deepEqual(await f.runtime.listModels(f.options), []);
    await f.set({ error: true });
    await assert.rejects(f.runtime.listModels(f.options), error =>
      error.data?.code === "HARNESS_ERROR" && error.data.operation === "listModels" &&
      error.data.harness === profile.harness && !error.message.includes("private diagnostic"));
    assert.equal(f.runtime.status, "active");
    await f.set({ models: profile.models });
    assert.deepEqual(await f.runtime.listModels(f.options), profile.expected);
  });

  test(profile.harness + " rejects malformed Model catalogs instead of returning an empty list", async t => {
    const f = await fixture(t, profile);
    await f.set({ models: profile.harness === "agy" ? "WARNING: catalog unavailable\n" : [{}] });
    await assert.rejects(f.runtime.listModels(f.options), error => error.data?.code === "ADAPTER_PROTOCOL_ERROR");
    assert.equal(f.runtime.status, "active");
  });
}

test("Codex rejects repeated Model cursors and conflicting native identity fields", async t => {
  const f = await fixture(t, profiles[0]);
  await f.set({ models: profiles[0].models, repeatCursor: true });
  await assert.rejects(f.runtime.listModels(f.options), error => error.data?.code === "ADAPTER_PROTOCOL_ERROR");
  await f.set({ models: [{ id: "alias", model: "different-selection" }] });
  await assert.rejects(f.runtime.listModels(f.options), error => error.data?.code === "ADAPTER_PROTOCOL_ERROR");
});

test("Pi lists available SDK chat models without creating a Session or making a provider request", async t => {
  const f = await controlledPi(t);
  const modelFile = join(f.agentDir, "models.json");
  const configuration = JSON.parse(await readFile(modelFile, "utf8"));
  configuration.providers.unconfigured = { ...configuration.providers.controlled, apiKey: undefined };
  await writeFile(modelFile, JSON.stringify(configuration));
  const runtime = await f.runtime();
  const options = { harness: "pi", workspacePath: f.workspace };
  const catalog = await runtime.listModels(options);
  assert.equal(catalog.some(model => model.id.startsWith("unconfigured/")), false);
  assert.deepEqual(catalog.filter(model => model.id.startsWith("controlled/")), [
    { id: "controlled/controlled", name: "controlled" }, { id: "controlled/next", name: "next" },
    { id: "controlled/minimal", name: "minimal" },
  ]);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(await runtime.listSessions(options), []);
  await writeFile(modelFile, "INVALID JSON");
  await assert.rejects(runtime.listModels(options), error => error.data?.code === "HARNESS_ERROR" &&
    error.data.operation === "listModels");
  assert.equal(runtime.status, "active");
  await writeFile(modelFile, JSON.stringify(configuration));
  assert.ok((await runtime.listModels(options)).some(model => model.id === "controlled/next"));
  assert.deepEqual(f.requests, []);
});

test("AGY Model query cancellation reclaims the owned CLI before Runtime.close resolves", async t => {
  const f = await fixture(t, profiles[3]);
  const pidFile = join(f.root, "model-query.pid");
  await f.set({ hang: true, pidFile });
  const query = f.runtime.listModels(f.options);
  const rejected = assert.rejects(query, error => error.data?.code === "RUNTIME_CLOSED");
  let pid;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { pid = Number(await readFile(pidFile, "utf8")); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid, "native catalog command started");
  await f.runtime.close();
  await rejected;
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
});

test("AGY finite Model query reclaims detached descendants after native success", async t => {
  const f = await fixture(t, profiles[3]);
  const detachedPidFile = join(f.root, "catalog-child.pid");
  await f.set({ models: profiles[3].models, detachedPidFile });
  assert.deepEqual(await f.runtime.listModels(f.options), profiles[3].expected);
  const pid = Number(await readFile(detachedPidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
});

test("AGY Model timeout, output bounds and unsupported decoration are explicit failures", async t => {
  const f = await fixture(t, profiles[3]);
  await f.set({ hang: true });
  await assert.rejects(f.runtime.listModels(f.options), error =>
    error.data?.code === "HARNESS_ERROR" && error.data.operation === "listModels" && /timed out/u.test(error.message));
  assert.equal(f.runtime.status, "active");
  for (const models of ["x".repeat(8 * 1024 * 1024 + 1), "\u001b[31mfake-opus\tColored model\u001b[0m\n",
    "fake-opus\tFirst\nfake-opus\tConflicting\n"]) {
    await f.set({ models });
    await assert.rejects(f.runtime.listModels(f.options), error => error.data?.code === "ADAPTER_PROTOCOL_ERROR");
    assert.equal(f.runtime.status, "active");
  }
});
