import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import {
  OFFICIAL_HARNESS_KINDS,
  createOfficialHarnessRegistration,
  isHarnessKind,
  readOfficialHarnessRegistration,
} from "@muha-sdk/core/internal";
import { FULL_HARNESS_CAPABILITIES } from "../support/full-harness-capabilities.mjs";

test("the frozen Core catalog is the runtime authority for official Harness kinds", () => {
  assert.deepEqual(OFFICIAL_HARNESS_KINDS, ["codex", "opencode", "kimi", "pi", "agy"]);
  assert.equal(Object.isFrozen(OFFICIAL_HARNESS_KINDS), true);
  for (const kind of OFFICIAL_HARNESS_KINDS) assert.equal(isHarnessKind(kind), true);
  assert.equal(isHarnessKind("unknown-harness"), false);
  assert.equal(isHarnessKind(null), false);
});

test("official Registration construction rejects a non-official runtime kind", () => {
  assert.throws(
    () => createOfficialHarnessRegistration(
      "unknown-harness",
      {},
      FULL_HARNESS_CAPABILITIES,
      unusedWorkspaceConfigurator,
      () => unusedAdapter("unknown-harness"),
    ),
    (error) => {
      assert.ok(error instanceof MuhaError);
      assert.deepEqual(error.data, {
        code: "INVALID_INPUT",
        message: "Unknown Harness Kind",
      });
      return true;
    },
  );
});

test("official Registrations require and freeze a Workspace Configurator", () => {
  assert.throws(
    () => createOfficialHarnessRegistration(
      "codex",
      {},
      FULL_HARNESS_CAPABILITIES,
      undefined,
      () => unusedAdapter("codex"),
    ),
    (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
  );
  const registration = createOfficialHarnessRegistration(
    "codex",
    {},
    FULL_HARNESS_CAPABILITIES,
    unusedWorkspaceConfigurator,
    () => unusedAdapter("codex"),
  );
  const internal = readOfficialHarnessRegistration(registration);
  assert.ok(internal);
  assert.equal(Object.isFrozen(internal), true);
  assert.equal(Object.isFrozen(internal.workspaceConfigurator), true);

  const marker = Symbol.for("@muha-sdk/core/HarnessRegistration");
  assert.equal(readOfficialHarnessRegistration(Object.freeze({
    [marker]: true,
    kind: "codex",
    options: {},
    create() { return unusedAdapter("codex"); },
  })), undefined);
});

test("official Registration rejects mutable Capability input and retains a frozen Profile", () => {
  const mutable = JSON.parse(JSON.stringify(FULL_HARNESS_CAPABILITIES));
  assert.throws(
    () => createOfficialHarnessRegistration(
      "codex",
      {},
      mutable,
      unusedWorkspaceConfigurator,
      () => unusedAdapter("codex"),
    ),
    (error) =>
      error instanceof MuhaError &&
      error.data.code === "INVALID_INPUT" &&
      /deeply frozen/.test(error.data.message),
  );
  const registration = createOfficialHarnessRegistration(
    "codex",
    {},
    FULL_HARNESS_CAPABILITIES,
    unusedWorkspaceConfigurator,
    () => unusedAdapter("codex"),
  );
  const capabilities = readOfficialHarnessRegistration(registration)?.capabilities;
  assert.ok(capabilities);
  assert.equal(capabilities.sessionListing, true);
  assert.deepEqual(capabilities.model.selectionAt, [
    "createSession",
    "resumeSession",
    "idleSession",
  ]);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(Object.isFrozen(capabilities.approvalPolicies), true);
  assert.equal(Object.isFrozen(capabilities.model), true);
  assert.equal(Object.isFrozen(capabilities.model.selectionAt), true);
  assert.equal(Object.isFrozen(capabilities.effort), true);
  assert.equal(Object.isFrozen(capabilities.effort.selectionAt), true);

  const invalidProfiles = [
    { ...FULL_HARNESS_CAPABILITIES, sessionListing: undefined },
    { ...FULL_HARNESS_CAPABILITIES, unexpected: true },
    { ...FULL_HARNESS_CAPABILITIES, approvalPolicies: ["interactive", "interactive"] },
    { ...FULL_HARNESS_CAPABILITIES, approvalPolicies: ["unknown"] },
    {
      ...FULL_HARNESS_CAPABILITIES,
      model: { ...FULL_HARNESS_CAPABILITIES.model, selectionAt: ["createSession", "unknown"] },
    },
  ];
  for (const profile of invalidProfiles) {
    assert.throws(
      () => createOfficialHarnessRegistration(
        "codex",
        {},
        profile,
        unusedWorkspaceConfigurator,
        () => unusedAdapter("codex"),
      ),
      (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
    );
  }
});

test("Core production source keeps official Harness literals in the catalog only", async () => {
  const sourceRoot = new URL("../../packages/core/src/", import.meta.url);
  for (const entry of await readdir(sourceRoot)) {
    if (!entry.endsWith(".ts") || entry === "harness-catalog.ts") continue;
    const source = await readFile(new URL(entry, sourceRoot), "utf8");
    assert.doesNotMatch(source, /["'](?:codex|opencode|kimi|pi|agy)["']/, entry);
  }
});

test("Runtime rejects a live Adapter whose kind differs from its Registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-kind-mismatch-"));
  try {
    const registration = createOfficialHarnessRegistration(
      "codex",
      {},
      FULL_HARNESS_CAPABILITIES,
      unusedWorkspaceConfigurator,
      () => unusedAdapter("opencode"),
    );
    await assert.rejects(
      createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") }),
      (error) => {
        assert.ok(error instanceof MuhaError);
        assert.equal(error.data.code, "RUNTIME_INITIALIZATION_FAILED");
        if (error.data.code !== "RUNTIME_INITIALIZATION_FAILED") return false;
        assert.deepEqual(error.data.initializationFailures, [{
          code: "HARNESS_ERROR",
          message: "Harness initialize failed",
          harness: "codex",
          operation: "initialize",
        }]);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const unusedWorkspaceConfigurator = Object.freeze({
  planSkill: unusedPlan,
  planMcpServer: unusedPlan,
});

function unusedPlan() {
  return Object.freeze({ entrypoint: "/unused.js", args: Object.freeze([]) });
}

function unusedAdapter(kind) {
  return {
    kind,
    async initialize() {},
    async createSession() { throw new Error("unused"); },
    async resumeSession() { throw new Error("unused"); },
    async listSessions() { return []; },
    async close() {},
  };
}
