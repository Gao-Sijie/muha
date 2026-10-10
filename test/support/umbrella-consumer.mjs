import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { MUHA_DELIVERY_PACKAGES } from "../../scripts/delivery-manifest.mjs";
import { controlledPi } from "../../packages/pi-adapter/test/support/controlled-pi.mjs";

const execute = promisify(execFile);
async function run(command, args, options) {
  return execute(command, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
}

export async function verifyUmbrellaConsumer({ repositoryRoot, registryVersion, reviewedInstallScripts }) {
  const root = await mkdtemp(join(tmpdir(), "muha-entry-consumer-"));
  const consumer = join(root, "consumer"), cleanup = [];
  const env = { ...process.env, npm_config_cache: join(root, "cold-npm-cache"),
    npm_config_userconfig: join(root, "anonymous.npmrc"), npm_config_globalconfig: join(root, "global.npmrc"),
    npm_config_audit: "false", npm_config_fund: "false", npm_config_fetch_retries: "1",
    npm_config_fetch_timeout: "30000", npm_config_update_notifier: "false" };
  for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[key];
  let server;
  try {
    await mkdir(consumer);
    await writeFile(env.npm_config_userconfig, "");
    await writeFile(env.npm_config_globalconfig, "");
    let directory;
    if (registryVersion) directory = resolve(process.env.MUHA_REGISTRY_CANDIDATE);
    else if (process.env.MUHA_RELEASE_DIRECTORY) directory = resolve(process.env.MUHA_RELEASE_DIRECTORY);
    else {
      directory = join(root, "candidate");
      await run(process.execPath, [join(repositoryRoot, "scripts/pack-local-release.mjs"), "--preview", "--output", directory],
        { cwd: repositoryRoot, env });
    }
    const release = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
    assert.deepEqual(release.packages.map(item => item.name), MUHA_DELIVERY_PACKAGES.map(item => item.packageName));
    if (registryVersion) {
      assert.equal(release.candidate, true);
      assert.equal(release.version, registryVersion);
      env.npm_config_registry = "https://registry.npmjs.org/";
    } else {
      server = spawn(process.execPath, [join(repositoryRoot, "test/fixtures/candidate-registry.mjs"), directory],
        { stdio: ["ignore", "pipe", "pipe"], env });
      let errors = "";
      server.stderr.on("data", chunk => { errors += chunk; });
      env.npm_config_registry = await new Promise((resolve, reject) => {
        server.stdout.once("data", chunk => resolve(String(chunk).trim()));
        server.once("error", reject);
        server.once("exit", code => reject(new Error(`Candidate Registry exited ${code}: ${errors}`)));
      });
    }
    await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", allowScripts: reviewedInstallScripts }));
    // Bare `muha` is tested before publication. The public job pins the reviewed
    // candidate version because latest is promoted only after both jobs pass.
    await run("npm", ["install", "--save-exact", registryVersion ? `muha@${registryVersion}` : "muha"], { cwd: consumer, env });
    const manifest = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
    assert.deepEqual(manifest.dependencies, { muha: release.version }, "muha must be the only direct SDK dependency");
    assert.equal(manifest.overrides, undefined);
    const lockBytes = await readFile(join(consumer, "package-lock.json"));
    const lock = JSON.parse(lockBytes);
    for (const item of release.packages) {
      const locked = lock.packages[`node_modules/${item.name}`];
      assert.equal(locked.version, release.version);
      assert.equal(locked.integrity, item.integrity);
      assert.equal(locked.link, undefined);
      assert.equal((await lstat(join(consumer, "node_modules", item.name))).isSymbolicLink(), false);
      if (registryVersion) assert.ok(locked.resolved.startsWith("https://registry.npmjs.org/"));
      for (const resource of item.resources) {
        const path = join(consumer, "node_modules", item.name, resource.path);
        assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), resource.sha256);
        if (resource.mode & 0o111) assert.ok((await lstat(path)).mode & 0o111);
      }
    }
    const cores = (await run("npm", ["ls", "@muha-sdk/core", "--all", "--parseable"], { cwd: consumer, env })).stdout;
    assert.deepEqual(cores.trim().split(/\r?\n/), [join(consumer, "node_modules/@muha-sdk/core")]);
    await run("npm", ["ls", "--all"], { cwd: consumer, env });
    await rm(join(consumer, "node_modules"), { recursive: true });
    await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: consumer, env });
    assert.deepEqual(await readFile(join(consumer, "package-lock.json")), lockBytes);

    await writeFile(join(consumer, "entry.mjs"), [
      'import assert from "node:assert/strict";',
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      'childProcess.spawn = childProcess.spawnSync = childProcess.exec = childProcess.execFile = () => { throw new Error("Import started a process"); };',
      'syncBuiltinESMExports();',
      'globalThis.fetch = () => { throw new Error("Import contacted a model/network"); };',
      'const sdk = await import("muha");',
      'const core = await import("@muha-sdk/core");',
      'for (const name of Object.keys(core)) assert.equal(sdk[name], core[name]);',
      ...MUHA_DELIVERY_PACKAGES.filter(item => item.role === "adapter").map(item => {
        const factory = { codex: "codexAdapter", opencode: "openCodeAdapter", kimi: "kimiAdapter", pi: "piAdapter", agy: "agyAdapter" }[item.harness];
        return `assert.equal(sdk.${factory}, (await import(${JSON.stringify(item.packageName)})).${factory}); assert.equal(typeof sdk.${factory}(), "object");`;
      }),
      'assert.equal(sdk.createOfficialHarnessRegistration, undefined);',
      'await assert.rejects(import("muha/internal"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });',
    ].join("\n"));
    await run(process.execPath, ["entry.mjs"], { cwd: consumer, env });
    await writeFile(join(consumer, "entry.cjs"), 'const sdk = require("muha"); if(typeof sdk.piAdapter !== "function") throw new Error("CommonJS ESM compatibility failed");\n');
    await run(process.execPath, ["entry.cjs"], { cwd: consumer, env });

    const english = await readFile(join(consumer, "node_modules/muha/README.md"), "utf8");
    const chinese = await readFile(join(consumer, "node_modules/muha/README.zh-CN.md"), "utf8");
    const example = text => text.match(/```js\n([\s\S]*?)\n```/)[1];
    assert.equal(example(english), example(chinese), "Both languages must use the same executable example");
    await writeFile(join(consumer, "example.mjs"), example(english));
    await writeFile(join(consumer, "example.mts"), example(english));
    await run(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
      "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--typeRoots", join(repositoryRoot, "node_modules/@types"), "example.mts"], { cwd: consumer, env });
    const nodeOnly = join(root, "node-only");
    await mkdir(nodeOnly);
    await symlink(process.execPath, join(nodeOnly, "node"));
    await writeFile(join(consumer, "readme-home.mjs"),
      'import os from "node:os"; import {syncBuiltinESMExports} from "node:module"; os.homedir = () => process.env.MUHA_README_HOME; syncBuiltinESMExports();\n');
    const readmeEnvironment = { ...env, PATH: `${join(repositoryRoot, "test/fixtures/harness-bin")}:${nodeOnly}`,
      MUHA_README_HOME: join(root, "readme-home"), MUHA_FAKE_NATIVE_SESSIONS_FILE: join(root, "codex-sessions.json") };
    await run(process.execPath, ["--import", "./readme-home.mjs", "example.mjs"], { cwd: consumer, env: readmeEnvironment });
    const answer = join(root, "question-answer.json");
    const questionRun = await run(process.execPath, ["--import", "./readme-home.mjs", "example.mjs"], {
      cwd: consumer, env: { ...readmeEnvironment, MUHA_FAKE_TURN_SCENARIO: "question", MUHA_FAKE_QUESTION_RESPONSE_FILE: answer },
    });
    assert.match(questionRun.stdout, /Thanks\./);
    assert.ok(await readFile(answer, "utf8"), "The README must respond to the native question");
    const failed = await execute(process.execPath, ["--import", "./readme-home.mjs", "example.mjs"], {
      cwd: consumer, env: { ...readmeEnvironment, MUHA_FAKE_TURN_REJECT: "1" }, timeout: 15000,
    }).then(() => undefined, error => error);
    assert.equal(failed?.code, 1, "The README must report a failed turn through its exit code");

    const pi = await controlledPi({ after: callback => cleanup.push(callback) });
    await writeFile(join(consumer, "pi-only.mjs"), [
      'import assert from "node:assert/strict";',
      'import {createMuhaRuntime, piAdapter} from "muha";',
      `const runtime = await createMuhaRuntime({harnesses: [piAdapter({env: {PI_CODING_AGENT_DIR: ${JSON.stringify(pi.agentDir)}, PATH: ${JSON.stringify(nodeOnly)}}})], dataDir: ${JSON.stringify(join(root, "pi-diagnostics"))}});`,
      'try {',
      `const session = await runtime.createSession({harness: "pi", workspacePath: ${JSON.stringify(pi.workspace)}, model: "controlled/controlled", approvalPolicy: "harnessManaged"});`,
      'const turn = await session.startTurn([{type: "text", text: "Entry package fixture"}]);',
      'for await(const event of turn) {}',
      'assert.equal((await turn.result).message.text, "Hello from Pi.");',
      '} finally {await runtime.close();}',
    ].join("\n"));
    await run(process.execPath, ["pi-only.mjs"], { cwd: consumer, env: { ...env, PATH: nodeOnly } });
    assert.equal(pi.requests.length, 1, "Only the explicitly enabled controlled Pi model must run");
  } finally {
    for (const callback of cleanup.reverse()) await callback();
    if (server && server.exitCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
}
