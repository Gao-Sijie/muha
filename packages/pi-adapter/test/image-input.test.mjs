import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { controlledPi, nativePi, completedTurn } from "./support/controlled-pi.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
test("Pi receives and persists interleaved file/base64 images in the consumer's order", async t => {
  const fixture = await controlledPi(t);
  const path = join(fixture.root, "pixel.png");
  await writeFile(path, Buffer.from(png, "base64"));
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  const input = [{ type: "image", source: { type: "file", path } }, { type: "text", text: "first" },
    { type: "image", source: { type: "base64", mediaType: "image/png", data: png } }, { type: "text", text: "last" }];
  const turn = await session.startTurn(input);
  assert.equal((await turn.result).status, "completed");
  const nativeContent = fixture.requests[0].messages.find(m => m.role === "user").content;
  assert.deepEqual(nativeContent.map(p => p.type), ["image_url", "text", "image_url", "text"]);
  assert.equal(nativeContent[0].image_url.url, `data:image/png;base64,${png}`);
  assert.equal(nativeContent[2].image_url.url, `data:image/png;base64,${png}`);
  assert.equal(nativeContent[1].text, "first");
  assert.equal(nativeContent[3].text, "last");
  await runtime.close();
  const restored = await nativePi(fixture, `
    const listed = await sdk.SessionManager.list(process.argv[1]);
    const manager = sdk.SessionManager.open(listed[0].path);
    console.log(JSON.stringify(manager.buildSessionContext().messages.find(m => m.role === "user").content));
  `);
  assert.deepEqual(restored, [{ type: "image", mimeType: "image/png", data: png }, { type: "text", text: "first" },
    { type: "image", mimeType: "image/png", data: png }, { type: "text", text: "last" }]);
});

test("Pi rejects missing files and native image blocking before acceptance, while text still works", async t => {
  const fixture = await controlledPi(t);
  await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ images: { blockImages: true } }));
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  await assert.rejects(session.startTurn([{ type: "image", source: { type: "file", path: join(fixture.root, "missing.png") } }]),
    error => error.data.code === "INVALID_INPUT");
  await assert.rejects(session.startTurn([{ type: "image", source: { type: "base64", mediaType: "image/png", data: png } }]),
    error => error.data.code === "HARNESS_ERROR");
  assert.equal(fixture.requests.length, 0);
  assert.equal((await completedTurn(session, "Text remains supported")).result.status, "completed");
});

test("Pi forwards all four declared image media types and pure-image input without text placeholders", async t => {
  const fixture = await controlledPi(t);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  // As in Core's media contract fixtures, the provider boundary checks byte
  // transport/signatures, not full decoding or real-model visual perception.
  const media = [
    ["image/png", Buffer.from(png, "base64")],
    ["image/jpeg", Buffer.from([255, 216, 255, 224, 0])],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFF0000WEBP")],
  ];
  const input = [];
  for (const [index, [mediaType, bytes]] of media.entries()) {
    const path = join(fixture.root, `image-${index}`);
    await writeFile(path, bytes);
    input.push({ type: "image", source: index % 2 === 0 ? { type: "file", path }
      : { type: "base64", mediaType, data: bytes.toString("base64") } });
  }
  const turn = await session.startTurn(input);
  for await (const event of turn) {}
  assert.equal((await turn.result).status, "completed");
  assert.deepEqual(fixture.requests[0].messages.find(message => message.role === "user").content,
    media.map(([mediaType, bytes]) => ({ type: "image_url", image_url: { url: `data:${mediaType};base64,${bytes.toString("base64")}` } })));
});

test("Pi snapshots verified image bytes when a native preflight hook deletes the original file", async t => {
  const fixture = await controlledPi(t);
  const path = join(fixture.root, "changing.png");
  await writeFile(path, Buffer.from(png, "base64"));
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "change-file.ts"), `
    import { unlinkSync } from "node:fs";
    export default pi => pi.on("input", () => { unlinkSync(${JSON.stringify(path)}); return { action: "continue" }; });
  `);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  const turn = await session.startTurn([{ type: "image", source: { type: "file", path } }]);
  for await (const event of turn) {}
  assert.equal((await turn.result).status, "completed");
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal(fixture.requests[0].messages.find(message => message.role === "user").content[0].image_url.url, `data:image/png;base64,${png}`);
});
