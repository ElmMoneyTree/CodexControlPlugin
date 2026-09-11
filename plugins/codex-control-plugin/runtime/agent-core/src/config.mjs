import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultConfigPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'CodexControl', 'agent.json');
}

export function readConfig(file = defaultConfigPath()) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const field of ['relayUrl', 'deviceId', 'deviceToken', 'name']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error(`Agent config is missing ${field}`);
  }
  return { ...value, relayUrl: value.relayUrl.replace(/\/$/, ''), configPath: file };
}

export function writeConfig(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function parseArguments(argv) {
  const options = { command: argv[0] ?? 'run' };
  for (let index = 1; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith('--')) throw new Error(`Unexpected argument: ${part}`);
    const key = part.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${part}`);
    options[key] = value;
    index += 1;
  }
  return options;
}
