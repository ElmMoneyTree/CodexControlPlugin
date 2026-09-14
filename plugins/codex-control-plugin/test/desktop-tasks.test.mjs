import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DesktopTasks } from '../runtime/desktop-ipc/tasks.mjs';

test('startTurn submits a version 2 follower request to the task owner', async () => {
  const requests = [];
  const ipc = Object.assign(new EventEmitter(), {
    request: async (method, params, options) => {
      requests.push({ method, params, options });
      return { result: { result: { turn: { id: 'turn-new', status: 'inProgress' } } } };
    },
    send: () => {},
  });
  const tasks = new DesktopTasks(ipc);
  tasks.owners.set('thread-target', 'desktop-owner');

  const result = await tasks.startTurn('thread-target', '  continue  ');

  assert.deepEqual(result, { turn: { id: 'turn-new', status: 'inProgress' } });
  assert.deepEqual(requests, [{
    method: 'thread-follower-start-turn',
    params: {
      conversationId: 'thread-target',
      turnStart: {
        request: {
          threadId: 'thread-target',
          turnTrigger: 'app_tool_send_message',
          input: [{ type: 'text', text: 'continue', text_elements: [] }],
        },
        context: { writingBlockContextPrepared: true },
      },
    },
    options: { targetClientId: 'desktop-owner', version: 2, timeoutMs: 120_000 },
  }]);
});

test('startTurn rejects blank input before contacting desktop', async () => {
  const ipc = Object.assign(new EventEmitter(), {
    request: async () => assert.fail('desktop must not be contacted for blank input'),
    send: () => {},
  });
  const tasks = new DesktopTasks(ipc);

  await assert.rejects(tasks.startTurn('thread-target', '   '), /Cannot send an empty message/);
});
