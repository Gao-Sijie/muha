import assert from "node:assert/strict";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";
import { agyAdapter } from "@muha-sdk/agy-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const fakeV2HarnessBin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");

test("configureWorkspace creates only when permitted and returns a canonical path", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-workspace-skills-"));
  const workspace = join(root, "missing", "workspace");
  const denied = join(root, "denied");
  let runtime;
  try {
    runtime = await createRuntime(root);
    assert.deepEqual(await runtime.configureWorkspace({ workspacePath: workspace }), {
      workspacePath: await realpath(workspace),
      created: true,
      attempts: [],
    });
    const alias = join(root, "workspace-alias");
    await symlink(workspace, alias, "dir");
    assert.deepEqual(await runtime.configureWorkspace({ workspacePath: alias }), {
      workspacePath: await realpath(workspace),
      created: false,
      attempts: [],
    });
    assert.deepEqual(await runtime.configureWorkspace({ workspacePath: workspace }), {
      workspacePath: await realpath(workspace),
      created: false,
      attempts: [],
    });
    await assert.rejects(
      runtime.configureWorkspace({ workspacePath: denied, createIfMissing: false }),
      (error) => error instanceof MuhaError && error.data.code === "WORKSPACE_NOT_FOUND",
    );
    await assert.rejects(access(denied), { code: "ENOENT" });
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("configureWorkspace rejects closed invalid inputs before creating a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-workspace-skills-invalid-"));
  const workspace = join(root, "must-not-exist");
  let runtime;
  try {
    runtime = await createRuntime(root);
    const invalid = [
      { workspacePath: "relative" },
      { workspacePath: workspace, createIfMissing: "yes" },
      { workspacePath: workspace, harnesses: [] },
      { workspacePath: workspace, harnesses: ["codex", "codex"] },
      { workspacePath: workspace, harnesses: ["opencode"] },
      { workspacePath: workspace, skills: {} },
      { workspacePath: workspace, skills: [{ source: "" }] },
      { workspacePath: workspace, skills: [{ source: "./source", skillNames: [] }] },
      { workspacePath: workspace, skills: [{ source: "./source", skillNames: ["one", "one"] }] },
      { workspacePath: workspace, skills: [{ source: "./source", extra: true }] },
      { workspacePath: workspace, unknown: true },
    ];
    for (const options of invalid) {
      await assert.rejects(
        runtime.configureWorkspace(options),
        (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
      );
    }
    await assert.rejects(access(workspace), { code: "ENOENT" });
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const harness of ["codex", "opencode", "kimi", "agy"]) {
  test(`${harness} Skill attempts use Workspace-relative copy installs, replace conflicts, and isolate failures`, async () => {
    const root = await mkdtemp(join(tmpdir(), `muha-${harness}-workspace-skills-cli-`));
    const workspace = join(root, "workspace");
    let runtime;
    try {
      await mkdir(workspace);
      await writeSkill(join(workspace, "source-one"), "replace-me", "first", {
        "obsolete.txt": "remove me",
      });
      await writeSkill(join(workspace, "source-one"), "discovered-too", "discovered");
      await writeSkill(join(workspace, "source-two"), "replace-me", "second", {
        "current.txt": "keep me",
      });
      await writeSkill(join(workspace, "source-two"), "not-selected", "must stay absent");
      await writeSkill(join(workspace, ".agents", "skills"), "unrelated", "untouched");
      const nativePlugin = join(workspace, ".gemini", "plugins", "unrelated");
      await mkdir(nativePlugin, { recursive: true });
      await writeFile(join(nativePlugin, "plugin.json"), '{"name":"unrelated"}\n');

      runtime = await createRuntime(root, harness);
      const result = await runtime.configureWorkspace({
        workspacePath: workspace,
        skills: [
          { source: "./source-one" },
          { source: "./missing;touch shell-owned" },
          { source: "./source-two", skillNames: ["replace-me"] },
        ],
      });
      assert.equal(result.workspacePath, await realpath(workspace));
      assert.equal(result.created, false);
      assert.deepEqual(result.attempts.map((attempt) => ({
        ...attempt,
        ...(attempt.status === "failed" ? { error: { code: attempt.error.code } } : {}),
      })), [
        { kind: "skill", harness, inputIndex: 0, status: "succeeded" },
        {
          kind: "skill",
          harness,
          inputIndex: 1,
          status: "failed",
          error: { code: "SKILL_CONFIGURATION_FAILED" },
        },
        { kind: "skill", harness, inputIndex: 2, status: "succeeded" },
      ]);
      const installed = join(workspace, ".agents", "skills");
      assert.match(await readFile(join(installed, "replace-me", "SKILL.md"), "utf8"), /second/);
      assert.equal(await readFile(join(installed, "replace-me", "current.txt"), "utf8"), "keep me");
      await assert.rejects(access(join(installed, "replace-me", "obsolete.txt")), { code: "ENOENT" });
      assert.match(await readFile(join(installed, "discovered-too", "SKILL.md"), "utf8"), /discovered/);
      await assert.rejects(access(join(installed, "not-selected")), { code: "ENOENT" });
      assert.match(await readFile(join(installed, "unrelated", "SKILL.md"), "utf8"), /untouched/);
      assert.equal((await lstat(join(installed, "replace-me"))).isSymbolicLink(), false);
      await assert.rejects(access(join(workspace, "shell-owned")), { code: "ENOENT" });
      assert.equal(result.attempts[1].error.message.includes("missing"), false);
      await writeFile(join(installed, "replace-me", "SKILL.md"), "caller modified\n");
      assert.deepEqual(
        await runtime.configureWorkspace({ workspacePath: workspace }),
        { workspacePath: await realpath(workspace), created: false, attempts: [] },
      );
      assert.equal(
        await readFile(join(installed, "replace-me", "SKILL.md"), "utf8"),
        "caller modified\n",
      );
      assert.equal(runtime.status, "active");
      assert.equal(await readFile(join(nativePlugin, "plugin.json"), "utf8"), '{"name":"unrelated"}\n');
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

function createRuntime(root, harness = "codex") {
  const adapter = harness === "codex"
    ? codexAdapter
    : harness === "opencode"
      ? openCodeAdapter
      : harness === "agy" ? agyAdapter : kimiAdapter;
  return createMuhaRuntime({
    harnesses: [
      adapter({
        env: {
          HOME: join(root, "native-home"),
          PATH: [harness === "opencode" ? fakeV2HarnessBin : fakeHarnessBin, dirname(process.execPath)].join(delimiter),
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      }),
    ],
    dataDir: join(root, "diagnostics"),
  });
}

async function writeSkill(sourceRoot, name, marker, extraFiles = {}) {
  const directory = join(sourceRoot, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${marker}\n---\n\n${marker}\n`,
  );
  for (const [filename, contents] of Object.entries(extraFiles)) {
    await writeFile(join(directory, filename), contents);
  }
}
