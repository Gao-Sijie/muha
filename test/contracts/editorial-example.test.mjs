import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MuhaError } from '@muha-sdk/muha';
import {
  createCommandLine, downloadPinnedSkill, installedHarnesses, PINNED_SKILLS, runEditorialScript, stagePrompt, terminalText,
} from '../../examples/auto-social-media/main.ts';
import { fakeEditorialPlatform } from '../support/editorial-example-runtime.mjs';

const selection = (harness = 'codex', model = harness + '/controlled-model', effort = '') => [harness, model, effort];
const answers = (first = selection(), second = selection('pi')) => ['yes', ...first, ...second];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 10)); }
  assert.fail('Controlled fixture did not reach its expected state');
}
async function fixture(t, specs = [], discoverHarnesses = async () => ['codex', 'opencode', 'kimi', 'pi', 'agy'], script = runEditorialScript, commandLine = createCommandLine) {
  const root = await mkdtemp(join(tmpdir(), 'muha-editorial-cli-test-')), platform = fakeEditorialPlatform(specs);
  const input = new PassThrough(), output = new PassThrough(), controller = new AbortController();
  let transcript = '', pending, closed = false;
  output.on('data', data => { transcript += data.toString(); });
  const prompts = [], terminal = commandLine(input, output, reason => controller.abort(reason));
  const io = {
    write: text => terminal.write(text),
    async ask(prompt, signal) { prompts.push(prompt); return terminal.ask(prompt, signal); },
    close() { closed = true; terminal.close(); },
  };
  const f = {
    root, platform, input, output, controller, prompts,
    get text() { return transcript; }, get closed() { return closed; },
    start(lines = answers(), end = true, useDefaultOutputRoot = false) {
      assert.equal(pending, undefined);
      pending = script({ ...(useDefaultOutputRoot ? {} : { outputRoot: root }), io, signal: controller.signal,
        createRuntime: kind => platform.createRuntime(kind), discoverHarnesses, prepareSkill: (...args) => platform.prepareSkill(...args) });
      const text = lines.length ? lines.join('\n') + '\n' : '';
      if (end) input.end(text); else input.write(text);
      return pending;
    },
  };
  t.after(async () => {
    controller.abort(); input.end();
    if (pending) await pending;
    terminal.close(); input.destroy(); output.destroy();
    await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function copiedExample(t) {
  const root = await mkdtemp(join(tmpdir(), 'muha-editorial-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'project with spaces', 'example');
  await mkdir(directory, { recursive: true });
  await cp(new URL('../../examples/auto-social-media/main.ts', import.meta.url), join(directory, 'main.ts'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { runEditorialScript: script, createCommandLine: commandLine } = await import(pathToFileURL(join(directory, 'main.ts')).href);
  return { directory, outputRoot: join(directory, 'workspaces'), script, commandLine };
}
function assertNoWriter(f) {
  assert.ok(f.platform.runtimes.length <= 1);
  assert.equal(f.prompts.filter(prompt => prompt.startsWith('Harness')).length, 1);
  assert.ok(!f.text.includes('配置写文 Agent'));
}

function webSearchQuestion() {
  return { questions: [{ questionId: randomUUID(),
    question: 'Allow OpenCode to search the web for up-to-date information?', required: true,
    hidden: false, default: { kind: 'none' }, when: [],
    input: { kind: 'select', allowCustom: false, options: [
      { optionId: randomUUID(), label: 'Allow search via Exa, Firecrawl, Parallel, Tavily, TinyFish' },
      { optionId: randomUUID(), label: 'Choose another provider' },
      { optionId: randomUUID(), label: 'Disable web search' },
    ] } }] };
}
function webSearchAnswer(question, index) {
  return { action: 'answer', answers: [{ questionId: question.questions[0].questionId,
    kind: 'selection', optionIds: [question.questions[0].input.options[index].optionId], customValues: [] }] };
}

test('editorial is a pure Node command-line entry, with no frontend or example service', async () => {
  const source = await readFile(new URL('../../examples/auto-social-media/main.ts', import.meta.url), 'utf8');
  assert.match(source, /node:readline/);
  assert.match(source, /runEditorialScript/);
  assert.doesNotMatch(source, /node:http|createServer|startEditorialServer|process\.env\.PORT|<html|<script|\.listen\(/);
});

test('blank, no and arbitrary consent decline before any workspace, download, Harness or model', async t => {
  for (const consent of ['', 'no', 'true']) {
    const f = await fixture(t);
    assert.deepEqual(await f.start([consent]), { status: 'declined' });
    assert.match(f.text, /真实模型/); assert.match(f.text, /费用/);
    assert.deepEqual(await readdir(f.root), []); assert.deepEqual(f.platform.calls, []);
    assert.equal(f.closed, true);
  }
});

test('EOF before confirmation is interruption, not implicit consent or native startup', async t => {
  const f = await fixture(t), result = await f.start([]);
  assert.equal(result.status, 'interrupted'); assert.equal(result.reason, 'input-ended');
  assert.deepEqual(f.platform.calls, []); assert.deepEqual(await readdir(f.root), []);
});

test('default workspaces live beside the script, survive both stages and stay distinct across runs', async t => {
  const copy = await copiedExample(t), paths = [];
  assert.notEqual(copy.directory, process.cwd());
  await assert.rejects(access(copy.outputRoot), { code: 'ENOENT' });
  for (let run = 0; run < 2; run++) {
    const f = await fixture(t, [], undefined, copy.script, copy.commandLine), result = await f.start(answers(), true, true);
    assert.equal(result.status, 'completed');
    const parent = await realpath(copy.outputRoot);
    assert.ok(result.workspacePath.startsWith(join(parent, 'muha-social-')));
    if (process.platform !== 'win32') {
      assert.equal((await stat(copy.outputRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(result.workspacePath)).mode & 0o777, 0o700);
    }
    assert.deepEqual(await readdir(f.root), []);
    assert.ok(f.platform.runtimes.every(runtime => runtime.sessions[0].reference.workspacePath === result.workspacePath));
    for (const file of ['topic.md', 'article.md', 'provenance.json']) await access(join(result.workspacePath, file));
    assert.ok(f.text.includes(result.workspacePath));
    paths.push(result.workspacePath);
  }
  assert.notEqual(paths[0], paths[1]);
  assert.equal((await readdir(copy.outputRoot)).length, 2);
});

test('default output parent is not created before consent and complete topic configuration', async t => {
  const copy = await copiedExample(t);
  for (const lines of [['no'], [], ['yes', 'q'], ['yes', 'codex', 'model']]) {
    const f = await fixture(t, [], undefined, copy.script, copy.commandLine), result = await f.start(lines, true, true);
    assert.ok(['declined', 'interrupted'].includes(result.status));
    await assert.rejects(access(copy.outputRoot), { code: 'ENOENT' });
    assert.deepEqual(f.platform.calls, []);
  }
});

test('an explicit existing output parent overrides the default without creating it', async t => {
  const copy = await copiedExample(t), f = await fixture(t, [], undefined, copy.script, copy.commandLine);
  const result = await f.start();
  assert.equal(result.status, 'completed');
  assert.ok(result.workspacePath.startsWith(join(await realpath(f.root), 'muha-social-')));
  await assert.rejects(access(copy.outputRoot), { code: 'ENOENT' });
});

test('default output-parent creation failure stops before Skill download or native setup', async t => {
  const copy = await copiedExample(t);
  await writeFile(copy.outputRoot, 'Keep this existing file.');
  const f = await fixture(t, [], undefined, copy.script, copy.commandLine), result = await f.start(answers(), true, true);
  assert.equal(result.status, 'failed');
  assert.deepEqual(f.platform.calls, []);
  assert.equal(await readFile(copy.outputRoot, 'utf8'), 'Keep this existing file.');
  assert.equal(result.workspacePath, undefined);
});

test('default output-parent symlinks retain canonical shared workspace identity', async t => {
  const copy = await copiedExample(t), f = await fixture(t, [], undefined, copy.script, copy.commandLine);
  await symlink(f.root, copy.outputRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.start(answers(), true, true);
  assert.equal(result.status, 'completed');
  assert.ok(result.workspacePath.startsWith(join(await realpath(f.root), 'muha-social-')));
  assert.ok(f.platform.runtimes.every(runtime => runtime.sessions[0].reference.workspacePath === result.workspacePath));
});

test('invalid Harness and missing model re-prompt; blank effort is omitted without fallback', async t => {
  const f = await fixture(t);
  const result = await f.start(['Y', 'unknown', '1', '', 'codex/model', '', '4', 'pi/model', '']);
  assert.equal(result.status, 'completed');
  const created = f.platform.calls.filter(call => call.operation === 'create');
  assert.deepEqual(created.map(call => call.options.harness), ['codex', 'pi']);
  assert.deepEqual(created.map(call => call.options.model), ['codex/model', 'pi/model']);
  assert.ok(created.every(call => !Object.hasOwn(call.options, 'effort')));
  assert.match(f.text, /不会自动回退/); assert.match(f.text, /Model 不能为空/);
});

test('both editorial menus number only installed harnesses and reject absent names', async t => {
  let discoveries = 0;
  const f = await fixture(t, [], async () => { discoveries++; return ['codex', 'pi']; });
  const result = await f.start(['yes', 'opencode', '2', 'provider/topic', '', 'agy', '1', 'codex-writer', '']);
  assert.equal(result.status, 'completed');
  assert.equal(discoveries, 2);
  assert.equal(f.text.split('1. codex\n2. pi\n').length - 1, 2);
  assert.doesNotMatch(f.text, /\d+\. (opencode|kimi|agy)\n/);
  assert.match(f.text, /未安装的名称不可选/);
  assert.deepEqual(f.platform.calls.filter(call => call.operation === 'create').map(call => call.options.harness), ['pi', 'codex']);
});

test('an actual executable agy file is offered and selectable in both editorial stages', async t => {
  let bin;
  const f = await fixture(t, [], () => installedHarnesses(bin));
  bin = join(f.root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const result = await f.start(['yes', '2', 'claude-sonnet-4-6', '', 'agy', 'claude-sonnet-4-6', '']);
  assert.equal(result.status, 'completed');
  assert.equal(f.text.split('1. pi\n2. agy\n').length - 1, 2);
  assert.deepEqual(f.platform.calls.filter(call => call.operation === 'create').map(call => call.options.harness), ['agy', 'agy']);
});

test('editorial refreshes installed harnesses before configuring the next stage', async t => {
  let discoveries = 0;
  const f = await fixture(t, [], async () => ++discoveries === 1 ? ['codex'] : ['pi']);
  const result = await f.start(['yes', '1', 'codex-topic', '', 'codex', '1', 'provider/writer', '']);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.platform.calls.filter(call => call.operation === 'create').map(call => call.options.harness), ['codex', 'pi']);
  assert.match(f.text, /未安装的名称不可选/);
});

test('empty editorial discovery fails before workspace/download/native setup, and decline does not discover', async t => {
  let discoveries = 0;
  const discover = async () => { discoveries++; return []; };
  const declined = await fixture(t, [], discover);
  assert.equal((await declined.start(['no'])).status, 'declined');
  assert.equal(discoveries, 0);
  const f = await fixture(t, [], discover);
  assert.equal((await f.start(['yes'])).status, 'failed');
  assert.equal(discoveries, 1);
  assert.match(f.text, /没有检测到已安装的 Harness/);
  assert.deepEqual(f.platform.calls, []);
  assert.deepEqual(await readdir(f.root), []);
  assert.equal(f.prompts.filter(prompt => prompt.startsWith('Harness')).length, 0);
});

for (const harness of ['pi', 'opencode']) {
  test(harness + ' explains provider/model syntax without prescribing a provider, in both stages', async t => {
    const selected = selection(harness, 'custom-provider/opaque/model');
    const f = await fixture(t), result = await f.start(answers(selected, selected));
    assert.equal(result.status, 'completed');
    assert.equal(f.text.split('Model 写法为 <provider>/<model>').length - 1, 2);
    assert.match(f.text, /原生配置中可用的 provider ID 和 model ID，不限定提供方/);
    assert.doesNotMatch(f.text, /opencode-go/);
    assert.deepEqual(f.platform.calls.filter(call => call.operation === 'create').map(call => call.options.model), [selected[1], selected[1]]);
  });
}

test('consent notice and guides distinguish five retries from six total attempts', async t => {
  const f = await fixture(t);
  assert.equal((await f.start(['no'])).status, 'declined');
  assert.match(f.text, /最多自动重试 5 次（共最多 6 次尝试）/);
  assert.match(f.text, /autoApprove，自动允许工具操作/);
  assert.ok(f.prompts[0].includes('自动允许工具操作（autoApprove）'));
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const guide = await readFile(new URL('../../examples/auto-social-media/' + name, import.meta.url), 'utf8');
    assert.ok(guide.includes('<provider>/<model>'));
    assert.ok(guide.includes('maxRetries: 5'));
    assert.ok(guide.includes('autoApprove'));
    assert.ok(guide.includes('`k3`')); assert.ok(guide.includes('`deepseek/deepseek-flash`'));
    assert.ok(guide.includes('Kimi Code'));
    assert.match(guide, /third-party provider|第三方 provider/);
    assert.doesNotMatch(guide, /use `interactive`|使用 `interactive`|use `harnessManaged`|使用 `harnessManaged`/);
    assert.doesNotMatch(guide, /opencode-go|maxRetries: 3/);
  }
});

test('topic completion hands off exact text in the same workspace to a new Session, retaining licenses', async t => {
  const topic = 'Plain topic text, not JSON.\n素材与链接。\n', article = 'Draft text, unchanged.\n';
  const f = await fixture(t, [{ text: topic }, { text: article }]), result = await f.start();
  assert.equal(result.status, 'completed');
  assert.ok(result.workspacePath.startsWith(join(f.root, 'muha-social-')));
  if (process.platform !== 'win32') assert.equal((await stat(result.workspacePath)).mode & 0o777, 0o700);
  const topicSession = f.platform.runtimes[0].sessions[0], writerSession = f.platform.runtimes[1].sessions[0];
  assert.notEqual(topicSession.reference.sessionId, writerSession.reference.sessionId);
  assert.equal(topicSession.reference.workspacePath, writerSession.reference.workspacePath);
  assert.equal(f.platform.calls.filter(call => call.operation === 'submitted')[1].input[0].text, stagePrompt('writer', topic));
  assert.equal(await readFile(join(result.workspacePath, 'topic.md'), 'utf8'), topic);
  assert.equal(await readFile(join(result.workspacePath, 'article.md'), 'utf8'), article);
  const receipt = JSON.parse(await readFile(join(result.workspacePath, 'provenance.json'), 'utf8'));
  assert.equal(receipt.phase, 'completed'); assert.equal(receipt.skills.topic.revision, PINNED_SKILLS.topic.revision);
  assert.equal(receipt.selections.writer.harness, 'pi'); assert.equal(receipt.maxRetries, 5);
  assert.equal(receipt.approvalPolicy, 'autoApprove');
  for (const skill of ['content-strategy', 'khazix-writer']) assert.match(
    await readFile(join(result.workspacePath, '.agents', 'skills', skill, 'LICENSE'), 'utf8'), /Controlled MIT/);
  for (const source of f.platform.sources) await assert.rejects(access(source), { code: 'ENOENT' });
  assert.ok(f.platform.runtimes.every(runtime => runtime.status === 'closed'));
  assert.equal(f.text.split(topic).length - 1, 1, 'streamed topic is not duplicated by final events');
  assert.equal(f.text.split(article).length - 1, 1);
  assert.doesNotMatch(f.text, /tool\.|assistant\.|usage\.|turn\.|推理|inputTokens|toolCallId|"type"|"sequence"|"timestamp"/);
  assert.doesNotMatch(f.text, /First inspect the project|summarize the findings|Muha SDK project overview/);
  assert.match(f.text, /产出目录/);
});

for (const harness of ['codex', 'opencode', 'kimi', 'pi', 'agy']) {
  test(harness + ' supports both stages with explicit opaque model/effort and independent Sessions', async t => {
    const selected = selection(harness, harness + '/opaque/model', 'opaque/native-effort');
    const f = await fixture(t), result = await f.start(answers(selected, selected));
    assert.equal(result.status, 'completed');
    const created = f.platform.calls.filter(call => call.operation === 'create');
    assert.equal(created.length, 2);
    for (const call of created) {
      assert.equal(call.options.model, selected[1]); assert.equal(call.options.effort, selected[2]);
      assert.deepEqual(call.options.turnRetryPolicy, { maxRetries: 5 });
      assert.equal(call.options.approvalPolicy, 'autoApprove');
    }
    assert.notEqual(f.platform.runtimes[0].sessions[0].reference.sessionId, f.platform.runtimes[1].sessions[0].reference.sessionId);
    const configured = f.platform.calls.filter(call => call.operation === 'configure');
    assert.deepEqual(configured.map(call => call.options.harnesses), [[harness], [harness]]);
    assert.deepEqual(configured.map(call => call.options.skills[0].skillNames), [['content-strategy'], ['khazix-writer']]);
    assert.ok(configured.every(call => call.options.createIfMissing === false));
    assert.equal(f.platform.calls.filter(call => call.operation === 'submitted').length, 2);
  });
}

test('writer asks for configuration only after topic Runtime cleanup and starts no Turn while waiting', async t => {
  const f = await fixture(t), gate = deferred(); f.platform.closeBarrier = gate.promise;
  const pending = f.start(['yes', ...selection()], false);
  await until(() => f.platform.calls.some(call => call.operation === 'close'));
  try { assertNoWriter(f); assert.equal(f.platform.runtimes[0].status, 'active'); }
  finally { gate.resolve(); }
  await until(() => f.prompts.filter(prompt => prompt.startsWith('Harness')).length === 2);
  assert.equal(f.platform.runtimes[0].status, 'closed'); assert.equal(f.platform.runtimes.length, 1);
  f.input.end(selection('pi').join('\n') + '\n');
  assert.equal((await pending).status, 'completed');
});

test('empty completed topic is not rejected by a content or quality gate', async t => {
  const f = await fixture(t, [{ text: '' }]), result = await f.start();
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(join(result.workspacePath, 'topic.md'), 'utf8'), '');
  assert.equal(f.platform.calls.filter(call => call.operation === 'submitted')[1].input[0].text, stagePrompt('writer', ''));
});

test('topic failure stops the workflow and never asks for writer selection', async t => {
  const f = await fixture(t, [{ command: '[fail]' }]), result = await f.start();
  assert.equal(result.status, 'failed'); assertNoWriter(f);
  assert.match(f.text, /选题失败: Fixture failure（HARNESS_ERROR）/);
  assert.doesNotMatch(f.text, /"code"|"message"|turn\.failed/);
  assert.equal(f.platform.runtimes[0].status, 'closed');
  await assert.rejects(access(join(result.workspacePath, 'topic.md')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(result.workspacePath, 'provenance.json'))).phase, 'failed');
});

test('writer failure retains successful topic but does not claim a draft', async t => {
  const f = await fixture(t, [{}, { command: '[fail]' }]), result = await f.start();
  assert.equal(result.status, 'failed'); await access(join(result.workspacePath, 'topic.md'));
  await assert.rejects(access(join(result.workspacePath, 'article.md')), { code: 'ENOENT' });
  assert.ok(f.platform.runtimes.every(runtime => runtime.status === 'closed'));
});

test('missing terminal events cannot advance even when controlled Result says completed', async t => {
  const f = await fixture(t, [{ omitTerminal: true }]), result = await f.start();
  assert.equal(result.status, 'failed'); assert.match(result.error.message, /终态事件与 Result 不一致/);
  assertNoWriter(f);
});

test('five retry events stay quiet inside one accepted Turn without replaying setup or stages', async t => {
  const f = await fixture(t, [{ retries: 5 }]), result = await f.start(['yes', ...selection(), 'q']);
  assert.equal(result.status, 'interrupted');
  assert.doesNotMatch(f.text, /重试 [1-5]\/5|turn\.retrying|Controlled connection failure|"retryNumber"|"error"/);
  assert.deepEqual(f.platform.calls.find(call => call.operation === 'create').options.turnRetryPolicy, { maxRetries: 5 });
  assert.equal(f.platform.calls.filter(call => call.operation === 'submitted').length, 1);
  assert.equal(f.platform.calls.filter(call => call.operation === 'prepare').length, 1);
});

test('Skill install errors and rejected Session/Turn creation never start writer or retry setup', async t => {
  for (const [spec, selected] of [[{ installFails: true }, selection()], [{}, selection('codex', 'invalid-model')],
    [{ command: '[reject]' }, selection()]]) {
    const f = await fixture(t, [spec]), result = await f.start(answers(selected));
    assert.equal(result.status, 'failed'); assertNoWriter(f);
    assert.equal(f.platform.runtimes[0].status, 'closed');
    assert.ok(f.platform.calls.filter(call => call.operation === 'submitted').length <= 1);
    assert.equal(f.platform.calls.filter(call => call.operation === 'prepare').length, 1);
  }
});

test('Ctrl+C equivalent interruption drains active Turn, closes resources and preserves workspace', async t => {
  const f = await fixture(t, [{ command: '[hold]' }]), pending = f.start();
  await until(() => f.platform.runtimes[0]?.sessions[0]?.status.status === 'running'); f.controller.abort();
  const result = await pending;
  assert.equal(result.status, 'interrupted'); assertNoWriter(f); await access(result.workspacePath);
  const runtime = f.platform.runtimes[0];
  assert.ok(runtime.calls.some(call => call.operation === 'interrupt'));
  assert.equal(runtime.status, 'closed'); assert.equal(runtime.sessions[0].status.status, 'closed');
  assert.equal(f.closed, true);
});

for (const phase of ['prepare', 'runtime', 'configure', 'create', 'submitted']) {
  test('cancellation during pending ' + phase + ' reclaims late resources without writer', async t => {
    const f = await fixture(t), gate = deferred();
    if (phase === 'prepare') f.platform.prepareBarrier = gate.promise;
    if (phase === 'runtime') f.platform.runtimeBarrier = gate.promise;
    if (phase === 'configure') f.platform.configureBarrier = gate.promise;
    if (['create', 'submitted'].includes(phase)) {
      const original = f.platform.createRuntime;
      f.platform.createRuntime = async kind => {
        const runtime = await original(kind);
        runtime[phase === 'create' ? 'createBarrier' : 'startBarrier'] = gate.promise; return runtime;
      };
    }
    const pending = f.start();
    await until(() => f.platform.calls.some(call => call.operation === phase));
    f.controller.abort(); gate.resolve();
    const result = await pending;
    assert.equal(result.status, 'interrupted'); assertNoWriter(f);
    assert.ok(f.platform.runtimes.every(runtime => runtime.status === 'closed'));
    if (phase === 'submitted') assert.ok(f.platform.runtimes[0].calls.some(call => call.operation === 'interrupt'));
    for (const source of f.platform.sources) await assert.rejects(access(source), { code: 'ENOENT' });
  });
}

test('q or EOF at writer configuration retains topic and starts no paid writer Turn', async t => {
  for (const last of [[], ['q']]) {
    const f = await fixture(t), result = await f.start(['yes', ...selection(), ...last]);
    assert.equal(result.status, 'interrupted'); assert.equal(result.reason, last.length ? 'caller' : 'input-ended');
    await access(join(result.workspacePath, 'topic.md'));
    assert.equal(f.platform.runtimes.length, 1); assert.equal(f.platform.runtimes[0].status, 'closed');
  }
});

test('autoApprove leaves residual approvals to Core without prompts or duplicate responses, in both stages', async t => {
  const f = await fixture(t, [{ command: '[approval]' }, { command: '[approval]' }]);
  assert.equal((await f.start(answers(selection('codex'), selection('kimi', 'k3')))).status, 'completed');
  assert.ok(f.prompts.every(prompt => !prompt.startsWith('审批')));
  assert.doesNotMatch(f.text, /需要审批|Fixture approval|审批：allow/);
  for (const runtime of f.platform.runtimes) {
    assert.deepEqual(runtime.calls.filter(call => call.operation === 'approval').map(call => [call.decision, call.source]), [['allowOnce', 'policy']]);
  }
});

test('Kimi suggests k3 or a third-party-provider DeepSeek configuration in both stages without substitution', async t => {
  const f = await fixture(t);
  const result = await f.start(['yes', 'kimi', '', 'k3', '', 'kimi', 'deepseek/deepseek-flash', '']);
  assert.equal(result.status, 'completed');
  assert.equal(f.text.split('Model 提示（不是可用性承诺）: k3 或 deepseek/deepseek-flash').length - 1, 2);
  assert.equal(f.text.split('deepseek/deepseek-flash 是 Kimi Code 的第三方 provider 配置示例').length - 1, 2);
  assert.equal(f.text.split('需先在原生配置中设置对应 provider、凭据和模型；Muha 不会自动配置').length - 1, 2);
  assert.match(f.text, /Model 不能为空/);
  assert.deepEqual(f.platform.calls.filter(call => call.operation === 'create').map(call => call.options.model), ['k3', 'deepseek/deepseek-flash']);
});

test('an unsupported autoApprove policy fails without falling back or creating a model Session', async t => {
  const f = await fixture(t);
  const original = f.platform.createRuntime.bind(f.platform);
  f.platform.createRuntime = async kind => {
    const runtime = await original(kind), capabilities = runtime.getHarnessCapabilities(kind);
    runtime.getHarnessCapabilities = () => ({ ...capabilities, approvalPolicies: ['interactive'] });
    return runtime;
  };
  assert.equal((await f.start()).status, 'failed');
  assert.match(f.text, /审批策略/);
  assert.ok(f.platform.calls.every(call => !['configure', 'create', 'submitted'].includes(call.operation)));
  assert.ok(f.platform.runtimes.every(runtime => runtime.status === 'closed'));
});

test('OpenCode web-search choices accept numbers and Chinese without exposing UUID/JSON protocol', async t => {
  for (const [reply, index] of [['1', 0], ['允许', 0], ['2', 1], ['换服务', 1], ['3', 2], ['禁用', 2], ['关闭搜索', 2]]) {
    const question = webSearchQuestion(), f = await fixture(t, [{ command: '[question]', question }]);
    const result = await f.start(['yes', ...selection('opencode'), reply, ...selection('pi')]);
    assert.equal(result.status, 'completed');
    const calls = f.platform.runtimes[0].calls.filter(call => call.operation === 'question');
    assert.equal(calls.length, 1); assert.equal(calls[0].requestId, 'question-1');
    assert.deepEqual(calls[0].response, webSearchAnswer(question, index));
    assert.match(f.text, /1\. 允许联网搜索/); assert.match(f.text, /2\. 选择其他搜索服务/); assert.match(f.text, /3\. 禁用联网搜索/);
    assert.doesNotMatch(f.text, /JSON|questionId|optionIds|customValues|类型化答案/);
    for (const id of [question.questions[0].questionId, ...question.questions[0].input.options.map(option => option.optionId)]) assert.ok(!f.text.includes(id));
  }
});

test('OpenCode web-search menu maps current IDs despite reordered native options, also in writer stage', async t => {
  const question = webSearchQuestion(), field = question.questions[0];
  const allowId = field.input.options[0].optionId;
  field.input.options = [field.input.options[2], field.input.options[0], field.input.options[1]];
  question.description = field.question; field.question = 'Search provider';
  field.description = 'Native context: your queries are sent to the selected search service.';
  const f = await fixture(t, [{}, { command: '[question]', question }]);
  const result = await f.start(['yes', ...selection('codex'), ...selection('opencode'), '允许']);
  assert.equal(result.status, 'completed');
  assert.match(f.text, /Native context: your queries are sent to the selected search service\./);
  assert.deepEqual(f.platform.runtimes[1].calls.filter(call => call.operation === 'question').map(call => call.response), [
    { action: 'answer', answers: [{ questionId: field.questionId, kind: 'selection', optionIds: [allowId], customValues: [] }] },
  ]);
});

test('blank or invalid web-search input re-prompts and never implicitly agrees', async t => {
  const question = webSearchQuestion(), f = await fixture(t, [{ command: '[question]', question }]);
  const pending = f.start(['yes', ...selection('opencode')], false);
  await until(() => f.prompts.some(prompt => prompt.startsWith('联网搜索选择')));
  assert.ok(!f.platform.runtimes[0].calls.some(call => call.operation === 'question'));
  f.input.write('\n9\nmaybe\n');
  await until(() => f.prompts.filter(prompt => prompt.startsWith('联网搜索选择')).length === 4);
  assert.ok(!f.platform.runtimes[0].calls.some(call => call.operation === 'question'));
  f.input.end(['允许', ...selection('pi')].join('\n') + '\n');
  assert.equal((await pending).status, 'completed');
  assert.deepEqual(f.platform.runtimes[0].calls.filter(call => call.operation === 'question').map(call => call.response), [webSearchAnswer(question, 0)]);
});

test('web-search Core validation errors allow re-selection without a new Turn or automatic retry', async t => {
  const question = webSearchQuestion(), replies = [];
  const f = await fixture(t, [{ command: '[question]', question, onQuestionReply(requestId, response) {
    replies.push({ requestId, response });
    if (replies.length === 1) throw new MuhaError({ code: 'INVALID_ARGUMENT', message: 'Controlled rejection' });
  } }]);
  const result = await f.start(['yes', ...selection('opencode'), '1', '禁用', ...selection('pi')]);
  assert.equal(result.status, 'completed'); assert.match(f.text, /Core 校验/);
  assert.deepEqual(replies.map(reply => reply.response), [webSearchAnswer(question, 0), webSearchAnswer(question, 2)]);
  assert.equal(f.platform.calls.filter(call => call.operation === 'submitted').length, 2);
});

test('web-search dismiss remains whole-request dismissal, not disabling search', async t => {
  const f = await fixture(t, [{ command: '[question]', question: webSearchQuestion() }]);
  assert.equal((await f.start(['yes', ...selection('opencode'), 'dismiss', ...selection('pi')])).status, 'completed');
  assert.deepEqual(f.platform.runtimes[0].calls.filter(call => call.operation === 'question').map(call => call.response), [{ action: 'dismiss' }]);
});

test('web-search q, EOF and cancellation interrupt and clean up without answering or starting writer', async t => {
  for (const action of ['q', 'EOF', 'abort']) {
    const f = await fixture(t, [{ command: '[question]', question: webSearchQuestion() }]);
    const pending = f.start(['yes', ...selection('opencode'), ...(action === 'q' ? ['q'] : [])], action !== 'abort');
    if (action === 'abort') {
      await until(() => f.prompts.some(prompt => prompt.startsWith('联网搜索选择')));
      f.controller.abort();
    }
    assert.equal((await pending).status, 'interrupted'); assertNoWriter(f);
    assert.ok(!f.platform.runtimes[0].calls.some(call => call.operation === 'question'));
    assert.ok(f.platform.runtimes[0].calls.some(call => call.operation === 'interrupt'));
    assert.equal(f.platform.runtimes[0].status, 'closed');
  }
});

test('another harness with the same web-search wording keeps its ordinary typed Question interface', async t => {
  const question = webSearchQuestion(), response = webSearchAnswer(question, 0);
  const f = await fixture(t, [{ command: '[question]', question }]);
  const result = await f.start(['yes', ...selection('kimi', 'k3'), '允许', JSON.stringify(response), ...selection('pi')]);
  assert.equal(result.status, 'completed'); assert.match(f.text, /JSON 无效/);
  assert.ok(!f.text.includes('OpenCode 联网搜索设置'));
  assert.deepEqual(f.platform.runtimes[0].calls.filter(call => call.operation === 'question').map(call => call.response), [response]);
});

test('unrelated OpenCode Questions still require explicit typed JSON rather than web-search aliases', async t => {
  const f = await fixture(t, [{ command: '[question]' }]);
  const response = { action: 'answer', answers: [{ questionId: 'field-1', kind: 'text', text: 'Explicit text' }] };
  assert.equal((await f.start(['yes', ...selection('opencode'), '允许', JSON.stringify(response), ...selection('pi')])).status, 'completed');
  assert.match(f.text, /JSON 无效/); assert.ok(!f.text.includes('OpenCode 联网搜索设置'));
  assert.deepEqual(f.platform.runtimes[0].calls.filter(call => call.operation === 'question').map(call => call.response), [response]);
});

test('changed web-search shapes use the generic interface without guessing or submitting defaults', async t => {
  for (const variant of ['hidden', 'multiple', 'custom', 'unknown-option']) {
    const question = webSearchQuestion(), field = question.questions[0];
    if (variant === 'hidden') field.hidden = true;
    if (variant === 'multiple') question.questions.push({ ...structuredClone(field), questionId: randomUUID(), question: 'Another selection' });
    if (variant === 'custom') field.input.allowCustom = true;
    if (variant === 'unknown-option') field.input.options[0].label = 'A different operation';
    const f = await fixture(t, [{ command: '[question]', question }]);
    const result = await f.start(['yes', ...selection('opencode'), 'dismiss', ...selection('pi')]);
    assert.equal(result.status, 'completed'); assert.ok(!f.text.includes('OpenCode 联网搜索设置'));
    assert.ok(f.prompts.some(prompt => prompt.startsWith('Question 答案')));
    assert.deepEqual(f.platform.runtimes[0].calls.filter(call => call.operation === 'question').map(call => call.response), [{ action: 'dismiss' }]);
  }
});

test('Questions wait for explicit JSON/dismiss and recover malformed JSON and invalid Core answers', async t => {
  const f = await fixture(t, [{ command: '[question]' }]), pending = f.start(['yes', ...selection()], false);
  await until(() => f.text.includes('模型需要你的回答'));
  assert.ok(!f.platform.runtimes[0].calls.some(call => call.operation === 'question'));
  f.input.end(['not json', '{"action":"invalid"}', 'dismiss', ...selection('pi')].join('\n') + '\n');
  assert.equal((await pending).status, 'completed');
  assert.match(f.text, /JSON 无效/); assert.match(f.text, /Core 校验/);
  const calls = f.platform.runtimes[0].calls.filter(call => call.operation === 'question');
  assert.deepEqual(calls.map(call => call.response.action), ['invalid', 'dismiss']);
  assert.match(f.text, /useDefault/); assert.match(f.text, /externalAcknowledged/);
  assert.match(f.text, /field-1: Fixture question/);
  assert.doesNotMatch(f.text, /"action"|"answers"|"questions"|question\.requested/);
});

test('q during a pending Question interrupts and drains rather than dismissing or auto-answering', async t => {
  const f = await fixture(t, [{ command: '[question]' }]), result = await f.start(['yes', ...selection(), 'q']);
  assert.equal(result.status, 'interrupted'); assertNoWriter(f);
  assert.ok(!f.platform.runtimes[0].calls.some(call => call.operation === 'question'));
  assert.equal(f.platform.runtimes[0].status, 'closed');
});

test('edited typed Question JSON is forwarded exactly and never answered automatically', async t => {
  const response = { action: 'answer', answers: [{ questionId: 'field-1', kind: 'text', text: 'My explicit answer' }] };
  const f = await fixture(t, [{ command: '[question]' }]);
  const result = await f.start(['yes', ...selection(), JSON.stringify(response), ...selection('pi')]);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.platform.runtimes[0].calls.filter(call => call.operation === 'question').map(call => call.response), [response]);
});

test('Ctrl+C equivalent abort at a waiting Question cancels terminal input and reclaims the Turn', async t => {
  const f = await fixture(t, [{ command: '[question]' }]), pending = f.start(['yes', ...selection()], false);
  await until(() => f.prompts.some(prompt => prompt.startsWith('Question 答案')));
  f.controller.abort();
  assert.equal((await pending).status, 'interrupted'); assertNoWriter(f);
  assert.ok(!f.platform.runtimes[0].calls.some(call => call.operation === 'question'));
  assert.ok(f.platform.runtimes[0].calls.some(call => call.operation === 'interrupt'));
  assert.equal(f.platform.runtimes[0].status, 'closed');
});

test('cleanup failure is observable, blocks writer and does not claim successful reclamation', async t => {
  const f = await fixture(t, [{ closeFails: true }]), result = await f.start();
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'EXAMPLE_CLEANUP_FAILED');
  assert.match(f.text, /不宣称原生进程已回收/); assertNoWriter(f);
});

test('a final artifact symlink cannot overwrite an external file or advance to writer', async t => {
  const f = await fixture(t, [{ beforeTerminal: async session => {
    await symlink(join(f.root, 'outside.txt'), join(session.reference.workspacePath, 'topic.md'));
  } }]);
  await writeFile(join(f.root, 'outside.txt'), 'preserve');
  const result = await f.start();
  assert.equal(result.status, 'failed'); assertNoWriter(f);
  assert.equal(await readFile(join(f.root, 'outside.txt'), 'utf8'), 'preserve');
});

test('terminal control sequences are stripped only on display, not saved raw replies or handoff', async t => {
  const topic = '\u001b[31mCOLOR\u001b[0m\u001b]52;c;payload\u0007\u0000\n';
  assert.equal(terminalText(topic), 'COLOR\n');
  const f = await fixture(t, [{ text: topic }]), result = await f.start();
  assert.equal(result.status, 'completed'); assert.doesNotMatch(f.text, /[\u0000\u0007\u001b]/);
  assert.equal(await readFile(join(result.workspacePath, 'topic.md'), 'utf8'), topic);
  assert.equal(f.platform.calls.filter(call => call.operation === 'submitted')[1].input[0].text, stagePrompt('writer', topic));
});

test('authoritative corrected final reply is printed and saved instead of trusting deltas', async t => {
  const f = await fixture(t, [{ delta: 'STREAMED_UNIQUE_TEXT', text: 'CORRECTED_UNIQUE_FINAL' }]), result = await f.start();
  assert.equal(result.status, 'completed');
  assert.equal(f.text.split('STREAMED_UNIQUE_TEXT').length - 1, 1);
  assert.equal(f.text.split('CORRECTED_UNIQUE_FINAL').length - 1, 1);
  assert.equal(await readFile(join(result.workspacePath, 'topic.md'), 'utf8'), 'CORRECTED_UNIQUE_FINAL');
  assert.match(f.text, /STREAMED_UNIQUE_TEXT\nCORRECTED_UNIQUE_FINAL/);
});

test('hidden Tool and reasoning events never interrupt contiguous assistant text', async t => {
  const topic = 'UNINTERRUPTED_MODEL_OUTPUT';
  const f = await fixture(t, [{ text: topic, interleaved: true, retries: 5 }]), result = await f.start();
  assert.equal(result.status, 'completed');
  assert.equal(f.text.split(topic).length - 1, 1);
  assert.doesNotMatch(f.text, /HIDDEN_TOOL_RESULT|HIDDEN_REASONING|toolCallId|retryNumber|sequence|timestamp/);
  assert.equal(await readFile(join(result.workspacePath, 'topic.md'), 'utf8'), topic);
});

test('final-only Harness still prints its authoritative reply once without event envelopes', async t => {
  const topic = 'FINAL_ONLY_MODEL_OUTPUT';
  const f = await fixture(t, [{ text: topic, finalOnly: true }]), result = await f.start();
  assert.equal(result.status, 'completed');
  assert.equal(f.text.split(topic).length - 1, 1);
  assert.doesNotMatch(f.text, /assistant\.message|turn\.completed|messageId|turnId/);
});

test('JSON authored by the model is preserved as output, unlike hidden SDK event JSON', async t => {
  const topic = '{"topic":"native model reply"}';
  const f = await fixture(t, [{ text: topic }]), result = await f.start();
  assert.equal(result.status, 'completed');
  assert.equal(f.text.split(topic).length - 1, 1);
  assert.equal(await readFile(join(result.workspacePath, 'topic.md'), 'utf8'), topic);
  assert.equal(f.platform.calls.filter(call => call.operation === 'submitted')[1].input[0].text, stagePrompt('writer', topic));
});

test('readline queues early piped answers, handles EOF and close never ends stdout', async () => {
  const input = new PassThrough(), output = new PassThrough(), io = createCommandLine(input, output);
  try {
    input.end('first\n\nthird\n');
    await new Promise(done => setImmediate(done));
    const signal = new AbortController().signal;
    assert.equal(await io.ask('one: ', signal), 'first');
    assert.equal(await io.ask('two: ', signal), '');
    assert.equal(await io.ask('three: ', signal), 'third');
    await assert.rejects(io.ask('four: ', signal), /Workflow interrupted/);
    io.close(); io.close(); assert.equal(output.writableEnded, false);
  } finally { io.close(); input.destroy(); output.destroy(); }
});

test('readline pending question honors AbortSignal and rejects concurrent prompts', async () => {
  const input = new PassThrough(), output = new PassThrough(), controller = new AbortController();
  const io = createCommandLine(input, output);
  try {
    const pending = io.ask('answer: ', controller.signal);
    await assert.rejects(io.ask('concurrent: ', controller.signal), /另一个命令行问题/);
    controller.abort(); await assert.rejects(pending, /Workflow interrupted/);
    io.close();
  } finally { io.close(); input.destroy(); output.destroy(); }
});

test('standalone command consumes real stdin; declining exits without download/model/service', async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'examples/auto-social-media/main.ts'], {
    cwd: new URL('../..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  child.stdin.end('no\n');
  assert.deepEqual(await done, { code: 0, signal: null });
  assert.match(stdout, /未授权/); assert.equal(stderr, '');
});

test('pinned downloader checks all bytes, retains MIT/license/references and does not execute scripts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muha-skill-download-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const contents = ['---\nname: sample\n---\n', 'MIT fixture text', 'Reference fixture'];
  const skill = { name: 'sample', repository: 'owner/repo', revision: 'a'.repeat(40),
    files: ['SKILL.md', 'LICENSE', 'references/sample.md'].map((local, i) => ({ remote: local, local,
      sha256: createHash('sha256').update(contents[i]).digest('hex') })) };
  const urls = [], controller = new AbortController();
  const source = await downloadPinnedSkill(skill, root, controller.signal, async (url, options) => {
    const i = urls.length; urls.push(url); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    return new Response(contents[i]);
  });
  assert.ok(urls.every(url => url.includes('/' + skill.revision + '/')));
  for (let i = 0; i < skill.files.length; i++) assert.equal(await readFile(join(source, skill.files[i].local), 'utf8'), contents[i]);
  assert.ok(!urls.some(url => url.endsWith('install.sh')));
  const failedRoot = await mkdtemp(join(root, 'bad-'));
  await assert.rejects(downloadPinnedSkill(skill, failedRoot, controller.signal, async () => new Response('tampered')), /checksum mismatch/);
  await assert.rejects(access(join(failedRoot, 'sample', 'SKILL.md')), { code: 'ENOENT' });
});

test('downloader HTTP errors, oversized responses and cancellation fail before installation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muha-skill-download-errors-')); t.after(() => rm(root, { recursive: true, force: true }));
  const skill = { name: 'sample', repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ remote: 'SKILL.md', local: 'SKILL.md', sha256: 'a'.repeat(64) }] };
  const signal = new AbortController().signal;
  await assert.rejects(downloadPinnedSkill(skill, root, signal, async () => new Response('missing', { status: 404 })), /Could not download/);
  await assert.rejects(downloadPinnedSkill(skill, root, signal, async () => new Response('a'.repeat(1024 * 1024 + 1))), /exceeds 1 MiB/);
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(downloadPinnedSkill(skill, root, controller.signal, async () => { called = true; return new Response(''); }));
  assert.equal(called, false);
});

test('fixed Skill manifest includes exact revisions, licenses and every referenced resource; prompts do not bind AIHOT', () => {
  assert.deepEqual(Object.values(PINNED_SKILLS).map(skill => skill.name), ['content-strategy', 'khazix-writer']);
  for (const skill of Object.values(PINNED_SKILLS)) {
    assert.match(skill.revision, /^[a-f0-9]{40}$/); assert.equal(skill.files.length, 4);
    assert.ok(skill.files.some(file => file.local === 'LICENSE'));
    assert.equal(skill.files.filter(file => file.local.startsWith('references/')).length, 2);
    for (const file of skill.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  const prompt = stagePrompt('topic', '', '2026-10-13');
  assert.match(prompt, /最近七天/); assert.match(prompt, /content-strategy/); assert.match(prompt, /不访问 AIHOT/);
  assert.match(stagePrompt('writer', 'raw topic'), /不要声称自己是卡兹克/);
  assert.ok(stagePrompt('writer', 'raw topic').endsWith('raw topic\n</topic-material>'));
});
