// Exact-version evidence for dependency archives that omit a root LICENSE.
// These resources ship in the Pi adapter tarball and are checksum-checked by
// the delivery audit. A SPDX label alone never satisfies this mapping.
const pi = {
  resource: "dist/PI-SDK-LICENSE",
  sha256: "4f6a1985796db5225e3b1e59972bd47e07a27a0748427cb3d3c8fbf39f9311f0",
  source: "https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/LICENSE",
};
const aws = {
  resource: "dist/third-party-licenses/aws-sdk-3.972.39.LICENSE",
  sha256: "edea91454b811f127fbdea3d86f378f6719bd372ed440abf82b232f6fca06c3d",
  source: "https://github.com/aws/aws-sdk-js-v3/blob/313813d9e1f25eb6896cf2880977f01ee7fb2556/LICENSE",
};
const evidence = new Map([
  ...["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-client", "pi-protocol", "pi-telemetry", "pi-tui"]
    .map(name => [`@earendil-works/${name}@0.84.2`, pi]),
  ["@aws-sdk/credential-provider-http@3.972.39", aws],
  ["@aws-sdk/credential-provider-login@3.972.41", aws],
  ["@aws-sdk/nested-clients@3.997.9", aws],
  ["data-uri-to-buffer@4.0.1", {
    resource: "dist/third-party-licenses/data-uri-to-buffer-4.0.1.README.md",
    sha256: "a7cc4332acfa1f9b6530e01aac77fefe74f2efa32579215fddaa473013f9a25c",
    source: "https://registry.npmjs.org/data-uri-to-buffer/-/data-uri-to-buffer-4.0.1.tgz",
  }],
  ["@nodable/entities@2.1.0", {
    resource: "dist/third-party-licenses/nodable-entities-2.1.0.LICENSE",
    sha256: "750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40",
    source: "https://github.com/nodable/val-parsers/blob/f1c61a65e7b967c17b13822ef71e91bd25f17ce2/LICENSE",
  }],
  ["xml-naming@0.1.0", {
    resource: "dist/third-party-licenses/xml-naming-0.1.0.LICENSE",
    sha256: "8e75fc0e776c62ccadb8178ece8d3daa9ba7601fb0a49b2dfb0ea9a7a5c0aa07",
    source: "https://github.com/NaturalIntelligence/xml-naming/blob/c0afc395948730bed124859d7fc7cccabe0aac8a/LICENSE",
  }],
]);

export function bindDependencyLicenseEvidence(dependencies, resources) {
  const piResources = new Map(resources.filter(item => item.package === "@muha-sdk/pi-adapter")
    .map(item => [item.path, item]));
  const blockers = [];
  const nodes = dependencies.map(node => {
    if (node.licenseFiles.some(file => /^(?:licen[sc]e|copying)(?:[.-]|$)/i.test(file.path) && file.bytes > 0)) return node;
    const identity = `${node.name}@${node.version}`;
    const known = evidence.get(identity);
    const resource = known && piResources.get(known.resource);
    if (known && resource?.sha256 === known.sha256) {
      return { ...node, licenseEvidence: { status: "verified", ...known } };
    }
    const reason = known ? "verified license resource missing or changed" :
      "no version-bound complete license text and native notice evidence";
    blockers.push(`${identity}: ${reason}`);
    return { ...node, licenseEvidence: { status: "blocked", reason } };
  });
  return { nodes, blockers };
}
