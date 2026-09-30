import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";

import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const fakeBin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");

test("OpenCode v2 MCP writer preserves JSONC and writes only the requested project server", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-mcp-"));
  const workspace = join(root, "workspace");
  const configPath = join(workspace, "opencode.jsonc");
  await mkdir(workspace);
  const original = '{\n  // caller-owned setting\n  "theme": "dark",\n  "mcp": {"servers": {"keep": {"type": "remote", "url": "https://keep.example/mcp"}}}\n}\n';
  await writeFile(configPath, original);
  let runtime;
  try {
    runtime = await createRuntime(root);
    const result = await runtime.configureWorkspace({ workspacePath: workspace, mcpServers: [
      { name: "replace", transport: "stdio", command: "/usr/bin/printf", args: ["hello world"],
        env: { TOKEN: "{env:TOKEN}" } },
      { name: "remote", transport: "http", url: "https://example.com/mcp",
        headers: { Authorization: "Bearer {env:TOKEN}" } },
    ] });
    assert.deepEqual(result.attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"]);
    const source = await readFile(configPath, "utf8");
    assert.match(source, /caller-owned setting/);
    const value = parse(source);
    assert.equal(value.theme, "dark");
    assert.deepEqual(value.mcp.servers.keep,
      { type: "remote", url: "https://keep.example/mcp" });
    assert.deepEqual(value.mcp.servers.replace,
      { type: "local", command: ["/usr/bin/printf", "hello world"],
        environment: { TOKEN: "{env:TOKEN}" } });
    assert.deepEqual(value.mcp.servers.remote,
      { type: "remote", url: "https://example.com/mcp",
        headers: { Authorization: "Bearer {env:TOKEN}" }, oauth: false });
    await assert.rejects(access(join(workspace, ".mcp.json")), { code: "ENOENT" });
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 MCP writer refuses invalid or ambiguous user config without rewriting it", async () => {
  for (const variant of ["invalid", "both"]) {
    const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-mcp-refuse-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const jsonc = join(workspace, "opencode.jsonc");
    const original = variant === "invalid" ? '{ "mcp": [1] }\n' : '{ "theme": "dark" }\n';
    await writeFile(jsonc, original);
    if (variant === "both") await writeFile(join(workspace, "opencode.json"), "{}\n");
    let runtime;
    try {
      runtime = await createRuntime(root);
      const result = await runtime.configureWorkspace({ workspacePath: workspace,
        mcpServers: [{ name: "new", transport: "stdio", command: "node" }] });
      assert.equal(result.attempts[0].status, "failed");
      assert.equal(await readFile(jsonc, "utf8"), original);
      assert.equal(runtime.status, "active");
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

function createRuntime(root) {
  return createMuhaRuntime({
    harnesses: [openCodeAdapter({ env: {
      PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
    } })], dataDir: join(root, "diagnostics"),
  });
}
