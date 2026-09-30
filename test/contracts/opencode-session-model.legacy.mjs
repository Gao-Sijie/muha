// Historical v1 Model contract. Retained for archaeology; v2 Model behavior has separate coverage.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("OpenCode model pairs are lossless, validated, and resolved only from native state", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-model-contract-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  let runtime;
  let session;
  await mkdir(workspace);

  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: {
          PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_OPENCODE_EVIDENCE_FILE: evidenceFile,
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });

    for (const model of ["no-slash", "/model", "provider/", " provider/model", "provider/model "]) {
      await assert.rejects(
        runtime.createSession({ harness: "opencode", workspacePath: workspace, model }),
        (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
      );
    }

    const lossless = "Fake.Provider/model/with/slashes";
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      model: lossless,
    });
    assert.equal(session.model, lossless);
    await assert.rejects(
      session.setModel("fake-provider/not-in-catalog"),
      (error) =>
        error instanceof MuhaError &&
        error.data.code === "HARNESS_ERROR" &&
        error.data.nativeCode === "model_not_found",
    );
    assert.equal(session.model, lossless);
    await assert.rejects(
      session.setModel(" fake-provider/fake-high"),
      (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
    );
    assert.equal(session.model, lossless);
    const selected = await session.startTurn([{ type: "text", text: "Use this exact model." }]);
    await selected.result;
    assert.deepEqual(JSON.parse(await readFile(evidenceFile, "utf8")).prompts[0].model, {
      providerID: "Fake.Provider",
      modelID: "model/with/slashes",
    });
    await session.close();

    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    assert.equal(session.model, undefined);
    const turn = await session.startTurn([{ type: "text", text: "Resolve native default." }]);
    await turn.result;
    assert.equal(session.model, "fake-provider/fake-model");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
