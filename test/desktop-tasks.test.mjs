import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DesktopTasks } from '../plugins/codex-control-plugin/runtime/desktop-ipc/tasks.mjs';

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

test('approveCommand validates the live request and replies to its desktop owner', async () => {
  const requests = [];
  const ipc = Object.assign(new EventEmitter(), {
    request: async (method, params, options) => {
      requests.push({ method, params, options });
      return { result: { submitted: true } };
    },
    send: () => {},
  });
  const tasks = new DesktopTasks(ipc);
  tasks.owners.set('thread-target', 'desktop-owner');
  tasks.snapshot = async () => ({
    requests: [{
      id: 'request-1',
      method: 'item/commandExecution/requestApproval',
      params: { turnId: 'turn-1', availableDecisions: ['accept', 'decline'] },
    }],
  });

  const result = await tasks.approveCommand('thread-target', {
    requestId: 'request-1', turnId: 'turn-1', decision: 'accept',
  });

  assert.deepEqual(result, { submitted: true });
  assert.deepEqual(requests, [{
    method: 'thread-follower-command-approval-decision',
    params: { conversationId: 'thread-target', requestId: 'request-1', decision: 'accept' },
    options: { targetClientId: 'desktop-owner' },
  }]);
});

test('approveCommand rejects a decision that the live request does not offer', async () => {
  const ipc = Object.assign(new EventEmitter(), {
    request: async () => assert.fail('desktop reply must not be sent for an unavailable decision'),
    send: () => {},
  });
  const tasks = new DesktopTasks(ipc);
  tasks.owners.set('thread-target', 'desktop-owner');
  tasks.snapshot = async () => ({
    requests: [{
      id: 'request-1',
      method: 'item/commandExecution/requestApproval',
      params: { turnId: 'turn-1', availableDecisions: ['decline'] },
    }],
  });

  await assert.rejects(tasks.approveCommand('thread-target', {
    requestId: 'request-1', turnId: 'turn-1', decision: 'accept',
  }), /Decision not offered by desktop/);
});

test('approvePermissions returns only the permissions requested by desktop', async () => {
  const requests = [];
  const requestedPermissions = {
    fileSystem: { read: ['/workspace'], write: ['/workspace/output'] },
    network: { hosts: ['api.example.test'] },
  };
  const ipc = Object.assign(new EventEmitter(), {
    request: async (method, params, options) => {
      requests.push({ method, params, options });
      return { result: { submitted: true } };
    },
    send: () => {},
  });
  const tasks = new DesktopTasks(ipc);
  tasks.owners.set('thread-target', 'desktop-owner');
  tasks.snapshot = async () => ({
    requests: [{
      id: 'permission-1',
      method: 'item/permissions/requestApproval',
      params: { turnId: 'turn-1', permissions: requestedPermissions },
    }],
  });

  const result = await tasks.approvePermissions('thread-target', {
    requestId: 'permission-1', turnId: 'turn-1', decision: 'accept',
  });

  assert.deepEqual(result, { submitted: true });
  assert.deepEqual(requests, [{
    method: 'thread-follower-permissions-request-approval-response',
    params: {
      conversationId: 'thread-target',
      requestId: 'permission-1',
      response: { permissions: requestedPermissions, scope: 'turn' },
    },
    options: { targetClientId: 'desktop-owner' },
  }]);
  assert.notEqual(requests[0].params.response.permissions, requestedPermissions);
});
