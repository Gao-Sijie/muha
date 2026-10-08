import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [rootArgument = new URL('../', import.meta.url).pathname,
  manifestArgument = new URL('./fixtures/sdk-runtime-sha256.json', import.meta.url).pathname] = process.argv.slice(2);
const root = resolve(rootArgument);
const manifest = JSON.parse(await readFile(manifestArgument, 'utf8'));
const resources = [];
async function collect(directory, prefix) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}/${item.name}`;
    assert.equal(item.isSymbolicLink(), false, `unexpected source symlink: ${path}`);
    if (item.isDirectory()) await collect(join(directory, item.name), path);
    else resources.push(path);
  }
}
for (const name of ['core', 'codex-adapter', 'opencode-adapter', 'kimi-adapter', 'pi-adapter', 'agy-adapter']) {
  for (const directory of ['src', 'native', 'scripts']) {
    const prefix = `packages/${name}/${directory}`;
    try { await collect(join(root, prefix), prefix); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
resources.push('packages/pi-adapter/PI-SDK-LICENSE');
await collect(join(root, 'packages/pi-adapter/third-party-licenses'), 'packages/pi-adapter/third-party-licenses');
assert.deepEqual(resources.sort(), manifest.runtime.map(item => item.path).sort(), 'runtime resource set differs from qualified source');
for (const { path, sha256 } of manifest.runtime) {
  const actual = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  assert.equal(actual, sha256, `runtime changed: ${path}; obtain bounded requalification authorization`);
}
process.stdout.write(`Verified ${resources.length} pinned runtime/loader/build/license resources\n`);
