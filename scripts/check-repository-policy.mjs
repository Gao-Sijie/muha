import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyRepositoryDocs(root, revision) {
  const args = revision === undefined
    ? ['ls-files', '--cached', '-z']
    : ['ls-tree', '-r', '--name-only', '-z', revision];
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot inspect repository paths: ${result.stderr}`);
  const forbidden = result.stdout.split('\0').filter(path => path.split('/').includes('docs'));
  if (forbidden.length) throw new Error(`Repository must not track docs paths:\n${forbidden.join('\n')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root = new URL('../', import.meta.url).pathname, revision] = process.argv.slice(2);
  verifyRepositoryDocs(resolve(root), revision);
  process.stdout.write(`Verified ${revision === undefined ? 'Git index' : `commit ${revision}`} contains no docs paths\n`);
}
