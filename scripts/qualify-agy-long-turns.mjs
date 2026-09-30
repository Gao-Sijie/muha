import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agyAdapter } from "@muha-sdk/agy-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const base = resolve(".scratch/agy-native-qualification");
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, "long-turns-"));
const nativeLimitSeconds = 3_600;
const externalGuardSeconds = 3_780;
console.log(JSON.stringify({ evidence: root, nativeLimitSeconds, externalGuardSeconds }));
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
async function run(seconds, timeout) {
  const directory = join(root, String(seconds));
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const marker = `MUHA_AGY_LONG_${seconds}`;
  const artifact = join(workspacePath, "completed.txt");
  const command = `python3 -c ${quote(`import time; from pathlib import Path; time.sleep(${seconds}); Path(${JSON.stringify(artifact)}).write_text(${JSON.stringify(marker)})`)}`;
  const report = { seconds, expectsTimeout: timeout, model: "claude-opus-4-6-thinking", checks: [], failures: [], externalGuardTriggered: false };
  let runtime, guard;
  try {
    report.version = execFileSync("agy", ["--version"], { encoding: "utf8" }).trim();
    runtime = await createMuhaRuntime({ dataDir: join(directory, "diagnostics"), harnesses: [agyAdapter({ shutdownTimeoutMs: 10_000 })] });
    const session = await runtime.createSession({ harness: "agy", workspacePath, model: report.model, approvalPolicy: "autoApprove" });
    report.reference = session.reference;
    const start = Date.now();
    const work = (async () => {
      const turn = await session.startTurn([{ type: "text", text:
        `Run this exact command and wait for it to finish: ${command}\nDo not change or shorten the sleep. Do not finish your answer until the command has completed and you have read ${artifact}. Then report the file's marker. Use only this temporary Workspace.` }]);
      for await (const _event of turn) { /* Drain the public backlog throughout the native wait. */ }
      const result = await turn.result;
      report.elapsedMs = Date.now() - start;
      report.result = result;
      if (timeout) {
        assert.equal(result.status, "failed");
        assert.equal(result.error.code, "HARNESS_ERROR");
        assert.equal(result.error.nativeCode, "timeout");
        assert.ok(report.elapsedMs >= (nativeLimitSeconds - 10) * 1_000, "must reach the native bound, not an early failure");
        await assert.rejects(access(artifact), error => error.code === "ENOENT");
        report.checks.push("native 60 minute timeout becomes failure and stops unfinished work");
      } else {
        assert.equal(result.status, "completed");
        assert.equal(await readFile(artifact, "utf8"), marker);
        assert.ok(report.elapsedMs >= seconds * 1_000, "must complete the requested real wait");
        report.checks.push(`real tool work waits ${seconds} seconds and completes`);
      }
    })();
    await Promise.race([work, new Promise((_, reject) => {
      guard = setTimeout(() => { report.externalGuardTriggered = true; reject(new Error("external qualification guard expired")); }, externalGuardSeconds * 1_000);
    })]);
  } catch (error) { report.failures.push(error?.data ?? { message: String(error) }); }
  finally {
    clearTimeout(guard);
    try { await runtime?.close(); } catch (error) { report.failures.push(error?.data ?? { message: String(error) }); }
    await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  }
  return report;
}
const durations = process.argv[2] === undefined ? [660, 3_660] : [Number(process.argv[2])];
if (durations.some(seconds => ![315, 660, 3_660].includes(seconds))) {
  throw new Error("Usage: qualify-agy-long-turns.mjs [315|660|3660]");
}
const cases = durations.map(seconds => [seconds, seconds > nativeLimitSeconds]);
const reports = [];
// Core permits one live Runtime per process. Run separate script processes
// when qualifying both durations concurrently.
for (const [seconds, timeout] of cases) reports.push(await run(seconds, timeout));
await writeFile(join(root, "report.json"), `${JSON.stringify(reports, null, 2)}\n`);
if (reports.some(report => report.failures.length)) process.exitCode = 1;
