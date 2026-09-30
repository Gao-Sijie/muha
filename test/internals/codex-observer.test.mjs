import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { delimiter, dirname, resolve } from "node:path";
import test from "node:test";
import { CodexNativeObserver } from "../../packages/codex-adapter/dist/codex-observer.js";

const environment = { PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter) };

test("untrusted observer handshakes cannot fail the Runtime or enter semantic storage", { timeout: 3000 }, async () => {
  const failures = [], records = [];
  const observer = new CodexNativeObserver({
    reportFatalError: error => failures.push(error), recordNativeEvent: async (_, message) => records.push(message),
  }, () => async () => {});
  const binding = await observer.open(environment);
  try {
    for (const payload of ["{invalid}\n", JSON.stringify({ type: "hello", token: "é".repeat(64) }) + "\n"]) {
      const socket = createConnection(binding.MUHA_INTERNAL_CODEX_SOCKET);
      socket.on("error", () => {});
      const closed = once(socket, "close");
      await once(socket, "connect");
      socket.write(payload);
      await closed;
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(records, []);
  } finally { await observer.close(); }
});

test("an explicitly removed PATH cannot inherit the host Codex binary", async () => {
  const observer = new CodexNativeObserver({ reportFatalError() {}, async recordNativeEvent() {} }, () => async () => {});
  try { await assert.rejects(observer.open({ PATH: undefined }), error => error.code === "HARNESS_ERROR"); }
  finally { await observer.close(); }
});
