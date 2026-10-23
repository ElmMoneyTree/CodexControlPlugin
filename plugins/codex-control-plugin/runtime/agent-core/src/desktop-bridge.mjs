import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeProjects } from './new-chat.mjs';

const MAX_FRAME = 1024 * 1024;
export const bridgeDirectory = (platform = process.platform) => platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Codex Control Agent Plugin', 'desktop-bridges')
  : path.join('/tmp', `codex-control-bridges-${process.getuid?.() ?? 'local'}`);
const windowsPipePrefix = () => `\\\\.\\pipe\\codex-control-desktop-${createHash('sha256').update(os.homedir().toLowerCase()).digest('hex').slice(0, 16)}-`;

function sign(value, token) { return createHmac('sha256', token).update(JSON.stringify(value)).digest('hex'); }
function validMac(value, expected) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
}
function frame(value) { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }
function receive(socket, callback) {
  let buffer = Buffer.alloc(0), complete = false;
  socket.on('data', chunk => {
    if (complete) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) return;
    const size = buffer.readUInt32LE();
    if (!size || size > MAX_FRAME) { complete = true; socket.destroy(); return; }
    if (buffer.length < size + 4) return;
    complete = true;
    try { callback(JSON.parse(buffer.subarray(4, size + 4).toString('utf8'))); }
    catch { socket.destroy(); }
  });
}
function privateDirectory(directory, platform) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (platform !== 'win32' && stat.uid !== process.getuid?.())) throw new Error('Unsafe desktop bridge directory');
  fs.chmodSync(directory, 0o700);
}

export class DesktopBridgeClient {
  constructor(pipePath, credentials, { timeoutMs = 35_000 } = {}) { this.pipePath = pipePath; this.credentials = credentials; this.timeoutMs = timeoutMs; }
  static async discover({ credentials, platform = process.platform, directory = bridgeDirectory(platform), ...options } = {}) {
    if (!credentials?.deviceId || !credentials.token) throw new Error('Device credentials are required for the desktop bridge');
    let paths;
    try {
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (platform !== 'win32' && (directoryStat.uid !== process.getuid?.() || (directoryStat.mode & 0o077)))) throw new Error('Unsafe desktop bridge directory');
      if (platform === 'win32') {
        paths = fs.readdirSync(directory).filter(name => /^[0-9]+-[0-9a-f-]+\.json$/.test(name)).map(name => path.join(directory, name))
          .map(file => ({ file, stat: fs.lstatSync(file) })).filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink())
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).flatMap(({ file }) => {
            try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return typeof value.pipePath === 'string' && value.pipePath.startsWith(windowsPipePrefix()) ? [value.pipePath] : []; }
            catch { return []; }
          });
      } else paths = fs.readdirSync(directory).filter(name => /^[0-9]+-[0-9a-f-]+\.sock$/.test(name)).map(name => path.join(directory, name))
          .map(file => ({ file, stat: fs.lstatSync(file) })).filter(({ stat }) => stat.isSocket() && stat.uid === process.getuid?.() && !(stat.mode & 0o077))
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).map(({ file }) => file);
    } catch { throw new Error('Open a desktop chat with the Codex Control plugin enabled, then refresh'); }
    for (const file of paths) {
      try {
        const client = new DesktopBridgeClient(file, credentials, options);
        const capabilities = await client.request('capabilities', {});
        client.backends = capabilities.backends;
        return client;
      } catch { /* Another app session may still be starting or closing. */ }
    }
    throw new Error('Open a desktop chat with the Codex Control plugin enabled, then refresh');
  }
  creationBackends() { return this.backends ?? []; }
  listThreads(context, limit = 50) { return this.request('listThreads', { context, limit: Math.min(50, limit) }); }
  listProjects(context) { return this.request('listProjects', { context }); }
  createThread(backend, projectId, text, context) { return this.request('createThread', { context, backend, projectId, text }); }
  readThread(threadId, cursor, context) { return this.request('readThread', { context, threadId, cursor }); }
  sendMessage(threadId, prompt, context) { return this.request('sendMessage', { context, threadId, prompt }); }
  request(operation, args) {
    const token = this.credentials.token;
    const payload = { version: 1, deviceId: this.credentials.deviceId, nonce: randomUUID(), timestamp: Date.now(), operation, args };
    const input = { ...payload, signature: sign(payload, token) };
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath); let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(new Error('Desktop bridge timed out; outcome unknown')), this.timeoutMs);
      socket.on('error', error => finish(error));
      socket.on('close', () => finish(new Error('Desktop bridge closed; outcome unknown')));
      socket.on('connect', () => socket.write(frame(input)));
      receive(socket, response => {
        const { signature, ...value } = response;
        if (value.nonce !== payload.nonce || !validMac(signature, sign(value, token))) return finish(new Error('Desktop bridge response authentication failed'));
        if (value.ok !== true) return finish(new Error(value.error ?? 'Desktop bridge failed'));
        finish(null, value.value);
      });
    });
  }
}

