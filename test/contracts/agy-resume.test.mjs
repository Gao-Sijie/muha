import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { agyAdapter } from "@muha-sdk/agy-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";
import { DatabaseSync } from "node:sqlite";
import { agyConformance } from "../support/agy-conformance.mjs";

test("AGY resumes the same native history after closing its Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-resume-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, "source.txt"), "local-evidence");
  let runtime;
  const open = () => createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter({
    env: { HOME: join(root, "home"), PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter) },
    startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
  })] });
  try {
    runtime = await open();
    const session = await runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "harnessManaged" });
    const reference = structuredClone(session.reference);
    assert.equal((await (await session.startTurn([{ type: "text", text: "Read workspace." }])).result).status, "completed");
    await runtime.close();
    runtime = await open();
    const resumed = await runtime.resumeSession({ reference, approvalPolicy: "harnessManaged" });
    assert.deepEqual(resumed.reference, reference);
    const turn = await resumed.startTurn([{ type: "text", text: "Recall my previous input." }]);
    assert.equal((await turn.result).message.text, "Read workspace.");
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ["missing-db", "corrupt-db", "wrong-cascade", "truncated-blob", "duplicate-workspace", "missing-project", "wrong-project-workspace"]) {
  test(`AGY resume rejects ${scenario} native metadata before submitting input`, async t => {
    const root = await mkdtemp(join(tmpdir(), "muha-agy-metadata-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const { options } = await agyConformance(t, { root });
    const runtime = await createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter(options)] });
    try {
      const session = await runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "harnessManaged" });
      const reference = session.reference;
      await session.close();
      const database = join(options.env.HOME, ".gemini/antigravity-cli/conversations", `${reference.sessionId}.db`);
      const projects = join(options.env.HOME, ".gemini/config/projects");
      if (scenario === "missing-db") await rename(database, `${database}.saved`);
      else if (scenario === "corrupt-db") await writeFile(database, "not sqlite");
      else if (scenario === "missing-project" || scenario === "wrong-project-workspace") {
        for (const name of await readdir(projects)) {
          const path = join(projects, name);
          const project = JSON.parse(await readFile(path, "utf8"));
          if (!project.projectResources.resources.some(resource => resource.folderUri.endsWith("/workspace"))) continue;
          if (scenario === "missing-project") await rename(path, `${path}.saved`);
          else {
            project.projectResources.resources.push({ folderUri: "file:///tmp" });
            await writeFile(path, JSON.stringify(project));
          }
        }
      } else {
        const db = new DatabaseSync(database);
        try {
          if (scenario === "wrong-cascade") db.exec("UPDATE trajectory_meta SET cascade_id='different-session'");
          else if (scenario === "truncated-blob") db.prepare("UPDATE trajectory_metadata_blob SET data=?").run(Buffer.from([0x92, 1, 0x80]));
          else {
            const row = db.prepare("SELECT data FROM trajectory_metadata_blob").get();
            db.prepare("UPDATE trajectory_metadata_blob SET data=?").run(Buffer.concat([row.data, Buffer.from([0x3a, 11]), Buffer.from("file:///tmp")]));
          }
        } finally { db.close(); }
      }
      await assert.rejects(runtime.resumeSession({ reference, approvalPolicy: "harnessManaged" }),
        error => error.data?.code === (scenario === "missing-db" ? "SESSION_NOT_FOUND" : "HARNESS_ERROR"));
      assert.equal(runtime.status, "active");
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("AGY rejects a new Session whose Project differs from its claimed init Workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-binding-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  let runtime;
  try {
    runtime = await createMuhaRuntime({ dataDir: join(root, "diagnostics"), harnesses: [agyAdapter({
      env: { HOME: join(root, "home"), PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
        MUHA_FAKE_AGY_SCENARIO: "wrong-create-project" }, startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
    })] });
    await assert.rejects(runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "harnessManaged" }),
      error => error.data?.code === "HARNESS_ERROR");
    assert.equal(runtime.status, "active");
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
