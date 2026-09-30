import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openCodeV2Input } from "../../packages/opencode-adapter/dist/opencode-v2-image-input.js";

test("OpenCode v2 snapshots all four supported image types and keeps an explicit order manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-image-parts-"));
  try {
    const images = [
      ["image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
      ["image/jpeg", Buffer.from([255, 216, 255, 224, 0])],
      ["image/webp", Buffer.from("RIFF0000WEBP1234")],
      ["image/gif", Buffer.from("GIF89a123456")],
    ];
    const paths = [];
    for (let index = 0; index < images.length; index++) {
      const path = join(root, `${index}.img`);
      await writeFile(path, images[index][1]);
      paths.push(path);
    }
    const prompt = await openCodeV2Input([
      { type: "text", text: "A" },
      ...paths.map((path) => ({ type: "image", source: { type: "file", path } })),
      { type: "text", text: "B" },
    ]);
    assert.equal(prompt.text, "AB");
    assert.deepEqual(prompt.metadata.muhaOrderedInput.parts.map((part) => part.type),
      ["text", "image", "image", "image", "image", "text"]);
    assert.deepEqual(prompt.files.map((file) => file.uri.slice(0, file.uri.indexOf(";"))),
      images.map(([mime]) => `data:${mime}`));
    await writeFile(paths[0], Buffer.from("changed"));
    assert.equal(prompt.files[0].uri, `data:image/png;base64,${images[0][1].toString("base64")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 revalidates files before native acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-invalid-file-"));
  try {
    const path = join(root, "removed.png");
    await writeFile(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    await rm(path);
    await assert.rejects(openCodeV2Input([{ type: "image", source: { type: "file", path } }]),
      (error) => error.data?.code === "INVALID_INPUT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
