import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DesktopBridgeClient } from './desktop-bridge.mjs';

const PIPE_ROOT = '\\\\.\\pipe\\';
const MAX_FRAME = 32 * 1024 * 1024;

export class FrameDecoder {
  constructor(onMessage) { this.onMessage = onMessage; this.buffer = Buffer.alloc(0); }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME) throw new Error('Invalid app tools frame length');
      if (this.buffer.length < length + 4) return;
      const message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
      this.buffer = this.buffer.subarray(length + 4);
      this.onMessage(message);
    }
  }
}

export class AppTools {
  constructor(pipePath, { timeoutMs = 30_000 } = {}) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
  }

  static async discover({ platform = process.platform, useBroker = true, ...options } = {}) {
    if (useBroker) {
      try { return await DesktopBridgeClient.discover({ platform, ...options }); }
      catch { /* A trusted foreground CLI process can also call app tools directly. */ }
    }
    const candidates = appToolPipePaths(platform);
    const failures = [];
    for (const pipePath of candidates) {
      const instance = new AppTools(pipePath, options);
      try {
        const tools = await instance.list();
        if (tools.some(tool => tool.namespace === 'codex_app' && tool.name === 'list_threads')) {
          instance.tools = tools;
          return instance;
        }
      } catch (error) { failures.push(error.message); }
    }
    throw new Error(`Codex app tools pipe was not found${failures.length ? `: ${failures.at(-1)}` : ''}`);
  }

  async list() {
    const response = await this.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { threadStartKind: 'all' } });
    if (response.error) throw new Error(response.error.message ?? 'Unable to list desktop tools');
    return response.result?.tools ?? [];
  }

  async listThreads(context, limit = 50) {
    return this.call('list_threads', { limit: Math.min(50, limit) }, context);
  }

  async listProjects(context) { return this.call('list_projects', {}, context); }

  async createThread(backend, projectId, text, context) {
    const target = backend === 'chatgpt' ? { type: 'chatgptWorkCloud', ...(projectId ? { projectId } : {}) }
      : projectId ? { type: 'project', projectId, environment: { type: 'local' } } : { type: 'projectless' };
    return this.call('create_thread', { prompt: text, target }, context);
  }

  async readThread(threadId, cursor, context) {
    return this.call('read_thread', { threadId, ...(cursor ? { cursor } : {}), turnLimit: 5, includeOutputs: false, maxOutputCharsPerItem: 20_000 }, context);
  }

  creationBackends() {
    const tool = this.tools?.find(tool => tool.namespace === 'codex_app' && tool.name === 'create_thread');
    const targets = tool?.inputSchema?.properties?.target?.anyOf ?? [];
    const types = targets.flatMap(target => target?.properties?.type?.enum ?? []);
    return [...(types.includes('projectless') ? ['codex'] : []), ...(types.includes('chatgptWorkCloud') ? ['chatgpt'] : [])];
  }

  async sendMessage(threadId, prompt, context) {
    return this.call('send_message_to_thread', { threadId, prompt }, context);
  }

  async waitThread(threadId, context) {
    return this.call('wait_threads', { targets: [{ threadId }], timeoutMs: 0 }, context);
  }

  async call(tool, args, { threadId, turnId, callerSource = 'codex', hostId = 'local' } = {}) {
    if (!threadId || !turnId) throw new Error('Open an existing desktop chat before creating a chat from the phone');
    const response = await this.rpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { namespace: 'codex_app', tool, arguments: args, threadId, turnId, callerSource, hostId, callId: randomUUID() },
    });
    if (response.error) throw new Error(response.error.message ?? `${tool} failed`);
    if (response.result?.success === false) throw new Error(readToolError(response.result) ?? `${tool} failed`);
    return readToolValue(response.result);
  }

  rpc(request) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        error ? reject(error) : resolve(value);
      };
      const decoder = new FrameDecoder(message => finish(null, message));
      const timer = setTimeout(() => finish(new Error('App tools request timed out; outcome unknown')), this.timeoutMs);
      socket.on('error', error => finish(error));
      socket.on('close', () => finish(new Error('Desktop app tools connection closed; use the app bundled Node.js runtime on macOS')));
      socket.on('data', chunk => { try { decoder.receive(chunk); } catch (error) { finish(error); } });
      socket.on('connect', () => {
        const body = Buffer.from(JSON.stringify(request));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      });
    });
  }

}

export function appToolPipePaths(platform = process.platform, env = process.env) {
  const configured = env.CODEX_APP_TOOLS_PIPE_PATH;
  let paths = [];
  try {
    if (platform === 'win32') paths = fs.readdirSync(PIPE_ROOT).filter(name => /^codex-browser-use-[0-9a-f-]+$/i.test(name)).map(name => `${PIPE_ROOT}${name}`);
    else paths = fs.readdirSync('/tmp/codex-browser-use').filter(name => /^[0-9a-f-]+\.sock$/i.test(name)).map(name => path.join('/tmp/codex-browser-use', name))
      .map(file => ({ file, stat: fs.statSync(file) })).filter(({ stat }) => stat.isSocket() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).map(({ file }) => file);
  } catch { /* The desktop may be closed or still starting. */ }
  return [...new Set([...(configured ? [configured] : []), ...paths])];
}

function readToolValue(result) {
  const text = result?.contentItems?.find(item => item.type === 'inputText')?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

function readToolError(result) {
  const value = readToolValue(result);
  return typeof value === 'string' ? value : value?.error;
}
