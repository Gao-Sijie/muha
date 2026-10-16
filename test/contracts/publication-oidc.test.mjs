import { spawnNpmSync } from "../../scripts/npm-command.mjs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPublicationOidcContext,
  assertPublicationNpmVersion,
  publicationNpmEnvironment,
  PUBLICATION_NPM_VERSION,
} from "../../scripts/publication-oidc.mjs";

const revision = "a".repeat(40);
const environment = (mode = "publish") => ({
  GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Gao-Sijie/muha",
  GITHUB_REF: "refs/heads/main", GITHUB_SHA: revision, REVIEWED_REVISION: revision,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: "Gao-Sijie/muha/.github/workflows/sdk-release.yml@refs/heads/main",
  GITHUB_JOB: mode, RUNNER_ENVIRONMENT: "github-hosted",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.actions.githubusercontent.com/idtoken",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "controlled-request-credential-never-log",
});

test("both publication operations accept hosted reviewed OIDC context without an npm token", () => {
  for (const mode of ["publish", "promote"]) {
    assert.doesNotThrow(() => assertPublicationOidcContext(environment(mode), mode));
  }
});

test("OIDC publication rejects other source, workflow, event, runner and job identities", () => {
  for (const change of [
    { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "someone/muha" },
    { GITHUB_REF: "refs/heads/other" }, { GITHUB_SHA: "b".repeat(40) },
    { REVIEWED_REVISION: undefined }, { REVIEWED_REVISION: "bad", GITHUB_SHA: "bad" },
    { GITHUB_WORKFLOW_REF: "Gao-Sijie/muha/.github/workflows/other.yml@refs/heads/main" },
    { GITHUB_EVENT_NAME: "pull_request" }, { RUNNER_ENVIRONMENT: "self-hosted" },
    { RUNNER_ENVIRONMENT: undefined }, { GITHUB_JOB: "prepare" },
  ]) {
    assert.throws(() => assertPublicationOidcContext({ ...environment(), ...change }, "publish"));
  }
  assert.throws(() => assertPublicationOidcContext(environment(), "unknown"));
  assert.throws(() => assertPublicationOidcContext(environment(), "promote"));
});

test("absent or malformed OIDC configuration fails without revealing credentials", () => {
  for (const change of [
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: " " },
    { ACTIONS_ID_TOKEN_REQUEST_URL: undefined },
    { ACTIONS_ID_TOKEN_REQUEST_URL: "controlled-secret-not-a-url" },
    { ACTIONS_ID_TOKEN_REQUEST_URL: "http://example.actions.githubusercontent.com/idtoken" },
    { ACTIONS_ID_TOKEN_REQUEST_URL: "https://untrusted.invalid/idtoken" },
    { ACTIONS_ID_TOKEN_REQUEST_URL: "https://secret@example.actions.githubusercontent.com/idtoken" },
  ]) {
    assert.throws(() => assertPublicationOidcContext({ ...environment(), ...change }, "publish"), error => {
      assert.match(error.message, /OIDC/);
      assert.doesNotMatch(error.message, /controlled-secret|controlled-request-credential/);
      return true;
    });
  }
});

test("OIDC mutation rejects explicit legacy npm credentials rather than falling back", () => {
  for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_AUTH_TOKEN", "NPM_PUBLISH_TOKEN", "NPM_ID_TOKEN", "npm_config__auth", "NPM_CONFIG__AUTHTOKEN", "npm_config_//registry.npmjs.org/:_authToken"]) {
    for (const mode of ["publish", "promote"]) {
      assert.throws(() => assertPublicationOidcContext({ ...environment(mode), [key]: "controlled-secret-value" }, mode), error => {
        assert.match(error.message, /token|credential/i);
        assert.doesNotMatch(error.message, /controlled-secret-value/);
        return true;
      });
    }
  }
  assert.doesNotThrow(() => assertPublicationOidcContext({ ...environment(), NODE_AUTH_TOKEN: "" }, "publish"));
});

test("publication requires the reviewed CLI supporting both OIDC publish and dist-tags", () => {
  assert.equal(PUBLICATION_NPM_VERSION, "11.21.0");
  assert.doesNotThrow(() => assertPublicationNpmVersion("11.21.0"));
  for (const value of ["11.15.0", "11.16.0", "11.21.0-beta.1", "12.2.0", undefined, "bad"]) {
    assert.throws(() => assertPublicationNpmVersion(value), /npm 11\.21\.0/);
  }
});

