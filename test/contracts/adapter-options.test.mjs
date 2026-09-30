import assert from "node:assert/strict";
import test from "node:test";
import { codexAdapter } from "@muha-sdk/codex-adapter";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";
import { kimiAdapter } from "@muha-sdk/kimi-adapter";
import { piAdapter } from "@muha-sdk/pi-adapter";
import { agyAdapter } from "@muha-sdk/agy-adapter";

test("official factories reject public ACP bindings before any Harness starts", () => {
  for (const factory of [codexAdapter, openCodeAdapter, kimiAdapter, piAdapter, agyAdapter]) {
    for (const acp of [undefined, { command: process.execPath }, { command: "/must-not-execute", args: [] }]) {
      assert.throws(() => factory({ acp }), (error) => error.data?.code === "INVALID_INPUT", factory.name);
    }
    assert.throws(() => factory(Object.defineProperty({}, "acp", { value: { command: process.execPath } })),
      (error) => error.data?.code === "INVALID_INPUT", `${factory.name}: non-enumerable selector`);
    assert.doesNotThrow(() => factory({ env: {}, startupTimeoutMs: 100, shutdownTimeoutMs: 100 }));
  }
});
