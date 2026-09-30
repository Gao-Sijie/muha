// Native test administration only. The product Adapter never grants Workspace
// trust. Only this test's newly-created, canonical fixture may be trusted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

export async function trustKimiQualificationWorkspace(root, workspace, options = {}) {
  assert.ok(root === await realpath(root) && workspace === await realpath(workspace) &&
    root.startsWith(join(await realpath(tmpdir()), "muha-pf-kimi-")) &&
    /^muha-pf-kimi-[\w-]+$/.test(basename(root)) && workspace === join(root, "workspace"),
  "trust is restricted to the owned qualification workspace");
  const child = spawn("kimi", ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"], {
    detached: true, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  let exited = false, origin, token, workspaceID, closing;
  const exit = new Promise(resolve => {
    child.once("exit", () => { exited = true; resolve(); });
    child.once("error", () => { exited = true; resolve(); });
  });
  const request = async (method, path, body) => {
    const response = await fetch(origin + path, { method,
      headers: { Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const envelope = await response.json();
    assert.ok(response.ok && envelope.code === 0,
      `Kimi native trust administration failed: ${method} ${path} HTTP ${response.status} code ${envelope.code}`);
    return envelope.data;
  };
  const stop = async () => {
    if (!exited) {
      process.kill(-child.pid, "SIGTERM");
      const timer = setTimeout(() => { if (!exited) process.kill(-child.pid, "SIGKILL"); }, 3_000);
      try { await exit; } finally { clearTimeout(timer); }
    }
    lines.close();
  };
  const close = () => closing ??= (async () => {
    try {
      if (workspaceID) {
        const path = `/api/v1/workspaces/${encodeURIComponent(workspaceID)}`;
        await request("POST", path + "/untrust");
        assert.equal((await request("GET", path + "/trust")).trusted, false);
        await request("DELETE", path);
      }
    } finally { await stop(); }
  })();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Kimi native trust server startup timed out")), 30_000);
      exit.then(() => { clearTimeout(timer); reject(new Error("Kimi native trust server exited")); });
      lines.on("line", line => {
        const serialized = /^\s*(?:Local:\s+|Kimi server: )(\S+)\s*$/.exec(line)?.[1];
        if (!serialized) return;
        try {
          const url = new URL(serialized);
          const value = new URLSearchParams(url.hash.slice(1)).get("token");
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
              url.username || url.password || url.search || url.pathname !== "/" || !value) return;
          origin = url.origin; token = value; clearTimeout(timer); resolve();
        } catch { /* Do not log native banners or authentication material. */ }
      });
      child.once("error", () => { clearTimeout(timer); reject(new Error("Kimi native trust server unavailable")); });
    });
    const registered = await request("POST", "/api/v1/workspaces", { root: workspace });
    assert.equal(registered.root, workspace);
    assert.equal(typeof registered.id, "string");
    workspaceID = registered.id;
    const path = `/api/v1/workspaces/${encodeURIComponent(workspaceID)}/trust`;
    assert.equal((await request("GET", path)).trusted, false, "fixture must not inherit prior native trust");
    await request("POST", path);
    assert.equal((await request("GET", path)).trusted, true);
    return close;
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Kimi qualification setup and cleanup failed"); }
    throw error;
  }
}