export class DesktopBridgeServer {
  constructor({ getCredentials, getAppTools, platform = process.platform, directory = bridgeDirectory(platform) }) {
    this.getCredentials = getCredentials; this.getAppTools = getAppTools; this.platform = platform; this.directory = directory; this.nonces = new Map(); this.sockets = new Set();
  }
  async start() {
    privateDirectory(this.directory, this.platform);
    const id = `${process.pid}-${randomUUID()}`;
    this.path = this.platform === 'win32' ? `${windowsPipePrefix()}${id}` : path.join(this.directory, `${id}.sock`);
    this.server = net.createServer(socket => {
      this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(40_000, () => socket.destroy());
      receive(socket, request => { this.handle(request).then(response => socket.end(frame(response))).catch(() => socket.destroy()); });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.path, resolve); });
    if (this.platform === 'win32') {
      this.registryPath = path.join(this.directory, `${id}.json`);
      fs.writeFileSync(this.registryPath, JSON.stringify({ pipePath: this.path }), { mode: 0o600 });
    } else fs.chmodSync(this.path, 0o600);
    return this;
  }
  async handle(input) {
    const { signature, ...payload } = input;
    if (payload.version !== 1 || typeof payload.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(payload.nonce) || !Number.isSafeInteger(payload.timestamp) || Math.abs(Date.now() - payload.timestamp) > 30_000) throw new Error('Invalid desktop bridge authentication');
    const credentials = await this.getCredentials();
    if (!credentials?.token || payload.deviceId !== credentials.deviceId || !validMac(signature, sign(payload, credentials.token))) throw new Error('Desktop bridge authentication failed');
    for (const [nonce, at] of this.nonces) if (Date.now() - at > 60_000) this.nonces.delete(nonce);
    if (this.nonces.has(payload.nonce) || this.nonces.size >= 4096) throw new Error('Desktop bridge request was replayed');
    this.nonces.set(payload.nonce, Date.now());
    let response;
    try { response = { nonce: payload.nonce, ok: true, value: await this.execute(payload.operation, payload.args) }; }
    catch (error) { response = { nonce: payload.nonce, ok: false, error: error.message }; }
    return { ...response, signature: sign(response, credentials.token) };
  }
  async execute(operation, args) {
    if (!['capabilities', 'listThreads', 'listProjects', 'createThread', 'readThread', 'sendMessage'].includes(operation)) throw new Error('Unsupported desktop bridge operation');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid desktop bridge arguments');
    const tools = await this.getAppTools();
    if (operation === 'capabilities') return { backends: tools.creationBackends() };
    const context = safeContext(args.context);
    if (operation === 'listThreads') {
      if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50) throw new Error('Invalid thread limit');
      return tools.listThreads(context, args.limit);
    }
    if (operation === 'listProjects') return tools.listProjects(context);
    if (operation === 'createThread') {
      if (!['codex', 'chatgpt'].includes(args.backend) || !tools.creationBackends().includes(args.backend)) throw new Error('Unsupported chat backend');
      const projectId = args.projectId == null ? null : text(args.projectId, 200);
      const prompt = text(args.text, 20_000);
      if (projectId && !normalizeProjects(await tools.listProjects(context)).some(project => project.id === projectId && project.kind === args.backend)) throw new Error('The selected project is unavailable for this chat backend');
      return tools.createThread(args.backend, projectId, prompt, context);
    }
    const threadId = text(args.threadId, 100);
    const visible = await tools.listThreads(context, 50);
    if (![...(visible.pinnedThreads ?? []), ...(visible.threads ?? [])].some(thread => thread.id === threadId && !thread.archived && (thread.kind === 'chatgpt' || (thread.kind === 'codex' && (!thread.hostId || thread.hostId === 'local'))))) throw new Error('Conversation is not visible on this device');
    if (operation === 'readThread') return tools.readThread(threadId, args.cursor == null ? null : text(args.cursor, 200), context);
    return tools.sendMessage(threadId, text(args.prompt, 20_000), context);
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    if (this.registryPath) fs.rmSync(this.registryPath, { force: true });
    if (this.path && this.platform !== 'win32') fs.rmSync(this.path, { force: true });
  }
}

function text(value, max) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid desktop bridge text'); return value.trim(); }
function safeContext(value) {
  if (!value || (value.callerSource && value.callerSource !== 'codex') || (value.hostId && value.hostId !== 'local')) throw new Error('A local Codex caller context is required');
  return { threadId: text(value.threadId, 100), turnId: text(value.turnId, 100), callerSource: 'codex', hostId: 'local' };
}
