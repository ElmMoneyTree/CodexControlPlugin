import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class DesktopIPC extends EventEmitter {
  constructor(pipePath = '\\\\.\\pipe\\codex-ipc') {
    super(); this.path = pipePath; this.pending = new Map(); this.buffer = Buffer.alloc(0); this.clientId = 'initializing-client';
  }
  async connect() {
    if (this.socket) throw new Error('Already connected');
    this.socket = net.createConnection(this.path);
    this.socket.on('data', chunk => this.receive(chunk));
    this.socket.on('error', error => this.close(error));
    this.socket.on('close', () => this.close(new Error('Desktop disconnected')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error('Connection timeout')); }, 5_000);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const response = await this.request('initialize', { clientType: 'codex-connector' }, { version: 0 });
    this.clientId = response.result.clientId;
    return this;
  }
  send(message) {
    if (!this.socket?.writable) throw new Error('Desktop unavailable');
    const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
    header.writeUInt32LE(body.length); this.socket.write(Buffer.concat([header, body]));
  }
  request(method, params, { version = 1, targetClientId, timeoutMs = 5_000 } = {}) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${method}: timeout; outcome unknown`)); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, targetClientId, timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  receive(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE();
        if (!length || length > 32 * 1024 * 1024) throw new Error('Invalid desktop frame length');
        if (this.buffer.length < length + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, length + 4)); this.buffer = this.buffer.subarray(length + 4);
        if (message.type === 'response') {
          const pending = this.pending.get(message.requestId); if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.requestId);
          message.resultType === 'success' ? pending.resolve(message) : pending.reject(new Error(message.error ?? 'Desktop request failed'));
        } else if (message.type === 'client-discovery-request') {
          this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === 'broadcast') this.emit('broadcast', message);
      }
    } catch (error) { this.close(error); }
  }
  close(error = new Error('Connector closed')) {
    const socket = this.socket; this.socket = null; socket?.destroy();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.buffer = Buffer.alloc(0); this.clientId = 'initializing-client';
    if (socket) this.emit('disconnected', error);
  }
}
