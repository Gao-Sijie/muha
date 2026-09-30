import assert from "node:assert/strict";
import test from "node:test";
import { isObservedNativeDenial } from "../../scripts/qualify-native-autoapprove.mjs";

test("qualification accepts a native cancellation only with an observed denial and failed tool", () => {
  const denial = { type: "approval.resolved", outcome: "deny", source: "caller" };
  const tool = { type: "tool.completed", isError: true };
  const result = { status: "interrupted", reason: "harness" };
  assert.equal(isObservedNativeDenial({ result, events: [denial, tool] }), true);
  assert.equal(isObservedNativeDenial({ result, events: [tool] }), false);
  assert.equal(isObservedNativeDenial({ result, events: [denial] }), false);
  assert.equal(isObservedNativeDenial({ result: { ...result, reason: "caller" }, events: [denial, tool] }), false);
  assert.equal(isObservedNativeDenial({ result: { status: "failed", error: { code: "ADAPTER_PROTOCOL_ERROR" } }, events: [denial, tool] }), false);
});
