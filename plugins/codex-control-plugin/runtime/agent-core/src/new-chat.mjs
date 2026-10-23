// These mappings follow the desktop's list_projects/create_thread schemas.
// Only local Codex projects belong to this device; ChatGPT projects use the
// desktop's cloud Work target and never receive local filesystem paths.
export function normalizeProjects(value) {
  if (!Array.isArray(value?.projects)) throw new Error('Invalid desktop project catalog');
  const projects = new Map();
  for (const project of value.projects) {
    const kind = project.projectKind === 'chatgpt' ? 'chatgpt' : project.projectKind === 'local' ? 'codex' : null;
    if (!kind || (kind === 'codex' && project.hostId && project.hostId !== 'local')) continue;
    if (typeof project.projectId !== 'string' || !project.projectId.trim() || project.projectId.length > 200) continue;
    const name = typeof project.label === 'string' && project.label.trim() ? project.label.trim().slice(0, 500) : project.projectId;
    projects.set(`${kind}:${project.projectId}`, { id: project.projectId, name, kind });
  }
  return [...projects.values()];
}

export function normalizeCreation(value, command) {
  if (value?.status && !['created', 'starting', 'queued'].includes(value.status)) throw new Error(`Desktop chat creation ${value.status}; outcome must be checked on desktop before retrying`);
  if (value?.firstTurn && value.firstTurn.status !== 'accepted') throw new Error('The chat was created but its initial message was not accepted; check desktop before retrying');
  const threadId = value?.threadId ?? (value?.status === 'created' ? value.conversationId : null);
  const clientThreadId = value?.clientThreadId;
  const validIdentity = id => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 100;
  if ((threadId != null && !validIdentity(threadId)) || (clientThreadId != null && !validIdentity(clientThreadId)) || (!validIdentity(threadId) && !validIdentity(clientThreadId))) throw new Error('Desktop did not return a valid chat identity; outcome unknown, check desktop before retrying');
  if (value.kind && value.kind !== command.backend) throw new Error('Desktop created an unexpected chat backend; check desktop before retrying');
  return { submitted: true, backend: command.backend, ...(command.projectId ? { projectId: command.projectId } : {}),
    ...(threadId ? { threadId, status: 'created' } : { clientThreadId, status: 'starting' }) };
}

// ChatGPT's desktop history API pages backwards. Keep the last observed message
// as a watermark, then scan recent pages down to it on subsequent phone polls.
// Returning the watermark item again lets SQLite update streaming assistant text.
export async function readChatGPTConversation(appTools, context, threadId, encodedCursor) {
  if (!appTools || !context) throw new Error('Desktop ChatGPT history is unavailable');
  let cursor = { version: 1, threadId, seen: null, head: null, native: null };
  if (encodedCursor) {
    try { cursor = JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf8')); }
    catch { throw new Error('Invalid ChatGPT conversation cursor'); }
    if (cursor.version !== 1 || cursor.threadId !== threadId || ['seen', 'head', 'native'].some(key => cursor[key] !== null && (typeof cursor[key] !== 'string' || cursor[key].length > 200))) throw new Error('Invalid ChatGPT conversation cursor');
  }
  const value = await appTools.readThread(threadId, cursor.native, context);
  if (value?.thread?.kind !== 'chatgpt' || value.thread.id !== threadId || !Array.isArray(value.turns) || value?.page?.order !== 'newest_first') throw new Error('Invalid desktop ChatGPT history response');
  const newestFirst = [];
  for (const turn of value.turns) {
    const items = turn.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex];
      let role, text;
      if (item.type === 'userMessage') { role = 'user'; text = item.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n'); }
      else if (item.type === 'agentMessage') { role = 'assistant'; text = item.text; }
      else continue;
      if (typeof item.id !== 'string' || !item.id || typeof text !== 'string' || !text.trim()) continue;
      const createdAt = timestamp(turn.startedAt ?? value.thread.createdAt ?? value.thread.updatedAt);
      newestFirst.push({ threadId, messageId: `chatgpt:${item.id}`, role, text: text.slice(0, 100_000), createdAt,
        position: Math.min(createdAt, 8_000_000_000_000) * 1_000 + Math.min(itemIndex, 999), truncated: item.truncated === true || text.length > 100_000 || item.content?.some(part => part.truncated === true) === true });
    }
  }
  const head = cursor.head ?? newestFirst[0]?.messageId ?? cursor.seen;
  const boundary = cursor.seen ? newestFirst.findIndex(message => message.messageId === cursor.seen) : -1;
  const messages = (boundary >= 0 ? newestFirst.slice(0, boundary + 1) : newestFirst).reverse();
  if (messages.length > 100 || Buffer.byteLength(JSON.stringify(messages), 'utf8') > 400_000) throw new Error('Desktop ChatGPT history page is too large');
  const more = boundary < 0 && value.page.hasMore === true;
  if (more && (typeof value.page.nextCursor !== 'string' || !value.page.nextCursor || value.page.nextCursor === cursor.native)) throw new Error('Invalid desktop ChatGPT history pagination');
  const next = more ? { version: 1, threadId, seen: cursor.seen, head, native: value.page.nextCursor }
    : { version: 1, threadId, seen: head, head: null, native: null };
  return { messages, nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url'), hasMore: more };
}

function timestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  return Math.floor(parsed < 10_000_000_000 ? parsed * 1_000 : parsed);
}
