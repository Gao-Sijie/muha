import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Bounded native TUI research only. Choose /permissions -> Project explicitly.
// Ctrl-] stops the owned helper. Never send a model prompt in this setup step.
assert.ok(process.stdin.isTTY, "Run this manual research setup in a terminal");
const exec = promisify(execFile);
const base = resolve(".scratch/agy-native-qualification");
await mkdir(base, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(base, "muha-agy-permissions-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const source = fileURLToPath(new URL("./", import.meta.url));
const helper = join(root, "supervisor");
const baseline = await fingerprints();
const report = { root, workspace, model: "claude-opus-4-6-thinking", controls: [], inputs: [] };
await exec("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-s", "-Wl,--wrap=__libc_start_main", "-o", helper,
  join(source, "supervisor.c"), join(source, "glibc-startup-compat.c")], { timeout: 10000 });
report.version = (await exec("agy", ["--version"], { timeout: 10000 })).stdout.trim();
await writeFile(join(root, "setup.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ root, workspace, stopKey: "Ctrl-]" })}\n`);
const args = ["agy", "--model", report.model, "--new-project", "--add-dir", workspace, "--log-file", join(root, "native-tui.log")];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const terminalCommand = `stty columns 120 rows 40; exec ${args.map(quote).join(" ")}`;
const child = spawn(helper, ["1000", "script", "-q", "-e", "-f", "-c", terminalCommand, "/dev/null"],
  { cwd: workspace, env: { ...process.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe", "pipe"] });
const control = child.stdio[3];
let controls = "", terminal = "", stderr = "";
child.stdin.on("error", () => {});
control.on("error", () => {});
control.setEncoding("utf8");
control.on("data", data => {
  controls += data;
  for (;;) {
    const index = controls.indexOf("\n"); if (index < 0) break;
    const event = JSON.parse(controls.slice(0, index)); controls = controls.slice(index + 1);
    report.controls.push(event);
    if (event.type === "ready") control.write("go\n");
  }
});
child.stdout.on("data", data => { terminal += data.toString(); process.stdout.write(data); });
child.stderr.on("data", data => { stderr += data.toString(); process.stderr.write(data); });
const input = data => {
  report.inputs.push(data.toString());
  if (data.includes(0x1d)) control.write("close\n");
  else child.stdin.write(data);
};
process.stdin.setRawMode(true);
process.stdin.on("data", input);
const timer = setTimeout(() => { report.externalGuardTriggered = true; control.write("close\n"); }, 120000);
try {
  report.helperExit = await new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal })));
} finally {
  clearTimeout(timer);
  process.stdin.off("data", input);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  const after = await fingerprints();
  report.existingConfigurationChanged = [...baseline].filter(([path, hash]) => after.get(path) !== hash).map(([path]) => path);
  report.newProjectFiles = [...after.keys()].filter(path => !baseline.has(path) && path.includes("/projects/"));
  await Promise.all([
    writeFile(join(root, "setup.json"), JSON.stringify(report, null, 2), { mode: 0o600 }),
    writeFile(join(root, "terminal.txt"), terminal, { mode: 0o600 }),
    writeFile(join(root, "stderr.txt"), stderr, { mode: 0o600 })
  ]);
  process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
}
async function fingerprints() {
  const projects = join(homedir(), ".gemini/config/projects");
  const paths = [join(homedir(), ".gemini/antigravity-cli/settings.json"), join(homedir(), ".gemini/config/permissions.json"),
    join(homedir(), ".gemini/config/settings.json"), join(homedir(), ".gemini/config/config.json"),
    ...(await readdir(projects)).filter(name => name.endsWith(".json")).map(name => join(projects, name))];
  return new Map(await Promise.all(paths.map(async path => [path, await readFile(path)
    .then(bytes => createHash("sha256").update(bytes).digest("hex"), error => { if (error.code === "ENOENT") return null; throw error; })])));
}
