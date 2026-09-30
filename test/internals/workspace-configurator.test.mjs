import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import {
  composeWorkspaceConfigurator,
  createAddMcpPlanner,
  createOfficialHarnessRegistration,
  createSkillsCliPlanner,
} from "@muha-sdk/core/internal";
import { FULL_HARNESS_CAPABILITIES } from "../support/full-harness-capabilities.mjs";

const workerPath = resolve(import.meta.dirname, "../fixtures/workspace-worker.mjs");

test("shared Workspace planners produce frozen, parameterized worker invocations", () => {
  const configurator = composeWorkspaceConfigurator({
    planSkill: createSkillsCliPlanner("codex"),
    planMcpServer: createAddMcpPlanner("codex"),
  });

  assert.equal(Object.isFrozen(configurator), true);

  const skill = configurator.planSkill(Object.freeze({
    workspacePath: "/tmp/workspace",
    source: "acme/example",
    skillNames: Object.freeze(["one", "two"]),
  }));
  assert.equal(Object.isFrozen(skill), true);
  assert.equal(Object.isFrozen(skill.args), true);
  assert.equal(isAbsolute(skill.entrypoint), true);
  assert.deepEqual(skill.args, [
    "add",
    "acme/example",
    "--agent",
    "codex",
    "--skill",
    "one",
    "two",
    "--copy",
    "--yes",
  ]);
  assert.equal(skill.stdin, undefined);

  const server = Object.freeze({
    name: "example",
    transport: "stdio",
    command: "example-mcp",
    args: Object.freeze(["serve"]),
    env: Object.freeze({ API_TOKEN: "payload-only" }),
  });
  const mcp = configurator.planMcpServer(Object.freeze({
    workspacePath: "/tmp/workspace",
    server,
  }));
  assert.equal(Object.isFrozen(mcp), true);
  assert.equal(Object.isFrozen(mcp.args), true);
  assert.equal(isAbsolute(mcp.entrypoint), true);
  assert.deepEqual(mcp.args, []);
  assert.deepEqual(JSON.parse(mcp.stdin), {
    workspacePath: "/tmp/workspace",
    target: "codex",
    server,
  });
});

test("Workspace Configurator composition permits one planner to be overridden", () => {
  const customPlan = () => Object.freeze({
    entrypoint: "/adapter/custom-worker.js",
    args: Object.freeze(["--custom"]),
  });
  const configurator = composeWorkspaceConfigurator({
    planSkill: createSkillsCliPlanner("kimi-code-cli"),
    planMcpServer: customPlan,
  });

  assert.equal(configurator.planMcpServer, customPlan);
  assert.deepEqual(
    configurator.planSkill(Object.freeze({
      workspacePath: "/tmp/workspace",
      source: "acme/example",
    })).args,
    [
      "add",
      "acme/example",
      "--agent",
      "kimi-code-cli",
      "--skill",
      "*",
      "--copy",
      "--yes",
    ],
  );
});

test("Core snapshots planner inputs and exclusively controls each valid worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-configurator-worker-"));
  const workspacePath = join(root, "workspace");
  const outputPath = join(root, "workers.jsonl");
  const inputs = [];
  const configurator = composeWorkspaceConfigurator({
    planSkill(input) {
      inputs.push(input);
      return invocation(outputPath, "skill");
    },
    planMcpServer(input) {
      inputs.push(input);
      return invocation(outputPath, "mcp");
    },
  });
  const registrationValue = registration(configurator, {
    env: { MUHA_ADAPTER_ONLY: "must-not-flow" },
  });
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [registrationValue],
      dataDir: join(root, "diagnostics"),
    });
    const result = await runtime.configureWorkspace({
      workspacePath,
      skills: [{ source: "acme/example" }],
      mcpServers: [{
        name: "example",
        transport: "stdio",
        command: "example-mcp",
        env: { MUHA_MCP_PAYLOAD_ONLY: "must-not-flow" },
      }],
    });

    assert.deepEqual(result.attempts.map(({ status }) => status), ["succeeded", "succeeded"]);
    assert.equal(inputs.length, 2);
    for (const input of inputs) {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(input.workspacePath, workspacePath);
    }
    assert.equal(Object.isFrozen(inputs[1].server), true);
    assert.equal(Object.isFrozen(inputs[1].server.env), true);

    const records = (await readFile(outputPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(records.map(({ label }) => label), ["skill", "mcp"]);
    for (const record of records) {
      assert.equal(record.cwd, workspacePath);
      assert.equal(record.disableTelemetry, "1");
      assert.equal(record.doNotTrack, "1");
      assert.equal(record.adapterOnly, null);
      assert.equal(record.mcpPayloadOnly, null);
    }
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("planner throws and invalid invocations become failed attempts without spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-configurator-invalid-"));
  const outputPath = join(root, "must-not-exist.jsonl");
  const configurator = composeWorkspaceConfigurator({
    planSkill() {
      throw new Error("planner defect");
    },
    planMcpServer() {
      return {
        entrypoint: workerPath,
        args: [],
        stdin: JSON.stringify({ outputPath, label: "must-not-run" }),
        unexpected: true,
      };
    },
  });
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration(configurator)],
      dataDir: join(root, "diagnostics"),
    });
    const result = await runtime.configureWorkspace({
      workspacePath: join(root, "workspace"),
      skills: [{ source: "acme/example" }],
      mcpServers: [{ name: "example", transport: "stdio", command: "example-mcp" }],
    });
    assert.deepEqual(result.attempts, [
      {
        kind: "skill",
        harness: "codex",
        inputIndex: 0,
        status: "failed",
        error: {
          code: "SKILL_CONFIGURATION_FAILED",
          message: "Skills CLI failed to configure the Workspace",
        },
      },
      {
        kind: "mcp",
        harness: "codex",
        inputIndex: 0,
        status: "failed",
        error: {
          code: "MCP_CONFIGURATION_FAILED",
          message: "MCP configuration writer failed for the Workspace",
        },
      },
    ]);
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime closure during a throwing planner rejects configuration as cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-configurator-cancel-"));
  let runtime;
  const configurator = composeWorkspaceConfigurator({
    planSkill() {
      void runtime.close();
      throw new Error("planner defect after closing runtime");
    },
    planMcpServer() {
      throw new Error("unused");
    },
  });
  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration(configurator)],
      dataDir: join(root, "diagnostics"),
    });
    await assert.rejects(
      runtime.configureWorkspace({
        workspacePath: join(root, "workspace"),
        skills: [{ source: "acme/example" }],
      }),
      (error) => error?.name === "MuhaError" && error?.data?.code === "RUNTIME_CLOSED",
    );
    await runtime.close();
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function invocation(outputPath, label) {
  return Object.freeze({
    entrypoint: workerPath,
    args: Object.freeze([]),
    stdin: JSON.stringify({ outputPath, label }),
  });
}

function registration(workspaceConfigurator, options = {}) {
  return createOfficialHarnessRegistration(
    "codex",
    options,
    FULL_HARNESS_CAPABILITIES,
    workspaceConfigurator,
    () => ({
      kind: "codex",
      async initialize() {},
      async createSession() { throw new Error("unused"); },
      async resumeSession() { throw new Error("unused"); },
      async listSessions() { return []; },
      async close() {},
    }),
  );
}
