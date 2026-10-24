import assert from "node:assert/strict";
import test from "node:test";
import {
  coldInstallTimeoutMs,
  reinstallTimeoutMs,
  umbrellaConsumerTimeoutMs,
} from "../support/umbrella-consumer.mjs";

test("consumer cold-install timeout allows twenty minutes without changing lockfile replay or Windows limits", () => {
  assert.equal(coldInstallTimeoutMs, process.platform === "win32" ? 600000 : 1200000);
  assert.equal(reinstallTimeoutMs, process.platform === "win32" ? 600000 : 120000);
});

test("consumer enclosing timeout covers the complete cold install and lockfile replay budgets", () => {
  const overhead = process.platform === "win32" ? 300000 : 120000;
  assert.equal(umbrellaConsumerTimeoutMs, coldInstallTimeoutMs + reinstallTimeoutMs + overhead);
  assert.equal(umbrellaConsumerTimeoutMs, process.platform === "win32" ? 1500000 : 1440000);
});
