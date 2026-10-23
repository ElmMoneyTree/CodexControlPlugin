import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 196_608;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif']);
const digest = value => createHash('sha256').update(value).digest('hex');

export function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(4, 8).toString() === 'ftyp') {
    const brands = buffer.subarray(8, Math.min(buffer.length, 64)).toString('ascii');
    if (/avif|avis/.test(brands)) return 'image/avif';
    if (/heic|heix|hevc|hevx/.test(brands)) return 'image/heic';
    if (/mif1|msf1/.test(brands)) return 'image/heif';
  }
  return null;
}

export function markdownImages(text) {
  const images = [];
  const pattern = /(?<!\\)!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
  const replaceImages = value => value.replace(pattern, (_match, alt, angle, simple) => {
    images.push({ source: angle ?? simple, name: alt || undefined, urlEncoded: true });
    return alt ? `[${alt}]` : '';
  });
  const inline = line => {
    let result = '', position = 0;
    while (position < line.length) {
      const tick = line.indexOf('`', position);
      if (tick < 0) return result + replaceImages(line.slice(position));
      let end = tick + 1;
      while (line[end] === '`') end++;
      const marker = line.slice(tick, end);
      let close = line.indexOf(marker, end);
      while (close >= 0 && (line[close - 1] === '`' || line[close + marker.length] === '`')) close = line.indexOf(marker, close + marker.length);
      if (close < 0) return result + replaceImages(line.slice(position));
      result += replaceImages(line.slice(position, tick)) + line.slice(tick, close + marker.length);
      position = close + marker.length;
    }
    return result;
  };
  let fence = null;
  const cleaned = text.split(/(?<=\n)/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return line; }
    if (/^(?: {4}|\t)/.test(line)) return line;
    return inline(line);
  }).join('');
  return { text: cleaned, images };
}

export function imageCandidates(record) {
  const payload = record.payload ?? {}, item = payload.item;
  if (record.type !== 'event_msg' || payload.type !== 'item_completed') return [];
  if (item?.type === 'Extension' && item.kind === 'image_gen.generation' && item.status === 'completed') {
    return [{ source: item.savedPath, base64: item.result, name: '生成的图片.png' }];
  }
  if (item?.type === 'ImageView') return [{ source: item.path }];
  if (!['UserMessage', 'AgentMessage'].includes(item?.type)) return [];
  const result = [];
  for (const part of item.content ?? []) {
    if (['local_image', 'LocalImage'].includes(part.type)) result.push({ source: part.path, name: part.name });
    if (['image', 'Image', 'input_image', 'output_image'].includes(part.type)) {
      result.push({ source: part.image_url?.url ?? part.image_url ?? part.url ?? part.path, name: part.name });
    }
  }
  return result;
}

function filename(value, mime) {
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif' })[mime] ?? 'png';
  const name = typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f/\\]/g, '_').trim().slice(0, 180) : '';
  return name || `图片.${extension}`;
}

// IDs resolve only to sources declared in a visible message, never to a path
// supplied by a phone request. Inline image buffers have a bounded memory cache.
export class ImageAttachments {
  constructor({ maxCachedBytes = 64 * 1024 * 1024 } = {}) {
    this.entries = new Map();
    this.buffers = new Map();
    this.cachedBytes = 0;
    this.maxCachedBytes = maxCachedBytes;
  }

  key(threadId, messageId, attachmentId) { return `${threadId}\0${messageId}\0${attachmentId}`; }

  describe(threadId, messageId, candidates, context = {}) {
    const result = [], seen = new Set();
    for (const [index, candidate] of candidates.slice(0, 16).entries()) {
      const id = digest(`${threadId}\0${messageId}\0${index}`);
      const key = this.key(threadId, messageId, id);
      let entry;
      try {
        entry = this.resolve(candidate, context);
        // The same image can occur as both a native attachment and Markdown.
        if (seen.has(entry.sha256)) continue;
        seen.add(entry.sha256);
        entry.id = id;
        entry.name = filename(candidate.name ?? entry.basename, entry.mimeType);
        entry.context = context;
        entry.candidate = candidate.source?.startsWith('data:') || candidate.base64 ? null : candidate;
        this.entries.set(key, entry);
        if (entry.buffer) this.cache(key, entry.buffer);
        delete entry.buffer;
        result.push(this.metadata(entry));
      } catch (error) {
        const metadata = { id, name: filename(candidate.name, 'image/png'), mimeType: 'image/png', byteCount: 0, sha256: '', unavailableReason: error.safeReason ?? '电脑端暂时无法读取这张图片' };
        this.entries.set(key, { ...metadata, context });
        result.push(metadata);
      }
    }
    return result;
  }

