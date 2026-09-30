import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMuhaRuntime } from "@muha-sdk/core";
import { controlledOpenCodeAdapter, acpOptions } from "../fixtures/acp-harness/options.mjs";

// Independent byte-signature fixtures, like the existing native input tests;
// these prove transport fidelity, not a model's visual understanding.
const formats = [
  ["image/png", Buffer.from("89504e470d0a1a0a00000102", "hex")],
  ["image/jpeg", Buffer.from("ffd8ff000304", "hex")],
  ["image/webp", Buffer.from("RIFF0000WEBP5678", "ascii")],
  ["image/gif", Buffer.from("GIF89a123456", "ascii")],
];

test("shared ACP input preserves file/base64 bytes, all four MIME types and mixed ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-images-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("inspect-input") })], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const input = [];
    const expected = [];
    for (const [mimeType, bytes] of formats) {
      const file = join(workspace, `${mimeType.slice(6)} image with spaces.bin`);
      await writeFile(file, bytes);
      input.push({ type: "text", text: mimeType }, { type: "image", source: { type: "file", path: file } },
        { type: "image", source: { type: "base64", mediaType: mimeType, data: bytes.toString("base64") } });
      expected.push({ type: "text", text: mimeType }, ...[0, 1].map(() => ({ type: "image", mimeType, data: bytes.toString("base64") })));
    }
    const turn = await session.startTurn(input);
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.deepEqual(JSON.parse(result.message.text), expected);
    const imageOnly = await session.startTurn([input[1]]);
    assert.deepEqual(JSON.parse((await imageOnly.result).message.text), [expected[1]]);
    await assert.rejects(session.startTurn([{ type: "image", source: { type: "file", path: join(workspace, "missing.png") } }]), error => error.data?.code === "INVALID_INPUT");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
