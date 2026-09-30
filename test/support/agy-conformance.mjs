import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { nativeStringField } from "../fixtures/agy-native-metadata.mjs";

export async function agyConformance(t, { root, scenario, sessionsFile, evidenceFile } = {}) {
  if (!root) {
    root = await mkdtemp(join(tmpdir(), "muha-agy-fixture-"));
    const owned = root;
    t.after(() => rm(owned, { recursive: true, force: true }));
  }
  const home = join(root, "native-home");
  if (sessionsFile) {
    for (const entry of JSON.parse(await readFile(sessionsFile, "utf8"))) {
      const projectId = randomUUID();
      const conversations = join(home, ".gemini/antigravity-cli/conversations");
      const projects = join(home, ".gemini/config/projects");
      await mkdir(conversations, { recursive: true });
      await mkdir(projects, { recursive: true });
      const uri = pathToFileURL(entry.workspacePath).href;
      await writeFile(join(projects, `${projectId}.json`), JSON.stringify({ id: projectId,
        projectResources: { resources: [{ folderUri: uri }] } }));
      const db = new DatabaseSync(join(conversations, `${entry.id}.db`));
      try {
        db.exec("CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)");
        db.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run(randomUUID(), entry.id);
        // External child conversation: the root ID is intentionally different.
        const parent = "00000000-0000-0000-0000-000000000001";
        const blob = Buffer.concat([nativeStringField([0x32], parent), nativeStringField([0x3a], uri),
          nativeStringField([0x92, 0x01], projectId)]);
        db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(blob);
      } finally { db.close(); }
    }
  }
  return { options: {
    env: { HOME: home, PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
      ...(scenario ? { MUHA_FAKE_AGY_SCENARIO: scenario } : {}),
      ...(evidenceFile ? { MUHA_FAKE_AGY_EVIDENCE: evidenceFile } : {}) },
    startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
  } };
}
