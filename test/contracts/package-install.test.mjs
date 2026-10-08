import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { controlledPi } from "../../packages/pi-adapter/test/support/controlled-pi.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const registryVersion = process.env.MUHA_PUBLIC_REGISTRY_VERSION;
// The consumer owns its npm policy. Approvals pin only the reviewed hook versions;
// they do not propagate through the published Muha package manifests.
const reviewedInstallScripts = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).allowScripts;
if (registryVersion && !/^\d+\.\d+\.\d+$/.test(registryVersion)) throw new Error("Invalid public Registry version");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    [command, ...args, result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  return result.stdout;
}

const adapters = [
  ["codex-adapter", "@muha-sdk/codex-adapter", "codexAdapter"],
  ["opencode-adapter", "@muha-sdk/opencode-adapter", "openCodeAdapter"],
  ["kimi-adapter", "@muha-sdk/kimi-adapter", "kimiAdapter"],
  ["agy-adapter", "@muha-sdk/agy-adapter", "agyAdapter"],
  ["pi-adapter", "@muha-sdk/pi-adapter", "piAdapter"],
];

for (const [adapterDirectory, adapterPackage, factory] of
  process.env.MUHA_RELEASE_DIRECTORY ? [] : adapters) {
  test(`a consumer can install only Core and ${adapterPackage}`, () =>
    verifyConsumerInstall(adapterDirectory, adapterPackage, factory));
}