test("publication npm ignores inherited registry/auth/config policy but preserves GitHub OIDC", () => {
  const original = {
    ...environment(), PATH: "/controlled/bin", HTTPS_PROXY: "http://proxy.invalid",
    NPM_CONFIG_USERCONFIG: "/previous/credentials", npm_config_globalconfig: "/previous/global",
    npm_config_registry: "https://wrong.invalid", npm_config_provenance: "false",
  };
  const snapshot = { ...original };
  const directory = "/controlled/owned-npm";
  const result = publicationNpmEnvironment(original, directory);
  assert.deepEqual(original, snapshot, "never mutate the host environment");
  assert.equal(result.NPM_CONFIG_USERCONFIG, join(directory, "user.npmrc"));
  assert.equal(result.NPM_CONFIG_GLOBALCONFIG, join(directory, "global.npmrc"));
  assert.equal(result.npm_config_registry, undefined);
  assert.equal(result.npm_config_provenance, undefined);
  assert.equal(result.npm_config_globalconfig, undefined);
  for (const key of ["PATH", "HTTPS_PROXY", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) {
    assert.equal(result[key], original[key]);
  }
});

test("the actual npm CLI reads only the owned credential-free user/global configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muha-oidc-config-contract-"));
  try {
    await writeFile(join(directory, "user.npmrc"), "registry=https://registry.npmjs.org/\n", { mode: 0o600 });
    await writeFile(join(directory, "global.npmrc"), "", { mode: 0o600 });
    const env = publicationNpmEnvironment({ ...process.env,
      NPM_CONFIG_USERCONFIG: "/unreadable/previous-credentials",
      npm_config_registry: "https://wrong.invalid",
    }, directory);
    for (const [key, expected] of [
      ["userconfig", join(directory, "user.npmrc")],
      ["globalconfig", join(directory, "global.npmrc")],
      ["registry", "https://registry.npmjs.org/"],
    ]) {
      const result = spawnNpmSync(["config", "get", key], { cwd: directory, env, encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 0, "read-only npm config command must succeed");
      assert.equal(result.stdout.trim(), expected);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("both publisher entry modes fail on missing OIDC before loading artifacts or contacting Registry", () => {
  for (const mode of ["publish", "promote"]) {
    const env = { ...environment(mode), PATH: process.env.PATH,
      ACTIONS_ID_TOKEN_REQUEST_URL: "invalid-controlled-secret", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" };
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/publish-public-release.mjs", import.meta.url)), mode], {
      env, encoding: "utf8", timeout: 15000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GitHub OIDC is unavailable/);
    assert.doesNotMatch(result.stderr, /invalid-controlled-secret|ENOENT|npm command failed/);
  }
});

test("only upload and post-consumer promotion request OIDC and use the pinned publishing CLI", async () => {
  const source = await readFile(new URL("../../.github/workflows/sdk-release.yml", import.meta.url), "utf8");
  const jobs = Object.fromEntries([...source.matchAll(/^  ([a-z-]+):\n([\s\S]*?)(?=^  [a-z-]+:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  assert.deepEqual(Object.keys(jobs), ["prepare", "publish", "registry-consumers", "promote"]);
  assert.doesNotMatch(source, /NODE_AUTH_TOKEN|NPM_PUBLISH_TOKEN|NPM_TOKEN|registry-url:/);
  for (const name of ["publish", "promote"]) {
    assert.match(jobs[name], /id-token: write/);
    assert.match(jobs[name], /runs-on: ubuntu-22\.04/);
    assert.match(jobs[name], /npm install --global npm@11\.21\.0/);
    assert.match(jobs[name], /REVIEWED_REVISION:/);
    assert.match(jobs[name], /REVIEWED_MANIFEST_SHA256:/);
  }
  for (const name of ["prepare", "registry-consumers"]) {
    assert.doesNotMatch(jobs[name], /id-token: write/);
    assert.match(jobs[name], /npm install --global npm@11\.15\.0/);
  }
  assert.match(jobs.promote, /needs: \[publish, registry-consumers\]/);
  assert.match(jobs["registry-consumers"], /Cold public Registry installs and lockfile npm ci/);
  assert.match(jobs.publish, /publish-public-release\.mjs publish/);
  assert.match(jobs.promote, /publish-public-release\.mjs promote/);
});

test("release instructions cover all seven package setups and both independent OIDC permissions", async () => {
  const source = await readFile(new URL("../../RELEASING.md", import.meta.url), "utf8");
  for (const packageName of ["core", "codex-adapter", "opencode-adapter", "kimi-adapter", "pi-adapter", "agy-adapter", "muha"]) {
    assert.ok(source.includes(`@muha-sdk/${packageName}`));
  }
  for (const required of ["Gao-Sijie", "sdk-release.yml", "leave blank", "npm publish", "npm dist-tag", "11.21.0", "within two days", "No `NPM_PUBLISH_TOKEN`", "new source-bound candidate"]) {
    assert.ok(source.includes(required), `missing trusted publishing instruction: ${required}`);
  }
});
