// T17 — Workspace configuration remains native-owned. The verified Drivers
// advertise no file/terminal Host capabilities and must not execute requests
// for those unadvertised methods, even inside the Workspace.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import { controlledOpenCodeAdapter as openCodeAdapter } from "../fixtures/acp-harness/options.mjs";
import { acpOptions } from "../fixtures/acp-harness/options.mjs";

test("ACP preserves Workspace Skills configuration without exposing unadvertised Host file operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-ws-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("fs") })],
      dataDir: join(root, "diagnostics"),
    });
    const skillSource = join(root, "skills-source");
    const skillDir = join(skillSource, "muha-ws");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: muha-ws\ndescription: ACP ws fixture.\n---\n\nFixture.\n");
    const configuration = await runtime.configureWorkspace({
      workspacePath: workspace,
      harnesses: ["opencode"],
      skills: [{ source: skillSource, skillNames: ["muha-ws"] }],
    });
    // Configuration is written to the canonical Workspace (native loading side).
    await writeFile(join(workspace, "skills.txt"), "configured\n");
    assert.equal(configuration.attempts[0].status, "succeeded");

    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "read" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "read=-32601 write=-32601 escape=-32601 terminal=-32601");
    assert.equal(await readFile(join(workspace, "skills.txt"), "utf8"), "configured\n");
    await assert.rejects(readFile(join(workspace, "host-wrote.txt")), { code: "ENOENT" });
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route keeps static Workspace-related capabilities truthful and unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-cap-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("normal") })],
      dataDir: join(root, "diagnostics"),
    });
    const capabilities = runtime.getHarnessCapabilities("opencode");
    assert.equal(capabilities.workspaceSkills, true);
    assert.equal(capabilities.workspaceMcp, true);
    // Host RPC availability is separate from native Workspace configuration.
    assert.deepEqual([...Object.keys(capabilities)].sort(), [
      "approvalPolicies", "assistantMessageStreaming", "assistantReasoningStreaming",
      "effort", "imageInput", "model", "sessionListing", "toolEvents",
      "turnQuestions", "turnUsage", "workspaceMcp", "workspaceSkills",
    ]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
