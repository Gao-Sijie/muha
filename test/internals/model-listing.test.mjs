import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "../support/temporary-directory.mjs";
import { createMuhaRuntime } from "@muha-sdk/core";
import { createOfficialHarnessRegistration } from "../../packages/core/dist/internal.js";
import { FULL_HARNESS_CAPABILITIES } from "../support/full-harness-capabilities.mjs";

async function fixture(t, { listing = true, list = async () => [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "muha-core-models-")), workspace = join(root, "workspace");
  await mkdir(workspace);
  let calls = 0;
  const registration = createOfficialHarnessRegistration("codex", {}, Object.freeze({
    ...FULL_HARNESS_CAPABILITIES, model: Object.freeze({ ...FULL_HARNESS_CAPABILITIES.model, listing }),
  }), { planSkill() { throw new Error("unused"); }, planMcpServer() { throw new Error("unused"); } }, () => ({
    kind: "codex", route: "native", async initialize() {}, async close() {},
    async createSession() { assert.fail("model listing must not create a Session"); },
    async resumeSession() { assert.fail("model listing must not resume a Session"); },
    async listSessions() { assert.fail("model listing must not enumerate Sessions"); },
    async listModels(workspacePath) { calls++; return list(workspacePath); },
  }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "diagnostics") });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, runtime, calls: () => calls, options: { harness: "codex", workspacePath: workspace } };
}

test("Core validates model-list inputs and capabilities before native action", async t => {
  const f = await fixture(t, { listing: false });
  for (const options of [null, {}, { ...f.options, harness: "unknown" }, { ...f.options, workspacePath: "." },
    { ...f.options, limit: 1 }]) {
    await assert.rejects(f.runtime.listModels(options), error => error.data?.code === "INVALID_INPUT");
  }
  await assert.rejects(f.runtime.listModels({ ...f.options, harness: "pi" }), error => error.data?.code === "HARNESS_NOT_ENABLED");
  await assert.rejects(f.runtime.listModels(f.options), error => error.data?.code === "UNSUPPORTED_CAPABILITY" &&
    error.data.capability === "model.listing" && error.data.operation === "listModels");
  assert.equal(f.calls(), 0);
  await f.runtime.close();
  await assert.rejects(f.runtime.listModels(f.options), error => error.data?.code === "RUNTIME_CLOSED");
});

test("Core canonicalizes model Workspace, snapshots options and rejects missing directories without creating them", async t => {
  let received;
  const f = await fixture(t, { list: async path => { received = path; return []; } });
  const link = join(f.root, "workspace-link");
  await symlink(f.workspace, link, process.platform === "win32" ? "junction" : "dir");
  const options = { harness: "codex", workspacePath: link };
  const result = f.runtime.listModels(options);
  options.harness = "pi"; options.workspacePath = join(f.root, "unrelated");
  assert.deepEqual(await result, []);
  assert.equal(received, f.workspace);
  await assert.rejects(f.runtime.listModels({ ...f.options, workspacePath: join(f.root, "missing") }),
    error => error.data?.code === "WORKSPACE_NOT_FOUND");
  assert.equal(f.calls(), 1);
});

test("Core freezes and deduplicates catalog values while excluding unlisted native fields", async t => {
  const entry = { id: "native/model", name: "Native", supportedEfforts: ["opaque"], defaultEffort: "opaque",
    apiKey: "must-not-be-returned", headers: { authorization: "must-not-be-returned" } };
  const f = await fixture(t, { list: async () => [entry, { ...entry }] });
  const models = await f.runtime.listModels(f.options);
  assert.deepEqual(models, [{ id: "native/model", name: "Native", supportedEfforts: ["opaque"], defaultEffort: "opaque" }]);
  entry.supportedEfforts.push("later");
  assert.deepEqual(models[0].supportedEfforts, ["opaque"]);
  assert.equal(Object.isFrozen(models[0].supportedEfforts), true);
  assert.equal(Object.isFrozen(models[0]), true);
  assert.equal(Object.isFrozen(models), true);
});

test("Core rejects invalid, contradictory and conflicting catalog entries without closing Runtime", async t => {
  let value;
  const f = await fixture(t, { list: async () => value });
  for (value of [null, [{}], [{ id: "" }], [{ id: " native " }], [{ id: "native", name: 1 }],
    [{ id: "native", supportedEfforts: ["x", "x"] }], [{ id: "native", supportedEfforts: ["x"], defaultEffort: "y" }],
    [{ id: "native", name: "first" }, { id: "native", name: "different" }]]) {
    await assert.rejects(f.runtime.listModels(f.options), error => error.data?.code === "ADAPTER_PROTOCOL_ERROR");
    assert.equal(f.runtime.status, "active");
  }
});

test("Runtime.close preempts a pending model catalog even before the Adapter acknowledges", async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { list: async () => { started(); return new Promise(() => {}); } });
  const result = f.runtime.listModels(f.options);
  const rejected = assert.rejects(result, error => error.data?.code === "RUNTIME_CLOSED");
  await ready;
  await f.runtime.close();
  await rejected;
});
