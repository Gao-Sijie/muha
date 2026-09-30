import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, delimiter, resolve } from "node:path";
import { once } from "node:events";
import test from "node:test";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("a controlled PATH can provide a deterministic Codex executable", async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  const child = spawn("codex", ["app-server", "--stdio"], {
    env: {
      ...process.env,
      PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
    },
    signal: controller.signal,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    child.stdin.end(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          capabilities: null,
          clientInfo: { version: "0.1.12" },
        },
      })}\n`,
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout.trim()), {
      id: 1,
      result: { harness: "codex", fixture: true },
    });
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});
