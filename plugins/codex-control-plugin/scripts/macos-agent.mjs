import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { requestDeviceClaim } from './create-device-claim.mjs';
import { MacKeychain, credentialAccount, ensurePrivateDirectory } from './macos-storage.mjs';
import { writeStatus, appendLog } from './daemon-lib.mjs';
import { DesktopIPC } from '../runtime/desktop-ipc/index.mjs';
import { watchDesktop } from './macos-lifecycle.mjs';

const VERSION = '0.3.4';
const DEFAULT_RELAY = 'https://codex-relay.kuajingvs.com';
const pluginRoot = path.resolve(import.meta.dirname, '..');
export const defaultDataDirectory = () => path.join(os.homedir(), 'Library/Application Support/Codex Control Agent Plugin');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function relayOrigin(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Connection service must be an HTTPS origin (HTTP is allowed only on localhost).');
  }
  return url.origin;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Unable to read ${path.basename(file)}.`); }
}

function writeAgentStatus(data, values) {
  writeStatus(path.join(data, 'status.json'), {
    source: 'codex-plugin', platform: 'darwin', version: VERSION,
    ...values, updatedAt: new Date().toISOString(),
  });
}

export function safeClaimSummary(pending, resumed = false) {
  return { state: 'claim-pending', resumed, name: pending.name, deviceKeyFingerprint: pending.deviceKeyFingerprint, expiresAt: pending.expiresAt };
}

function openClaimPage(pending, secret) {
  const url = `${relayOrigin(pending.relayUrl)}/claim/${encodeURIComponent(pending.claimId)}#secret=${encodeURIComponent(secret)}`;
  // Pass the one-time URL through stdin so it does not appear in process arguments.
  const result = spawnSync('/usr/bin/osascript', ['-'], {
    input: `open location ${JSON.stringify(url)}\n`, encoding: 'utf8', timeout: 15_000,
  });
  if (result.status !== 0) throw new Error('Unable to open the claim page. Run the claim command again to reopen it.');
}

export function launchLabel(data) {
  return `com.codexcontrol.agent.${createHash('sha256').update(path.resolve(data)).digest('hex').slice(0, 24)}`;
}

function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }

export function launchPlist(data, node = process.execPath, root = pluginRoot) {
  const environment = {
    HOME: os.homedir(),
    PATH: `${path.dirname(node)}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(launchLabel(data))}</string>
<key>ProgramArguments</key><array>${[node, path.join(root, 'scripts/macos-agent.mjs'), 'watch', '--data', data].map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(data, 'launcher.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(data, 'launcher.log'))}</string>
</dict></plist>\n`;
}

function launchctl(args) { return spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000 }); }

