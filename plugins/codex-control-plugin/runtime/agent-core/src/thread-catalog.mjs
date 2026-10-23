import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RolloutReader } from './rollouts.mjs';
import { readSessionIndex } from './state.mjs';

// session_index.jsonl includes internal reviews and archived threads. It is a
// title index, not the desktop sidebar's list of user-visible conversations.
export function isVisibleThread(metadata) {
  if (metadata.archived === true || metadata.archived === 1) return false;
  const kind = metadata.thread_source ?? metadata.threadSource;
  if (kind && !['user', 'automation', 'agent_created_thread'].includes(kind)) return false;
  let source = metadata.source;
  if (typeof source === 'string' && source.startsWith('{')) {
    try { source = JSON.parse(source); } catch { return false; }
  }
  if (source && typeof source === 'object') return false;
  if (typeof source === 'string' && /^subagent/i.test(source)) return false;
  return ['user', 'automation', 'agent_created_thread'].includes(kind) || ['cli', 'vscode', 'exec', 'appServer', 'app_server'].includes(source);
}

export class LocalThreadCatalog {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
    this.codexHome = codexHome;
    this.rollouts = new RolloutReader({ codexHome });
    this.metadataCache = new Map();
  }

  read(limit = 50) {
    const database = this.databasePath();
    if (database) {
      try { return this.readDatabase(database, limit); }
      catch { /* Older or migrating schemas use verified active rollout metadata. */ }
    }
    // Apply visibility BEFORE the limit so internal tasks cannot crowd out
    // real conversations. Unknown metadata is not safe to publish.
    const index = readSessionIndex(path.join(this.codexHome, 'session_index.jsonl'), Infinity);
    const visible = [];
    for (const entry of index) {
      const metadata = this.readMetadata(entry.id);
      if (!metadata || !isVisibleThread(metadata)) continue;
      visible.push({ ...entry, cwd: metadata.cwd });
      if (visible.length >= limit) break;
    }
    return visible;
  }

  databasePath() {
    try {
      const names = fs.readdirSync(this.codexHome).filter(name => /^state_\d+\.sqlite$/.test(name));
      names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      return names[0] ? path.join(this.codexHome, names[0]) : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  readDatabase(file, limit) {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 1000');
      const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
      for (const required of ['id', 'title', 'source', 'archived', 'updated_at']) {
        if (!columns.has(required)) throw new Error('Unsupported thread metadata schema');
      }
      const optional = (name, fallback = 'NULL') => columns.has(name) ? name : fallback;
      const updated = `COALESCE(${optional('updated_at_ms')}, updated_at * 1000)`;
      const recency = `COALESCE(${optional('recency_at_ms')}, ${optional('recency_at')} * 1000, ${updated})`;
      const rows = database.prepare(`SELECT id, title, source, archived,
        ${optional('name')} AS name, ${optional('cwd')} AS cwd,
        ${optional('thread_source')} AS thread_source, ${updated} AS updatedAt
        FROM threads WHERE archived = 0 ORDER BY ${recency} DESC, id DESC`).all();
      return rows.filter(isVisibleThread).slice(0, limit).map(row => ({
        id: row.id, title: row.name || row.title || row.id, cwd: row.cwd, updatedAt: row.updatedAt,
      }));
    } finally { database.close(); }
  }

  readMetadata(threadId) {
    // locate() only searches active sessions, never archived_sessions.
    const file = this.rollouts.locate(threadId);
    if (!file) return null;
    try {
      const stat = fs.statSync(file);
      const previous = this.metadataCache.get(threadId);
      if (previous?.file === file && previous.mtimeMs === stat.mtimeMs) return previous.value;
      const descriptor = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
      let bytes;
      try { bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0); }
      finally { fs.closeSync(descriptor); }
      const record = JSON.parse(buffer.subarray(0, bytes).toString('utf8').split('\n', 1)[0]);
      if (record.type !== 'session_meta' || record.payload?.id !== threadId) return null;
      const { source, thread_source, cwd } = record.payload;
      const value = { source, thread_source, cwd };
      this.metadataCache.set(threadId, { file, mtimeMs: stat.mtimeMs, value });
      return value;
    } catch { return null; }
  }
}
