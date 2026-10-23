import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

for (const [label, root] of [
  ['windows release', '../plugins/codex-control-plugin/runtime'],
]) {
  const { CodexDeviceAgent, AppTools, defaultSessionIndexPath, readSessionIndex } = await import(`${root}/agent-core/index.mjs`);
  const { DesktopIPC, DesktopTasks } = await import(`${root}/desktop-ipc/index.mjs`);

  for (const failure of ['discovery', 'listing']) {
    test(`${label}: Windows still syncs real IPC state when app tools ${failure} fails`, async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agent-connectivity-'));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const read = fs.readFileSync;
      t.mock.method(fs, 'readFileSync', (file, ...args) => file === defaultSessionIndexPath()
        ? JSON.stringify({ id: 'thread-test', thread_name: 'Local task', updated_at: '2026-10-23T00:00:00Z' })
        : read(file, ...args));
      const ipc = new EventEmitter();
      ipc.socket = { writable: true };
      ipc.close = () => { ipc.socket = null; };
      t.mock.method(DesktopIPC.prototype, 'connect', async () => ipc);
      let toolCalls = 0;
      t.mock.method(AppTools, 'discover', async () => {
        if (failure === 'discovery') throw new Error('Codex app tools pipe was not found');
        return { listThreads: async () => { toolCalls++; throw new Error('tools/list is unavailable'); } };
      });
      t.mock.method(DesktopTasks.prototype, 'snapshot', async () => ({
        title: 'Live IPC task', updatedAt: 1_792_713_600_000,
        threadRuntimeStatus: { type: 'active' },
        turns: [{ turnId: 'turn-test', turnStartedAtMs: 1_792_713_600_000 }],
        requests: [],
      }));
      const agent = new CodexDeviceAgent({ relayUrl: 'https://relay.example.test', deviceToken: 'test-only', configPath: path.join(directory, 'agent.json') }, { platform: 'win32' });
      t.after(() => agent.close());
      agent.rollouts.read = () => null;
      const synced = [];
      agent.relay = { sync: async state => synced.push(state), commands: async () => [] };
      await agent.cycle();
      await agent.cycle();
      assert.equal(synced.length, 2);
      assert.equal(synced[0].tasks[0].title, 'Live IPC task');
      assert.equal(synced[0].tasks[0].threadId, 'thread-test');
      assert.equal(toolCalls, failure === 'listing' ? 1 : 0);
      assert.equal(agent.appTools, null);
    });
  }

  test(`${label}: a missing session index on first launch is an empty task list`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agent-empty-index-'));
    try { assert.deepEqual(readSessionIndex(path.join(directory, 'session_index.jsonl')), []); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test(`${label}: an unavailable desktop cannot report a successful sync`, async t => {
    const agent = Object.assign(Object.create(CodexDeviceAgent.prototype), {
      relay: { sync: async () => assert.fail('must not pretend the desktop is online') },
    });
    t.mock.method(DesktopIPC.prototype, 'connect', async () => { throw new Error('connect ENOENT codex-ipc'); });
    await assert.rejects(agent.cycle(), /ENOENT/);
  });
}
