#!/usr/bin/env node
// Deterministic compiler boundary: expose a partial output until the test lets
// the real compiler finish. The public build must not publish that output yet.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
const barrier = process.env.MUHA_BUILD_BARRIER;
await writeFile(output, "unfinished executable", { mode: 0o600 });
await chmod(output, 0o600);
await writeFile(join(barrier, "started"), "ready");
while (await readFile(join(barrier, "release")).then(() => false, () => true)) await delay(5);
const child = spawn("cc", args, { stdio: "inherit" });
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
