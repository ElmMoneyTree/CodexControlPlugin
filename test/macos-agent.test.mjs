import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimDevice, finishClaim, launchPlist, relayOrigin, agentStatus } from '../plugins/codex-control-plugin/scripts/macos-agent.mjs';
import { credentialAccount, ensurePrivateDirectory } from '../plugins/codex-control-plugin/scripts/macos-storage.mjs';
import { daemonPipeName, readAgentConfig } from '../plugins/codex-control-plugin/scripts/daemon-lib.mjs';
import { defaultDesktopPath } from '../plugins/codex-control-plugin/runtime/desktop-ipc/ipc.mjs';
import { buildAgentState, extractLatestTurn } from '../plugins/codex-control-plugin/runtime/agent-core/src/state.mjs';

function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-macos-test-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const secrets = new Map();
  const keychain = { read: key => secrets.get(key), write: (key, value) => secrets.set(key, value), delete: key => secrets.delete(key) };
  const claim = { relayUrl: 'https://relay.example.test', id: 'claim-1', deviceName: 'Test Mac', devicePublicKey: 'public-key', deviceKeyFingerprint: 'ABCD-EFGH', expiresAt: Date.now() + 300_000, claimSecret: 'secret-link-value', pollToken: 'secret-poll-value', privateKeyPkcs8: 'secret-private-key' };
  let requests = 0, starts = 0;
  const pages = [];
  return { data, secrets, keychain, claim, pages, requestCount: () => requests, startCount: () => starts,
    dependencies: { keychain, requestClaim: async () => { requests++; return claim; }, start: () => starts++, open: (pending, secret) => pages.push({ pending, secret }) } };
}

test('Mac and Windows use their native desktop and daemon transports', () => {
  assert.equal(defaultDesktopPath('darwin', '/Users/test/.codex'), '/Users/test/.codex/ipc/ipc.sock');
  assert.equal(defaultDesktopPath('win32'), '\\\\.\\pipe\\codex-ipc');
  if (process.platform !== 'win32') {
    const socket = daemonPipeName('/very/long/'.repeat(30), 'darwin');
    assert.ok(Buffer.byteLength(socket) < 104);
    assert.notEqual(daemonPipeName('/One', 'darwin'), daemonPipeName('/one', 'darwin'));
  }
});

test('Mac claims keep all credentials in Keychain and safely resume the same QR code', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const options = { data: f.data, relayUrl: f.claim.relayUrl };
  const first = await claimDevice(options, f.dependencies);
  const second = await claimDevice(options, f.dependencies);
  assert.equal(first.resumed, false);
  assert.equal(second.resumed, true);
  assert.equal(f.requestCount(), 1);
  assert.equal(f.startCount(), 2);
  assert.equal(f.pages[1].secret, f.claim.claimSecret);
  const files = fs.readdirSync(f.data).map(name => fs.readFileSync(path.join(f.data, name), 'utf8')).join('');
  for (const secret of [f.claim.claimSecret, f.claim.pollToken, f.claim.privateKeyPkcs8]) {
    assert.equal(files.includes(secret), false);
    assert.equal(JSON.stringify([first, second]).includes(secret), false);
  }
  assert.equal(fs.statSync(f.data).mode & 0o777, 0o700);
  await assert.rejects(claimDevice({ ...options, relayUrl: 'https://other.example.test' }, f.dependencies), /different Relay/);
});

test('concurrent Mac claim requests create one identity', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const results = await Promise.all([claimDevice({ data: f.data }, f.dependencies), claimDevice({ data: f.data }, f.dependencies)]);
  assert.equal(f.requestCount(), 1);
  assert.equal(results.filter(result => result.resumed).length, 1);
});

