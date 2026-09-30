import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const signatures = {
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
  "image/webp": Buffer.from("RIFF0000WEBP", "ascii"),
  "image/gif": Buffer.from("GIF89a", "ascii"),
};

test("Codex receives only locally validated ordered image input", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-image-input-"));
  const workspace = join(root, "workspace");
  const pngPath = join(root, "pixel.png");
  const acceptedFile = join(root, "accepted");
  const turnRequestFile = join(root, "turn-request.json");
  let runtime;
  let session;

  await mkdir(workspace);
  await writeFile(pngPath, png);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_TURN_ACCEPTED_FILE: acceptedFile,
            MUHA_FAKE_TURN_REQUEST_FILE: turnRequestFile,
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });

    const invalidInputs = [
      [],
      [{ type: "image", source: { type: "file", path: "relative.png" } }],
      [{ type: "image", source: { type: "file", path: "https://example.test/a.png" } }],
      [{ type: "image", source: { type: "file", path: join(root, "missing.png") } }],
      [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "data:image/png;base64,AAAA" } }],
      [{ type: "image", source: { type: "base64", mediaType: "image/svg+xml", data: "PHN2Zz4=" } }],
      [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "%%%" } }],
      [{ type: "image", source: { type: "base64", mediaType: "image/png", data: signatures["image/jpeg"].toString("base64") } }],
      [{ type: "audio", source: { type: "file", path: pngPath } }],
      [{ type: "video", source: { type: "file", path: pngPath } }],
    ];
    for (const input of invalidInputs) {
      await assert.rejects(
        session.startTurn(input),
        (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
      );
    }
    await assert.rejects(access(acceptedFile));

    const mixed = [
      { type: "image", source: { type: "file", path: pngPath } },
      { type: "text", text: "Compare in order." },
      ...Object.entries(signatures).map(([mediaType, data]) => ({
        type: "image",
        source: { type: "base64", mediaType, data: data.toString("base64") },
      })),
    ];
    const turn = await session.startTurn(mixed);
    await turn.result;
    const nativeInput = JSON.parse(await readFile(turnRequestFile, "utf8")).input;
    assert.deepEqual(nativeInput, [
      { type: "localImage", path: pngPath },
      { type: "text", text: "Compare in order.", text_elements: [] },
      ...Object.entries(signatures).map(([mediaType, data]) => ({
        type: "image",
        url: `data:${mediaType};base64,${data.toString("base64")}`,
      })),
    ]);

    const imageOnly = await session.startTurn([
      { type: "image", source: { type: "base64", mediaType: "image/png", data: png.toString("base64") } },
    ]);
    assert.equal((await imageOnly.result).status, "completed");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a native rejection of valid image input remains a Harness rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-image-rejection-"));
  const workspace = join(root, "workspace");
  const acceptedFile = join(root, "accepted");
  let runtime;
  let session;

  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [
        codexAdapter({
          env: {
            PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
            MUHA_FAKE_REJECT_IMAGE: "1",
            MUHA_FAKE_TURN_ACCEPTED_FILE: acceptedFile,
          },
          startupTimeoutMs: 2_000,
          shutdownTimeoutMs: 2_000,
        }),
      ],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    await assert.rejects(
      session.startTurn([
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: png.toString("base64") },
        },
      ]),
      (error) =>
        error instanceof MuhaError &&
        error.data.code === "HARNESS_ERROR" &&
        error.data.nativeCode === "image_not_supported",
    );
    await assert.rejects(access(acceptedFile));
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "an available real Codex accepts a validated local image smoke Turn",
  { skip: process.env.MUHA_REAL_CODEX_SMOKE !== "1" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "muha-real-codex-image-smoke-"));
    const workspace = join(root, "workspace");
    const pngPath = join(root, "pixel.png");
    let runtime;
    let session;

    await mkdir(workspace);
    await writeFile(pngPath, png);
    try {
      runtime = await createMuhaRuntime({
        harnesses: [codexAdapter()],
        dataDir: join(root, "diagnostics"),
      });
      session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
      const turn = await session.startTurn([
        { type: "image", source: { type: "file", path: pngPath } },
        { type: "text", text: "Describe this image in one short sentence. Do not use tools." },
      ]);
      const result = await Promise.race([
        turn.result,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("real Codex image smoke timed out")), 120_000).unref();
        }),
      ]);
      assert.equal(result.status, "completed");
      assert.equal(result.message.text.length > 0, true);
    } finally {
      await session?.close();
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
