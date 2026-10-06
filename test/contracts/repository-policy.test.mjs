import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'scripts/check-repository-policy.mjs');
const check = (directory, revision) => spawnSync(process.execPath,
  [script, directory, ...(revision === undefined ? [] : [revision])], { encoding: 'utf8' });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'muha-repository-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  await writeFile(join(directory, '.gitignore'), 'docs/\n');
  await writeFile(join(directory, 'README.md'), '# Fixture\n');
  git('add', '.gitignore', 'README.md');
  git('-c', 'user.name=Muha fixture', '-c', 'user.email=fixture@invalid.test', 'commit', '-qm', 'fixture');
  return { directory, git };
}

test('the SDK index and current committed tree contain no docs paths', () => {
  for (const revision of [undefined, 'HEAD']) {
    const result = check(root, revision);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('ignored root and nested docs leave a clean repository acceptable', async t => {
  const { directory, git } = await fixture(t);
  for (const relative of ['docs/plan.md', 'packages/core/docs/private.md']) {
    const path = join(directory, relative);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, '[private broken link](missing.md)\n');
  }
  git('add', '.');
  for (const revision of [undefined, 'HEAD']) {
    const result = check(directory, revision);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('forced docs additions fail in the index and committed tree at any depth', async t => {
  const { directory, git } = await fixture(t);
  for (const relative of ['docs/plan.md', 'packages/core/docs/private.md']) {
    const path = join(directory, relative);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, 'private\n');
    git('add', '-f', relative);
    const staged = check(directory);
    assert.notEqual(staged.status, 0);
    assert.ok(staged.stderr.includes(relative), staged.stderr);
  }
  git('-c', 'user.name=Muha fixture', '-c', 'user.email=fixture@invalid.test', 'commit', '-qm', 'invalid docs');
  const committed = check(directory, 'HEAD');
  assert.notEqual(committed.status, 0);
  assert.match(committed.stderr, /docs\/plan\.md/);
  assert.match(committed.stderr, /packages\/core\/docs\/private\.md/);
});
