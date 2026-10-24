// In-memory browser/HTTP fixture. No CLI, SDK worker, provider, credentials or model calls.
import { randomUUID } from 'node:crypto';
import { MuhaError } from '@muha-sdk/muha';

export function fakeChatRuntime() {
  const calls = [], sessions = [];
  let resolveTermination;
  const runtime = {
    calls, sessions, status: 'active', runtimeId: 'controlled', dataDir: '/unused',
    enabledHarnesses: ['codex', 'opencode', 'kimi', 'pi', 'agy'],
    termination: new Promise(resolve => { resolveTermination = resolve; }),
    getHarnessCapabilities(harness) {
      const agy = harness === 'agy', pi = harness === 'pi';
      return {
        sessionListing: !agy, imageInput: !agy,
        approvalPolicies: agy || pi ? ['harnessManaged', 'autoApprove'] : ['interactive', 'autoDeny', 'autoApprove', 'harnessManaged'],
        turnQuestions: !agy && !pi, workspaceSkills: true, workspaceMcp: !agy && !pi,
        model: { listing: true, selectionAt: agy ? ['createSession', 'resumeSession'] : ['createSession', 'resumeSession', 'idleSession'], observation: 'selectedOnly' },
        effort: { selectionAt: agy ? ['createSession', 'resumeSession'] : ['createSession', 'resumeSession', 'idleSession'], observation: 'selectedOnly', requiresKnownModel: pi },
        assistantMessageStreaming: true, assistantReasoningStreaming: !agy, toolEvents: true, turnUsage: true,
      };
    },
    async createSession(options) {
      calls.push({ operation: 'create', options });
      if (runtime.createBarrier) await runtime.createBarrier;
      if (options.model === 'invalid-model') throw new MuhaError({ code: 'HARNESS_ERROR', harness: options.harness,
        operation: 'createSession', command: 'fixture', message: 'Invalid fixture model', retryable: false });
      const session = {
        reference: { harness: options.harness, sessionId: randomUUID(), workspacePath: options.workspacePath, route: 'native' },
        model: options.model ?? `${options.harness}/default`, effort: options.effort,
        status: { status: 'idle' }, turns: [],
        async setModel(model) {
          calls.push({ operation: 'setModel', model });
          if (runtime.selectionBarrier) await runtime.selectionBarrier;
          session.model = model; session.effort = undefined;
        },
        async setEffort(effort) {
          calls.push({ operation: 'setEffort', effort });
          if (effort === 'bad') throw new MuhaError({ code: 'HARNESS_ERROR', harness: options.harness,
            operation: 'setEffort', command: 'fixture', message: 'Unsupported fixture effort', retryable: false });
          session.effort = effort;
        },
        async startTurn(input) {
          calls.push({ operation: 'startTurn', sessionId: session.reference.sessionId, input });
          if (runtime.startBarrier) await runtime.startBarrier;
          const prompt = input[0].text;
          if (prompt === '[reject]') throw new MuhaError({ code: 'HARNESS_ERROR', harness: options.harness,
            operation: 'startTurn', command: 'fixture', message: 'Fixture rejected input', retryable: false });
          session.status = { status: 'running' };
          let finished, releaseGate, resolveResult, sequence = 0;
          const gate = new Promise(resolve => { releaseGate = resolve; });
          const turnId = randomUUID(), message = { id: randomUUID(), text: `reply: ${prompt}` };
          const makeEvent = event => ({ turnId, sequence: ++sequence, timestamp: new Date().toISOString(), ...event });
          const turn = {
            turnId,
            result: new Promise(resolve => { resolveResult = resolve; }),
            async interrupt() {
              calls.push({ operation: 'interrupt', turnId });
              finished = { status: 'interrupted', turnId, reason: 'caller' }; releaseGate();
            },
            async respondToApproval(requestId, decision) {
              calls.push({ operation: 'approval', requestId, decision });
              if (requestId !== 'approval-1') throw new MuhaError({ code: 'INVALID_ARGUMENT', message: 'Unknown fixture approval' });
              releaseGate();
            },
            async respondToQuestion(requestId, response) {
              calls.push({ operation: 'question', requestId, response });
              if (response.action !== 'answer' && response.action !== 'dismiss') {
                throw new MuhaError({ code: 'INVALID_ARGUMENT', message: 'Invalid fixture answer' });
              }
              releaseGate();
            },
            async *[Symbol.asyncIterator]() {
              yield makeEvent({ type: 'turn.started' });
              if (prompt === '[approval]') {
                yield makeEvent({ type: 'approval.requested', requestId: 'approval-1', title: 'Fixture approval' });
                await gate;
                yield makeEvent({ type: 'approval.resolved', requestId: 'approval-1', outcome: 'deny', source: 'caller' });
              }
              if (prompt === '[question]') {
                yield makeEvent({ type: 'question.requested', requestId: 'question-1', questions: [{
                  questionId: 'field-1', question: 'Fixture question', input: { kind: 'text' }, required: true,
                  hidden: false, default: { kind: 'none' }, when: [],
                }] });
                await gate;
                yield makeEvent({ type: 'question.resolved', requestId: 'question-1', outcome: 'dismissed', source: 'caller' });
              }
              if (prompt === '[hold]') await gate;
              if (!finished && prompt === '[fail]') {
                finished = { status: 'failed', turnId, error: { code: 'HARNESS_ERROR', message: 'Fixture failure' } };
              }
              if (!finished) {
                if (prompt === '[events]') {
                  yield makeEvent({ type: 'assistant.message.started', messageId: message.id });
                  yield makeEvent({ type: 'assistant.reasoning.delta', messageId: message.id, delta: 'First inspect the project. ' });
                  yield makeEvent({ type: 'assistant.reasoning.delta', messageId: message.id, delta: 'Then summarize the findings.' });
                  yield makeEvent({ type: 'tool.started', toolCallId: 'tool-1', toolName: 'Read', input: { path: 'README.md' } });
                  yield makeEvent({ type: 'tool.updated', toolCallId: 'tool-1', update: { progress: 'reading' } });
                  yield makeEvent({ type: 'tool.completed', toolCallId: 'tool-1', output: 'Muha SDK project overview', isError: false });
                  yield makeEvent({ type: 'usage.updated', usage: { inputTokens: 128, outputTokens: 64 } });
                }
                if (prompt === '[multi]') {
                  const previous = { id: randomUUID(), text: 'An intermediate assistant message.' };
                  yield makeEvent({ type: 'assistant.message.started', messageId: previous.id });
                  yield makeEvent({ type: 'assistant.message.completed', message: previous });
                }
                if (prompt !== '[events]') yield makeEvent({ type: 'assistant.message.started', messageId: message.id });
                yield makeEvent({ type: 'assistant.message.delta', messageId: message.id, delta: message.text });
                yield makeEvent({ type: 'assistant.message.completed', message });
                finished = { status: 'completed', turnId, message };
              }
              session.status = { status: 'idle' };
              resolveResult(finished);
              yield makeEvent(finished.status === 'completed' ? { type: 'turn.completed', message } :
                finished.status === 'failed' ? { type: 'turn.failed', error: finished.error } :
                  { type: 'turn.interrupted', reason: finished.reason });
            },
          };
          session.turns.push(turn);
          return turn;
        },
        async close() { calls.push({ operation: 'sessionClose' }); session.status = { status: 'closed' }; },
      };
      sessions.push(session);
      return session;
    },
    async close() {
      calls.push({ operation: 'runtimeClose' }); runtime.status = 'closed';
      for (const session of sessions) if (session.status.status === 'running') await session.turns.at(-1).interrupt();
      resolveTermination({ reason: 'callerClosed' });
    },
  };
  return runtime;
}
