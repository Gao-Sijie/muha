import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("../../scripts/qualify-real-harness.mjs", import.meta.url);

test("fixed effort probes use model-specific alternate native values rather than a portable medium", async () => {
  const { qualificationProfileFor } = await import("../../scripts/real-harness-profiles.mjs");
  assert.equal(qualificationProfileFor("pi").qualificationIdleEffort, "high");
  assert.equal(qualificationProfileFor("codex").qualificationIdleEffort, "medium");
  assert.equal(qualificationProfileFor("opencode").qualificationIdleEffort, "low");
  assert.equal(qualificationProfileFor("kimi").qualificationIdleEffort, "high");
});

function invoke(args, env = {}) {
  return spawnSync(process.execPath, [script.pathname, ...args], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
}

test("real qualification refuses an implicit all-Harness invocation", () => {
  const run = invoke([]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /explicit Harness/i);
  assert.doesNotMatch(run.stdout, /qualified/);
});

test("real qualification refuses an unset or substituted fixed model before native activity", () => {
  const missing = invoke(["agy", "--preprobe"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /MUHA_QUALIFY_AGY_MODEL/);

  const substituted = invoke(["agy", "--preprobe"], {
    MUHA_QUALIFY_AGY_MODEL: "claude-opus-4-6-thinking",
  });
  assert.equal(substituted.status, 2);
  assert.match(substituted.stderr, /claude-sonnet-4-6/);
});

test("real qualification requires a bounded mode and rejects unknown Harnesses", () => {
  const mode = invoke(["codex"], { MUHA_QUALIFY_CODEX_MODEL: "gpt-5.6-luna" });
  assert.equal(mode.status, 2);
  assert.match(mode.stderr, /--preprobe|--full/);

  const unknown = invoke(["all", "--preprobe"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /explicit Harness/i);
});

test("fixed AGY Sonnet effort is model-inapplicable without starting the CLI", () => {
  const run = invoke(["agy", "--effort"], {
    PATH: "/nonexistent",
    MUHA_QUALIFY_AGY_MODEL: "claude-sonnet-4-6",
  });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).qualified.status, "NOT_APPLICABLE");
  assert.match(run.stdout, /claude-sonnet-4-6/);
});
