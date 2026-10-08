import assert from "node:assert/strict";
import test from "node:test";

import { auditLocalDelivery } from "../../scripts/audit-local-delivery.mjs";
import { bindDependencyLicenseEvidence } from "../../scripts/dependency-license-evidence.mjs";
import { assertClipboardLicenseEvidence } from "../support/clipboard-license-contract.mjs";

test("local delivery preserves exact supplemental Pi dependency license resources", async () => {
  const audit = await auditLocalDelivery();
  const verified = audit.dependencyClosure.filter(node => !node.licenseFiles.length &&
    node.licenseEvidence?.status === "verified");
  const expected = [
    ...["chord", "pi-agent-core", "pi-ai", "pi-codemode", "pi-mcp", "pi-telemetry", "pi-tui"]
      .map(name => `@earendil-works/${name}@1.1.0`),
    "@earendil-works/pi-coding-agent@1.0.4",
    "@aws-sdk/credential-provider-http@3.972.74",
    "@aws-sdk/credential-provider-login@3.972.79",
    "@aws-sdk/nested-clients@3.997.46", "data-uri-to-buffer@4.0.1",
  ];
  assert.deepEqual(verified.map(node => `${node.name}@${node.version}`).sort(), expected.sort());
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
  assertClipboardLicenseEvidence({ ...audit, nodes: audit.dependencyClosure, edges: audit.dependencyEdges });
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
