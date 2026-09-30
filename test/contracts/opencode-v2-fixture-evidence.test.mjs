import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const fixture = resolve(import.meta.dirname, "../fixtures/v2-harness-bin/opencode");

test("OpenCode v2 fixture evidence remains complete during concurrent requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-v2-evidence-"));
  const evidenceFile = join(root, "evidence.json");
  const child = spawn(process.execPath, [fixture, "serve", "--stdio", "--port", "0"], {
    env: { ...process.env, OPENCODE_PASSWORD: "fixture-password",
      OPENCODE_SERVER_PASSWORD: "", MUHA_V2_EVIDENCE_FILE: evidenceFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const ready = await new Promise((resolveReady, rejectReady) => {
      lines.once("line", (line) => resolveReady(JSON.parse(line)));
      child.once("exit", (code) => rejectReady(new Error(`fixture exited before ready: ${code}`)));
    });
    const headers = { authorization: "Basic " + Buffer.from("opencode:fixture-password").toString("base64") };
    const info = () => fetch(`${ready.url}/api/info`, { headers }).then((response) => {
      assert.equal(response.status, 200);
    });
    await info();
    const deadline = Date.now() + 2_000;
    while (true) {
      try {
        JSON.parse(await readFile(evidenceFile, "utf8"));
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
    }

    const requests = Promise.all(Array.from({ length: 120 }, () => info()));
    let settled = false;
    void requests.then(() => { settled = true; }, () => { settled = true; });
    let reads = 0;
    let parseFailure;
    while (!settled || reads < 300) {
      try {
        const snapshot = JSON.parse(await readFile(evidenceFile, "utf8"));
        assert.ok(snapshot.authenticated >= 1);
      } catch (error) {
        parseFailure = error;
        break;
      }
      reads += 1;
      if (reads >= 3_000) break;
    }
    await requests;
    if (parseFailure) throw parseFailure;
    assert.ok(reads >= 300);
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});
