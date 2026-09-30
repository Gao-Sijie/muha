import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const controlledPath = [fakeHarnessBin, dirname(process.execPath)].join(delimiter);
const fakeV2HarnessBin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");
const v2ControlledPath = [fakeV2HarnessBin, fakeHarnessBin, dirname(process.execPath)].join(delimiter);

test("Workspace defaults preserve Harness order, explicit subsets, and cross-Harness failure isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-workspace-multi-harness-"));
  const workspace = join(root, "workspace");
  const codexConfig = join(workspace, ".codex", "config.toml");
  const openCodeConfig = join(workspace, "opencode.jsonc");
  const kimiConfig = join(workspace, ".kimi-code", "mcp.json");
  let runtime;
  try {
    await Promise.all([
      mkdir(dirname(codexConfig), { recursive: true }),
      mkdir(dirname(kimiConfig), { recursive: true }),
      writeSkill(join(workspace, "source"), "shared-skill", "shared"),
    ]);
    const originalCodex = '[mcp_servers.unrelated]\ncommand = "keep-codex"\n';
    await writeFile(codexConfig, originalCodex, { mode: 0o400 });
    await writeFile(openCodeConfig, JSON.stringify({
      instructions: ["keep.md"],
      mcp: { servers: { unrelated: { type: "local", command: ["keep-opencode"] } } },
    }, null, 2));
    await writeFile(kimiConfig, JSON.stringify({
      callerOwned: true,
      mcpServers: {
        unrelated: { transport: "stdio", command: "keep-kimi", enabled: false },
      },
    }, null, 2));

    runtime = await createMuhaRuntime({
      harnesses: [registration("codex"), registration("opencode"), registration("kimi")],
      dataDir: join(root, "diagnostics"),
    });
    const configured = await runtime.configureWorkspace({
      workspacePath: workspace,
      skills: [{ source: "./source", skillNames: ["shared-skill"] }],
      mcpServers: [{ name: "shared", transport: "stdio", command: "node", args: ["server.js"] }],
    });
    assert.deepEqual(configured.attempts, [
      { kind: "skill", harness: "codex", inputIndex: 0, status: "succeeded" },
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
      { kind: "skill", harness: "opencode", inputIndex: 0, status: "succeeded" },
      { kind: "mcp", harness: "opencode", inputIndex: 0, status: "succeeded" },
      { kind: "skill", harness: "kimi", inputIndex: 0, status: "succeeded" },
      { kind: "mcp", harness: "kimi", inputIndex: 0, status: "succeeded" },
    ]);
    assert.equal(await readFile(codexConfig, "utf8"), originalCodex);
    assert.match(
      await readFile(join(workspace, ".agents", "skills", "shared-skill", "SKILL.md"), "utf8"),
      /shared/,
    );
    let openCode = JSON.parse(await readFile(openCodeConfig, "utf8"));
    assert.deepEqual(openCode.instructions, ["keep.md"]);
    assert.deepEqual(openCode.mcp.servers.unrelated, {
      type: "local",
      command: ["keep-opencode"],
    });
    assert.deepEqual(openCode.mcp.servers.shared.command, ["node", "server.js"]);
    let kimi = JSON.parse(await readFile(kimiConfig, "utf8"));
    assert.equal(kimi.callerOwned, true);
    assert.deepEqual(kimi.mcpServers.unrelated, {
      transport: "stdio",
      command: "keep-kimi",
      enabled: false,
    });
    assert.deepEqual(kimi.mcpServers.shared, {
      transport: "stdio",
      command: "node",
      args: ["server.js"],
    });

    await chmod(codexConfig, 0o600);
    const subset = await runtime.configureWorkspace({
      workspacePath: workspace,
      harnesses: ["codex"],
      mcpServers: [{ name: "codex-only", transport: "http", url: "https://example.com/codex" }],
    });
    assert.deepEqual(subset.attempts, [
      { kind: "mcp", harness: "codex", inputIndex: 0, status: "succeeded" },
    ]);
    assert.match(await readFile(codexConfig, "utf8"), /codex-only/);
    openCode = JSON.parse(await readFile(openCodeConfig, "utf8"));
    assert.equal(Object.hasOwn(openCode.mcp.servers, "codex-only"), false);
    kimi = JSON.parse(await readFile(kimiConfig, "utf8"));
    assert.equal(Object.hasOwn(kimi.mcpServers, "codex-only"), false);
    assert.equal(runtime.status, "active");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode Workspace configuration settles while its Session has an active Turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-live-workspace-config-"));
  const workspace = join(root, "workspace");
  let runtime;
  let session;
  await writeSkill(join(workspace, "source"), "live-skill", "live");
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: {
          PATH: v2ControlledPath,
          MUHA_V2_PERMISSION: "ask",
          MUHA_V2_FORM: "question",
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "Wait for Workspace config." }]);
    const iterator = turn[Symbol.asyncIterator]();
    const approval = await nextEventOfType(iterator, "approval.requested");

    const configured = await runtime.configureWorkspace({
      workspacePath: workspace,
      harnesses: ["opencode"],
      skills: [{ source: "./source", skillNames: ["live-skill"] }],
      mcpServers: [{ name: "live", transport: "http", url: "https://example.com/live" }],
    });
    assert.deepEqual(configured.attempts, [
      { kind: "skill", harness: "opencode", inputIndex: 0, status: "succeeded" },
      { kind: "mcp", harness: "opencode", inputIndex: 0, status: "succeeded" },
    ]);
    assert.deepEqual(session.status, { status: "running", turnId: turn.turnId });
    await access(join(workspace, ".agents", "skills", "live-skill", "SKILL.md"));
    assert.equal(JSON.parse(await readFile(join(workspace, "opencode.jsonc"), "utf8")).mcp.servers.live.url,
      "https://example.com/live");

    await turn.respondToApproval(approval.requestId, "allowOnce");
    const question = await nextEventOfType(iterator, "question.requested");
    await turn.respondToQuestion(question.requestId, { action: "dismiss" });
    assert.equal((await turn.result).status, "completed");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function registration(harness) {
  const adapter = harness === "codex"
    ? codexAdapter
    : harness === "opencode"
      ? openCodeAdapter
      : kimiAdapter;
  return adapter({
    env: { PATH: harness === "opencode" ? v2ControlledPath : controlledPath },
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
  });
}

async function writeSkill(sourceRoot, name, marker) {
  const directory = join(sourceRoot, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${marker}\n---\n\n${marker}\n`,
  );
}

async function nextEventOfType(iterator, type) {
  for (;;) {
    const next = await iterator.next();
    assert.equal(next.done, false, `Turn ended before ${type}`);
    if (next.value.type === type) return next.value;
  }
}
