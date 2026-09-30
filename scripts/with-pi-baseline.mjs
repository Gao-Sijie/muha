import { execFile } from "node:child_process";
import { access, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Qualification-only environment: native authentication/model configuration,
// but no globally installed extensions or packages. The Adapter itself never
// filters native extensions. The temporary credential links are always removed.
const [mode, model] = process.argv.slice(2);
if (!["qualify", "lifecycle"].includes(mode) || !model?.includes("/")) {
  throw new Error("Usage: with-pi-baseline.mjs <qualify|lifecycle> <provider/model>");
}
const root = await mkdtemp(join(tmpdir(), "muha-pi-no-extensions-"));
const nativeAgentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
try {
  for (const name of ["auth.json", "models.json"]) {
    try { await access(join(nativeAgentDir, name)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await symlink(join(nativeAgentDir, name), join(root, name));
  }
  await writeFile(join(root, "settings.json"), JSON.stringify({
    packages: [], extensions: [], compaction: { enabled: false }, retry: { enabled: false },
  }), { mode: 0o600 });
  const args = mode === "qualify"
    ? [new URL("qualify-real-harness.mjs", import.meta.url).pathname, "pi"]
    : [new URL("qualify-pi-lifecycle.mjs", import.meta.url).pathname];
  const { stdout, stderr } = await promisify(execFile)(process.execPath, args, {
    env: { ...process.env, PI_CODING_AGENT_DIR: root, MUHA_QUALIFY_PI_MODEL: model },
    timeout: mode === "qualify" ? 600000 : 0, maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} catch (error) {
  // Do not render execFile's Error (it embeds command arguments and output).
  process.stderr.write(error.stderr ?? "Pi baseline child failed\n");
  process.stdout.write(error.stdout ?? "");
  process.exitCode = 1;
} finally {
  if (process.env.MUHA_PI_BASELINE_RETAIN === "1") {
    // Never retain authentication/model configuration links or SDK auth writes.
    for (const name of ["auth.json", "models.json"]) {
      try { await unlink(join(root, name)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    process.stderr.write(`Native Pi qualification history retained at ${root}\n`);
  } else await rm(root, { recursive: true, force: true });
}
