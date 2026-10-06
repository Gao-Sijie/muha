import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
test('SDK guidance is self-contained and preserves qualification exceptions', async () => {
  const qualification = await readFile(join(root, 'QUALIFICATION.md'), 'utf8');
  for (const fact of ['gpt-5.6-luna', 'opencode-go/deepseek-v4.1-flash', 'deepseek/deepseek-flash',
    'claude-sonnet-4-6', 'opencode-go/qwen3.8-flash', 'NOT_TRIGGERED', 'WAIVED', 'N/A']) {
    assert.ok(qualification.includes(fact), fact);
  }
  for (const directory of ['core', 'codex-adapter', 'opencode-adapter', 'kimi-adapter', 'pi-adapter', 'agy-adapter']) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', directory, 'package.json'), 'utf8'));
    assert.equal(manifest.repository.url, 'https://github.com/Gao-Sijie/muha.git');
    assert.equal(manifest.repository.directory, `packages/${directory}`);
    assert.equal(manifest.bugs.url, 'https://github.com/Gao-Sijie/muha/issues');
    assert.equal(manifest.homepage, `https://github.com/Gao-Sijie/muha/tree/main/packages/${directory}#readme`);
  }
  const tracked = spawnSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  const files = tracked.stdout.split('\0').filter(file => file && !file.split('/').includes('docs'));
  for (const required of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CONTEXT.md',
    'QUALIFICATION.md']) assert.ok(files.includes(required), `missing shared guidance: ${required}`);
  for (const file of files) {
    const path = resolve(root, file), contents = await readFile(path, 'utf8');
    for (const [, target] of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const local = target.split('#')[0];
      await assert.doesNotReject(access(resolve(dirname(path), local)), `${file}: ${target}`);
    }
  }
});
