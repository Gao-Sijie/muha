import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { createConformanceProfiles } from "../support/official-harness-profiles.mjs";
import { piConformance } from "../support/pi-conformance.mjs";
import { agyConformance } from "../support/agy-conformance.mjs";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const fakeOpenCodeV2Bin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");
const controlledPath = [fakeHarnessBin, dirname(process.execPath)].join(delimiter);

const profiles = createConformanceProfiles({
  agy: {
    expectedText: "Hello from AGY.",
    options: async ({ root }, t) => (await agyConformance(t, { root })).options,
  },
  pi: {
    expectedText: "Hello from Pi.",
    options: async (_paths, t) => (await piConformance(t)).options,
  },
  codex: {
    expectedText: "Hello from Codex.",
    options: ({ root }) => ({
      env: {
        PATH: controlledPath,
        MUHA_FAKE_NATIVE_SESSIONS_FILE: join(root, "native-sessions.json"),
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
  },
  opencode: {
    expectedText: "OpenCode v2: Say hello.",
    options: ({ evidenceFile, pidFile }) => ({
      env: {
        PATH: [fakeOpenCodeV2Bin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_EVIDENCE_FILE: evidenceFile,
        MUHA_V2_PID_FILE: pidFile,
        OPENCODE_SERVER_USERNAME: "caller-username",
        OPENCODE_SERVER_PASSWORD: "caller-password",
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
  },
  kimi: {
    expectedText: "Hello from Kimi.",
    options: ({ evidenceFile, pidFile }) => ({
      env: {
        PATH: controlledPath,
        MUHA_FAKE_KIMI_EVIDENCE_FILE: evidenceFile,
        MUHA_FAKE_PID_FILE: pidFile,
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    }),
  },
});

for (const profile of profiles) {
  test(`${profile.harness} satisfies the durable text Turn Core Conformance`, async t => {
    const root = await mkdtemp(join(tmpdir(), `muha-${profile.harness}-conformance-`));
    const workspace = join(root, "workspace");
    const evidenceFile = join(root, `${profile.harness}-evidence.json`);
    const pidFile = join(root, `${profile.harness}.pid`);
    let runtime;
    let session;

    await mkdir(workspace);
    try {
      runtime = await createMuhaRuntime({
        harnesses: [profile.registration(await profile.options({ root, evidenceFile, pidFile }, t))],
        dataDir: join(root, "diagnostics"),
      });
      assert.deepEqual(runtime.enabledHarnesses, [profile.harness]);
      const capabilities = runtime.getHarnessCapabilities(profile.harness);

      session = await runtime.createSession({
        harness: profile.harness,
        workspacePath: workspace,
        approvalPolicy: capabilities.approvalPolicies[0],
      });
      assert.equal(session.reference.harness, profile.harness);
      assert.deepEqual(session.status, { status: "idle" });
      await assert.rejects(
        session.startTurn([]),
        (error) => error instanceof MuhaError && error.data.code === "INVALID_INPUT",
      );

      const turn = await session.startTurn([{ type: "text", text: "Say hello." }]);
      const events = [];
      for await (const event of turn) events.push(event);
      const result = await turn.result;

      const eventTypes = events.map(({ type }) => type);
      assert.equal(eventTypes[0], "turn.started");
      assert.deepEqual(
        eventTypes.filter((type) =>
          type === "turn.completed" || type === "turn.failed" || type === "turn.interrupted"),
        ["turn.completed"],
      );
      assert.deepEqual(events.map(({ sequence }) => sequence),
        Array.from({ length: events.length }, (_value, index) => index + 1));
      for (const event of events) {
        assert.equal(event.turnId, turn.turnId);
        assert.equal(Number.isNaN(Date.parse(event.timestamp)), false);
        assert.equal("harness" in event, false);
        assert.equal("workspacePath" in event, false);
        assert.equal("nativeId" in event, false);
      }

      assert.equal(result.status, "completed");
      assert.equal(result.turnId, turn.turnId);
      assert.equal(result.message.text, profile.expectedText);
      assert.deepEqual(events.at(-1).message, result.message);
      assert.deepEqual(session.status, { status: "idle" });

      const knownReference = session.reference;
      await session.close();
      session = await runtime.resumeSession({
        reference: knownReference,
        approvalPolicy: capabilities.approvalPolicies[0],
      });
      assert.deepEqual(session.reference, {
        ...knownReference,
        route: "native",
      });
      assert.deepEqual(session.status, { status: "idle" });
      assert.equal(runtime.getHarnessCapabilities(profile.harness), capabilities);
      await session.close();
      session = undefined;
      await runtime.close();

      if (profile.harness === "opencode") {
        const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
        assert.equal(evidence.unauthenticated, 1);
        assert.equal(evidence.authenticated, 1);
        assert.equal(evidence.requests.includes("/api/info"), true);
        assert.equal(evidence.requests.includes("/api/event"), true);
        assert.equal(evidence.requests.includes("/api/session"), true);
        assert.equal(evidence.requests.some((path) => /\/api\/session\/[^/]+\/prompt$/.test(path)), true);
        assert.equal(evidence.prompts.length, 1);
        assert.equal(evidence.prompts[0].sessionID, knownReference.sessionId);
        const pid = Number(await readFile(pidFile, "utf8"));
        await assertPathEventuallyMissing(`/proc/${pid}`);
      }
      if (profile.harness === "kimi") {
        const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
        assert.deepEqual(evidence.argv,
          ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"]);
        assert.equal(evidence.unauthorizedRequests, 0);
        assert.equal(evidence.authenticatedWebSockets, 1);
        assert.equal(evidence.clientHellos, 1);
        assert.ok(evidence.requests.length >= 4);
        assert.equal(evidence.requests.every(({ authenticated }) => authenticated), true);
        assert.equal(evidence.requests.some(({ path }) => path === "/api/v1/healthz"), true);
        assert.equal(evidence.requests.some(({ path }) => path === "/api/v1/workspaces"), true);
        assert.equal(evidence.requests.some(({ path }) => path === "/api/v1/sessions"), true);
        assert.equal(
          evidence.requests.some(({ path }) => /\/api\/v1\/sessions\/[^/]+\/prompts$/.test(path)),
          true,
        );
        assert.equal(evidence.prompts[0].model, null);
        const pid = Number(await readFile(pidFile, "utf8"));
        await assertPathEventuallyMissing(`/proc/${pid}`);
      }
    } finally {
      await session?.close();
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function assertPathEventuallyMissing(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await import("node:fs/promises").then(({ access }) => access(path));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.fail(`${path} still exists`);
}
