import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";

async function unchanged(path, bytes) {
  try { return (await readFile(path)).equals(Buffer.from(bytes)); }
  catch (error) { if (error.code !== "ENOENT") throw error; return false; }
}
async function writeChanged(path, bytes) {
  if (!await unchanged(path, bytes)) await writeFile(path, bytes);
}
async function copyChanged(source, destination) {
  await writeChanged(destination, await readFile(source));
}

// Build from the workspace lockfile installation, not a user's global SDK.
const sdkRoot = new URL("../../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);
const sdkEntry = new URL("dist/index.js", sdkRoot);
const target = new URL("core/agent-session.js", sdkEntry);
const source = await readFile(target, "utf8");
const expected = "a5c9ff22e42215405804dc0c850e98aff424a1262829161155132a3da020b693";
if (createHash("sha256").update(source).digest("hex") !== expected) {
  throw new Error("Pi SDK 1.2.0 input patch does not match installed source");
}
let patched = source;
function replaceOnce(from, to) {
  if (patched.split(from).length !== 2) throw new Error("Pi SDK input patch anchor mismatch");
  patched = patched.replace(from, to);
}
replaceOnce("        const expandPromptTemplates = options?.expandPromptTemplates ?? true;", `        const orderedContent = Array.isArray(text) ? structuredClone(text) : undefined;
        if (orderedContent) {
            if (orderedContent.length === 0 || orderedContent.some(part =>
                !part || (part.type !== "text" && part.type !== "image"))) {
                throw new Error("Invalid ordered Pi input");
            }
            if (options?.images !== undefined || options?.streamingBehavior !== undefined) {
                throw new Error("Ordered Pi input cannot use attachment or queue options");
            }
            text = orderedContent.filter(part => part.type === "text").map(part => part.text).join("\\n");
            options = { ...options, images: orderedContent.filter(part => part.type === "image") };
        }
        const expandPromptTemplates = options?.expandPromptTemplates ?? true;`);
// An explicit native transformation wins even when its text is unchanged.
replaceOnce('return { text: inputResult.text, images: inputResult.images ?? images };',
  'return { text: inputResult.text, images: inputResult.images ?? images, transformed: true };');
// Pi 1.2 prepares user/custom messages in _prepareRun. Carry the order privately,
// not on the native trigger exposed to extension hooks. Native custom-message
// runs omit it. Native transformations and Skill/template expansion discard it.
replaceOnce("    async _startRun(trigger, onStarted) {", "    async _startRun(trigger, onStarted, orderedContent) {");
replaceOnce("messages = await this._prepareRun(trigger);", "messages = await this._prepareRun(trigger, orderedContent);");
replaceOnce("    async _prepareRun(trigger) {", "    async _prepareRun(trigger, orderedContent) {");
// SDK 1.2 marks preparation busy before notifying preflight acceptance. Keep
// that callback inside its existing native finalizer: rejection/interruption
// must release the busy state without starting a model or copying the loop.
replaceOnce("        onStarted?.();\n", "");
replaceOnce(`        try {
            await this.agent.prompt(messages);`, `        try {
            onStarted?.();
            await this.agent.prompt(messages);`);
replaceOnce('await this._startRun({ messageType: "user", prompt: expandedText, images: currentImages }, () => preflightResult?.("started"));',
  'await this._startRun({ messageType: "user", prompt: expandedText, images: currentImages }, () => preflightResult?.("started"), !processedInput.transformed && expandedText === text ? orderedContent : undefined);');
// Keep Pi's image normalization. When it can preserve every image slot, place
// normalized images back into the original ordered parts. Native replacement
// text, image omissions, or normalization hints use Pi's replacement message.
replaceOnce(`            messages.push({
                role: "user",
                content: [{ type: "text", text }, ...normalized.images],`, `            let imageIndex = 0;
            const userContent = orderedContent && normalized.hints.length === 0 &&
                normalized.images.length === (trigger.images?.length ?? 0)
                ? orderedContent.map(part => part.type === "image" ? normalized.images[imageIndex++] : part)
                : [{ type: "text", text }, ...normalized.images];
            messages.push({
                role: "user",
                content: userContent,`);
const output = new URL("../dist/", import.meta.url);
const licenseResources = [
  [new URL("../../../node_modules/@aws-sdk/core/LICENSE", import.meta.url), "third-party-licenses/aws-sdk-3.972.39.LICENSE", "edea91454b811f127fbdea3d86f378f6719bd372ed440abf82b232f6fca06c3d"],
  [new URL("../../../node_modules/data-uri-to-buffer/README.md", import.meta.url), "third-party-licenses/data-uri-to-buffer-4.0.1.README.md", "a7cc4332acfa1f9b6530e01aac77fefe74f2efa32579215fddaa473013f9a25c"],
  [new URL("../third-party-licenses/nodable-entities-2.1.0.LICENSE", import.meta.url), "third-party-licenses/nodable-entities-2.1.0.LICENSE", "750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40"],
  [new URL("../third-party-licenses/xml-naming-0.1.0.LICENSE", import.meta.url), "third-party-licenses/xml-naming-0.1.0.LICENSE", "8e75fc0e776c62ccadb8178ece8d3daa9ba7601fb0a49b2dfb0ea9a7a5c0aa07"],
];
for (const [sourcePath, destination, expectedSha256] of licenseResources) {
  const sourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  if (sourceSha256 !== expectedSha256) throw new Error(`Pinned Pi dependency license changed: ${destination}`);
  if (process.argv.includes("--check")) {
    const outputSha256 = createHash("sha256").update(await readFile(new URL(destination, output))).digest("hex");
    if (outputSha256 !== expectedSha256) throw new Error(`Pi dependency license is missing or stale: ${destination}`);
  }
}
if (process.argv.includes("--check")) {
  // Packing validates an already built artifact; it must not rewrite the SDK
  // tree that other owned Session processes may currently be importing.
  const manifest = JSON.parse(await readFile(new URL("sdk-patch.json", output), "utf8"));
  const hash = value => createHash("sha256").update(value).digest("hex");
  if (manifest.version !== "1.2.0" || manifest.originalSha256 !== expected || manifest.patchedSha256 !== hash(patched) ||
      hash(await readFile(new URL("ordered-agent-session.mjs", output))) !== hash(patched)) {
    throw new Error("Pi SDK patch is missing or stale; build before packing");
  }
  for (const name of ["sdk-loader.mjs", "sdk-worker.mjs", "sdk-worker-transport.mjs", "sdk-sessions.mjs", "sdk-settings.mjs", "sdk-extensions.mjs"]) {
    if (hash(await readFile(new URL(`../src/${name}`, import.meta.url))) !== hash(await readFile(new URL(name, output)))) {
      throw new Error(`Pi ${name} is stale; build before packing`);
    }
  }
  await readFile(new URL("index.js", output));
  await readFile(new URL("pi-process.js", output));
  process.exit(0);
}
await mkdir(output, { recursive: true });
await writeChanged(new URL("ordered-agent-session.mjs", output), patched);
await writeChanged(new URL("sdk-patch.json", output), JSON.stringify({
  version: "1.2.0", originalSha256: expected,
  patchedSha256: createHash("sha256").update(patched).digest("hex"),
}) + "\n");
await copyChanged(new URL("../src/sdk-loader.mjs", import.meta.url), new URL("sdk-loader.mjs", output));
await copyChanged(new URL("../src/sdk-worker.mjs", import.meta.url), new URL("sdk-worker.mjs", output));
await copyChanged(new URL("../src/sdk-worker-transport.mjs", import.meta.url), new URL("sdk-worker-transport.mjs", output));
await copyChanged(new URL("../src/sdk-sessions.mjs", import.meta.url), new URL("sdk-sessions.mjs", output));
await copyChanged(new URL("../src/sdk-settings.mjs", import.meta.url), new URL("sdk-settings.mjs", output));
await copyChanged(new URL("../src/sdk-extensions.mjs", import.meta.url), new URL("sdk-extensions.mjs", output));
await copyChanged(new URL("../PI-SDK-LICENSE", import.meta.url), new URL("PI-SDK-LICENSE", output));
await mkdir(new URL("third-party-licenses/", output), { recursive: true });
for (const [sourcePath, destination] of licenseResources) {
  await copyChanged(sourcePath, new URL(destination, output));
}
