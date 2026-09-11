import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

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
  constructor(pipePath, { timeoutMs = 10_000 } = {}) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
  }

  static async discover(options) {
    const names = fs.readdirSync(PIPE_ROOT).filter(name => /^codex-browser-use-[0-9a-f-]+$/i.test(name));
    const failures = [];
    for (const name of names) {
      const instance = new AppTools(`${PIPE_ROOT}${name}`, options);
      try {
        const tools = await instance.list();
        if (tools.some(tool => tool.namespace === 'codex_app' && tool.name === 'send_message_to_thread')) return instance;
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
    return this.call('list_threads', { limit }, context);
  }

  async sendMessage(threadId, prompt, context) {
    return this.call('send_message_to_thread', { threadId, prompt }, context);
  }

  async waitThread(threadId, context) {
    return this.call('wait_threads', { targets: [{ threadId }], timeoutMs: 0 }, context);
  }

  async call(tool, args, { threadId, turnId }) {
    if (!threadId || !turnId) throw new Error('A live Codex caller context is required');
    const response = await this.rpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { namespace: 'codex_app', tool, arguments: args, threadId, turnId, callId: randomUUID() },
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
      socket.on('data', chunk => { try { decoder.receive(chunk); } catch (error) { finish(error); } });
      socket.on('connect', () => {
        const body = Buffer.from(JSON.stringify(request));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      });
    });
  }
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
