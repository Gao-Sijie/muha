import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  createMuhaRuntime, createSessionReference, parseSessionReference,
  serializeSessionReference, referenceRoute,
} from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const valid = { harness: "opencode", sessionId: "ses_1", workspacePath: "/tmp/ws", route: "native" };
const invalidReference = (error) => error.data?.code === "INVALID_SESSION_REFERENCE";

test("every Reference helper rejects retired Muha formats instead of interpreting or stripping them", () => {
  const { route, ...legacy } = valid;
  for (const input of [legacy, ...[undefined, null, 1, 2, 3].map((formatVersion) => ({ ...valid, formatVersion }))]) {
    for (const interpret of [parseSessionReference, serializeSessionReference, referenceRoute]) {
      assert.throws(() => interpret(input), invalidReference, `${interpret.name}: ${JSON.stringify(input)}`);
    }
  }
});

test("Reference output is exactly four required fields, with no format marker", () => {
  for (const route of ["native", "acp", "combined"]) {
    const expected = { ...valid, route };
    const actual = createSessionReference("opencode", "ses_1", "/tmp/ws", route);
    assert.deepEqual(actual, expected);
    assert.ok(Object.isFrozen(actual));
    assert.deepEqual(parseSessionReference(JSON.parse(serializeSessionReference(actual))), expected);
    assert.equal(referenceRoute(actual), route);
  }
});

test("Runtime rejects retired references before creating a Workspace or reaching native resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-ref-format-"));
  const workspace = join(root, "workspace");
  let runtime;
  try {
    await mkdir(workspace);
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: { PATH: [resolve(import.meta.dirname, "../fixtures/v2-harness-bin"), dirname(process.execPath)].join(delimiter) },
        startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    const { route, ...legacy } = { ...valid, workspacePath: join(root, "must-not-create") };
    const malformed = [
      legacy,
      ...[undefined, 1, 2, 3, null].map((formatVersion) => ({ ...legacy, route: "native", formatVersion })),
      { ...valid, extra: true }, { ...valid, route: "unknown" },
      { ...valid, harness: "other" }, { ...valid, sessionId: "" },
      { ...valid, workspacePath: "relative" }, { ...valid, route: undefined },
      null, [], "not a reference", Object.create(valid),
      { ...valid, toJSON: () => valid },
    ];
    for (const reference of malformed) {
      let expected;
      assert.throws(() => parseSessionReference(reference), (error) => {
        expected = error.data;
        return invalidReference(error);
      });
      for (const helper of [serializeSessionReference, referenceRoute]) {
        assert.throws(() => helper(reference), (error) => { assert.deepEqual(error.data, expected); return true; });
      }
      await assert.rejects(runtime.resumeSession({ reference, createWorkspaceIfMissing: true }), (error) => {
        assert.deepEqual(error.data, expected);
        return true;
      });
    }
    const { stat } = await import("node:fs/promises");
    await assert.rejects(stat(legacy.workspacePath), { code: "ENOENT" });
    assert.equal(runtime.status, "active");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
