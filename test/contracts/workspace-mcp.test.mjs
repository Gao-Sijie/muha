import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const fakeV2HarnessBin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");

for (const harness of ["codex", "opencode", "kimi"]) {
  test(`${harness} project MCP entries preserve portable boundaries and replace only name conflicts`, async () => {
    const root = await mkdtemp(join(tmpdir(), `muha-${harness}-workspace-mcp-`));
    const workspace = join(root, "workspace");
    const native = nativeMcpFixture(harness, workspace);
    let runtime;
    try {
      await mkdir(dirname(native.path), { recursive: true });
      await writeFile(native.path, native.original);
      runtime = await createRuntime(root, harness);
      const result = await runtime.configureWorkspace({
        workspacePath: workspace,
        mcpServers: [
          {
            name: "replace-me",
            transport: "stdio",
            command: "/bin/echo;not-a-shell",
            args: ["one argument", "${LITERAL_ARG}"],
            env: { OBSOLETE: "remove-me" },
          },
          {
            name: "remote",
            transport: "http",
            url: "https://example.com/mcp?x=1",
            headers: { Authorization: "Bearer ${TOKEN}", "X-Empty": "" },
          },
          {
            name: "replace-me",
            transport: "stdio",
            command: "/usr/bin/printf",
            args: ["final", "value"],
            env: { TOKEN: "${LITERAL_TOKEN}", EMPTY: "" },
          },
        ],
      });
      assert.deepEqual(result.attempts, [0, 1, 2].map((inputIndex) => ({
        kind: "mcp",
        harness,
        inputIndex,
        status: "succeeded",
      })));
      native.assert(await readFile(native.path, "utf8"));
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Kimi MCP writer creates only its project config path when none exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-kimi-workspace-mcp-create-"));
  const workspace = join(root, "workspace");
  let runtime;
  try {
    runtime = await createRuntime(root, "kimi");
    const result = await runtime.configureWorkspace({
      workspacePath: workspace,
      mcpServers: [{ name: "new", transport: "http", url: "https://example.com/new" }],
    });
    assert.deepEqual(result.attempts, [
      { kind: "mcp", harness: "kimi", inputIndex: 0, status: "succeeded" },
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(workspace, ".kimi-code", "mcp.json"), "utf8")),
      {
        mcpServers: {
          new: { transport: "http", url: "https://example.com/new" },
        },
      },
    );
    await assert.rejects(access(join(workspace, ".mcp.json")), { code: "ENOENT" });
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("portable MCP input rejects non-stdio/http and arbitrary native fields before writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-workspace-mcp-invalid-"));
  const workspace = join(root, "must-not-exist");
  let runtime;
  try {
    runtime = await createRuntime(root);
    const invalidServers = [
      { name: "", transport: "stdio", command: "node" },
      { name: "legacy", transport: "sse", url: "https://example.com/sse" },
      { name: "local", transport: "stdio", command: "" },
      { name: "local", transport: "stdio", command: "node", args: [1] },
      { name: "local", transport: "stdio", command: "node", env: { KEY: 1 } },
      { name: "local", transport: "stdio", command: "node", timeout: 1 },
      { name: "remote", transport: "http", url: "/relative" },
      { name: "remote", transport: "http", url: "ftp://example.com/mcp" },
      { name: "remote", transport: "http", url: "https://example.com", headers: { Key: 1 } },
      { name: "remote", transport: "http", url: "https://example.com", oauthScopes: [] },
    ];
    await assert.rejects(
      runtime.configureWorkspace({ workspacePath: workspace, mcpServers: {} }),
      invalidInput,
    );
    for (const server of invalidServers) {
      await assert.rejects(
        runtime.configureWorkspace({ workspacePath: workspace, mcpServers: [server] }),
        invalidInput,
      );
    }
    await assert.rejects(access(workspace), { code: "ENOENT" });
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const harness of ["codex", "opencode", "kimi"]) {
  test(`${harness} MCP writer failures preserve native config and leave the Runtime usable`, async () => {
    const root = await mkdtemp(join(tmpdir(), `muha-${harness}-workspace-mcp-failure-`));
    const workspace = join(root, "workspace");
    const native = nativeMcpFixture(harness, workspace);
    let runtime;
    try {
      await mkdir(dirname(native.path), { recursive: true });
      await writeFile(native.path, native.original, { mode: 0o400 });
      runtime = await createRuntime(root, harness);
      const failed = await runtime.configureWorkspace({
        workspacePath: workspace,
        mcpServers: [
          { name: "first", transport: "stdio", command: "node" },
          { name: "second", transport: "http", url: "https://example.com/mcp" },
        ],
      });
      assert.deepEqual(failed.attempts, [0, 1].map((inputIndex) => ({
        kind: "mcp",
        harness,
        inputIndex,
        status: "failed",
        error: {
          code: "MCP_CONFIGURATION_FAILED",
          message: "MCP configuration writer failed for the Workspace",
        },
      })));
      assert.equal(await readFile(native.path, "utf8"), native.original);
      assert.equal(runtime.status, "active");

      await chmod(native.path, 0o600);
      const retry = await runtime.configureWorkspace({
        workspacePath: workspace,
        mcpServers: [{ name: "retry", transport: "stdio", command: "node" }],
      });
      assert.deepEqual(retry.attempts, [
        { kind: "mcp", harness, inputIndex: 0, status: "succeeded" },
      ]);
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

function invalidInput(error) {
  return error instanceof MuhaError && error.data.code === "INVALID_INPUT";
}

function createRuntime(root, harness = "codex") {
  const adapter = harness === "codex"
    ? codexAdapter
    : harness === "opencode"
      ? openCodeAdapter
      : kimiAdapter;
  return createMuhaRuntime({
    harnesses: [adapter({
      env: { PATH: [harness === "opencode" ? fakeV2HarnessBin : fakeHarnessBin, dirname(process.execPath)].join(delimiter) },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    })],
    dataDir: join(root, "diagnostics"),
  });
}

function nativeMcpFixture(harness, workspace) {
  if (harness === "codex") {
    return {
      path: join(workspace, ".codex", "config.toml"),
      original: '[mcp_servers.unrelated]\ncommand = "keep-me"\nargs = ["untouched"]\n',
      assert(config) {
        assert.match(config, /\[mcp_servers\.unrelated\][\s\S]*keep-me/);
        assert.match(config, /\[mcp_servers\.replace-me\][\s\S]*\/usr\/bin\/printf/);
        assert.match(config, /args = \[ "final", "value" \]/);
        assert.equal(config.includes("OBSOLETE"), false);
        assert.match(config, /TOKEN = "\$\{LITERAL_TOKEN\}"/);
        assert.match(config, /EMPTY = ""/);
        assert.match(config, /\[mcp_servers\.remote\]/);
        assert.match(config, /https:\/\/example\.com\/mcp\?x=1/);
        assert.match(config, /Bearer \$\{TOKEN\}/);
        assert.match(config, /X-Empty = ""/);
      },
    };
  }
  if (harness === "opencode") return {
    path: join(workspace, "opencode.jsonc"),
    original: JSON.stringify({
      $schema: "https://opencode.ai/v2/config.json",
      instructions: ["keep.md"],
      mcp: {
        servers: { unrelated: { type: "local", command: ["keep-me", "untouched"] } },
      },
    }, null, 2),
    assert(source) {
      const config = JSON.parse(source);
      assert.equal(config.$schema, "https://opencode.ai/v2/config.json");
      assert.deepEqual(config.instructions, ["keep.md"]);
      assert.deepEqual(config.mcp.servers.unrelated, {
        type: "local",
        command: ["keep-me", "untouched"],
      });
      assert.deepEqual(config.mcp.servers["replace-me"], {
        type: "local",
        command: ["/usr/bin/printf", "final", "value"],
        environment: { TOKEN: "${LITERAL_TOKEN}", EMPTY: "" },
      });
      assert.equal(JSON.stringify(config).includes("OBSOLETE"), false);
      assert.deepEqual(config.mcp.servers.remote, {
        type: "remote",
        url: "https://example.com/mcp?x=1",
        headers: { Authorization: "Bearer ${TOKEN}", "X-Empty": "" },
        oauth: false,
      });
    },
  };
  return {
    path: join(workspace, ".kimi-code", "mcp.json"),
    original: JSON.stringify({
      $schema: "https://example.com/kimi-mcp.schema.json",
      callerOwned: { keep: true },
      mcpServers: {
        unrelated: {
          transport: "stdio",
          command: "keep-me",
          args: ["untouched"],
          enabled: false,
        },
      },
    }, null, 2),
    assert(source) {
      const config = JSON.parse(source);
      assert.equal(config.$schema, "https://example.com/kimi-mcp.schema.json");
      assert.deepEqual(config.callerOwned, { keep: true });
      assert.deepEqual(config.mcpServers.unrelated, {
        transport: "stdio",
        command: "keep-me",
        args: ["untouched"],
        enabled: false,
      });
      assert.deepEqual(config.mcpServers["replace-me"], {
        transport: "stdio",
        command: "/usr/bin/printf",
        args: ["final", "value"],
        env: { TOKEN: "${LITERAL_TOKEN}", EMPTY: "" },
      });
      assert.deepEqual(config.mcpServers.remote, {
        transport: "http",
        url: "https://example.com/mcp?x=1",
        headers: { Authorization: "Bearer ${TOKEN}", "X-Empty": "" },
      });
    },
  };
}
