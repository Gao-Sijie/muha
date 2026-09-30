import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
const directories = ['core', 'codex-adapter', 'opencode-adapter', 'kimi-adapter', 'pi-adapter', 'agy-adapter'];
test('a fresh SDK checkout has exactly six locked workspaces and guarded development commands', async () => {
  assert.deepEqual(root.workspaces, directories.map(name => `packages/${name}`));
  assert.equal(root.private, true);
  assert.equal(root.engines.node, '>=22.20.0');
  assert.doesNotMatch(JSON.stringify(root.scripts), /orchestrator/);
  assert.deepEqual(Object.keys(lock.packages).filter(path => /^packages\//.test(path)).sort(),
    directories.map(name => `packages/${name}`).sort());
  for (const name of directories) {
    const manifest = JSON.parse(await readFile(new URL(`../../packages/${name}/package.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.version, '0.1.13');
    assert.equal(manifest.private, true);
    assert.deepEqual(manifest.dependencies, lock.packages[`packages/${name}`].dependencies);
  }
});
