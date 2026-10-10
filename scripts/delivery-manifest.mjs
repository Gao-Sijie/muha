export const MUHA_DELIVERY_PACKAGES = Object.freeze([
  Object.freeze({
    role: "core",
    packageName: "@muha-sdk/core",
    directory: "core",
    artifactStem: "muha-sdk-core",
    requiredFiles: Object.freeze([
      "dist/index.js",
      "dist/internal.js",
      "dist/workspace-mcp-worker.js",
      "dist/acp-supervisor", "dist/acp-supervisor.c", "dist/acp-supervisor-glibc-compat.c",
    ]),
    forbiddenFilePrefixes: Object.freeze(["dist/kimi-mcp."]),
  }),
  Object.freeze({
    role: "adapter",
    harness: "codex",
    packageName: "@muha-sdk/codex-adapter",
    directory: "codex-adapter",
    artifactStem: "muha-sdk-codex-adapter",
    requiredFiles: Object.freeze(["dist/index.js", "dist/codex-observer-worker.js", "dist/codex-observer-wire.js"]),
  }),
  Object.freeze({
    role: "adapter",
    harness: "opencode",
    packageName: "@muha-sdk/opencode-adapter",
    directory: "opencode-adapter",
    artifactStem: "muha-sdk-opencode-adapter",
    requiredFiles: Object.freeze(["dist/index.js"]),
  }),
  Object.freeze({
    role: "adapter",
    harness: "kimi",
    packageName: "@muha-sdk/kimi-adapter",
    directory: "kimi-adapter",
    artifactStem: "muha-sdk-kimi-adapter",
    requiredFiles: Object.freeze([
      "dist/index.js",
      "dist/workspace-mcp-worker.js",
    ]),
  }),
  Object.freeze({
    role: "adapter",
    harness: "pi",
    packageName: "@muha-sdk/pi-adapter",
    directory: "pi-adapter",
    artifactStem: "muha-sdk-pi-adapter",
    requiredFiles: Object.freeze([
      "dist/index.js", "dist/pi-process.js", "dist/pi-owned-worker.js", "dist/pi-events.js", "dist/pi-input.js",
      "dist/sdk-worker.mjs", "dist/sdk-loader.mjs", "dist/sdk-sessions.mjs", "dist/sdk-settings.mjs",
      "dist/sdk-extensions.mjs", "dist/ordered-agent-session.mjs", "dist/sdk-patch.json", "dist/PI-SDK-LICENSE",
      "dist/third-party-licenses/aws-sdk-3.972.39.LICENSE",
      "dist/third-party-licenses/data-uri-to-buffer-4.0.1.README.md",
      "dist/third-party-licenses/nodable-entities-2.1.0.LICENSE",
      "dist/third-party-licenses/xml-naming-0.1.0.LICENSE",
    ]),
  }),
  Object.freeze({
    role: "adapter",
    harness: "agy",
    packageName: "@muha-sdk/agy-adapter",
    directory: "agy-adapter",
    artifactStem: "muha-sdk-agy-adapter",
    requiredFiles: Object.freeze(["dist/index.js", "dist/agy-supervisor", "dist/agy-supervisor.c", "dist/agy-supervisor-glibc-compat.c"]),
  }),
  Object.freeze({
    role: "umbrella",
    packageName: "muha",
    directory: "muha",
    artifactStem: "muha",
    additionalFiles: Object.freeze(["README.zh-CN.md"]),
    requiredFiles: Object.freeze(["dist/index.js", "README.zh-CN.md"]),
  }),
]);

export const MUHA_ADAPTER_DELIVERIES = Object.freeze(
  MUHA_DELIVERY_PACKAGES.filter(({ role }) => role === "adapter"),
);

export function publicationFiles(delivery) {
  return ["dist", ...(delivery.additionalFiles ?? [])];
}

export function isPublicationFile(delivery, path) {
  if (typeof path !== "string" || /[\\\r\n]/.test(path) ||
      path.split("/").some(part => ["", "..", "docs"].includes(part))) return false;
  return ["package.json", "LICENSE", "README.md", ...(delivery.additionalFiles ?? [])].includes(path) ||
    path.startsWith("dist/");
}

export function validateDeliveryDependencies(delivery, dependencies, version) {
  if (delivery.role === "adapter" && dependencies?.["@muha-sdk/core"] !== version) {
    throw new Error(`${delivery.packageName}: Core dependency must pin the release version`);
  }
  if (delivery.role === "umbrella") {
    const expected = MUHA_DELIVERY_PACKAGES.filter(item => item.role !== "umbrella")
      .map(item => item.packageName).sort();
    if (JSON.stringify(Object.keys(dependencies ?? {}).sort()) !== JSON.stringify(expected) ||
        expected.some(name => dependencies[name] !== version)) {
      throw new Error(`${delivery.packageName}: dependencies must pin the complete SDK release`);
    }
  }
}

export async function deliveryResources(root, delivery) {
  const resources = ["package.json", "LICENSE", "README.md", ...delivery.requiredFiles]
    .map(path => ({ path }));
  if (delivery.harness === "pi") {
    resources.find(item => item.path === "dist/PI-SDK-LICENSE").expectedSha256 =
      "4f6a1985796db5225e3b1e59972bd47e07a27a0748427cb3d3c8fbf39f9311f0";
  }
  return resources;
}
