import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DesktopLifecycle } from '../plugins/codex-control-plugin/scripts/macos-lifecycle.mjs';

const root = fileURLToPath(new URL('../plugins/codex-control-plugin/', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, options = {}) {
  const children = [], signals = [], errors = [];
  let stops = 0;
  const controller = new DesktopLifecycle({
    launch: () => { const child = new EventEmitter(); children.push(child); return child; },
    terminate: (child, signal) => signals.push({ child, signal }),
    onStopped: () => stops++, onError: error => errors.push(error),
    retryMs: 15, killAfterMs: 30, ...options,
  });
  t.after(async () => {
    const closing = controller.close();
    controller.child?.emit('close', 0);
    await closing;
  });
  return { controller, children, signals, errors, stops: () => stops };
}

test('desktop launch starts one worker and termination stops it immediately', t => {
  const f = fixture(t);
  f.controller.setRunning(false);
  assert.equal(f.children.length, 0, 'The agent must stay stopped while Codex is closed');
  f.controller.setRunning(true);
  f.controller.setRunning(true);
  assert.equal(f.children.length, 1);
  f.controller.setRunning(false);
  assert.equal(f.signals[0].signal, 'SIGTERM', 'Do not wait for the old 90-second IPC grace period');
  f.children[0].emit('close', 0);
  assert.equal(f.controller.child, null);
  assert.equal(f.stops(), 2);
});

test('a quick desktop restart drains the old worker before starting a replacement', t => {
  const f = fixture(t);
  f.controller.setRunning(true);
  f.controller.setRunning(false);
  f.controller.setRunning(true);
  assert.equal(f.children.length, 1, 'No overlapping workers during a desktop restart');
  f.children[0].emit('close', 0);
  assert.equal(f.children.length, 2);
  assert.equal(f.controller.child, f.children[1]);
});

test('worker crashes retry only while the desktop remains open', async t => {
  const f = fixture(t);
  f.controller.setRunning(true);
  f.children[0].emit('close', 1);
  await sleep(40);
  assert.equal(f.children.length, 2);
  f.children[1].emit('close', 1);
  f.controller.setRunning(false);
  await sleep(40);
  assert.equal(f.children.length, 2, 'Closing Codex cancels crash recovery');
});

test('a hung worker is killed and closing the watcher cannot restart it', async t => {
  const f = fixture(t);
  f.controller.setRunning(true);
  const closing = f.controller.close();
  f.controller.setRunning(true);
  await sleep(60);
  assert.deepEqual(f.signals.map(item => item.signal), ['SIGTERM', 'SIGKILL']);
  f.children[0].emit('close', 0);
  await closing;
  await sleep(30);
  assert.equal(f.children.length, 1);
});

test('native lifecycle helper reports app presence without needing a chat or IPC connection', { skip: process.platform !== 'darwin' }, () => {
  const helper = path.join(root, 'runtime/macos/desktop-lifecycle-helper');
  const result = spawnSync(helper, ['--once', 'com.codexcontrol.nonexistent-lifecycle-test'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { running: false });
});

test('watcher starts, stops and restarts real worker groups with the desktop and cleans up on exit', { skip: process.platform !== 'darwin', timeout: 15_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lifecycle-test-'));
  const data = path.join(directory, 'data');
  const events = path.join(data, 'events.jsonl');
  const state = path.join(data, 'desktop-state.json');
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.mkdirSync(path.join(directory, 'runtime/macos'), { recursive: true });
  fs.writeFileSync(state, JSON.stringify({ running: false }));
  fs.writeFileSync(path.join(directory, 'observer.mjs'), `import fs from 'node:fs';
let previous;
setInterval(() => {
  const value = fs.readFileSync(${JSON.stringify(state)}, 'utf8');
  if (value !== previous) { previous = value; process.stdout.write(value + '\\n'); }
}, 20);
`);
  fs.writeFileSync(path.join(directory, 'runtime/macos/desktop-lifecycle-helper'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${path.join(directory, 'observer.mjs').replaceAll("'", "'\\''")}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, 'scripts/macos-agent.mjs'), `import fs from 'node:fs';
const file = ${JSON.stringify(events)};
const record = event => fs.appendFileSync(file, JSON.stringify({ event, pid: process.pid, supervised: process.env.CODEX_CONTROL_AGENT_DESKTOP_SUPERVISED }) + '\\n');
record('start');
process.once('SIGTERM', () => { record('stop'); process.exit(0); });
setInterval(() => {}, 1000);
`);
  const entry = path.join(directory, 'watch.mjs');
  fs.writeFileSync(entry, `import { watchDesktop } from ${JSON.stringify(new URL('../plugins/codex-control-plugin/scripts/macos-lifecycle.mjs', import.meta.url).href)};\nawait watchDesktop(${JSON.stringify(data)}, ${JSON.stringify(directory)});\n`);
  const watcher = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  watcher.stderr.on('data', value => { stderr += value; });
  const closed = new Promise(resolve => watcher.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    watcher.kill('SIGTERM');
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const records = () => fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const waitFor = async predicate => {
    const deadline = Date.now() + 4000;
    while (!predicate() && Date.now() < deadline) await sleep(20);
    assert.ok(predicate(), `Lifecycle event timed out: ${stderr}`);
  };
  await waitFor(() => fs.existsSync(path.join(data, 'status.json')));
  assert.equal(records().length, 0);
  fs.writeFileSync(state, JSON.stringify({ running: true }));
  await waitFor(() => records().filter(item => item.event === 'start').length === 1);
  assert.equal(records()[0].supervised, '1');
  fs.writeFileSync(state, JSON.stringify({ running: false }));
  await waitFor(() => records().some(item => item.event === 'stop'));
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(data, 'status.json'))).stopReason === 'codex-desktop-stopped');
  fs.writeFileSync(state, JSON.stringify({ running: true }));
  await waitFor(() => records().filter(item => item.event === 'start').length === 2);
  watcher.kill('SIGTERM');
  assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
  assert.deepEqual(records().map(item => item.event), ['start', 'stop', 'start', 'stop']);
  for (const pid of new Set(records().map(item => item.pid))) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'No worker may outlive the watcher');
  }
});
