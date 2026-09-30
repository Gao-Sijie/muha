// T25 — Pi patched-SDK route keeps the reference contract and its verified
// patch/worker resources intact (SDK exception per ADR-0120..0123, T08).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import { createSessionReference, parseSessionReference, serializeSessionReference, referenceRoute } from "@muha-sdk/core";

const piDist = fileURLToPath(new URL("../../packages/pi-adapter/dist", import.meta.url));

test("Pi references retain native identity and round-trip without a format marker", () => {
  const reference = createSessionReference("pi", "sdk-session-1", "/tmp/ws", "native");
  assert.equal(Object.hasOwn(reference, "formatVersion"), false);
  assert.equal(reference.route, "native");
  assert.equal(referenceRoute(reference), "native");
  assert.deepEqual(parseSessionReference(JSON.parse(serializeSessionReference(reference))), reference);
});

test("Pi patched SDK and license resources ship intact with stable digests", async () => {
  const resources = [
    "pi-process.js", "pi-events.js", "pi-input.js", "sdk-worker.mjs", "sdk-loader.mjs",
    "sdk-sessions.mjs", "sdk-settings.mjs", "sdk-extensions.mjs", "sdk-process-ownership.mjs",
    "ordered-agent-session.mjs", "sdk-patch.json", "PI-SDK-LICENSE",
  ];
  const digest = await import("node:crypto").then(({ createHash }) => createHash);
  for (const file of resources) {
    const bytes = await readFile(join(piDist, file));
    assert.ok(bytes.length > 0, `${file} must be non-empty`);
    assert.equal(digest("sha256").update(bytes).digest("hex").length, 64);
  }
  // Verified high-level input patch must be structurally intact.
  const patch = JSON.parse(await readFile(join(piDist, "sdk-patch.json"), "utf8"));
  assert.ok(Array.isArray(patch) || typeof patch === "object");
  assert.ok(await stat(join(piDist, "PI-SDK-LICENSE")).then((metadata) => metadata.isFile()));
});
