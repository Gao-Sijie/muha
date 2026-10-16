import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createMuhaRuntime } from '@muha-sdk/core';
import { DiagnosticEventStore } from '../../packages/core/dist/event-store.js';
import { randomUUID } from 'node:crypto';
import { spawnHarnessProcess, closeHarnessProcess, harnessEnvironment, harnessProcessExitCode } from '@muha-sdk/core/internal/host-process';

const windows = { skip: process.platform !== 'win32', timeout: 10000 };
const endpoint = fileURLToPath(new URL('../fixtures/acp-owned-process.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10); } throw new Error('Owned fixture did not settle'); }

test('Windows environment overrides replace and remove differently cased native keys', windows, () => {
  const merged = harnessEnvironment({ Path: 'test-only-path' });
  assert.deepEqual(Object.keys(merged).filter(name => name.toLowerCase() === 'path'), ['PATH']);
  assert.equal(merged.PATH, 'test-only-path');
  assert.equal(harnessEnvironment({ home: 'native-home' }).HOME, 'native-home');
  const removed = harnessEnvironment({ PATH: undefined });
  assert.equal(Object.keys(removed).some(name => name.toLowerCase() === 'path'), false);
});

test('Windows owner preserves argument boundaries and the actual native exit code', windows, async () => {
  const values = ['中文 空格', '', 'quote"value', 'trailing\\', '&literal', '%PATH%', 'x'.repeat(17000)];
  const child = spawnHarnessProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exitCode=23', '--', ...values], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', value => output += value); child.stderr.resume();
  const [code] = await once(child, 'close');
  assert.equal(code, 0, 'owner proves cleanup independently of native exit status');
  assert.equal(harnessProcessExitCode(child), 23);
  assert.deepEqual(JSON.parse(output), values);
  await closeHarnessProcess(child);
});

test('Windows owner reclaims detached grandchildren, keeps close repeatable and preserves outsiders', windows, async t => {
  const root = await mkdtemp(join(tmpdir(), 'muha Windows 进程 '));
  const file = join(root, 'pids.json');
  const child = spawnHarnessProcess(process.execPath, [endpoint], { env: { ...process.env, MUHA_TEST_OWNED_PIDS: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const outsiderExit = once(outsider, 'exit');
  let pids = [];
  t.after(async () => {
    await closeHarnessProcess(child).catch(() => {});
    for (const pid of [...pids].reverse()) if (alive(pid)) process.kill(pid);
    outsider.kill(); await outsiderExit; await rm(root, { recursive: true, force: true });
  });
  await waitFor(async () => { pids = await readFile(file, 'utf8').then(JSON.parse, () => []); return pids.length === 3; });
  const first = closeHarnessProcess(child);
  assert.equal(first, closeHarnessProcess(child));
  await first;
  assert.ok(pids.every(pid => !alive(pid)));
  assert.ok(alive(outsider.pid));
});

test('Windows helper loss fails ownership reporting and releases owned descendants', windows, async t => {
  const root = await mkdtemp(join(tmpdir(), 'muha-windows-owner-loss-'));
  const file = join(root, 'pids.json');
  const child = spawnHarnessProcess(process.execPath, [endpoint], { env: { ...process.env, MUHA_TEST_OWNED_PIDS: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  let pids = [];
  t.after(async () => { for (const pid of [...pids].reverse()) if (alive(pid)) process.kill(pid); await rm(root, { recursive: true, force: true }); });
  await waitFor(async () => { pids = await readFile(file, 'utf8').then(JSON.parse, () => []); return pids.length === 3; });
  const exit = once(child, 'exit'); child.kill(); await exit;
  await assert.rejects(closeHarnessProcess(child), /ownership|owner|cleanup/i);
  await waitFor(() => pids.every(pid => !alive(pid)));
});

test('Windows diagnostic store enforces private ACLs and lease ownership and reopens after close', windows, async t => {
  const root = await mkdtemp(join(tmpdir(), 'muha Windows 数据 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'private');
  const runtime = await DiagnosticEventStore.open(dataDir, randomUUID());
  try {
    const database = join(dataDir, 'diagnostic-events.sqlite');
    const acl = execFileSync('icacls.exe', [database], { encoding: 'utf8' });
    assert.ok(acl.length > 0);
    assert.doesNotMatch(acl, /S-1-1-0|Everyone|BUILTIN\\Users/i);
    await assert.rejects(DiagnosticEventStore.open(dataDir, randomUUID()), error => error.code === 'DATA_DIR_LOCKED');
  } finally { await runtime.close(); }
  const reopened = await DiagnosticEventStore.open(dataDir, randomUUID());
  await reopened.close();
});

test('Windows refuses an existing diagnostic file granting ordinary users access', windows, async t => {
  const root = await mkdtemp(join(tmpdir(), 'muha-win-unsafe-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'private');
  const runtime = await DiagnosticEventStore.open(dataDir, randomUUID());
  await runtime.close();
  const database = join(dataDir, 'diagnostic-events.sqlite');
  execFileSync('icacls.exe', [database, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe' });
  await assert.rejects(DiagnosticEventStore.open(dataDir, randomUUID()), error => error.code === 'EVENT_STORE_ERROR');
});
