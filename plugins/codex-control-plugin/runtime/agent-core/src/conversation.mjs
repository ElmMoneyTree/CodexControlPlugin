import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ImageAttachments, imageCandidates, markdownImages, IMAGE_CHUNK_BYTES } from './image-attachments.mjs';
import { questionReplyText } from '../../desktop-ipc/async-input.mjs';

// Only user-visible events are eligible. Raw model inputs, reasoning and
// unrelated tool results can contain private instructions and are never read.
export function conversationMessage(record, offset, describeImages = null) {
  if (record.type !== 'event_msg') return null;
  const payload = record.payload ?? {}, item = payload.item;
  let role, text = '', id, candidates = [];
  if (payload.type === 'item_completed' && ['UserMessage', 'AgentMessage'].includes(item?.type)) {
    role = item.type === 'UserMessage' ? 'user' : 'assistant';
    text = item.content?.filter(part => ['Text', 'text', 'input_text', 'output_text'].includes(part.type))
      .map(part => part.text ?? '').join('\n') ?? '';
    const markdown = markdownImages(role === 'user' ? questionReplyText(text) : text);
    text = markdown.text;
    candidates = [...imageCandidates(record), ...markdown.images];
    id = item.id;
  } else if (payload.type === 'item_completed' && ((item?.type === 'Extension' && item.kind === 'image_gen.generation' && item.status === 'completed') || item?.type === 'ImageView')) {
    role = 'assistant'; id = item.id; candidates = imageCandidates(record);
  } else if (['user_message', 'agent_message'].includes(payload.type)) {
    role = payload.type === 'user_message' ? 'user' : 'assistant';
    const message = typeof payload.message === 'string' ? payload.message : '';
    const markdown = markdownImages(role === 'user' ? questionReplyText(message) : message);
    text = markdown.text; candidates = markdown.images;
    for (const source of [...(payload.images ?? []), ...(payload.local_images ?? [])]) {
      candidates.push(typeof source === 'string' ? { source } : { source: source?.image_url ?? source?.url ?? source?.path });
    }
  } else return null;
  const createdAt = Date.parse(record.timestamp);
  if (!Number.isFinite(createdAt)) return null;
  const messageId = id ? `item:${id}` : `event:${createHash('sha256').update(`${offset}:${record.timestamp}:${role}:${text}`).digest('hex')}`;
  const attachments = describeImages ? describeImages(messageId, candidates) : [];
  if (!text.trim() && !attachments.length) return null;
  return { messageId, role, text: text.slice(0, 100_000), createdAt, position: offset,
    truncated: text.length > 100_000, ...(attachments.length ? { attachments } : {}) };
}

// Most records fit in one read window. Generated/inline images require reading
// a whole record; cap it independently so a large picture is not skipped at 1 MiB.
function* recordsFrom(file, start, size, maxRecordBytes, skipping = false) {
  const fd = fs.openSync(file, 'r');
  let readOffset = start, recordStart = start, parts = [], collected = 0;
  try {
    while (readOffset < size) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, size - readOffset));
      const count = fs.readSync(fd, buffer, 0, buffer.length, readOffset);
      if (!count) break;
      let position = 0;
      while (position < count) {
        const newline = buffer.indexOf(10, position);
        const end = newline < 0 || newline >= count ? count : newline;
        const segment = buffer.subarray(position, end);
        if (!skipping && collected + segment.length <= maxRecordBytes) { parts.push(segment); collected += segment.length; }
        else { skipping = true; parts = []; collected = 0; }
        const nextOffset = readOffset + end + (end < count ? 1 : 0);
        if (end < count) {
          const line = skipping ? null : (parts.length === 1 ? parts[0] : Buffer.concat(parts, collected)).toString('utf8');
          yield { line, start: recordStart, nextOffset, skipping: false };
          recordStart = nextOffset; parts = []; collected = 0; skipping = false;
        } else if (skipping) {
          yield { line: null, start: recordStart, nextOffset, skipping: true };
          recordStart = nextOffset;
        }
        position = end < count ? end + 1 : count;
      }
      readOffset += count;
    }
    // An unfinished trailing record is deliberately left for the next read.
  } finally { fs.closeSync(fd); }
}

export class ConversationReader {
  constructor(rollouts, { maxBytes = 1024 * 1024, maxBatchBytes = 400_000, maxRecordBytes = 64 * 1024 * 1024 } = {}) {
    this.rollouts = rollouts;
    this.maxBytes = maxBytes;
    this.maxBatchBytes = maxBatchBytes;
    this.maxRecordBytes = maxRecordBytes;
    this.images = new ImageAttachments();
    this.contexts = new Map();
  }