  metadata(entry) {
    return { id: entry.id, name: entry.name, mimeType: entry.mimeType, byteCount: entry.byteCount, sha256: entry.sha256,
      ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}) };
  }

  resolve(candidate, context) {
    const fail = reason => { throw Object.assign(new Error(reason), { safeReason: reason }); };
    // Generated results embed the original bytes. Prefer them over a saved
    // path that may have been edited since the message was produced.
    let source = typeof candidate.base64 === 'string' && candidate.base64 ? null : candidate.source;
    if (candidate.urlEncoded && typeof source === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(source)) {
      try { source = decodeURIComponent(source); } catch { fail('图片文件地址无法读取'); }
    }
    if (typeof source === 'string' && source.startsWith('file:')) {
      try { source = fileURLToPath(source); } catch { fail('图片文件地址无法读取'); }
    }
    if (typeof source === 'string' && !source.startsWith('data:') && !/^https?:/i.test(source)) {
      const file = path.isAbsolute(source) ? source : context.cwd ? path.resolve(context.cwd, source) : null;
      if (file) {
        try {
          const realPath = fs.realpathSync(file);
          const fd = fs.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) fail('图片文件已不存在');
            if (stat.size > MAX_IMAGE_BYTES) fail('图片超过 25 MB，暂时无法同步');
            const buffer = Buffer.alloc(stat.size);
            let count = 0;
            while (count < buffer.length) {
              const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
              if (!read) fail('图片文件仍在写入，请稍后重试');
              count += read;
            }
            const after = fs.fstatSync(fd);
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('图片文件仍在写入，请稍后重试');
            const mimeType = imageType(buffer);
            if (!mimeType) fail('暂不支持这种图片格式');
            return { realPath, inode: stat.ino, device: stat.dev, mtimeMs: stat.mtimeMs,
              basename: path.basename(realPath), byteCount: buffer.length, mimeType, sha256: digest(buffer) };
          } finally { fs.closeSync(fd); }
        } catch (error) {
          if (!candidate.base64) {
            if (error.safeReason) throw error;
            fail('图片文件在电脑端已不存在或无法读取');
          }
        }
      }
    }
    let encoded, declaredType;
    if (typeof source === 'string' && source.startsWith('data:')) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(source);
      if (!match) fail('图片数据格式无法读取');
      declaredType = match[1].toLowerCase(); encoded = match[2];
    } else if (typeof candidate.base64 === 'string') encoded = candidate.base64;
    else if (typeof source === 'string' && /^https?:/i.test(source)) fail('这张图片尚未保存在电脑本地');
    else fail('图片文件地址无法读取');
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024) fail('图片超过 25 MB，暂时无法同步');
    const clean = encoded.replace(/\s/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    const equal = clean.indexOf('=');
    if (!clean.length || clean.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(clean) || (equal >= 0 && equal !== clean.length - padding)) fail('图片数据格式无法读取');
    const buffer = Buffer.from(clean, 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) fail('图片大小超出可同步范围');
    const mimeType = imageType(buffer);
    if (!mimeType || (declaredType && !TYPES.has(declaredType))) fail('暂不支持这种图片格式');
    return { buffer, byteCount: buffer.length, mimeType, sha256: digest(buffer) };
  }

  cache(key, buffer) {
    const previous = this.buffers.get(key);
    if (previous) this.cachedBytes -= previous.length;
    this.buffers.delete(key);
    while (this.cachedBytes + buffer.length > this.maxCachedBytes && this.buffers.size) {
      const first = this.buffers.keys().next().value;
      this.cachedBytes -= this.buffers.get(first).length;
      this.buffers.delete(first);
    }
    if (buffer.length <= this.maxCachedBytes) { this.buffers.set(key, buffer); this.cachedBytes += buffer.length; }
  }

  contextFor(threadId, messageId, id) { return this.entries.get(this.key(threadId, messageId, id))?.context; }

  has(threadId, messageId, id) { return this.entries.has(this.key(threadId, messageId, id)); }

  chunk(threadId, messageId, id, offset, length = IMAGE_CHUNK_BYTES) {
    if (!/^[0-9a-f]{64}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > IMAGE_CHUNK_BYTES) throw new Error('Invalid image request');
    const key = this.key(threadId, messageId, id), entry = this.entries.get(key);
    if (!entry || entry.unavailableReason) throw new Error('Image is unavailable in this conversation');
    if (offset >= entry.byteCount) throw new Error('Image offset is outside the file');
    let data;
    if (entry.realPath) {
      const fd = fs.openSync(entry.realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== entry.byteCount || stat.ino !== entry.inode || stat.dev !== entry.device || stat.mtimeMs !== entry.mtimeMs) throw new Error('Image changed on the computer; reopen the conversation');
        data = Buffer.alloc(Math.min(length, entry.byteCount - offset));
        const read = fs.readSync(fd, data, 0, data.length, offset);
        if (read !== data.length) throw new Error('Image changed during transfer');
      } finally { fs.closeSync(fd); }
    } else {
      const buffer = this.buffers.get(key);
      if (!buffer) throw Object.assign(new Error('Inline image needs to be reloaded'), { code: 'IMAGE_CACHE_MISS' });
      this.cache(key, buffer);
      data = buffer.subarray(offset, Math.min(offset + length, buffer.length));
    }
    return { attachmentId: id, offset, totalBytes: entry.byteCount, mimeType: entry.mimeType, sha256: entry.sha256,
      data: data.toString('base64'), hasMore: offset + data.length < entry.byteCount };
  }
}
