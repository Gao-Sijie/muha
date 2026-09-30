import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { OFFICIAL_HARNESS_KINDS } from "@muha-sdk/core/internal";
import { imageQualificationInput } from "../../scripts/qualify-real-harness.mjs";
import { REAL_HARNESS_QUALIFICATION_PROFILES, qualificationModelForMode, qualificationProfileFor, qualificationTurnRetryPolicy } from "../../scripts/real-harness-profiles.mjs";

test("image qualification constrains the answer to one color word after the image", () => {
  const input = imageQualificationInput("/tmp/blue.png");

  assert.deepEqual(input.map(({ type }) => type), ["text", "image", "text"]);
  assert.deepEqual(input[1], { type: "image", source: { type: "file", path: "/tmp/blue.png" } });
  assert.match(input[2].text, /exactly one lowercase English color word/i);
  assert.match(input[2].text, /red, blue, green/);
  assert.match(input[2].text, /no (?:other text|explanation)/i);
  assert.match(input[2].text, /pixels.*not the filename/i);
});

test("real qualification profiles exactly cover the Core official Harness set", () => {
  assert.deepEqual(
    REAL_HARNESS_QUALIFICATION_PROFILES.map(({ harness }) => harness),
    OFFICIAL_HARNESS_KINDS,
  );
  assert.equal(Object.isFrozen(REAL_HARNESS_QUALIFICATION_PROFILES), true);
  assert.deepEqual(
    REAL_HARNESS_QUALIFICATION_PROFILES.map(({ harness, qualificationModel }) => [harness, qualificationModel]),
    [
      ["codex", "gpt-5.6-luna"],
      ["opencode", "opencode-go/deepseek-v4.1-flash"],
      ["kimi", "deepseek/deepseek-flash"],
      ["pi", "opencode-go/deepseek-v4.1-flash"],
      ["agy", "claude-sonnet-4-6"],
    ],
  );
});

test("Pi uses Qwen only for image color and retains DeepSeek for other qualification modes", () => {
  const pi = qualificationProfileFor("pi");
  assert.equal(qualificationModelForMode(pi, "--image"), "opencode-go/qwen3.8-flash");
  assert.equal(qualificationModelForMode(pi, "--full"), "opencode-go/deepseek-v4.1-flash");
  assert.equal(qualificationModelForMode(pi, "--effort"), "opencode-go/deepseek-v4.1-flash");
  assert.equal(pi.qualificationImageModel, "opencode-go/qwen3.8-flash");
});

test("real Pi qualification opts in to three Muha retries without changing other Harness defaults", () => {
  assert.deepEqual(qualificationTurnRetryPolicy(qualificationProfileFor("pi")), { maxRetries: 3 });
  for (const harness of ["codex", "opencode", "kimi", "agy"]) {
    assert.equal(qualificationTurnRetryPolicy(qualificationProfileFor(harness)), undefined);
  }
});

test("Pi image and full qualification require explicit models before native startup", () => {
  const script = new URL("../../scripts/qualify-real-harness.mjs", import.meta.url).pathname;
  const wrongImage = spawnSync(process.execPath, [script, "pi", "--image"], {
    encoding: "utf8", env: { ...process.env, MUHA_QUALIFY_PI_MODEL: "opencode-go/deepseek-v4.1-flash" },
  });
  assert.equal(wrongImage.status, 2);
  assert.match(wrongImage.stderr, /MUHA_QUALIFY_PI_MODEL must equal opencode-go\/qwen3\.8-flash/);

  const missingFullImage = spawnSync(process.execPath, [script, "pi", "--full"], {
    encoding: "utf8", env: { ...process.env, MUHA_QUALIFY_PI_MODEL: "opencode-go/deepseek-v4.1-flash",
      MUHA_QUALIFY_PI_IMAGE_MODEL: "" },
  });
  assert.equal(missingFullImage.status, 2);
  assert.match(missingFullImage.stderr, /MUHA_QUALIFY_PI_IMAGE_MODEL must equal opencode-go\/qwen3\.8-flash/);
});

test("the real qualification runner preflights the explicitly selected Harness before startup", () => {
  const result = spawnSync(process.execPath, [
    new URL("../../scripts/qualify-real-harness.mjs", import.meta.url).pathname,
    "codex", "--preprobe",
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", MUHA_QUALIFY_CODEX_MODEL: "gpt-5.6-luna" },
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Required Harness command not found on PATH: codex/,
  );
});

test("the real qualification runner accepts a bounded image-only diagnostic mode", () => {
  const result = spawnSync(process.execPath, [
    new URL("../../scripts/qualify-real-harness.mjs", import.meta.url).pathname,
    "opencode", "--image",
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", MUHA_QUALIFY_OPENCODE_MODEL: "opencode-go/deepseek-v4.1-flash" },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required Harness command not found on PATH: opencode/);
});

test("the real qualification runner rejects every unknown Harness deterministically", async (t) => {
  for (const harness of ["unknown-harness", "__proto__", "constructor"]) {
    await t.test(harness, () => {
      const result = spawnSync(process.execPath, [
        new URL("../../scripts/qualify-real-harness.mjs", import.meta.url).pathname,
        harness,
      ], { encoding: "utf8" });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`Unknown Harness: ${harness}`));
    });
  }
});
