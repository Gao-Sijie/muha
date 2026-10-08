import assert from "node:assert/strict";
import test from "node:test";

import { auditLocalDelivery } from "../../scripts/audit-local-delivery.mjs";
import { assertClipboardLicenseEvidence } from "../support/clipboard-license-contract.mjs";

test("Pi dependency closure retains license evidence without bundling its SDK dependencies", async () => {
  const audit = await auditLocalDelivery();
  assert.deepEqual(audit.problems, []);
  assert.deepEqual(audit.licenseBlockers, []);
  assertClipboardLicenseEvidence({ ...audit, nodes: audit.dependencyClosure, edges: audit.dependencyEdges });
  assert.equal(audit.dependencyClosure.some(node => node.name.startsWith("@mariozechner/clipboard")), false);
  assert.ok(audit.dependencyClosure.some(node => node.name === "@earendil-works/pi-coding-agent" && node.version === "1.0.4"));
  assert.ok(audit.packages.every(item => item.bundledFiles.length === 0));
  assert.ok(audit.resources.some(item => item.package === "@muha-sdk/pi-adapter" &&
    item.path === "dist/PI-SDK-LICENSE" && item.sha256 === "4f6a1985796db5225e3b1e59972bd47e07a27a0748427cb3d3c8fbf39f9311f0"));
});