export async function startService(data) {
  const directory = path.join(os.homedir(), 'Library/LaunchAgents');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${launchLabel(data)}.plist`);
  const content = launchPlist(data);
  const target = `gui/${process.getuid()}/${launchLabel(data)}`;
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (previous !== content) {
    const stopped = launchctl(['bootout', target]);
    if (stopped.status !== 0 && launchctl(['print', target]).status === 0) throw new Error('Unable to stop the previous Agent version for upgrade.');
    // launchd may still expose the old job briefly after bootout returns. Do
    // not kickstart that disappearing job instead of registering its replacement.
    const deadline = Date.now() + 15_000;
    while (launchctl(['print', target]).status === 0) {
      if (Date.now() >= deadline) throw new Error('The previous LaunchAgent is still unloading. Retry start shortly.');
      await delay(100);
    }
    // bootout can return before the old daemon releases its single-instance
    // socket. Wait for it before starting the replacement version.
    const drained = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/agent-daemon.mjs'), '--stop', '--data', data], {
      encoding: 'utf8', timeout: 20_000,
    });
    if (drained.status !== 0) throw new Error('The previous Agent is still stopping. Retry start shortly.');
    fs.writeFileSync(file, content, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  if (launchctl(['print', target]).status !== 0) {
    const result = launchctl(['bootstrap', `gui/${process.getuid()}`, file]);
    if (result.status !== 0) throw new Error('Unable to register the Codex Control launch agent. Run from the logged-in Mac account.');
  }
  const result = launchctl(['kickstart', target]);
  if (result.status !== 0) throw new Error('Unable to start the Codex Control launch agent.');
}

async function withClaimLock(data, operation) {
  const lock = path.join(data, 'claim.lock');
  for (let attempt = 0; attempt < 40; attempt++) {
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
        } else if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) { fs.unlinkSync(lock); continue; }
      } catch (probe) { if (probe.code === 'ENOENT') continue; }
      await delay(250); continue;
    }
    try { fs.writeFileSync(fd, String(process.pid)); return await operation(); }
    finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
  }
  throw new Error('Another device claim operation is running; retry shortly.');
}

export async function claimDevice(options, { keychain = new MacKeychain(), requestClaim = requestDeviceClaim, start = startService, open = openClaimPage } = {}) {
  const data = path.resolve(options.data);
  ensurePrivateDirectory(data);
  return withClaimLock(data, async () => {
    const config = readJson(path.join(data, 'agent-config.json'));
    if (config) {
      await start(data);
      return { state: 'already-claimed', deviceId: config.deviceId, name: config.name };
    }
    const pendingFile = path.join(data, 'pending-claim.json');
    const existing = readJson(pendingFile);
    if (existing && existing.expiresAt > Date.now()) {
      if (options.relayUrl && relayOrigin(options.relayUrl) !== existing.relayUrl) throw new Error('The pending claim belongs to a different Relay.');
      const secret = keychain.read(existing.credentialAccount);
      if (!secret?.claimSecret) throw new Error('Pending claim credentials are unavailable in Keychain.');
      await start(data);
      if (!options.noBrowser) open(existing, secret.claimSecret);
      return safeClaimSummary(existing, true);
    }
    if (existing) {
      keychain.delete(existing.credentialAccount);
      fs.rmSync(pendingFile, { force: true });
    }
    const claim = await requestClaim({ relayUrl: relayOrigin(options.relayUrl || DEFAULT_RELAY), deviceName: options.deviceName || os.hostname(), accountLabel: options.accountLabel || '' });
    const pending = {
      schemaVersion: 2, secretStorage: 'macos-keychain', credentialAccount: credentialAccount(data, 'claim'),
      relayUrl: claim.relayUrl, claimId: claim.id, devicePublicKey: claim.devicePublicKey,
      deviceKeyFingerprint: claim.deviceKeyFingerprint, expiresAt: claim.expiresAt,
      name: claim.deviceName, accountLabel: options.accountLabel || '',
    };
    keychain.write(pending.credentialAccount, { claimSecret: claim.claimSecret, pollToken: claim.pollToken, privateKeyPkcs8: claim.privateKeyPkcs8 });
    writeStatus(pendingFile, pending);
    writeAgentStatus(data, safeClaimSummary(pending));
    await start(data);
    if (!options.noBrowser) open(pending, claim.claimSecret);
    return safeClaimSummary(pending);
  });
}

export async function finishClaim(data, pending, { keychain = new MacKeychain(), fetchImpl = fetch } = {}) {
  const secret = keychain.read(pending.credentialAccount);
  if (!secret?.pollToken || !secret?.privateKeyPkcs8) throw new Error('Device claim credentials are unavailable in Keychain.');
  const response = await fetchImpl(`${relayOrigin(pending.relayUrl)}/v1/device-claims/${encodeURIComponent(pending.claimId)}/poll`, {
    headers: { accept: 'application/json', authorization: `Claim ${secret.pollToken}` },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Device claim polling returned HTTP ${response.status}.`);
  const claim = await response.json();
  if (claim.status !== 'approved') return claim.status;
  for (const field of ['deviceId', 'deviceToken', 'workspaceId', 'relayUrl']) {
    if (typeof claim[field] !== 'string' || !claim[field]) throw new Error('Approved device claim response is incomplete.');
  }
  const account = credentialAccount(data, 'device');
  // Persist the credential before committing the non-secret device configuration.
  keychain.write(account, { deviceToken: claim.deviceToken, privateKeyPkcs8: secret.privateKeyPkcs8 });
  const config = {
    schemaVersion: 2, secretStorage: 'macos-keychain', credentialAccount: account,
    relayUrl: relayOrigin(claim.relayUrl), workspaceId: claim.workspaceId, deviceId: claim.deviceId,
    devicePublicKey: pending.devicePublicKey, deviceKeyFingerprint: pending.deviceKeyFingerprint,
    name: pending.name, accountLabel: pending.accountLabel,
    configuredAt: new Date().toISOString(),
  };
  writeStatus(path.join(data, 'agent-config.json'), config);
  fs.rmSync(path.join(data, 'pending-claim.json'), { force: true });
  keychain.delete(pending.credentialAccount);
  writeAgentStatus(data, { state: 'claimed', name: config.name, deviceId: config.deviceId, workspaceId: config.workspaceId });
  return 'approved';
}

