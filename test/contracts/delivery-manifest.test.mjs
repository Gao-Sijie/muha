import assert from "node:assert/strict";
import test from "node:test";

import { OFFICIAL_HARNESS_KINDS } from "@muha-sdk/core/internal";
import {
  MUHA_ADAPTER_DELIVERIES,
  MUHA_DELIVERY_PACKAGES,
} from "../../scripts/delivery-manifest.mjs";

test("the explicit delivery manifest covers Core and every official Adapter", async () => {
  assert.equal(Object.isFrozen(MUHA_DELIVERY_PACKAGES), true);
  assert.deepEqual(
    MUHA_DELIVERY_PACKAGES.map(({ packageName }) => packageName),
    [
      "@muha-sdk/core",
      "@muha-sdk/codex-adapter",
      "@muha-sdk/opencode-adapter",
      "@muha-sdk/kimi-adapter",
      "@muha-sdk/pi-adapter",
      "@muha-sdk/agy-adapter",
    ],
  );
  assert.deepEqual(
    MUHA_ADAPTER_DELIVERIES.map(({ harness }) => harness),
    OFFICIAL_HARNESS_KINDS,
  );
  assert.deepEqual(
    MUHA_DELIVERY_PACKAGES.find(({ role }) => role === "core")?.forbiddenFilePrefixes,
    ["dist/kimi-mcp."],
  );

});
