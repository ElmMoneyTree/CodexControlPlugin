import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function parseDaemonArguments(argv) {
  const result = { dataDirectory: '', stop: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--stop') result.stop = true;
    else if (item === '--data') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--data requires a directory');
      result.dataDirectory = path.resolve(value);
      index += 1;
    } else throw new Error(`Unknown Agent option: ${item}`);
  }
  if (!result.dataDirectory) throw new Error('--data is required');
  return result;
}

export function daemonPipeName(dataDirectory) {
  const suffix = crypto.createHash('sha256').update(path.resolve(dataDirectory).toLowerCase()).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\codex-control-agent-${suffix}`;
}

export function readAgentConfig(configPath) {
  const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const field of ['relayUrl', 'deviceId', 'encryptedDeviceToken', 'name']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error(`Agent config is missing ${field}`);
  }
  return value;
}

export function publicAgentConfig(config) {
  return {
    relayUrl: config.relayUrl,
    deviceId: config.deviceId,
    name: config.name,
    accountLabel: config.accountLabel || '',
  };
}

export function isDesktopUnavailable(error, agent) {
  if (agent?.ipc?.socket?.writable) return false;
  const message = error instanceof Error ? `${error.code || ''} ${error.message}` : String(error);
  return /codex-ipc|codex app tools pipe|desktop disconnected|ENOENT|ECONNREFUSED|EPIPE/i.test(message);
}

export function writeStatus(statusPath, value) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statusPath);
}

export function appendLog(logPath, message, maxBytes = 1_000_000) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    if (fs.statSync(logPath).size >= maxBytes) {
      fs.rmSync(`${logPath}.previous`, { force: true });
      fs.renameSync(logPath, `${logPath}.previous`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { encoding: 'utf8', mode: 0o600 });
}
