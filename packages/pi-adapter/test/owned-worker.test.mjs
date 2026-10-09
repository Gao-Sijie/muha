import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PiOwnedWorker } from "../dist/pi-owned-worker.js";

test("Pi ownership helper loss fails close without claiming descendant reclamation", { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "muha-pi-owner-loss-"));
  const pidFile = join(root, "sdk.pid"), preload = join(root, "identity.mjs");
  await writeFile(preload, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`);
  let nativePid;
  t.after(async () => {
    if (nativePid) { try { process.kill(-nativePid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    await rm(root, { recursive: true, force: true });
  });
  let reportLoss;
  const lost = new Promise(resolve => { reportLoss = resolve; });
  const owner = new PiOwnedWorker({ ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, 1000, reportLoss);
  t.after(() => owner.close().catch(() => {}));
  const ready = once(owner.child, "message");
  owner.child.send({ id: "ready", command: "ready", args: {} });
  assert.equal((await ready)[0].value.version, "1.0.4");
  nativePid = Number(await readFile(pidFile, "utf8"));
  assert.ok(nativePid > 1);
  owner.child.kill("SIGKILL");
  assert.match(await lost, /without proving descendant cleanup/);
  await assert.rejects(owner.close(), /without proving descendant cleanup/);
});