  context(file, stat) {
    const key = `${file}:${stat.ino}`;
    if (this.contexts.has(key)) return this.contexts.get(key);
    let cwd;
    try {
      const records = recordsFrom(file, 0, stat.size, this.maxRecordBytes);
      let first;
      try { first = records.next().value; } finally { records.return(); }
      const record = JSON.parse(first?.line);
      if (record.type === 'session_meta') cwd = record.payload?.cwd;
    } catch { /* Absolute attachment paths do not need a session cwd. */ }
    const context = { file, cwd };
    this.contexts.set(key, context);
    return context;
  }

  parse(record, offset, threadId, context) {
    return conversationMessage(record, offset, (messageId, candidates) => this.images.describe(threadId, messageId, candidates, { ...context, offset }));
  }

  read(threadId, encodedCursor = null) {
    const file = this.rollouts.locate(threadId);
    if (!file) throw new Error('Conversation log is unavailable');
    const stat = fs.statSync(file), context = this.context(file, stat);
    let cursor = null;
    if (encodedCursor) {
      try { cursor = JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf8')); }
      catch { throw new Error('Invalid conversation cursor'); }
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || typeof cursor.skipping !== 'boolean') throw new Error('Invalid conversation cursor');
    }
    // A one-time replay discovers images in already-synced text history. Phone
    // SQLite deduplicates messages and its deletion markers still filter old rows.
    if (!cursor || cursor.version !== 2 || cursor.inode !== stat.ino || cursor.offset > stat.size) cursor = { version: 2, inode: stat.ino, offset: 0, skipping: false };
    const next = { ...cursor }, messages = [];
    let bytes = 0;
    const records = recordsFrom(file, next.offset, stat.size, this.maxRecordBytes, next.skipping);
    try {
      while (next.offset < stat.size && next.offset - cursor.offset < this.maxBytes) {
        const entry = records.next();
        if (entry.done) break;
        const record = entry.value;
        let message;
        if (record.line) {
          try { message = this.parse(JSON.parse(record.line), record.start, threadId, context); }
          catch { /* Ignore malformed events without blocking subsequent records. */ }
        }
        if (message) {
          const candidate = { threadId, ...message }, size = Buffer.byteLength(JSON.stringify(candidate));
          if (messages.length && (bytes + size > this.maxBatchBytes || messages.length >= 100)) break;
          messages.push(candidate); bytes += size;
        }
        next.offset = record.nextOffset;
        next.skipping = record.skipping;
      }
    } finally { records.return(); }
    return { messages, nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url'), hasMore: next.offset < stat.size && next.offset > cursor.offset };
  }

  readAttachment(threadId, messageId, attachmentId, offset, length = IMAGE_CHUNK_BYTES) {
    if (typeof messageId !== 'string' || !messageId || messageId.length > 200 || !/^[0-9a-f]{64}$/.test(attachmentId) ||
        !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > IMAGE_CHUNK_BYTES) throw new Error('Invalid image request');
    const reload = () => {
      const file = this.rollouts.locate(threadId);
      if (!file) throw new Error('Conversation log is unavailable');
      const stat = fs.statSync(file), context = this.context(file, stat);
      const known = this.images.contextFor(threadId, messageId, attachmentId);
      const start = known?.file === file ? known.offset : 0;
      for (const event of recordsFrom(file, start, stat.size, this.maxRecordBytes)) {
        if (event.line) {
          try {
            const value = JSON.parse(event.line), itemId = value.payload?.item?.id;
            // Avoid decoding other images when looking up one stable item ID.
            if (!messageId.startsWith('item:') || `item:${itemId}` === messageId) {
              const message = this.parse(value, event.start, threadId, context);
              if (message?.messageId === messageId && message.attachments?.some(image => image.id === attachmentId)) return;
            }
          } catch { /* A malformed unrelated line must not authorize a source. */ }
        }
        if (known) break;
      }
      throw new Error('Image is not part of this conversation');
    };
    if (!this.images.has(threadId, messageId, attachmentId)) reload();
    try { return this.images.chunk(threadId, messageId, attachmentId, offset, length); }
    catch (error) {
      if (error.code !== 'IMAGE_CACHE_MISS') throw error;
      reload();
      return this.images.chunk(threadId, messageId, attachmentId, offset, length);
    }
  }
}
