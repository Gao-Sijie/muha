import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { controlledPi, completedTurn } from "../packages/pi-adapter/test/support/controlled-pi.mjs";

// Qualification-only, post-close inspection of private diagnostics. This does
// not add a supported SQL schema/query API or a second live store owner.
let cleanup;
const fixture = await controlledPi({ after(fn) { cleanup = fn; } }, () => {});
try {
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "diagnostic.ts"), `
    export default pi => {
      pi.on("agent_start", () => { setTimeout(() => process.send(null), 20); });
      pi.on("session_shutdown", () => { throw new Error("QUALIFICATION_SHUTDOWN_DIAGNOSTIC"); });
    };
  `);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove", turnRetryPolicy: { maxRetries: 1 } });
  const { result, events } = await completedTurn(session, "Observe protocol quarantine");
  assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
  assert.equal(events.some(event => event.type === "turn.retrying"), false);
  assert.equal(session.status.status, "closed");
  assert.equal(runtime.status, "active");
  await runtime.close();
  const database = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"), { readOnly: true });
  try {
    const records = database.prepare("SELECT payload_json FROM native_event_records WHERE harness = 'pi'").all();
    const retained = records.map(row => JSON.parse(row.payload_json));
    assert.ok(retained.some(record => record.source === "AgentSession.bindExtensions.onError" &&
      record.payload.error === "QUALIFICATION_SHUTDOWN_DIAGNOSTIC"), "Native shutdown diagnostics were discarded");
    assert.equal(records.some(row => row.payload_json.includes("controlled-only")), false);
    process.stdout.write("Pi protocol quarantine retained native shutdown diagnostics without Harness retry or credentials.\n");
  } finally { database.close(); }
} finally { await cleanup(); }
