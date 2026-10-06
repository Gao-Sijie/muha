import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import test from 'node:test';
import { hasProcessStopped } from './support/process-state.mjs';

async function childFixture(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');
  return child;
}

test('process observation detects a live child and its eventual disappearance', async t => {
  const child = await childFixture(t);
  assert.equal(await hasProcessStopped(child.pid), false);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal(await hasProcessStopped(child.pid), true);
});

test('process observation accepts ESRCH when an opened proc stat outlives the child', async t => {
  const child = await childFixture(t);
  const stat = await open(`/proc/${child.pid}/stat`, 'r');
  t.after(() => stat.close());
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal(await hasProcessStopped(child.pid, () => stat.readFile('utf8')), true);
});

test('process observation preserves permission and unrelated I/O failures', async () => {
  for (const code of ['EACCES', 'EIO']) {
    const failure = Object.assign(new Error(code), { code });
    await assert.rejects(hasProcessStopped(process.pid, async () => { throw failure; }),
      error => error === failure);
  }
});
