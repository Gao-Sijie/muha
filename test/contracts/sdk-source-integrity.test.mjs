import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
test('migration provenance verifies every frozen runtime resource and rejects a changed worker', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'muha-source-provenance-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await cp(join(root, 'packages'), join(fixture, 'packages'), { recursive: true,
    filter: path => !/\/(node_modules|dist)(\/|$)/.test(path) });
  const manifest = join(root, 'docs/testing/sdk-runtime-sha256.json');
  const command = [join(root, 'scripts/verify-sdk-source.mjs'), fixture, manifest];
  const before = spawnSync(process.execPath, command, { encoding: 'utf8' });
  assert.equal(before.status, 0, before.stderr);
  const worker = join(fixture, 'packages/pi-adapter/src/sdk-worker.mjs');
  await writeFile(worker, (await readFile(worker, 'utf8')) + '\n// changed fixture\n');
  const after = spawnSync(process.execPath, command, { encoding: 'utf8' });
  assert.notEqual(after.status, 0);
  assert.match(after.stderr, /sdk-worker.mjs/);
});