async function runService(data) {
  const keychain = new MacKeychain();
  const configFile = path.join(data, 'agent-config.json');
  const pendingFile = path.join(data, 'pending-claim.json');
  while (!fs.existsSync(configFile)) {
    const pending = readJson(pendingFile);
    if (!pending) { writeAgentStatus(data, { state: 'setup-required' }); return; }
    if (pending.expiresAt <= Date.now()) {
      // A new claim may be replacing an expired one; serialize cleanup with creation.
      await withClaimLock(data, async () => {
        const current = readJson(pendingFile);
        if (!current || current.claimId !== pending.claimId) return;
        keychain.delete(pending.credentialAccount);
        fs.rmSync(pendingFile, { force: true });
        writeAgentStatus(data, { state: 'claim-expired', name: pending.name });
      });
      return;
    }
    try {
      const state = await finishClaim(data, pending, { keychain });
      if (state === 'approved') break;
      if (['expired', 'rejected'].includes(state)) {
        keychain.delete(pending.credentialAccount);
        fs.rmSync(pendingFile, { force: true });
        writeAgentStatus(data, { state: `claim-${state}`, name: pending.name });
        return;
      }
      writeAgentStatus(data, { ...safeClaimSummary(pending), state: 'claim-waiting' });
    } catch (error) {
      writeAgentStatus(data, { ...safeClaimSummary(pending), state: 'claim-waiting', detail: error.message });
    }
    await delay(2000);
  }
  // Keep the existing cross-platform sync/command engine as the single runtime.
  const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts/agent-daemon.mjs'), '--data', data], { stdio: 'inherit' });
  const forward = () => child.kill('SIGTERM');
  process.once('SIGTERM', forward); process.once('SIGINT', forward);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', value => resolve(value ?? 1));
  });
  process.exitCode = code;
}

export function agentStatus(data) {
  const status = readJson(path.join(data, 'status.json'));
  if (!status) return { state: fs.existsSync(path.join(data, 'agent-config.json')) ? 'not-started' : 'setup-required' };
  if (status.state === 'connected' && Date.now() - Date.parse(status.lastSyncAt) > 30_000) return { ...status, state: 'stale' };
  return status;
}

async function disconnect(data) {
  const target = `gui/${process.getuid()}/${launchLabel(data)}`;
  const bootout = launchctl(['bootout', target]);
  if (bootout.status !== 0 && launchctl(['print', target]).status === 0) throw new Error('Unable to stop the Agent; credentials were preserved.');
  fs.rmSync(path.join(os.homedir(), 'Library/LaunchAgents', `${launchLabel(data)}.plist`), { force: true });
  const keychain = new MacKeychain();
  keychain.delete(credentialAccount(data, 'claim'));
  keychain.delete(credentialAccount(data, 'device'));
  for (const name of ['agent-config.json', 'pending-claim.json']) fs.rmSync(path.join(data, name), { force: true });
  writeAgentStatus(data, { state: 'disconnected' });
  return { state: 'disconnected' };
}

async function verify() {
  const ipc = await new DesktopIPC().connect();
  ipc.close();
  return { platform: 'darwin', version: VERSION, nodeVersion: process.version, desktopIPC: 'connected', taskTransport: 'desktop-ipc', keychainHelper: fs.existsSync(path.join(pluginRoot, 'runtime/macos/keychain-helper')) };
}

function parseArguments(argv) {
  const result = { command: argv[0] || 'status', data: process.env.CODEX_CONTROL_AGENT_DATA || defaultDataDirectory() };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--no-browser') { result.noBrowser = true; continue; }
    const key = { '--data': 'data', '--relay-url': 'relayUrl', '--device-name': 'deviceName', '--account-label': 'accountLabel' }[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid macOS Agent option.');
    result[key] = argv[++i];
  }
  result.data = path.resolve(result.data);
  return result;
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This launcher requires macOS.');
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'status') return agentStatus(options.data);
  if (options.command === 'verify') return verify();
  ensurePrivateDirectory(options.data);
  if (options.command === 'claim') return claimDevice(options);
  if (options.command === 'start') { await startService(options.data); return { state: 'starting' }; }
  if (options.command === 'watch') { await watchDesktop(options.data, pluginRoot); return; }
  if (options.command === 'run') { await runService(options.data); return; }
  if (options.command === 'disconnect') return disconnect(options.data);
  if (options.command === 'hook') {
    // Consume the SessionStart payload without persisting conversation content.
    for await (const _chunk of process.stdin) { /* drain */ }
    const result = await claimDevice(options);
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.state === 'already-claimed'
      ? 'Codex Control macOS device agent started. Inspect its status before reporting a successful connection.'
      : `Codex Control opened this Mac's short-lived claim page. Scan it using the signed-in mobile app and approve the workspace. Fingerprint: ${result.deviceKeyFingerprint}. Never disclose claim links, private keys, or credentials.` } };
  }
  throw new Error('Unknown macOS Agent command.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main();
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (['run', 'watch'].includes(process.argv[2])) {
      const options = parseArguments(process.argv.slice(2));
      appendLog(path.join(options.data, 'agent.log'), `macOS launcher failed: ${error.message}`);
      writeAgentStatus(options.data, { state: 'error', detail: error.message });
    }
    process.exitCode = 1;
  }
}
