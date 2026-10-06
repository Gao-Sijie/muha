import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const coreReadme = await readFile(new URL("../../packages/core/README.md", import.meta.url), "utf8");
const piReadme = await readFile(new URL("../../packages/pi-adapter/README.md", import.meta.url), "utf8");
const adapterReadmes = await Promise.all([
  "codex-adapter",
  "opencode-adapter",
  "kimi-adapter",
].map((directory) => readFile(
  new URL(`../../packages/${directory}/README.md`, import.meta.url),
  "utf8",
)));
const qualification = await readFile(
  new URL("../../QUALIFICATION.md", import.meta.url),
  "utf8",
);

test("the maintained package READMEs document supported hosts and Harness prerequisites", () => {
  for (const statement of [
    "Node.js `>=22.20.0`",
    "Linux x64 glibc",
    "WSL2",
    "independently install and authenticate",
    "`PATH`",
    "never installs, upgrades, downloads",
    "await runtime.close()",
  ]) {
    assert.ok(coreReadme.includes(statement), `Core README is missing: ${statement}`);
  }
  assert.equal(adapterReadmes.every((readme) => readme.includes("independently installed")), true);
  assert.ok(coreReadme.includes("scoped exception"));
  assert.ok(piReadme.includes("@earendil-works/pi-coding-agent@0.84.2"));
  assert.ok(piReadme.includes("not a PATH"));
  assert.ok(piReadme.includes("native Pi authentication"));
});

test("the SDK qualification preserves Capabilities, resources, exceptions and non-publication boundaries", () => {
  for (const statement of [
    "Official Harness Set",
    "Harness Capability Profile",
    "UNSUPPORTED_CAPABILITY",
    "harnessManaged",
    "HARNESS_CAPABILITY_MISMATCH",
    "AGY and Pi",
    "npm run check",
    "SHA256",
    "isolated packed consumer",
    "No package is published",
  ]) {
    assert.ok(qualification.includes(statement), `qualification is missing: ${statement}`);
  }
});

test("Core README documents diagnostic data and semantic non-equivalence", () => {
  for (const statement of [
    "complete, unredacted",
    "no encryption, retention, pruning, rotation, delete, query, replay, or export API",
    "grow without bound",
    "does not promise identical output",
    "V0.1 explicitly does not support",
  ]) {
    assert.ok(coreReadme.includes(statement), `Core README is missing: ${statement}`);
  }
});

test("current package documentation preserves public usage and environment boundaries", () => {
  for (const statement of [
    "createMuhaRuntime",
    "configureWorkspace",
    "OfficialAdapterOptions.env",
    "Workspace workers",
    "stdio MCP server's `env`",
    "await runtime.close()",
  ]) {
    assert.ok(coreReadme.includes(statement), `Core README is missing: ${statement}`);
  }
});