test('approved Mac claim commits device credentials before removing pending claim', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  await claimDevice({ data: f.data, noBrowser: true }, f.dependencies);
  const pending = JSON.parse(fs.readFileSync(path.join(f.data, 'pending-claim.json')));
  const status = await finishClaim(f.data, pending, { keychain: f.keychain, fetchImpl: async (url, options) => {
    assert.equal(options.headers.authorization, `Claim ${f.claim.pollToken}`);
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ status: 'approved', deviceId: 'device-1', workspaceId: 'workspace-1', deviceToken: 'device-secret', relayUrl: f.claim.relayUrl }) };
  } });
  assert.equal(status, 'approved');
  const config = readAgentConfig(path.join(f.data, 'agent-config.json'));
  assert.equal(config.deviceId, 'device-1');
  assert.equal(config.secretStorage, 'macos-keychain');
  assert.equal(f.keychain.read(config.credentialAccount).deviceToken, 'device-secret');
  assert.equal(f.keychain.read(pending.credentialAccount), undefined);
  assert.equal(fs.existsSync(path.join(f.data, 'pending-claim.json')), false);
  assert.equal(JSON.stringify(config).includes('device-secret'), false);
  const result = await claimDevice({ data: f.data }, f.dependencies);
  assert.equal(result.state, 'already-claimed');
  assert.equal(f.requestCount(), 1);
});

test('Keychain write failure preserves pending claim for retry', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  await claimDevice({ data: f.data, noBrowser: true }, f.dependencies);
  const pending = JSON.parse(fs.readFileSync(path.join(f.data, 'pending-claim.json')));
  f.keychain.write = () => { throw new Error('Keychain locked'); };
  await assert.rejects(finishClaim(f.data, pending, { keychain: f.keychain, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'approved', deviceId: 'device-1', workspaceId: 'workspace-1', deviceToken: 'device-secret', relayUrl: f.claim.relayUrl }) }) }), /Keychain locked/);
  assert.equal(fs.existsSync(path.join(f.data, 'agent-config.json')), false);
  assert.equal(fs.existsSync(path.join(f.data, 'pending-claim.json')), true);
  assert.ok(f.keychain.read(pending.credentialAccount));
});

test('launchd configuration escapes paths and contains no device credentials', () => {
  const plist = launchPlist('/Users/Test & Mac/Data', '/Applications/Test & App/node', '/Plugin <root>');
  assert.ok(plist.includes('Test &amp; Mac'));
  assert.ok(plist.includes('Plugin &lt;root&gt;'));
  assert.ok(plist.includes('<key>KeepAlive</key><true/>'));
  assert.ok(plist.includes('<string>watch</string>'));
  assert.equal(plist.includes('deviceToken'), false);
  assert.equal(plist.includes('claimSecret'), false);
});

test('connection origin rejects insecure remote services and credentials', () => {
  assert.equal(relayOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/#secret']) assert.throws(() => relayOrigin(url));
});

test('new desktop tail entities expose latest turn, messages, and caller context', () => {
  const latest = { turnId: 'new-turn', turnStartedAtMs: 200, status: 'completed', items: [{ type: 'agentMessage', text: 'Task finished' }] };
  const snapshot = { turnHistory: { history: { entitiesByKey: { 'turn:older': { turnId: 'old-turn', turnStartedAtMs: 100 }, 'tail:0:local:uuid': latest } } } };
  assert.equal(extractLatestTurn(snapshot).turnId, 'new-turn');
  const state = buildAgentState([{ id: 'thread', status: 'idle' }], new Map([['thread', snapshot]]));
  assert.equal(state.callerContexts[0].turnId, 'new-turn');
  assert.equal(state.tasks[0].latestMessage, 'Task finished');
});

test('private Mac state rejects a symlink directory and reports stale connectivity', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const link = path.join(f.data, 'link');
  fs.symlinkSync(f.data, link);
  assert.throws(() => ensurePrivateDirectory(link), /must belong/);
  fs.writeFileSync(path.join(f.data, 'status.json'), JSON.stringify({ state: 'connected', lastSyncAt: new Date(Date.now() - 60_000).toISOString() }));
  assert.equal(agentStatus(f.data).state, 'stale');
  assert.notEqual(credentialAccount(f.data, 'claim'), credentialAccount(f.data, 'device'));
});
