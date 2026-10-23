import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { AppTools } from '../runtime/agent-core/src/app-tools.mjs';
import { DesktopBridgeServer } from '../runtime/agent-core/src/desktop-bridge.mjs';
import { readAgentConfig } from './daemon-lib.mjs';
import { readDeviceToken } from './device-credential.mjs';

const data = process.env.CODEX_CONTROL_DATA_DIRECTORY || (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library/Application Support/Codex Control Agent Plugin')
  : path.join(process.env.LOCALAPPDATA || os.homedir(), 'Codex Control Agent Plugin'));
const configPath = path.join(data, 'agent-config.json');
let tools, credentials, credentialAt = 0;
async function getAppTools() {
  if (!tools) tools = await AppTools.discover({ useBroker: false });
  return tools;
}
function getCredentials() {
  if (!fs.existsSync(configPath)) return null;
  const config = readAgentConfig(configPath);
  // Re-read device identity each time. A newly claimed/revoked device must not
  // inherit a previous device's authority; the secret is cached only briefly.
  if (!credentials || credentials.deviceId !== config.deviceId || Date.now() - credentialAt > 30_000) {
    credentials = { deviceId: config.deviceId, token: readDeviceToken(configPath) };
    credentialAt = Date.now();
  }
  return credentials;
}

const broker = await new DesktopBridgeServer({ getCredentials, getAppTools }).start();
const lines = readline.createInterface({ input: process.stdin, terminal: false });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let closing = false;
async function close() { if (closing) return; closing = true; lines.close(); await broker?.close(); }
process.once('SIGTERM', () => { close().finally(() => process.exit()); });
process.once('SIGINT', () => { close().finally(() => process.exit()); });

for await (const line of lines) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id == null) continue;
  let result;
  try {
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codex-control-desktop-bridge', version: '0.3.3' } };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools: [{ name: 'desktop_bridge_status', description: 'Read the Codex Control phone connection bridge status. Chat creation and messaging are accepted only from the authenticated device agent.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] };
    else if (request.method === 'tools/call' && request.params?.name === 'desktop_bridge_status') {
      const appTools = await getAppTools();
      result = { content: [{ type: 'text', text: JSON.stringify({ connected: true, claimed: fs.existsSync(configPath), backends: appTools.creationBackends() }) }] };
    } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported desktop bridge MCP method' } }); continue; }
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    tools = null;
    send({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } });
  }
}
await close();
