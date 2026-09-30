import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

// Loaded only in Adapter-owned SDK processes, before any SDK module is imported.
// The hook changes one verified module at its original URL, preserving all native
// relative imports and dependency resolution. It never edits installed packages.
let loading;
export function loadSdk() {
  return loading ??= importPatchedSdk();
}

async function importPatchedSdk() {
  let entry;
  try { entry = import.meta.resolve("@earendil-works/pi-coding-agent"); }
  catch (error) { throw new Error("Pi SDK dependency is unavailable", { cause: error }); }
  const target = new URL("core/agent-session.js", entry).href;
  const manifest = JSON.parse(readFileSync(new URL("sdk-patch.json", import.meta.url), "utf8"));
  const source = readFileSync(new URL("ordered-agent-session.mjs", import.meta.url), "utf8");
  const sdkManifest = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
  if (sdkManifest.name !== "@earendil-works/pi-coding-agent" || sdkManifest.version !== manifest.version) {
    throw new Error(`Pi SDK version mismatch: expected ${manifest.version}, found ${sdkManifest.version ?? "unknown"}`);
  }
  const hash = value => createHash("sha256").update(value).digest("hex");
  if (hash(readFileSync(new URL(target))) !== manifest.originalSha256
      || hash(source) !== manifest.patchedSha256) {
    throw new Error("Pi SDK input patch integrity check failed");
  }
  let applied = false;
  const hook = registerHooks({
    load(url, context, nextLoad) {
      if (url !== target) return nextLoad(url, context);
      applied = true;
      return { format: "module", source, shortCircuit: true };
    },
  });
  try {
    const sdk = await import(entry);
    if (!applied) throw new Error("Pi SDK was imported before its input patch");
    return sdk;
  } finally { hook.deregister(); }
}