test("an isolated fixture can install Core and all five official Adapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-sdk-install-"));
  const artifacts = join(root, "artifacts");
  const consumer = join(root, "consumer");
  const dependencyStaging = join(root, "dependency-staging");
  const isolatedEnvironment = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fetch_retries: "0",
    npm_config_fetch_timeout: "30000",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };

  try {
    await Promise.all([mkdir(artifacts), mkdir(consumer), mkdir(dependencyStaging)]);
    let tarballs;
    if (registryVersion) {
      isolatedEnvironment.npm_config_registry = "https://registry.npmjs.org/";
      isolatedEnvironment.npm_config_cache = join(root, "cold-npm-cache");
      isolatedEnvironment.npm_config_userconfig = join(root, "anonymous.npmrc");
      tarballs = ["@muha-sdk/core", ...adapters.map(([, name]) => name)].map(name => `${name}@${registryVersion}`);
    } else if (process.env.MUHA_RELEASE_DIRECTORY) {
      isolatedEnvironment.npm_config_registry = "https://registry.npmjs.org/";
      isolatedEnvironment.npm_config_cache = join(root, "cold-npm-cache");
      isolatedEnvironment.npm_config_userconfig = join(root, "anonymous.npmrc");
      for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete isolatedEnvironment[name];
      const releaseDirectory = resolve(process.env.MUHA_RELEASE_DIRECTORY);
      const release = JSON.parse(await readFile(join(releaseDirectory, "release.json"), "utf8"));
      assert.equal(release.packages.length, 6, "release must contain exactly six Muha SDK packages");
      assert.equal(new Set(release.packages.map(item => item.version)).size, 1);
      tarballs = [];
      for (const item of release.packages) {
        assert.match(item.filename, /^[a-z0-9.-]+\.tgz$/);
        const archive = join(releaseDirectory, item.filename);
        const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
        assert.equal(sha256, item.sha256, `${item.filename} differs from release.json`);
        tarballs.push(archive);
      }
      const checksums = await readFile(join(releaseDirectory, "SHA256SUMS"), "utf8");
      assert.equal(checksums, `${release.packages.map(item => `${item.sha256}  ${item.filename}`).sort().join("\n")}\n`);
    } else {
      for (const packageDirectory of [
        "core", "codex-adapter", "opencode-adapter", "kimi-adapter", "pi-adapter", "agy-adapter",
      ]) {
        run("npm", ["pack", "--pack-destination", artifacts], {
          cwd: join(repositoryRoot, "packages", packageDirectory), env: isolatedEnvironment,
        });
      }
      for (const [index, dependencyDirectory] of (
        await runtimeDependencyDirectories(["core", "opencode-adapter"])
      ).entries()) {
        const stagingDirectory = join(dependencyStaging, String(index));
        await cp(dependencyDirectory, stagingDirectory, { recursive: true });
        const packageJsonPath = join(stagingDirectory, "package.json");
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
        delete packageJson.scripts;
        delete packageJson.devEngines;
        delete packageJson.packageManager;
        await writeFile(packageJsonPath, JSON.stringify(packageJson));
        run("npm", ["pack", "--pack-destination", artifacts], {
          cwd: stagingDirectory, env: isolatedEnvironment,
        });
      }
      tarballs = (await readdir(artifacts))
        .filter((entry) => entry.endsWith(".tgz"))
        .map((entry) => join(artifacts, entry));
    }
    assert.equal(
      tarballs.filter((path) => {
        const name = basename(path);
        return path.startsWith("@muha-sdk/") || name.startsWith("muha-sdk-") || name.startsWith("muha-orchestrator-");
      }).length,
      6,
    );
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module", ...(registryVersion || process.env.MUHA_RELEASE_DIRECTORY ? { allowScripts: reviewedInstallScripts } : {}) }),
    );
    try { run(
      "npm", [
        "install",
        registryVersion ? "--prefer-online" : "--prefer-offline",
        ...(registryVersion ? ["--save-exact"] : ["--no-package-lock"]),
        ...tarballs,
      ],
      { cwd: consumer, env: isolatedEnvironment },
    ); } catch (error) {
      throw new Error(`Isolated npm install blocked (Node ${process.version}, ${process.platform}/${process.arch}, ` +
        `cache ${isolatedEnvironment.npm_config_cache ?? "npm default"}, registry configured: ${Boolean(process.env.npm_config_registry)}): ` +
        error.message, { cause: error });
    }
    if (registryVersion) await verifyRegistryLockAndReinstall(consumer, isolatedEnvironment, ["@muha-sdk/core", ...adapters.map(([, name]) => name)]);
    const installedCorePaths = run("npm", ["ls", "@muha-sdk/core", "--all", "--parseable"], {
      cwd: consumer, env: isolatedEnvironment,
    }).trim().split(/\r?\n/).filter(Boolean);
    assert.deepEqual(installedCorePaths, [join(consumer, "node_modules", "@muha-sdk", "core")],
      "all Muha packages must resolve to the single top-level Core installation");

    await writeFile(
      join(consumer, "esm.mjs"),
      [
        'import "@muha-sdk/core";',
        'import { codexAdapter } from "@muha-sdk/codex-adapter";',
        'import { kimiAdapter } from "@muha-sdk/kimi-adapter";',
        'import { openCodeAdapter } from "@muha-sdk/opencode-adapter";',
        'import { piAdapter } from "@muha-sdk/pi-adapter";',
        'import { agyAdapter } from "@muha-sdk/agy-adapter";',
        'if (typeof codexAdapter() !== "object") throw new Error("missing codex registration");',
        'if (typeof kimiAdapter() !== "object") throw new Error("missing kimi registration");',
        'if (typeof openCodeAdapter() !== "object") throw new Error("missing opencode registration");',
        'if (typeof piAdapter() !== "object") throw new Error("missing pi registration");',
        'if (typeof agyAdapter() !== "object") throw new Error("missing agy registration");',
      ].join("\n"),
    );
    run(process.execPath, ["esm.mjs"], { cwd: consumer });

    await verifyInstalledPi(consumer, isolatedEnvironment);
    await verifyInstalledWorkspace(consumer, isolatedEnvironment, ["codex", "opencode", "kimi"]);

    const installed = await readdir(join(consumer, "node_modules", "@muha-sdk"));
    assert.deepEqual(
      installed.sort(),
      ["codex-adapter", "core", "kimi-adapter", "opencode-adapter", "pi-adapter", "agy-adapter"].sort(),
    );
    assert.equal((await readdir(join(consumer, "node_modules"))).includes("muha-orchestrator"), false);
    for (const packageName of ["core", "codex-adapter", "opencode-adapter", "kimi-adapter", "pi-adapter", "agy-adapter"]) {
      assert.equal((await lstat(join(consumer, "node_modules", "@muha-sdk", packageName))).isSymbolicLink(), false,
        `${packageName} must not link back to the source workspace`);
    }
    await verifyAgyInstalledRuntime(consumer, root, isolatedEnvironment);

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function verifyConsumerInstall(adapterDirectory, adapterPackage, factory) {
  const root = await mkdtemp(join(tmpdir(), "muha-package-contract-"));
  const artifacts = join(root, "artifacts");
  const consumer = join(root, "consumer");
  const dependencyStaging = join(root, "dependency-staging");
  const isolatedEnvironment = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_cache: join(root, "npm-cache"),
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };

  try {
    await Promise.all([mkdir(artifacts), mkdir(consumer), mkdir(dependencyStaging)]);
    let tarballs;
    if (registryVersion) {
      isolatedEnvironment.npm_config_registry = "https://registry.npmjs.org/";
      isolatedEnvironment.npm_config_userconfig = join(root, "anonymous.npmrc");
      tarballs = [`@muha-sdk/core@${registryVersion}`, `${adapterPackage}@${registryVersion}`];
    } else {
      for (const packageDirectory of ["core", adapterDirectory]) {
        run(
          "npm",
          ["pack", "--pack-destination", artifacts],
          {
            cwd: join(repositoryRoot, "packages", packageDirectory),
            env: isolatedEnvironment,
          },
        );
      }
      for (const [index, dependencyDirectory] of (
        adapterDirectory === "pi-adapter" ? [] : await runtimeDependencyDirectories(["core", adapterDirectory])
      ).entries()) {
        const stagingDirectory = join(dependencyStaging, String(index));
        await cp(dependencyDirectory, stagingDirectory, { recursive: true });
        const packageJsonPath = join(stagingDirectory, "package.json");
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
        delete packageJson.scripts;
        delete packageJson.devEngines;
        delete packageJson.packageManager;
        await writeFile(packageJsonPath, JSON.stringify(packageJson));
        run("npm", ["pack", "--pack-destination", artifacts], {
          cwd: stagingDirectory,
          env: isolatedEnvironment,
        });
      }

      tarballs = (await readdir(artifacts))
        .filter((entry) => entry.endsWith(".tgz"))
        .map((entry) => join(artifacts, entry));
      assert.equal(
        tarballs.filter((path) => path.includes("muha-sdk-")).length,
        2,
      );
    }
    if (!registryVersion && adapterDirectory === "opencode-adapter") {
      const adapterTarball = tarballs.find((path) => basename(path).startsWith("muha-sdk-opencode-adapter-"));
      assert.ok(adapterTarball);
      const entries = run("tar", ["-tzf", adapterTarball]).trim().split("\n");
      assert.equal(entries.some((entry) => entry.includes("node_modules/") || entry.includes("@opencode/client")), false,
        "the official client must remain an ordinary npm dependency, not bundled Muha content");
    }

    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module", ...(registryVersion || process.env.MUHA_RELEASE_DIRECTORY ? { allowScripts: reviewedInstallScripts } : {}) }),
    );
    run(
      "npm",
      [
        "install",
        registryVersion ? "--prefer-online" : adapterDirectory === "pi-adapter" ? "--prefer-offline" : "--offline",
        ...(registryVersion ? [] : ["--ignore-scripts"]),
        ...(registryVersion ? ["--save-exact"] : ["--no-package-lock"]),
        ...tarballs,
      ],
      { cwd: consumer, env: isolatedEnvironment },
    );

    if (registryVersion) await verifyRegistryLockAndReinstall(consumer, isolatedEnvironment, ["@muha-sdk/core", adapterPackage]);
    await writeFile(
      join(consumer, "esm.mjs"),
      [
        'import "@muha-sdk/core";',
        `import { ${factory} } from "${adapterPackage}";`,
        `assertRegistration(${factory}());`,
        "function assertRegistration(value) {",
        '  if (value === null || typeof value !== "object") throw new Error("missing registration");',
        "}",
      ].join("\n"),
    );
    run(process.execPath, ["esm.mjs"], { cwd: consumer });
    if (adapterDirectory === "opencode-adapter") {
      const clientTree = JSON.parse(run("npm", ["ls", "@opencode/client", "--all", "--json"], {
        cwd: consumer, env: isolatedEnvironment,
      }));
      assert.equal(clientTree.dependencies["@muha-sdk/opencode-adapter"]
        .dependencies["@opencode/client"].version, "2.0.11");
    }

    await writeFile(
      join(consumer, "commonjs.cjs"),
      [
        'require("@muha-sdk/core");',
        `const { ${factory} } = require("${adapterPackage}");`,
        `if (typeof ${factory} !== "function") throw new Error("require failed");`,
        'import("@muha-sdk/core").then(() => undefined);',
      ].join("\n"),
    );
    run(process.execPath, ["commonjs.cjs"], { cwd: consumer });

    if (adapterDirectory === "agy-adapter") await verifyAgyInstalledRuntime(consumer, root, isolatedEnvironment);

    const installed = await readdir(join(consumer, "node_modules", "@muha-sdk"));
    assert.deepEqual(installed.sort(), [adapterDirectory, "core"].sort());
    await verifySelectedPackageContracts(consumer, root, isolatedEnvironment, adapterDirectory, adapterPackage, factory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyAgyInstalledRuntime(consumer, root, isolatedEnvironment) {
  await writeFile(join(consumer, "agy-consumer.mjs"), [
    'import assert from "node:assert/strict";',
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'import { createMuhaRuntime } from "@muha-sdk/core";',
    'import { agyAdapter } from "@muha-sdk/agy-adapter";',
    'const workspacePath = join(process.cwd(), "workspace-" + "x".repeat(140));',
    'await mkdir(workspacePath);',
    'await writeFile(join(workspacePath, "source.txt"), "packed helper works");',
    'let runtime = await createMuhaRuntime({ dataDir: join(process.cwd(), "data-one"), harnesses: [agyAdapter()] });',
    'let reference;',
    'try {',
    '  const session = await runtime.createSession({ harness: "agy", workspacePath, approvalPolicy: "harnessManaged" });',
    '  reference = structuredClone(session.reference);',
    '  const result = await (await session.startTurn([{ type: "text", text: "Read workspace." }])).result;',
    '  assert.equal(result.status, "completed");',
    '  assert.equal(result.message.text, "packed helper works");',
    '} finally { await runtime.close(); }',
    'runtime = await createMuhaRuntime({ dataDir: join(process.cwd(), "data-two"), harnesses: [agyAdapter()] });',
    'try {',
    '  const session = await runtime.resumeSession({ reference, approvalPolicy: "harnessManaged" });',
    '  assert.deepEqual(session.reference, reference);',
    '  const result = await (await session.startTurn([{ type: "text", text: "Recall my previous input." }])).result;',
    '  assert.equal(result.status, "completed");',
    '  assert.equal(result.message.text, "Read workspace.");',
    '} finally { await runtime.close(); }',
  ].join("\n"));
  run(process.execPath, ["agy-consumer.mjs"], {
    cwd: consumer,
    env: { ...isolatedEnvironment, HOME: join(root, "native-home"),
      PATH: `${join(repositoryRoot, "test/fixtures/harness-bin")}:${dirname(process.execPath)}` },
  });
  await writeFile(join(consumer, "agy-types.ts"), [
    'import { createMuhaRuntime, type HarnessKind } from "@muha-sdk/core";',
    'import { agyAdapter } from "@muha-sdk/agy-adapter";',
    'const harness: HarnessKind = "agy";',
    'void createMuhaRuntime({ harnesses: [agyAdapter({ env: { EXAMPLE: undefined } })] });',
    'void harness;',
  ].join("\n"));
  run(join(repositoryRoot, "node_modules/.bin/tsc"), ["--noEmit", "--strict", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "agy-types.ts"], { cwd: consumer });
}

async function verifySelectedPackageContracts(consumer, root, env, directory, packageName, factory) {
  for (const name of ["core", directory]) {
    assert.equal((await lstat(join(consumer, "node_modules/@muha-sdk", name))).isSymbolicLink(), false);
  }
  const cores = run("npm", ["ls", "@muha-sdk/core", "--all", "--parseable"], { cwd: consumer, env })
    .trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(cores, [join(consumer, "node_modules/@muha-sdk/core")]);
  await writeFile(join(consumer, "types.ts"), [
    'import { createMuhaRuntime, type SessionReference, type TurnResult } from "@muha-sdk/core";',
    `import { ${factory} } from "${packageName}";`,
    `void createMuhaRuntime({ harnesses: [${factory}()] });`,
    'declare const reference: SessionReference; declare const result: TurnResult;',
    'void reference.route; void result.status;',
  ].join("\n"));
  run(join(repositoryRoot, "node_modules/.bin/tsc"), ["--noEmit", "--strict", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "types.ts"], { cwd: consumer, env });
  if (["codex-adapter", "opencode-adapter", "kimi-adapter"].includes(directory)) {
    const harness = directory.replace("-adapter", "");
    await verifyInstalledWorkspace(consumer, env, [harness]);
    if (harness !== "opencode") {
      await writeFile(join(consumer, "native-turn.mjs"), [
        'import assert from "node:assert/strict";',
        'import { mkdir } from "node:fs/promises";',
        'import { join, dirname, delimiter } from "node:path";',
        'import { createMuhaRuntime } from "@muha-sdk/core";',
        `import { ${factory} } from "${packageName}";`,
        'const workspacePath = join(process.cwd(), "native-turn"); await mkdir(workspacePath);',
        `const runtime = await createMuhaRuntime({ harnesses: [${factory}({ env: {`,
        'PATH: [join(process.cwd(), "harness-bin"), dirname(process.execPath)].join(delimiter),',
        'MUHA_FAKE_NATIVE_SESSIONS_FILE: join(process.cwd(), "native-sessions.json"),',
        `}})], dataDir: join(process.cwd(), "native-turn-data") });`,
        'try {',
        `  const session = await runtime.createSession({ harness: "${harness}", workspacePath });`,
        '  const turn = await session.startTurn([{ type: "text", text: "Installed fixture" }]);',
        '  for await (const event of turn) {}',
        '  assert.equal((await turn.result).status, "completed");',
        '  const reference = session.reference; await session.close();',
        '  const resumed = await runtime.resumeSession({ reference });',
        '  assert.deepEqual(resumed.reference, reference);',
        '} finally { await runtime.close(); }',
      ].join("\n"));
      run(process.execPath, ["native-turn.mjs"], { cwd: consumer, env });
    }
  }
  if (directory === "pi-adapter") {
    await verifyInstalledPi(consumer, env);
    const installed = join(consumer, "node_modules/@muha-sdk/pi-adapter");
    const sdkSource = join(consumer, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
    const before = createHash("sha256").update(await readFile(sdkSource)).digest("hex");
    const patch = JSON.parse(await readFile(join(installed, "dist/sdk-patch.json"), "utf8"));
    assert.equal(before, patch.originalSha256);
    assert.equal(createHash("sha256").update(await readFile(join(installed, "dist/ordered-agent-session.mjs"))).digest("hex"), patch.patchedSha256);
    await cp(join(repositoryRoot, "packages/pi-adapter/test/support"), join(installed, "test/support"), { recursive: true });
    const contracts = ["text-turn", "image-input", "session", "selection", "lifecycle", "retry", "extensions", "rich-turn", "skills", "failures"];
    for (const name of contracts) await cp(join(repositoryRoot, `packages/pi-adapter/test/${name}.test.mjs`),
      join(installed, `test/${name}.test.mjs`));
    run(process.execPath, ["--test", ...contracts.map(name => join(installed, `test/${name}.test.mjs`))],
      { cwd: consumer, env });
    assert.equal(createHash("sha256").update(await readFile(sdkSource)).digest("hex"), before,
      "installed SDK source must remain unchanged after controlled lifecycle and ordering contracts");
  }
}

async function runtimeDependencyDirectories(packageDirectories) {
  const directories = [];
  const visited = new Set();
  async function visit(name, parentDirectory, optional = false) {
    if (name.startsWith("@muha-sdk/")) return;
    let packageDirectory;
    try {
      packageDirectory = await resolvePackageDirectory(name, parentDirectory);
    } catch (error) {
      if (optional && error?.code === "MODULE_NOT_FOUND") return;
      throw error;
    }
    if (visited.has(packageDirectory)) return;
    visited.add(packageDirectory);
    const packageJsonPath = join(packageDirectory, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    directories.push(packageDirectory);
    for (const dependency of Object.keys(packageJson.dependencies ?? {}).sort()) {
      await visit(dependency, packageDirectory);
    }
    for (const dependency of Object.keys(packageJson.optionalDependencies ?? {}).sort()) {
      await visit(dependency, packageDirectory, true);
    }
  }
  for (const packageDirectory of packageDirectories) {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "packages", packageDirectory, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      await visit(dependency, join(repositoryRoot, "packages", packageDirectory));
    }
  }
  return directories;
}

async function resolvePackageDirectory(name, parentDirectory) {
  let directory = parentDirectory;
  while (directory !== dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    try {
      const packageJson = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
      if (packageJson.name === name) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  const error = new Error(`Could not locate package root for ${name}`);
  error.code = "MODULE_NOT_FOUND";
  throw error;
}

async function verifyInstalledPi(consumer, isolatedEnvironment) {
    const resolvedPi = JSON.parse(run(
      "npm",
      ["ls", "@earendil-works/pi-coding-agent", "--depth=1", "--json"],
      { cwd: consumer, env: isolatedEnvironment },
    ));
    assert.equal(
      resolvedPi.dependencies["@muha-sdk/pi-adapter"]
        .dependencies["@earendil-works/pi-coding-agent"].version,
      "1.0.4",
    );
    await writeFile(join(consumer, "pi-session-consumer.mjs"), [
      'import assert from "node:assert/strict";',
      'import { createServer } from "node:http";',
      'import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      'import { createMuhaRuntime } from "@muha-sdk/core";',
      'import { piAdapter } from "@muha-sdk/pi-adapter";',
      controlledPi.toString(),
      'let cleanup;',
      'const pi = await controlledPi({ after(fn) { cleanup = fn; } });',
      'const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";',
      'try {',
      '  const runtime = await pi.runtime();',
      '  const session = await runtime.createSession({ harness: "pi", workspacePath: pi.workspace,',
      '    model: "controlled/controlled", approvalPolicy: "autoApprove" });',
      '  const turn = await session.startTurn([{ type: "image", source: { type: "base64",',
      '    mediaType: "image/png", data: image } }, { type: "text", text: "Describe this image" }]);',
      '  for await (const event of turn) {}',
      '  assert.equal((await turn.result).status, "completed");',
      '  assert.deepEqual(pi.requests[0].messages.find(message => message.role === "user").content',
      '    .map(part => part.type), ["image_url", "text"]);',
      '  const reference = session.reference;',
      '  const resumedRuntime = await pi.runtime();',
      '  const resumed = await resumedRuntime.resumeSession({ reference, approvalPolicy: "autoApprove" });',
      '  const next = await resumed.startTurn([{ type: "text", text: "Continue" }]);',
      '  for await (const event of next) {}',
      '  assert.equal((await next.result).status, "completed");',
      '} finally { await cleanup(); }',
    ].join("\n"));
    run(process.execPath, ["pi-session-consumer.mjs"], {
      cwd: consumer,
      env: isolatedEnvironment,
    });

}

async function verifyInstalledWorkspace(consumer, isolatedEnvironment, harnesses) {
    await cp(
      join(repositoryRoot, "test", "fixtures", "harness-bin"),
      join(consumer, "harness-bin"),
      { recursive: true },
    );
    await cp(
      join(repositoryRoot, "test", "fixtures", "v2-harness-bin", "opencode"),
      join(consumer, "harness-bin", "opencode"),
    );
    await writeFile(
      join(consumer, "workspace-consumer.mjs"),
      [
        'import { access, mkdir, readFile, writeFile } from "node:fs/promises";',
        'import { delimiter, dirname, join } from "node:path";',
        ...(harnesses.includes("codex") ? ['import { codexAdapter } from "@muha-sdk/codex-adapter";'] : []),
        'import { createMuhaRuntime } from "@muha-sdk/core";',
        ...(harnesses.includes("kimi") ? ['import { kimiAdapter } from "@muha-sdk/kimi-adapter";'] : []),
        ...(harnesses.includes("opencode") ? ['import { openCodeAdapter } from "@muha-sdk/opencode-adapter";'] : []),
        `const factories = { ${harnesses.map(harness => `${harness}: ${ {codex:"codexAdapter", opencode:"openCodeAdapter", kimi:"kimiAdapter"}[harness] }`).join(", ")} };`,
        'const root = process.cwd();',
        'const controlledPath = [join(root, "harness-bin"), dirname(process.execPath)].join(delimiter);',
        `for (const harness of ${JSON.stringify(harnesses)}) {`,
        '  const workspacePath = join(root, `workspace-${harness}`);',
        '  const skillPath = join(workspacePath, "skill-source", "packed-skill");',
        '  await mkdir(skillPath, { recursive: true });',
        '  await writeFile(join(skillPath, "SKILL.md"), "---\\nname: packed-skill\\ndescription: packed fixture\\n---\\n");',
        '  const runtime = await createMuhaRuntime({',
        '    harnesses: [factories[harness]({',
        '      env: { PATH: controlledPath },',
        '      startupTimeoutMs: 2_000,',
        '      shutdownTimeoutMs: 2_000,',
        '    })],',
        '    dataDir: join(root, `diagnostics-${harness}`),',
        '  });',
        '  try {',
        '    const result = await runtime.configureWorkspace({',
        '      workspacePath,',
        '      skills: [{ source: "./skill-source", skillNames: ["packed-skill"] }],',
        '      mcpServers: [{',
        '        name: "packed-mcp",',
        '        transport: "stdio",',
        '        command: "packed-command",',
        '        env: { MUHA_MCP_PAYLOAD_ONLY: "preserved" },',
        '      }],',
        '    });',
        '    if (result.attempts.length !== 2 || result.attempts.some(({ status }) => status !== "succeeded")) {',
        '      throw new Error(`${harness} packed Workspace configuration failed: ${JSON.stringify(result)}`);',
        '    }',
        '    await access(join(workspacePath, ".agents", "skills", "packed-skill", "SKILL.md"));',
        '    const nativePath = harness === "codex"',
        '      ? join(workspacePath, ".codex", "config.toml")',
        '      : harness === "opencode"',
        '        ? join(workspacePath, "opencode.jsonc")',
        '        : join(workspacePath, ".kimi-code", "mcp.json");',
        '    const native = await readFile(nativePath, "utf8");',
        '    if (!native.includes("packed-mcp") || !native.includes("MUHA_MCP_PAYLOAD_ONLY")) {',
        '      throw new Error(`${harness} packed MCP output is incomplete`);',
        '    }',
        '    const failed = await runtime.configureWorkspace({',
        '      workspacePath,',
        '      skills: [{ source: "./missing-packed-skill" }],',
        '    });',
        '    const [failure] = failed.attempts;',
        '    if (failure?.status !== "failed" || failure.error?.code !== "SKILL_CONFIGURATION_FAILED" ||',
        '        failure.error?.message !== "Skills CLI failed to configure the Workspace") {',
        '      throw new Error(`${harness} packed failure shape changed: ${JSON.stringify(failed)}`);',
        '    }',
        '  } finally {',
        '    await runtime.close();',
        '  }',
        '}',
      ].join("\n"),
    );
    run(process.execPath, ["workspace-consumer.mjs"], {
      cwd: consumer,
      env: isolatedEnvironment,
    });

    if (!harnesses.includes("opencode")) return;
    await writeFile(join(consumer, "opencode-v2-consumer.mjs"), [
      'import assert from "node:assert/strict";',
      'import { mkdir } from "node:fs/promises";',
      'import { delimiter, dirname, join } from "node:path";',
      'import { createMuhaRuntime } from "@muha-sdk/core";',
      'import { openCodeAdapter } from "@muha-sdk/opencode-adapter";',
      'const root = process.cwd();',
      'const workspacePath = join(root, "v2-turn-workspace");',
      'await mkdir(workspacePath);',
      'const runtime = await createMuhaRuntime({',
      '  harnesses: [openCodeAdapter({ env: {',
      '    PATH: [join(root, "harness-bin"), dirname(process.execPath)].join(delimiter),',
      '  } })], dataDir: join(root, "v2-turn-diagnostics"),',
      '});',
      'let session;',
      'let resumed;',
      'try {',
      '  session = await runtime.createSession({ harness: "opencode", workspacePath,',
      '    model: "opencode-go/deepseek-v4.1-flash", effort: "high" });',
      '  const first = await session.startTurn([{ type: "text", text: "installed" }]);',
      '  assert.equal((await first.result).message.text, "OpenCode v2: installed");',
      '  resumed = await runtime.resumeSession({ reference: session.reference });',
      '  assert.deepEqual(resumed.reference, session.reference);',
      '  const second = await resumed.startTurn([{ type: "text", text: "resumed" }]);',
      '  assert.equal((await second.result).message.text, "OpenCode v2: resumed");',
      '  const image = await resumed.startTurn([{ type: "image", source: { type: "base64",',
      '    mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } }]);',
      '  assert.equal((await image.result).status, "completed");',
      '} finally { await resumed?.close(); await session?.close(); await runtime.close(); }',
    ].join("\n"));
    run(process.execPath, ["opencode-v2-consumer.mjs"], {
      cwd: consumer,
      env: isolatedEnvironment,
    });
}


async function verifyRegistryLockAndReinstall(consumer, env, names) {
  const candidateDirectory = resolve(process.env.MUHA_REGISTRY_CANDIDATE ?? "");
  assert.ok(process.env.MUHA_REGISTRY_CANDIDATE, "Reviewed candidate is required for Registry acceptance");
  const candidate = JSON.parse(await readFile(join(candidateDirectory, "release.json"), "utf8"));
  assert.equal(candidate.candidate, true);
  const lockBytes = await readFile(join(consumer, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  for (const name of names) {
    const installed = lock.packages[`node_modules/${name}`];
    const reviewed = candidate.packages.find(item => item.name === name);
    assert.equal(installed.version, registryVersion);
    assert.equal(installed.integrity, reviewed.integrity, `${name}: public Registry bytes differ from reviewed artifact`);
    assert.ok(installed.resolved.startsWith("https://registry.npmjs.org/"), `${name}: installation must resolve from the public Registry`);
    assert.equal(installed.link, undefined);
    for (const resource of reviewed.resources) {
      const absolute = join(consumer, "node_modules", name, resource.path);
      assert.equal(createHash("sha256").update(await readFile(absolute)).digest("hex"), resource.sha256);
      if (resource.mode & 0o111) assert.ok((await lstat(absolute)).mode & 0o111);
    }
  }
  assert.equal(lock.packages[""].overrides, undefined);
  run("npm", ["ls", "--all"], { cwd: consumer, env });
  await rm(join(consumer, "node_modules"), { recursive: true });
  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: consumer, env });
  assert.deepEqual(await readFile(join(consumer, "package-lock.json")), lockBytes, "npm ci must preserve the consumer lockfile");
}

if (registryVersion) test("Core alone installs from the public Registry and replays its exact lockfile", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-registry-core-"));
  const env = { ...process.env, npm_config_registry: "https://registry.npmjs.org/",
    npm_config_cache: join(root, "cold-npm-cache"), npm_config_userconfig: join(root, "anonymous.npmrc") };
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module", ...(registryVersion || process.env.MUHA_RELEASE_DIRECTORY ? { allowScripts: reviewedInstallScripts } : {}) }));
    run("npm", ["install", "--save-exact", "--no-audit", "--no-fund", `@muha-sdk/core@${registryVersion}`], { cwd: root, env });
    await verifyRegistryLockAndReinstall(root, env, ["@muha-sdk/core"]);
    run(process.execPath, ["--input-type=module", "-e", "import {createMuhaRuntime} from '@muha-sdk/core'; if(typeof createMuhaRuntime!=='function')throw new Error('Core ESM entry missing');"], { cwd: root });
    await writeFile(join(root, "consumer.mts"), "import {createMuhaRuntime,type SessionReference} from '@muha-sdk/core';const create:typeof createMuhaRuntime=createMuhaRuntime;let reference:SessionReference;\n");
    run(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.mts"], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});
