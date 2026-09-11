import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class RolloutReader {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), maxBytes = 4 * 1024 * 1024 } = {}) {
    this.codexHome = codexHome; this.maxBytes = maxBytes; this.paths = new Map(); this.cache = new Map();
  }

  read(threadId) {
    const file = this.locate(threadId);
    if (!file) return null;
    const stat = fs.statSync(file), previous = this.cache.get(threadId);
    if (previous?.size === stat.size && previous?.mtimeMs === stat.mtimeMs) return previous.value;
    const length = Math.min(stat.size, this.maxBytes), descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    try { fs.readSync(descriptor, buffer, 0, length, stat.size - length); } finally { fs.closeSync(descriptor); }
    let lines = buffer.toString('utf8').split(/\r?\n/);
    if (stat.size > length) lines = lines.slice(1);
    const value = parseRollout(lines);
    this.cache.set(threadId, { size: stat.size, mtimeMs: stat.mtimeMs, value });
    return value;
  }

  locate(threadId) {
    const known = this.paths.get(threadId);
    if (known && fs.existsSync(known)) return known;
    const timestamp = uuidV7Timestamp(threadId);
    if (timestamp) {
      const date = new Date(timestamp);
      const directory = path.join(this.codexHome, 'sessions', String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), pad(date.getUTCDate()));
      try {
        const match = fs.readdirSync(directory).find(name => name.endsWith(`${threadId}.jsonl`));
        if (match) { const file = path.join(directory, match); this.paths.set(threadId, file); return file; }
      } catch { /* The task may have been created by a different local Codex home. */ }
    }
    return null;
  }
}

export function parseRollout(lines) {
  const result = { latestMessage: null, latestTurnId: null, status: null, updatedAt: null };
  for (const line of lines) {
    let record; try { record = JSON.parse(line); } catch { continue; }
    const timestamp = Date.parse(record.timestamp);
    if (Number.isFinite(timestamp)) result.updatedAt = timestamp;
    if (record.type === 'event_msg') readEvent(record.payload, result);
    if (record.type === 'response_item') readResponse(record.payload, result);
  }
  return result;
}

function readEvent(payload, result) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'task_started' || payload.type === 'turn_started') result.status = 'running';
  if (payload.type === 'task_complete') {
    result.status = 'completed'; result.latestTurnId = payload.turn_id ?? result.latestTurnId;
    if (typeof payload.last_agent_message === 'string') result.latestMessage = payload.last_agent_message;
  }
  if (payload.type === 'turn_aborted' || payload.type === 'task_failed') result.status = 'failed';
  if (payload.type === 'item_completed' && payload.item?.type === 'AgentMessage') {
    result.latestTurnId = payload.turn_id ?? result.latestTurnId;
    const text = payload.item.content?.filter(item => item.type === 'Text').map(item => item.text).join('\n');
    if (text) result.latestMessage = text;
  }
}

function readResponse(payload, result) {
  if (payload?.type !== 'message' || payload.role !== 'assistant') return;
  const text = payload.content?.filter(item => item.type === 'output_text').map(item => item.text).join('\n');
  if (text) result.latestMessage = text;
  result.latestTurnId = payload.internal_chat_message_metadata_passthrough?.turn_id ?? result.latestTurnId;
}

function uuidV7Timestamp(value) {
  if (typeof value !== 'string') return null;
  const prefix = value.replaceAll('-', '').slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(prefix)) return null;
  const number = Number.parseInt(prefix, 16);
  return Number.isSafeInteger(number) ? number : null;
}
function pad(value) { return String(value).padStart(2, '0'); }
