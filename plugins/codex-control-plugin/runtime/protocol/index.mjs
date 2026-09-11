export const COMMAND_KINDS = new Set([
  'send_message',
  'command_approval',
  'file_approval',
  'permissions_approval',
  'user_input_response',
  'mcp_response',
]);
export const APPROVAL_DECISIONS = new Set(['accept', 'decline', 'cancel']);
export const PERMISSION_DECISIONS = new Set(['accept', 'decline']);
export const MCP_ACTIONS = new Set(['accept', 'decline', 'cancel']);

export function requireString(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ProtocolError(`${name} is invalid`);
  }
  return value.trim();
}

export function optionalString(value, name, max = 2_000) {
  if (value == null) return null;
  return requireString(value, name, max);
}

export function validHttpOrigin(value, name = 'Relay URL') {
  let url;
  try { url = new URL(value); } catch { throw new ProtocolError(`${name} must be an HTTP(S) origin`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ProtocolError(`${name} must be an HTTP(S) origin`);
  }
  return url.origin;
}

export function parseAgentState(input) {
  if (!input || typeof input !== 'object') throw new ProtocolError('State is invalid');
  if (!Array.isArray(input.tasks) || !Array.isArray(input.requests)) {
    throw new ProtocolError('tasks and requests must be arrays');
  }
  if (input.tasks.length > 1_000 || input.requests.length > 500) {
    throw new ProtocolError('State payload is too large');
  }
  const tasks = input.tasks.map((task) => ({
    threadId: requireString(task.threadId, 'threadId', 100),
    title: requireString(task.title, 'title', 500),
    project: optionalString(task.project, 'project', 1_000),
    status: requireString(task.status, 'status', 40),
    summary: optionalString(task.summary, 'summary', 4_000),
    latestMessage: optionalString(task.latestMessage, 'latestMessage', 20_000),
    updatedAt: finiteTimestamp(task.updatedAt),
  }));
  const requests = input.requests.map((request) => ({
    threadId: requireString(request.threadId, 'threadId', 100),
    requestId: requireString(String(request.requestId), 'requestId', 100),
    turnId: optionalString(request.turnId, 'turnId', 100),
    kind: requireString(request.kind, 'kind', 100),
    payload: boundedObject(request.payload, 'request payload', 100_000),
    updatedAt: finiteTimestamp(request.updatedAt),
  }));
  return { tasks, requests };
}

export function parseCommand(input) {
  if (!input || typeof input !== 'object') throw new ProtocolError('Command is invalid');
  const kind = requireString(input.kind, 'kind', 40);
  if (!COMMAND_KINDS.has(kind)) throw new ProtocolError('Command kind is unsupported');
  const threadId = requireString(input.threadId, 'threadId', 100);
  const requestId = optionalString(input.requestId == null ? null : String(input.requestId), 'requestId', 100);
  const turnId = optionalString(input.turnId, 'turnId', 100);
  const text = optionalString(input.text, 'text', 20_000);
  const decision = optionalString(input.decision, 'decision', 30);
  const action = optionalString(input.action, 'action', 30);
  const answers = input.answers == null ? null : parseAnswers(input.answers);
  const content = input.content == null ? null : boundedObject(input.content, 'content', 50_000);
  if (kind === 'send_message' && !text) throw new ProtocolError('Message text is required');
  if (kind === 'command_approval' || kind === 'file_approval') {
    if (!requestId || !turnId || !decision || !APPROVAL_DECISIONS.has(decision)) {
      throw new ProtocolError('Approval identity or decision is invalid');
    }
  }
  if (kind === 'permissions_approval') {
    if (!requestId || !turnId || !decision || !PERMISSION_DECISIONS.has(decision)) {
      throw new ProtocolError('Permission approval identity or decision is invalid');
    }
  }
  if (kind === 'user_input_response' && (!requestId || !turnId || !answers || !Object.keys(answers).length)) {
    throw new ProtocolError('User input identity or answers are invalid');
  }
  if (kind === 'mcp_response') {
    if (!requestId || !action || !MCP_ACTIONS.has(action) || (action === 'accept' && !content)) {
      throw new ProtocolError('MCP response identity, action, or content is invalid');
    }
  }
  return { kind, threadId, requestId, turnId, text, decision, answers, action, content };
}

function parseAnswers(value) {
  if (!isPlainObject(value) || Object.keys(value).length > 20) throw new ProtocolError('answers is invalid');
  const result = {};
  for (const [questionId, raw] of Object.entries(value)) {
    const id = requireString(questionId, 'questionId', 100);
    if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new ProtocolError('answer list is invalid');
    result[id] = raw.map(answer => requireString(answer, 'answer', 4_000));
  }
  return result;
}

function boundedObject(value, name, maxBytes) {
  if (value == null) return {};
  if (!isPlainObject(value)) throw new ProtocolError(`${name} is invalid`);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new ProtocolError(`${name} is invalid`); }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new ProtocolError(`${name} is too large`);
  return JSON.parse(encoded);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Date.now();
}

export class ProtocolError extends Error {
  constructor(message) { super(message); this.name = 'ProtocolError'; this.statusCode = 400; }
}
