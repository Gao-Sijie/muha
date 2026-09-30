import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");

test("stable Codex MCP form and URL elicitations are durably declined without public interactions", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-codex-elicitation-"));
  const workspace = join(root, "workspace");
  const responseFile = join(root, "responses.json");
  let runtime;
  let session;
  try {
    await mkdir(workspace);
    runtime = await createMuhaRuntime({
      harnesses: [codexAdapter({
        env: {
          PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
          MUHA_FAKE_TURN_SCENARIO: "mcp-elicitations",
          MUHA_FAKE_ELICITATION_RESPONSE_FILE: responseFile,
        },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "codex", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "call MCP" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).status, "completed");
    assert.equal(events.some(({ type }) => type.startsWith("question.")), false);
    assert.equal(events.some(({ type }) => type.startsWith("approval.")), false);
    assert.equal(events.some(({ type }) => type === "tool.started"), true);
    assert.equal(events.some(({ type }) => type === "tool.completed"), true);
    assert.deepEqual(JSON.parse(await readFile(responseFile, "utf8")), [
      { action: "decline", content: null, _meta: null },
      { action: "decline", content: null, _meta: null },
    ]);

    const database = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"), {
      readOnly: true,
    });
    try {
      const records = database
        .prepare("SELECT payload_json FROM native_event_records ORDER BY record_id")
        .all()
        .map(({ payload_json }) => JSON.parse(payload_json));
      assert.deepEqual(
        records.filter(({ method }) => method === "mcpServer/elicitation/request"),
        [
          {
            id: "elicitation_form_1",
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread_fake_1",
              turnId: "turn_native_fake_1",
              serverName: "fixture-server",
              mode: "form",
              _meta: { fixture: true },
              message: "Provide a value",
              requestedSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
          },
          {
            id: "elicitation_url_1",
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread_fake_1",
              turnId: "turn_native_fake_1",
              serverName: "fixture-server",
              mode: "url",
              _meta: null,
              message: "Open URL",
              url: "https://example.com/authorize",
              elicitationId: "fixture-url",
            },
          },
        ],
      );
      assert.deepEqual(
        records.filter(({ method }) => method === "serverRequest/resolved"),
        [
          {
            method: "serverRequest/resolved",
            params: {
              threadId: "thread_fake_1",
              requestId: "elicitation_form_1",
            },
          },
          {
            method: "serverRequest/resolved",
            params: {
              threadId: "thread_fake_1",
              requestId: "elicitation_url_1",
            },
          },
        ],
      );
    } finally {
      database.close();
    }
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
