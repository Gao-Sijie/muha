// Single, closed Session Reference contract (T11, ADR-0135).
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { MuhaError, createMuhaRuntime, createSessionReference, parseSessionReference, serializeSessionReference, referenceRoute } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");
const nativeOptions = () => ({
  env: { PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter) },
  startupTimeoutMs: 2_000,
  shutdownTimeoutMs: 2_000,
});

test("retired three-field references are rejected without an implicit route", () => {
  const legacy = { harness: "opencode", sessionId: "ses_1", workspacePath: "/tmp/ws" };
  assert.throws(() => parseSessionReference(legacy), (error) => error.data?.code === "INVALID_SESSION_REFERENCE");
});

test("references keep an explicit interpretable route and round-trip", () => {
  const reference = createSessionReference("opencode", "ses_2", "/tmp/ws", "acp");
  assert.equal(Object.hasOwn(reference, "formatVersion"), false);
  assert.equal(reference.route, "acp");
  assert.equal(referenceRoute(reference), "acp");
  assert.deepEqual(parseSessionReference(JSON.parse(serializeSessionReference(reference))), reference);
  for (const route of ["native", "acp", "combined"]) {
    assert.equal(createSessionReference("kimi", "k", "/tmp/ws", route).route, route);
  }
});

test("extra fields, unknown routes, Harness kinds and malformed fields fail explicitly", () => {
  const cases = [
    [{ harness: "opencode", sessionId: "s", workspacePath: "/tmp/ws", formatVersion: 3 }, "unknown-field"],
    [{ harness: "opencode", sessionId: "s", workspacePath: "/tmp/ws", route: "teleport" }, "unknown-route"],
    [{ harness: "cursor", sessionId: "s", workspacePath: "/tmp/ws", route: "native" }, "unknown-harness"],
    [{ harness: "opencode", sessionId: "", workspacePath: "/tmp/ws", route: "native" }, "missing-session-id"],
    [{ harness: "opencode", sessionId: "s", workspacePath: "relative/ws", route: "native" }, "non-absolute-workspace"],
    [{ harness: "opencode", sessionId: "s" }, "missing-workspace-path"],
    ["not-an-object", "not-an-object"],
    [null, "not-an-object"],
  ];
  for (const [value, reason] of cases) {
    assert.throws(
      () => parseSessionReference(value),
      (error) => error instanceof MuhaError && error.data.code === "INVALID_SESSION_REFERENCE" && error.data.reason === reason,
      JSON.stringify(value),
    );
  }
});

test("serialized references survive JSON transport without guessing transport or route", () => {
  const reference = createSessionReference("opencode", "ses_3", "/tmp/ws", "combined");
  assert.equal(referenceRoute(parseSessionReference(JSON.parse(serializeSessionReference(reference)))), "combined");
});

test("resuming a reference whose route the enabled Adapter does not serve fails explicitly (no replacement Session)", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-ref-route-"));
  const workspace = join(root, "workspace");
  let runtime;
  await mkdir(workspace);
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter(nativeOptions())],
      dataDir: join(root, "diagnostics"),
    });
    // A reference claiming an ACP route against the native-only Adapter.
    const acpReference = createSessionReference("opencode", "ses_native_only", workspace, "acp");
    await assert.rejects(
      runtime.resumeSession({ reference: acpReference }),
      (error) => error instanceof MuhaError && error.data.code === "UNSUPPORTED_ROUTE" && error.data.route === "acp",
    );
    // Nothing was created; the native Adapter was never driven.
    assert.equal(runtime.getHarnessCapabilities("opencode").sessionListing, true);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown native identities still reject without creating replacement Sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-ref-legacy-resume-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter(nativeOptions())],
      dataDir: join(root, "diagnostics"),
    });
    const reference = createSessionReference("opencode", "ses_missing", workspace, "native");
    await assert.rejects(runtime.resumeSession({ reference }), (error) => error.data?.code === "SESSION_NOT_FOUND");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
