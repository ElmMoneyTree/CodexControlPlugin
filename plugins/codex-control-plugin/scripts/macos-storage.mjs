import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function credentialAccount(dataDirectory, kind) {
  const suffix = createHash('sha256').update(path.resolve(dataDirectory)).digest('hex').slice(0, 24);
  return `${kind}-${suffix}`;
}

export class MacKeychain {
  constructor(helper = path.resolve(import.meta.dirname, '../runtime/macos/keychain-helper')) {
    this.helper = helper;
  }
  invoke(action, account, value) {
    if (!fs.existsSync(this.helper)) throw new Error('macOS Keychain helper is missing; rebuild the macOS plugin runtime.');
    const result = spawnSync(this.helper, [action, account], {
      input: value === undefined ? undefined : JSON.stringify(value),
      encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024,
    });
    if (result.status === 44 && action === 'read') return null;
    if (result.status !== 0) throw new Error(`macOS Keychain ${action} failed (${result.status ?? result.error?.code ?? 'unknown'}).`);
    return action === 'read' ? JSON.parse(result.stdout) : null;
  }
  read(account) { return this.invoke('read', account); }
  write(account, value) { this.invoke('write', account, value); }
  delete(account) { this.invoke('delete', account); }
}

export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('Agent directory must belong to the current user.');
  fs.chmodSync(directory, 0o700);
}
