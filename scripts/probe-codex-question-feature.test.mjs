// Run explicitly with `node --test scripts/probe-codex-question-feature.test.mjs`.
// This probes the installed Codex app-server without starting a model Turn.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const featureName = "default_mode_request_user_input";

for (const { globalEnabled, projectEnabled } of [
  { globalEnabled: false, projectEnabled: true },
  { globalEnabled: true, projectEnabled: false },
]) {
  test(`Codex resolves ${featureName}: global ${globalEnabled}, project ${projectEnabled}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "muha-codex-feature-probe-"));
    const codexHome = join(root, "codex-home");
    const workspace = join(root, "project");
    let client;
    let runtime;
    let session;
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning);
    try {
      await mkdir(codexHome);
      await mkdir(join(workspace, ".codex"), { recursive: true });
      await writeFile(join(codexHome, "config.toml"), [
        "[features]",
        `${featureName} = ${globalEnabled}`,
        "",
        `[projects.${JSON.stringify(workspace)}]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"));
      await writeFile(join(workspace, ".codex", "config.toml"), [
        "[features]",
        `${featureName} = ${projectEnabled}`,
        "",
      ].join("\n"));

      client = startAppServer(root, codexHome);
      await client.request("initialize", {
        clientInfo: { name: "muha_feature_probe", title: "Muha feature probe", version: "0.1.0" },
        capabilities: null,
      });
      client.notify("initialized");

      assert.equal(await featureEnabled(client), globalEnabled, "global effective flag");
      const started = await client.request("thread/start", {
        cwd: workspace,
        sandbox: "workspace-write",
        approvalPolicy: "never",
      });
      assert.equal(typeof started?.thread?.id, "string", "Codex thread identity");
      assert.equal(
        await featureEnabled(client, started.thread.id),
        projectEnabled,
        "thread effective flag must follow trusted project config",
      );
      await client.close();
      client = undefined;

      process.on("warning", onWarning);
      runtime = await createMuhaRuntime({
        harnesses: [codexAdapter({
          env: { CODEX_HOME: codexHome },
          startupTimeoutMs: 5_000,
          shutdownTimeoutMs: 5_000,
        })],
        dataDir: join(root, "diagnostics"),
      });
      session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(session.reference.workspacePath, workspace);
      assert.equal(
        warnings.filter(({ code }) => code === "MUHA_CODEX_QUESTION_FEATURE_DISABLED").length,
        projectEnabled ? 0 : 1,
        "Adapter warning must follow effective project value",
      );
    } finally {
      process.off("warning", onWarning);
      await session?.close();
      await runtime?.close();
      await client?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function featureEnabled(client, threadId) {
  const cursors = new Set();
  let cursor;
  for (;;) {
    const response = await client.request("experimentalFeature/list", {
      limit: 50,
      ...(threadId === undefined ? {} : { threadId }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.ok(Array.isArray(response?.data), "feature list data");
    const feature = response.data.find((entry) => entry.name === featureName);
    if (feature !== undefined) {
      assert.equal(typeof feature.enabled, "boolean", "feature enabled value");
      return feature.enabled;
    }
    if (response.nextCursor === null || response.nextCursor === undefined) {
      assert.fail(`Codex did not expose ${featureName}`);
    }
    assert.equal(typeof response.nextCursor, "string", "feature list cursor");
    assert.ok(!cursors.has(response.nextCursor), "feature list cursor must advance");
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
}

function startAppServer(cwd, codexHome) {
  const child = spawn("codex", ["app-server", "--stdio"], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  child.stderr.resume();
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  });
  child.once("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  child.once("exit", (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`Codex app-server exited ${code}`));
    }
    pending.clear();
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 15_000);
        pending.set(id, { method, resolve, reject, timer });
        send({ id, method, params });
      });
    },
    notify(method) { send({ method }); },
    async close() {
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    },
  };
}
