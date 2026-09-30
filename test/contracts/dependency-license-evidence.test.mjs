import assert from "node:assert/strict";
import test from "node:test";

import { auditLocalDelivery } from "../../scripts/audit-local-delivery.mjs";
import { bindDependencyLicenseEvidence } from "../../scripts/dependency-license-evidence.mjs";

test("local delivery preserves exact supplemental Pi dependency license resources", async () => {
  const audit = await auditLocalDelivery();
  const verified = audit.dependencyClosure.filter(node => !node.licenseFiles.length &&
    node.licenseEvidence?.status === "verified");
  assert.equal(verified.length, 13);
  for (const node of verified) {
    assert.equal(node.licenseEvidence?.status, "verified", `${node.name}@${node.version}`);
    assert.match(node.licenseEvidence.resource, /^dist\//);
    assert.match(node.licenseEvidence.sha256, /^[a-f0-9]{64}$/);
    assert.ok(audit.resources.some(resource => resource.package === "@muha-sdk/pi-adapter" &&
      resource.path === node.licenseEvidence.resource && resource.sha256 === node.licenseEvidence.sha256),
    `${node.name}@${node.version} lacks packed license bytes`);
  }
});

test("unbundled OpenCode client license-body gaps remain explicit upstream evidence", async () => {
  const audit = await auditLocalDelivery();
  const names = ["@opencode/client", "@opencode/protocol", "@opencode/schema",
    "@msgpackr-extract/msgpackr-extract-linux-x64"];
  for (const name of names) {
    const node = audit.dependencyClosure.find((entry) => entry.name === name);
    assert.equal(node?.licenseEvidence?.status, "blocked", name);
    assert.ok(audit.upstreamLicenseGaps.some((problem) => problem.includes(name)));
  }
  assert.deepEqual(audit.licenseBlockers, []);
});

test("clipboard's unverified notices remain visible without blocking unbundled Muha bytes", async () => {
  const audit = await auditLocalDelivery();
  const unresolved = audit.dependencyClosure.filter(node =>
    node.name.startsWith("@mariozechner/clipboard"));
  assert.equal(unresolved.length, 11);
  assert.ok(unresolved.every(node => node.licenseEvidence?.status === "blocked"));
  assert.ok(audit.upstreamLicenseGaps.some(problem => problem.includes("@mariozechner/clipboard@0.3.9")));
  assert.deepEqual(audit.licenseBlockers, []);
});

test("a NOTICE-only archive cannot pass as a complete license body", () => {
  const node = { name: "fixture", version: "1.0.0", licenseFiles: [{ path: "NOTICE", sha256: "a".repeat(64) }] };
  const result = bindDependencyLicenseEvidence([node], []);
  assert.equal(result.nodes[0].licenseEvidence.status, "blocked");
  assert.equal(result.blockers.length, 1);
});

test("official delivery package lifecycle hooks are included in the audit", async () => {
  const audit = await auditLocalDelivery();
  assert.equal(audit.packageHooks["@muha-sdk/pi-adapter"].prepack.command,
    "node scripts/build-sdk.mjs --check");
  assert.equal(audit.packageHooks["@muha-sdk/pi-adapter"].prepack.packExecuted, true);
});
