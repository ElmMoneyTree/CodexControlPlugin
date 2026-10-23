import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { CodexDeviceAgent } from '../runtime/agent-core/index.mjs';
import { ensurePrivateDirectory } from './macos-storage.mjs';
import { readDeviceToken } from './device-credential.mjs';
import {
  appendLog,
  daemonPipeName,
  isDesktopUnavailable,
  parseDaemonArguments,
  publicAgentConfig,
  readAgentConfig,
  writeStatus,
} from './daemon-lib.mjs';

const VERSION = '0.3.4';
const CYCLE_INTERVAL_MS = positiveNumber(process.env.CODEX_CONTROL_AGENT_INTERVAL_MS, 3_000);
const DESKTOP_GRACE_MS = positiveNumber(process.env.CODEX_CONTROL_AGENT_DESKTOP_GRACE_MS, 90_000);
const desktopSupervised = process.platform === 'darwin' && process.env.CODEX_CONTROL_AGENT_DESKTOP_SUPERVISED === '1';
const options = parseDaemonArguments(process.argv.slice(2));
const pipeName = daemonPipeName(options.dataDirectory);

if (options.stop) {
  const stopRequested = await sendStop(pipeName);
  const stopped = stopRequested && await waitForPipeClosure(pipeName, 15_000);
  process.stdout.write(`${JSON.stringify({ stopped })}\n`);
  process.exit(stopped ? 0 : 1);
}

const configPath = path.join(options.dataDirectory, 'agent-config.json');
const statusPath = path.join(options.dataDirectory, 'status.json');
const logPath = path.join(options.dataDirectory, 'agent.log');
let stopping = false;
let stopReason = 'process-ended';
let agent;

process.once('SIGINT', () => {
  stopReason = 'signal';
  stopping = true;
  try { agent?.close(); } catch { /* Best-effort shutdown. */ }
});
process.once('SIGTERM', () => {
  stopReason = 'signal';
  stopping = true;
  try { agent?.close(); } catch { /* Best-effort shutdown. */ }
});

const lockServer = net.createServer(socket => {
  socket.setEncoding('utf8');
  socket.once('data', value => {
    if (value.trim() === 'stop') {
      socket.end('ok');
      stopReason = 'disconnect-requested';
      stopping = true;
      try { agent?.close(); } catch { /* Best-effort shutdown. */ }
    } else socket.end('unsupported');
  });
});

if (process.platform !== 'win32') ensurePrivateDirectory(path.dirname(pipeName));
if (process.platform !== 'win32' && fs.existsSync(pipeName)) {
  if (await pipeAcceptsConnections(pipeName)) process.exit(0);
  const stat = fs.lstatSync(pipeName);
  if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Unsafe Agent socket path');
  fs.unlinkSync(pipeName);
}
const lockState = await listen(lockServer, pipeName);
if (lockState === 'already-running') process.exit(0);
if (process.platform !== 'win32') fs.chmodSync(pipeName, 0o600);

const baseStatus = { source: 'codex-plugin', version: VERSION, pid: process.pid };
if (!fs.existsSync(configPath)) {
  writeStatus(statusPath, { ...baseStatus, state: 'setup-required', updatedAt: new Date().toISOString() });
  lockServer.close();
  process.exit(0);
}

try {
  const stored = readAgentConfig(configPath);
  const deviceToken = readDeviceToken(configPath);
  const publicConfig = publicAgentConfig(stored);
  agent = new CodexDeviceAgent({ ...publicConfig, deviceToken, configPath });
  appendLog(logPath, `Agent ${VERSION} started for ${publicConfig.deviceId}`);
  writeStatus(statusPath, { ...baseStatus, ...publicConfig, state: 'starting', updatedAt: new Date().toISOString() });

  let desktopMissingSince = null;
  while (!stopping) {
    try {
      const result = await agent.cycle();
      desktopMissingSince = null;
      writeStatus(statusPath, {
        ...baseStatus,
        ...publicConfig,
        state: 'connected',
        lastSyncAt: new Date().toISOString(),
        taskCount: result.taskCount,
        pendingRequestCount: result.requestCount,
        deliveredCommandCount: result.commandCount,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendLog(logPath, `Cycle failed: ${detail}`);
      if (isDesktopUnavailable(error, agent)) desktopMissingSince ??= Date.now();
      else desktopMissingSince = null;
      writeStatus(statusPath, {
        ...baseStatus,
        ...publicConfig,
        state: 'error',
        detail,
        desktopUnavailableSince: desktopMissingSince ? new Date(desktopMissingSince).toISOString() : null,
        updatedAt: new Date().toISOString(),
      });
      if (!desktopSupervised && desktopMissingSince && Date.now() - desktopMissingSince >= DESKTOP_GRACE_MS) {
        stopReason = 'codex-desktop-unavailable';
        break;
      }
    }
    if (!stopping) await delay(CYCLE_INTERVAL_MS);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  appendLog(logPath, `Agent stopped after an initialization failure: ${detail}`);
  writeStatus(statusPath, { ...baseStatus, state: 'error', detail, updatedAt: new Date().toISOString() });
  process.exitCode = 1;
} finally {
  try { agent?.close(); } catch { /* Best-effort shutdown. */ }
  await closeServer(lockServer);
  appendLog(logPath, `Agent stopped: ${stopReason}`);
  const previous = readJson(statusPath);
  writeStatus(statusPath, { ...previous, ...baseStatus, state: 'stopped', stopReason, updatedAt: new Date().toISOString() });
}

function positiveNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function listen(server, pipe) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') resolve('already-running');
      else reject(error);
    };
    const onListening = () => { server.off('error', onError); resolve('listening'); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipe);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

function sendStop(pipe) {
  return new Promise(resolve => {
    const socket = net.createConnection(pipe);
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 2_000);
    socket.once('connect', () => socket.write('stop'));
    socket.once('data', data => finish(data.toString() === 'ok'));
    socket.once('error', error => finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'));
  });
}

async function waitForPipeClosure(pipe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await pipeAcceptsConnections(pipe)) return true;
    await delay(100);
  }
  return false;
}

function pipeAcceptsConnections(pipe) {
  return new Promise(resolve => {
    const socket = net.createConnection(pipe);
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 500);
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
