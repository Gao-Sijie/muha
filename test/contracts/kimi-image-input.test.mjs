import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

test("Kimi receives locally validated ordered mixed and image-only input", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-kimi-image-input-"));
  const workspace = join(root, "workspace");
  const pngPath = join(root, "pixel image.png");
  const evidenceFile = join(root, "evidence.json");
  let runtime;
  let session;
  await mkdir(workspace);
  await writeFile(pngPath, png);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration(evidenceFile)],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "kimi", workspacePath: workspace });

    await assert.rejects(
      session.startTurn([{ type: "image", source: { type: "file", path: join(root, "missing.png") } }]),
      (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
    );
    assert.equal(JSON.parse(await readFile(evidenceFile, "utf8")).prompts.length, 0);

    const mixed = await session.startTurn([
      { type: "image", source: { type: "file", path: pngPath } },
      { type: "text", text: "Compare in order." },
      {
        type: "image",
        source: { type: "base64", mediaType: "image/jpeg", data: jpeg.toString("base64") },
      },
    ]);
    await mixed.result;
    let evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    assert.deepEqual(evidence.prompts[0].content, [
      {
        type: "image",
        source: { kind: "base64", media_type: "image/png", data: png.toString("base64") },
      },
      { type: "text", text: "Compare in order." },
      {
        type: "image",
        source: { kind: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
      },
    ]);

    const imageOnly = await session.startTurn([
      { type: "image", source: { type: "base64", mediaType: "image/png", data: png.toString("base64") } },
    ]);
    assert.equal((await imageOnly.result).status, "completed");
    evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    assert.equal(evidence.prompts[1].content.length, 1);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Kimi image rejection is a command rejection with no Turn Handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-kimi-image-rejection-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [registration(evidenceFile, { MUHA_FAKE_KIMI_SCENARIO: "image-reject" })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "kimi", workspacePath: workspace });
    await assert.rejects(
      session.startTurn([
        { type: "image", source: { type: "base64", mediaType: "image/png", data: png.toString("base64") } },
      ]),
      (error) =>
        error instanceof MuhaError &&
        error.data.code === "HARNESS_ERROR" &&
        error.data.nativeCode === "http_400",
    );
    assert.equal(JSON.parse(await readFile(evidenceFile, "utf8")).prompts.length, 0);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function registration(evidenceFile, extraEnv = {}) {
  return kimiAdapter({
    env: {
      PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
      MUHA_FAKE_KIMI_EVIDENCE_FILE: evidenceFile,
      ...extraEnv,
    },
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
  });
}
