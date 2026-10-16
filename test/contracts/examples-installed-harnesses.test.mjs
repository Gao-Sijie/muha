import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { readOfficialHarnessRegistration } from '@muha-sdk/core/internal';
import { installedHarnesses as chatInstalled, createInstalledChatRuntime, startChatServer } from '../../examples/local-chat/main.ts';
import { installedHarnesses as editorialInstalled } from '../../examples/auto-social-media/main.ts';
import { fakeChatRuntime } from '../support/chat-example-runtime.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'muha-example-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executable(path) {
  await writeFile(nativePath(path), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
}
const nativePath = path => process.platform === 'win32' ? path + '.exe' : path;

for (const [name, discover] of [['chat', chatInstalled], ['editorial', editorialInstalled]]) {
  test(name + ' discovers only executable native CLI files, without executing them', async t => {
    const root = await directory(t), first = join(root, 'first bin'), second = join(root, 'second');
    await mkdir(first); await mkdir(second);
    const marker = join(root, 'must-not-execute');
    await writeFile(nativePath(join(first, 'codex')), '#!/bin/sh\ntouch "' + marker + '"\nexit 99\n', { mode: 0o700 });
    await writeFile(join(first, 'opencode'), 'not executable', { mode: 0o600 });
    await mkdir(join(first, 'kimi'));
    await executable(join(first, 'antigravity-cli')); // A package/configuration name, not the native executable.
    const path = [join(root, 'absent'), first, second, first].join(delimiter);
    assert.deepEqual(await discover(path), ['codex', 'pi']);
    if (process.platform === 'win32') {
      await writeFile(join(second, 'opencode.cmd'), '@echo off\r\n"%~dp0\\..\\first bin\\codex.exe" %*\r\n');
    } else await symlink(join(first, 'codex'), join(second, 'opencode'));
    await executable(join(second, 'agy'));
    assert.deepEqual(await discover(path), ['codex', 'opencode', 'pi', 'agy']);
    if (process.platform === 'win32') {
      await writeFile(join(second, 'kimi.cmd'), '@echo off\r\n"%dp0%\\missing-target.exe" %*\r\n');
    } else await symlink(join(root, 'missing-target'), join(second, 'kimi'));
    assert.deepEqual(await discover(path), ['codex', 'opencode', 'pi', 'agy']);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    if (process.platform === 'win32') await rm(nativePath(join(first, 'codex')));
    else await chmod(join(first, 'codex'), 0o600);
    assert.deepEqual(await discover(path), ['pi', 'agy']);
  });

  test(name + ' needs no global Pi command and preserves the official order for all installed CLIs', async t => {
    const root = await directory(t);
    assert.deepEqual(await discover(root), ['pi']);
    for (const command of ['codex', 'opencode', 'kimi', 'agy']) await executable(join(root, command));
    assert.deepEqual(await discover(root), ['codex', 'opencode', 'kimi', 'pi', 'agy']);
  });

  test(name + ' discovers AGY by the same executable the Adapter actually launches', async t => {
    const source = await readFile(new URL('../../packages/agy-adapter/src/owned-cli.ts', import.meta.url), 'utf8');
    const nativeCommand = /"([^"]+)", \.\.\.args\]/.exec(source)?.[1];
    assert.equal(nativeCommand, 'agy');
    const root = await directory(t);
    await executable(join(root, 'antigravity-cli'));
    assert.deepEqual(await discover(root), ['pi'], 'the old package/configuration name must not count as an installed AGY');
    await executable(join(root, nativeCommand));
    await rm(nativePath(join(root, 'antigravity-cli')));
    assert.deepEqual(await discover(root), ['pi', 'agy'], 'an executable agy is sufficient without antigravity-cli');
  });

  test(name + ' discovers Windows Node bins and npm shims without evaluating shell commands', { skip: process.platform !== 'win32' }, async t => {
    const root = await directory(t);
    await writeFile(join(root, 'codex'), '#!/usr/bin/env node\nthrow new Error("must not run");\n');
    await writeFile(join(root, 'entry.js'), 'throw new Error("must not run");\n');
    await writeFile(join(root, 'opencode.cmd'), '@echo off\r\n"%dp0%\\entry.js" %*\r\n');
    await writeFile(join(root, 'agy.cmd'), '@echo off\r\necho arbitrary shell command\r\n');
    assert.deepEqual(await discover(root), ['codex', 'opencode', 'pi']);
    await rm(join(root, 'entry.js'));
    assert.deepEqual(await discover(root), ['codex', 'pi']);
  });
}

test('chat omits missing harnesses before initialization and exposes only the installed subset', async t => {
  const root = await directory(t);
  await executable(join(root, 'codex'));
  const runtime = fakeChatRuntime();
  let initialized;
  const result = await createInstalledChatRuntime({ path: root, createRuntime: async config => {
    initialized = config.harnesses.map(item => readOfficialHarnessRegistration(item).kind);
    runtime.enabledHarnesses = initialized;
    return runtime;
  } });
  assert.deepEqual(initialized, ['codex', 'pi']);
  assert.deepEqual(result.skipped, ['opencode', 'kimi', 'agy']);
  const app = await startChatServer(runtime, { workspacePath: root, port: 0 });
  t.after(() => app.close());
  const html = await (await fetch(app.url)).text();
  const token = /name="muha-token" content="([a-f0-9]+)"/.exec(html)[1];
  const headers = { 'x-muha-token': token, 'content-type': 'application/json', origin: app.url };
  const config = await (await fetch(app.url + '/api/config', { headers })).json();
  assert.deepEqual(config.harnesses.map(item => item.harness), ['codex', 'pi']);
  const absent = await fetch(app.url + '/api/sessions', { method: 'POST', headers,
    body: JSON.stringify({ harness: 'agy', approvalPolicy: 'harnessManaged' }) });
  assert.equal(absent.status, 400);
  assert.equal(runtime.calls.length, 0);
});

test('MUHA_HARNESSES intersects local installations and keeps requested ordering', async t => {
  const root = await directory(t);
  await executable(join(root, 'codex'));
  let initialized;
  const result = await createInstalledChatRuntime({ harnesses: 'pi,agy,codex', path: root,
    createRuntime: async config => {
      initialized = config.harnesses.map(item => readOfficialHarnessRegistration(item).kind);
      return fakeChatRuntime();
    } });
  assert.deepEqual(initialized, ['pi', 'codex']);
  assert.deepEqual(result.skipped, ['agy']);
});

test('chat rejects an empty installed allowlist or invalid names without initializing a Runtime', async t => {
  const root = await directory(t);
  let calls = 0;
  const createRuntime = async () => { calls++; return fakeChatRuntime(); };
  await assert.rejects(createInstalledChatRuntime({ harnesses: 'codex,agy', path: root, createRuntime }), /No locally installed harness/);
  for (const harnesses of ['', 'unknown', 'pi,pi']) {
    await assert.rejects(createInstalledChatRuntime({ harnesses, path: root, createRuntime }), /MUHA_HARNESSES/);
  }
  assert.equal(calls, 0);
});

test('chat does not disguise readiness/authentication failure as a missing installation', async t => {
  const root = await directory(t);
  const failure = new Error('Controlled native readiness failure');
  let calls = 0;
  await assert.rejects(createInstalledChatRuntime({ path: root, createRuntime: async () => {
    calls++; throw failure;
  } }), error => error === failure);
  assert.equal(calls, 1, 'there is no silent automatic fallback');
});
