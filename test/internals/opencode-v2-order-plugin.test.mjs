import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { restoreOrderedMessages } from "../../packages/opencode-adapter/dist/opencode-v2-order-plugin.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const image = (bytes, mediaType = "image/png") => ({
  type: "media", mediaType, data: Buffer.from(bytes).toString("base64"),
});
const imageOrder = (index, part) => ({
  type: "image", index, mime: part.mediaType, sha256: hash(Buffer.from(part.data, "base64")),
});

test("OpenCode v2 private hook reconstructs model-facing interleaved content", () => {
  const first = image([1, 2, 3]);
  const second = image([4, 5, 6], "image/jpeg");
  const message = {
    metadata: { muhaOrderedInput: {
      version: 1, textSha256: hash("beforeafter"),
      parts: [
        imageOrder(0, first), { type: "text", length: 6 },
        imageOrder(1, second), { type: "text", length: 5 },
      ],
    } },
    content: [{ type: "text", text: "beforeafter" }, first, second],
  };
  restoreOrderedMessages({ messages: [message] });
  assert.deepEqual(message.content.map((part) => part.type), ["media", "text", "media", "text"]);
  assert.deepEqual(message.content.filter((part) => part.type === "text").map((part) => part.text),
    ["before", "after"]);
  assert.equal(message.content[0], first);
  assert.equal(message.content[2], second);
});

test("OpenCode v2 private hook supports image-only and preserves unrelated native messages", () => {
  const picture = image([7, 8, 9]);
  const message = {
    metadata: { muhaOrderedInput: { version: 1, textSha256: hash(""), parts: [imageOrder(0, picture)] } },
    content: [picture],
  };
  const unrelated = { content: [{ type: "text", text: "native" }] };
  restoreOrderedMessages({ messages: [unrelated, message] });
  assert.deepEqual(message.content, [picture]);
  assert.deepEqual(unrelated.content, [{ type: "text", text: "native" }]);
});

test("OpenCode v2 private hook rejects content changed after Muha admission", () => {
  const picture = image([1, 2, 3]);
  const message = {
    metadata: { muhaOrderedInput: {
      version: 1, textSha256: hash("before"),
      parts: [{ type: "text", length: 6 }, imageOrder(0, picture)],
    } },
    content: [{ type: "text", text: "changed" }, picture],
  };
  assert.throws(() => restoreOrderedMessages({ messages: [message] }), /text changed/);
  assert.deepEqual(message.content.map((part) => part.type), ["text", "media"]);
});
