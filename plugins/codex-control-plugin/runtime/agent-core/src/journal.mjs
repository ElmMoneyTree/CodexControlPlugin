import fs from 'node:fs';
import path from 'node:path';
import { writeConfig } from './config.mjs';

export class CommandJournal {
  constructor(file) { this.file = file; this.records = read(file); }
  get(id) { return this.records[String(id)] ?? null; }
  begin(id) { this.set(id, { state: 'running', updatedAt: Date.now() }); }
  complete(id, acknowledgement) { this.set(id, { state: 'complete', acknowledgement, updatedAt: Date.now() }); }
  set(id, value) {
    this.records[String(id)] = value;
    const ordered = Object.entries(this.records).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, 1_000);
    this.records = Object.fromEntries(ordered);
    writeConfig(this.file, this.records);
  }
}

export function journalPath(configPath) {
  const extension = path.extname(configPath);
  return path.join(path.dirname(configPath), `${path.basename(configPath, extension)}.journal.json`);
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}
