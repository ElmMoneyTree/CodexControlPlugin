import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexDeviceAgent } from '../runtime/agent-core/index.mjs';

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
