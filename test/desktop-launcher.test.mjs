import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('../plugins/codex-control-plugin/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
const server = mcp.mcpServers.codex_control_desktop;

function packagedPath(value) {
  assert.equal(typeof value, 'string');
  assert.ok(value.startsWith('${PLUGIN_ROOT}/'), 'Local MCP paths must resolve inside the installed plugin');
  const relative = value.slice('${PLUGIN_ROOT}/'.length);
  assert.ok(relative && !relative.split(/[\\/]/).includes('..'));
  assert.equal(relative.includes('${'), false, 'Do not depend on undocumented environment expansion in MCP commands');
  return path.join(pluginRoot, relative);
}

test('desktop worker is declared through supported plugin MCP configuration', () => {
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.deepEqual(Object.keys(mcp), ['mcpServers']);
  assert.ok(server && typeof server === 'object');
  // RawMcpServerConfig has no commandWindows/platform overrides. commandWindows
  // is a HookHandlerConfig field, not a supported MCP transport field.
  const supported = new Set(['command', 'args', 'cwd', 'env', 'env_vars', 'startup_timeout_sec', 'tool_timeout_sec',
    'required', 'enabled', 'enabled_tools', 'disabled_tools', 'default_tools_approval_mode', 'tools']);
  assert.deepEqual(Object.keys(server).filter(key => !supported.has(key)), []);
  assert.equal(server.cwd, '${PLUGIN_ROOT}');
  assert.ok(Array.isArray(server.args) && server.args.length > 0);
  for (const item of [server.command, ...server.args]) assert.ok(fs.statSync(packagedPath(item)).isFile());
  assert.ok(server.env_vars.includes('CODEX_APP_TOOLS_PIPE_PATH'));
  assert.ok(server.env_vars.includes('CODEX_ELECTRON_RESOURCES_PATH'));
  assert.ok(server.startup_timeout_sec > 0);
  assert.equal(server.required, false, 'An unavailable desktop worker must not block normal chats');
});

test('extensionless MCP command also names the bundled Windows release runtime', () => {
  const relative = server.command.slice('${PLUGIN_ROOT}/'.length);
  assert.equal(relative, 'runtime/node');
  assert.equal(path.posix.extname(relative), '');
  assert.equal(path.win32.normalize(`${relative}.exe`), 'runtime\\node.exe');
  // Rust std::process::windows::resolve_exe appends .exe to a path before
  // trying the extensionless file. This checks the packaging contract only;
  // it does not pretend to execute or test Windows process resolution on Mac.
  // Source: std/src/sys/process/windows.rs, resolve_exe, lines 486-503 in the
  // installed Rust source checked during implementation.
  const ignoredReleaseFiles = fs.readFileSync(path.join(pluginRoot, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignoredReleaseFiles.includes('runtime/node.exe'));
  if (process.platform !== 'win32') assert.ok((fs.statSync(packagedPath(server.command)).mode & 0o111) !== 0);
});

test('Mac launcher execs the app runtime and preserves worker argv and process identity', { skip: process.platform === 'win32' }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-launcher-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const resources = path.join(fixture, 'app resources');
  const runtime = path.join(resources, 'cua_node/bin/node');
  const capture = path.join(fixture, 'capture runtime.mjs');
  const audit = path.join(fixture, 'runtime-calls.jsonl');
  const sentinel = path.join(fixture, 'must-not-be-created');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, '#!/bin/sh\nexec "$CODEX_CONTROL_TEST_NODE" "$CODEX_CONTROL_TEST_CAPTURE" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(capture, `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CODEX_CONTROL_TEST_AUDIT, JSON.stringify(args) + '\\n');
if (args[0] !== '-e') process.stdout.write(JSON.stringify({ pid: process.pid, args, cwd: process.cwd() }));
`);
  const args = [path.join(fixture, 'worker with spaces.mjs'), '--message', '项目名称 中文', `$(touch ${sentinel})`,
    'a "quoted" value', 'line one\nline two', ''];
  const child = spawn(packagedPath(server.command), args, {
    cwd: fixture,
    env: { ...process.env, CODEX_ELECTRON_RESOURCES_PATH: resources, CODEX_CONTROL_TEST_NODE: process.execPath,
      CODEX_CONTROL_TEST_CAPTURE: capture, CODEX_CONTROL_TEST_AUDIT: audit },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [], errors = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => errors.push(chunk));
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });

  assert.equal(exitCode, 0, Buffer.concat(errors).toString('utf8'));
  const result = JSON.parse(Buffer.concat(output).toString('utf8'));
  assert.equal(result.pid, child.pid, 'exec must preserve the app-owned worker process instead of leaving a launcher parent');
  assert.deepEqual(result.args, args);
  assert.equal(result.cwd, fs.realpathSync(fixture));
  assert.equal(fs.existsSync(sentinel), false, 'Worker arguments must not be interpreted by a shell');
  const calls = fs.readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], '-e', 'Check the app runtime version before launching the worker');
  assert.deepEqual(calls[1], args);
});
