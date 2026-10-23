import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MacKeychain } from './macos-storage.mjs';
import { readAgentConfig } from './daemon-lib.mjs';

export function readDeviceToken(file) {
  if (process.env.CODEX_CONTROL_AGENT_TEST_TOKEN) return process.env.CODEX_CONTROL_AGENT_TEST_TOKEN;
  if (process.platform === 'darwin') {
    const config = readAgentConfig(file);
    const secret = new MacKeychain().read(config.credentialAccount);
    if (!secret?.deviceToken) throw new Error('Device credential is missing from macOS Keychain.');
    return secret.deviceToken;
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'decrypt-token.ps1'), '-ConfigPath', file], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  if (result.status !== 0 || !result.stdout) throw new Error(result.stderr?.trim() || 'Unable to decrypt the device token.');
  return result.stdout;
}
