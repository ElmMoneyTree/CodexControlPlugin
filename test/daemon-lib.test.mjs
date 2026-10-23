import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  daemonPipeName,
  isDesktopUnavailable,
  parseDaemonArguments,
  publicAgentConfig,
  readAgentConfig,
  writeStatus,
} from '../plugins/codex-control-plugin/scripts/daemon-lib.mjs';
import { createPublicKey, verify } from 'node:crypto';
import { createDeviceProof, DEVICE_CLAIM_PROOF_CONTEXT, requestDeviceClaim } from '../plugins/codex-control-plugin/scripts/create-device-claim.mjs';

test('daemon arguments require and normalize the data directory', () => {
  const parsed = parseDaemonArguments(['--data', '.', '--stop']);
  assert.equal(parsed.dataDirectory, path.resolve('.'));
  assert.equal(parsed.stop, true);
  assert.throws(() => parseDaemonArguments([]), /--data is required/);
  assert.throws(() => parseDaemonArguments(['--unknown']), /Unknown Agent option/);
});

test('daemon lock pipe is stable per data directory', () => {
  assert.equal(daemonPipeName('C:\\One', 'win32'), daemonPipeName('c:\\one', 'win32'));
  assert.notEqual(daemonPipeName('C:\\One', 'win32'), daemonPipeName('C:\\Two', 'win32'));
  assert.match(daemonPipeName('C:\\One', 'win32'), /^\\\\\.\\pipe\\codex-control-agent-[a-f0-9]{24}$/);
});

test('agent config validation never exposes the encrypted token publicly', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-plugin-config-'));
  const configPath = path.join(directory, 'agent-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    relayUrl: 'https://relay.example.test',
    deviceId: 'device-1',
    encryptedDeviceToken: 'ciphertext',
    name: 'Device one',
    accountLabel: 'account',
  }));
  const config = readAgentConfig(configPath);
  assert.deepEqual(publicAgentConfig(config), {
    relayUrl: 'https://relay.example.test', deviceId: 'device-1', name: 'Device one', accountLabel: 'account',
  });
  assert.equal('encryptedDeviceToken' in publicAgentConfig(config), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('desktop availability uses both the live socket and transport error', () => {
  const error = Object.assign(new Error('connect ENOENT \\\\.\\pipe\\codex-ipc'), { code: 'ENOENT' });
  assert.equal(isDesktopUnavailable(error, { ipc: { socket: { writable: false } } }), true);
  assert.equal(isDesktopUnavailable(error, { ipc: { socket: { writable: true } } }), false);
  assert.equal(isDesktopUnavailable(new Error('Relay returned 503'), {}), false);
});

test('status writes atomically as JSON', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-plugin-status-'));
  const statusPath = path.join(directory, 'status.json');
  writeStatus(statusPath, { state: 'connected', taskCount: 4 });
  assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, 'utf8')), { state: 'connected', taskCount: 4 });
  assert.deepEqual(fs.readdirSync(directory), ['status.json']);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('device claim proof binds the key, nonce, name, and private key', () => {
  const result = createDeviceProof('Office PC');
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: result.devicePublicKey }, format: 'jwk' });
  const message = `${DEVICE_CLAIM_PROOF_CONTEXT}\n${result.devicePublicKey}\n${result.nonce}\nOffice PC`;
  assert.equal(verify(null, Buffer.from(message), publicKey, Buffer.from(result.proof, 'base64url')), true);
  assert.ok(result.privateKeyPkcs8.length > 40);
});

test('device claim request sends no private key to the service', async () => {
  let requestBody;
  const result = await requestDeviceClaim({
    relayUrl: 'https://relay.example.test',
    deviceName: 'Office PC',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: 'claim-1', claimSecret: 'secret', pollToken: 'poll', claimUrl: 'https://relay.example.test/claim/claim-1#secret=secret', deviceKeyFingerprint: 'ABCD-EFGH', expiresAt: 123 }) };
    },
  });
  assert.equal('privateKeyPkcs8' in requestBody, false);
  assert.equal(result.relayUrl, 'https://relay.example.test');
  assert.ok(result.privateKeyPkcs8);
});

test('legacy migration authenticates the claim without putting the token in its body', async () => {
  let requestBody, requestHeaders;
  await requestDeviceClaim({
    relayUrl: 'https://relay.example.test',
    deviceName: 'Legacy PC',
    deviceToken: 'legacy-device-secret',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      requestHeaders = options.headers;
      return { ok: true, json: async () => ({ id: 'claim-2', claimSecret: 'secret', pollToken: 'poll', claimUrl: 'https://relay.example.test/claim/claim-2#secret=secret', deviceKeyFingerprint: 'IJKL-MNOP', expiresAt: 456, migration: true }) };
    },
  });
  assert.equal(requestHeaders.authorization, 'Bearer legacy-device-secret');
  assert.equal(JSON.stringify(requestBody).includes('legacy-device-secret'), false);
  assert.equal('privateKeyPkcs8' in requestBody, false);
});
