import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexDeviceAgent } from '../plugins/codex-control-plugin/runtime/agent-core/index.mjs';

function snapshot(threadId, turnId) {
  return {
    title: 'Target task',
    updatedAt: 1_700_000_000_000,
    turnHistory: {
      history: {
        entitiesByKey: {
          [`turn:${turnId}`]: { turnId, turnStartedAtMs: 1_700_000_000_000, items: [] },
        },
      },
    },
  };
}

test('send_message starts a target turn through desktop IPC', async () => {
  const completed = [];
  const sent = [];
  const agent = Object.assign(Object.create(CodexDeviceAgent.prototype), {
    snapshots: new Map(),
    journal: {
      get: () => null,
      begin: () => {},
      complete: (id, result) => completed.push({ id, result }),
    },
    tasks: {
      startTurn: async (threadId, text) => {
        sent.push({ threadId, text });
        return { accepted: true };
      },
      snapshot: async threadId => snapshot(threadId, 'turn-target'),
    },
  });

  const result = await agent.execute({ id: 'command-1', kind: 'send_message', threadId: 'thread-target', text: 'continue' });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ threadId: 'thread-target', text: 'continue' }]);
  assert.equal(completed[0].result.ok, true);
});

test('send_message returns a desktop IPC submission failure', async () => {
  const agent = Object.assign(Object.create(CodexDeviceAgent.prototype), {
    snapshots: new Map(),
    journal: { get: () => null, begin: () => {}, complete: () => {} },
    tasks: {
      startTurn: async () => { throw new Error('Target task is unavailable'); },
      snapshot: async () => assert.fail('snapshot must not run after a failed submission'),
    },
  });

  const result = await agent.execute({ id: 'command-2', kind: 'send_message', threadId: 'thread-empty', text: 'continue' });

  assert.equal(result.ok, false);
  assert.equal(result.result.error, 'Target task is unavailable');
});

test('send_message resumes an old task when desktop has no owner', async () => {
  const resumed = [];
  const agent = Object.assign(Object.create(CodexDeviceAgent.prototype), {
    snapshots: new Map(),
    journal: { get: () => null, begin: () => {}, complete: () => {} },
    tasks: {
      startTurn: async () => { throw new Error('no-client-found'); },
      snapshot: async () => { throw new Error('no-client-found'); },
    },
    resumeTask: async (threadId, text) => {
      resumed.push({ threadId, text });
      return { submitted: true, transport: 'codex-cli-resume' };
    },
  });

  const result = await agent.execute({ id: 'command-3', kind: 'send_message', threadId: '01a09e89-d2ed-7153-af31-78a8a3e252f6', text: 'continue' });

  assert.equal(result.ok, true);
  assert.deepEqual(resumed, [{ threadId: '01a09e89-d2ed-7153-af31-78a8a3e252f6', text: 'continue' }]);
});

test('command_approval is dispatched to the desktop task and journaled', async () => {
  const approvals = [];
  const completed = [];
  const agent = Object.assign(Object.create(CodexDeviceAgent.prototype), {
    snapshots: new Map(),
    journal: {
      get: () => null,
      begin: () => {},
      complete: (id, result) => completed.push({ id, result }),
    },
    tasks: {
      approveCommand: async (threadId, command) => {
        approvals.push({ threadId, command });
        return { submitted: true };
      },
    },
  });
  const command = {
    id: 'command-approval-1',
    kind: 'command_approval',
    threadId: 'thread-target',
    requestId: 'request-1',
    turnId: 'turn-1',
    decision: 'accept',
  };

  const result = await agent.execute(command);

  assert.deepEqual(result, { ok: true, result: { submitted: true } });
  assert.deepEqual(approvals, [{ threadId: 'thread-target', command }]);
  assert.deepEqual(completed, [{ id: 'command-approval-1', result }]);
});
