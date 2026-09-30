import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { controlledPi } from "./support/controlled-pi.mjs";

for (const operation of ["prepack", "build:sdk"]) {
test(`${operation} does not break concurrent consumers loading the installed Pi SDK`, { timeout: 60000 }, async t => {
  const fixtures = await Promise.all(Array.from({ length: 4 }, () => controlledPi(t)));
  const failures = [];
  const packing = (async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.all(Array.from({ length: operation === "build:sdk" ? 2 : 1 }, () =>
        promisify(execFile)("npm", ["run", operation, "--workspace", "@muha-sdk/pi-adapter"], {
          cwd: new URL("../../../", import.meta.url), timeout: 10000,
        })));
    }
  })().catch(error => { failures.push(describeFailure(error)); });
  t.after(() => packing);
  await Promise.all(fixtures.map(async fixture => {
    // Each consumer has its own host process: Muha deliberately permits only
    // one live Runtime per process, even when data directories differ.
    try {
      await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
        import { createMuhaRuntime } from "@muha-sdk/core";
        import { piAdapter } from "@muha-sdk/pi-adapter";
        for (let i = 0; i < 10; i++) {
          const runtime = await createMuhaRuntime({ dataDir: ${JSON.stringify(fixture.root + "/diagnostics")},
            harnesses: [piAdapter(${JSON.stringify(fixture.options)})] });
          await runtime.close();
        }
      `], { cwd: new URL("../../../", import.meta.url), timeout: 30000 });
    } catch (error) { failures.push(describeFailure(error)); }
  }));
  await packing;
  assert.deepEqual(failures, [], "A package operation interrupted another consumer's SDK loading");
});
}

function describeFailure(error) {
  return { message: error.message, code: error.code, signal: error.signal,
    killed: error.killed, stdout: error.stdout, stderr: error.stderr };
}
