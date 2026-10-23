import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// NSWorkspace requires the logged-in GUI session, unavailable in a sandbox.
// Opt in for the local acceptance run; never quit the user's actual Codex.
test('native app notifications follow a real isolated app launch and exit', {
  skip: process.platform !== 'darwin' || process.env.CODEX_CONTROL_NATIVE_LIFECYCLE_TEST !== '1', timeout: 15_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-native-lifecycle-'));
  const application = path.join(directory, 'Lifecycle Test.app');
  const contents = path.join(application, 'Contents');
  const identifier = `com.codexcontrol.lifecycle-test.${path.basename(directory).toLowerCase()}`;
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.copyFileSync('/bin/sleep', path.join(contents, 'MacOS/lifecycle-test'));
  fs.chmodSync(path.join(contents, 'MacOS/lifecycle-test'), 0o755);
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>Codex Control Lifecycle Test</string>
<key>CFBundleExecutable</key><string>lifecycle-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>`);
  const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', identifier, application], { encoding: 'utf8', timeout: 5000 });
  assert.equal(signed.status, 0, signed.stderr);
  const helper = fileURLToPath(new URL('../plugins/codex-control-plugin/runtime/macos/desktop-lifecycle-helper', import.meta.url));
  const observer = spawn(helper, [identifier], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: observer.stdout });
  const observations = [];
  let stderr = '';
  observer.stderr.on('data', value => { stderr += value; });
  lines.on('line', line => observations.push(JSON.parse(line).running));
  const closed = new Promise(resolve => observer.once('close', resolve));
  t.after(async () => {
    observer.kill('SIGTERM');
    await closed;
    lines.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const waitFor = async predicate => {
    const deadline = Date.now() + 6000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(predicate(), `Native lifecycle observation timed out: ${JSON.stringify(observations)} ${stderr}`);
  };
  await waitFor(() => observations.length === 1);
  assert.deepEqual(observations, [false]);
  const launched = spawnSync('/usr/bin/open', ['-n', '-g', '-a', application, '--args', '3'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(launched.status, 0, launched.stderr);
  await waitFor(() => observations.includes(true));
  await waitFor(() => observations.length >= 3);
  assert.deepEqual(observations, [false, true, false]);
});
