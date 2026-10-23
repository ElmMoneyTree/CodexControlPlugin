import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultSessionIndexPath() {
  const root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(root, 'session_index.jsonl');
}

export function readSessionIndex(file = defaultSessionIndexPath(), limit = 100) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const lines = content.split(/\r?\n/).filter(Boolean);
  const entries = [], seen = new Set();
  for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (!value.id || seen.has(value.id)) continue;
      seen.add(value.id);
      entries.push({ id: value.id, title: value.thread_name || value.id, updatedAt: Date.parse(value.updated_at) || Date.now() });
    } catch { /* A partial trailing line is ignored. */ }
  }
  return entries;
}

export function extractLatestTurn(state) {
  const entities = state?.turnHistory?.history?.entitiesByKey ?? {};
  const turns = [...Object.values(entities), ...(Array.isArray(state?.turns) ? state.turns : [])]
    .filter(value => value && typeof value === 'object')
    .filter(turn => typeof turn.turnId === 'string')
    .sort((left, right) => (right.turnStartedAtMs ?? 0) - (left.turnStartedAtMs ?? 0));
  return turns[0] ?? null;
}

export function buildAgentState(listedTasks, snapshots = new Map()) {
  const tasks = [], requests = [], callerContexts = [];
  for (const listed of listedTasks) {
    const threadId = listed.id ?? listed.threadId;
    if (!threadId) continue;
    const snapshot = snapshots.get(threadId);
    const latestTurn = snapshot && extractLatestTurn(snapshot);
    const pending = snapshot?.requests ?? [];
    const latestMessage = latestAgentMessage(latestTurn) ?? textOrNull(listed.latestMessage, 20_000);
    const runtime = snapshot?.threadRuntimeStatus;
    const status = deriveStatus(listed, runtime, latestTurn, pending);
    const updatedAt = normalizeTimestamp(snapshot?.updatedAt ?? listed.updatedAt);
    tasks.push({
      threadId,
      backend: listed.backend ?? listed.kind ?? 'codex',
      title: listed.title || snapshot?.title || threadId,
      project: snapshot?.cwd || listed.cwd || listed.project || null,
      status,
      summary: listed.summary || null,
      latestMessage,
      updatedAt,
    });
    if (latestTurn?.turnId) callerContexts.push({ threadId, turnId: latestTurn.turnId, updatedAt });
    for (const request of pending) {
      const mapped = mapRequest(threadId, request, snapshot);
      if (mapped) requests.push(mapped);
    }
  }
  callerContexts.sort((left, right) => right.updatedAt - left.updatedAt);
  return { tasks, requests, callerContexts };
}

function deriveStatus(listed, runtime, latestTurn, requests) {
  if (requests.some(request => [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
  ].includes(request.method))) return 'waiting_approval';
  if (requests.length) return 'waiting_input';
  if (runtime?.activeFlags?.includes('waitingOnApproval')) return 'waiting_approval';
  const live = normalizeStatus(runtime?.type), advertised = normalizeStatus(listed.status);
  if (['active', 'running', 'in_progress'].includes(live)) return 'running';
  if (['active', 'running', 'in_progress'].includes(advertised)) return 'running';
  if (['queued', 'waiting_approval', 'waiting_input'].includes(advertised)) return advertised;

  // A listed "idle"/"completed" value is not a successful turn record. Use
  // the latest actual turn or a lifecycle event from its rollout instead.
  const rollout = listed.rolloutState;
  const newerRolloutTurn = rollout?.latestTurnId && latestTurn?.turnId
    && rollout.latestTurnId !== latestTurn.turnId
    && Number(rollout.updatedAt) > Number(latestTurn.turnStartedAtMs ?? Infinity);
  const evidence = newerRolloutTurn || !latestTurn
    ? (rollout?.latestTurnId ? rollout : null) : latestTurn;
  const status = normalizeStatus(evidence?.status);
  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(status)) return 'cancelled';
  if (evidence?.error || ['failed', 'error'].includes(status)) return 'failed';
  if (status === 'completed') return 'completed';
  if (['active', 'running', 'in_progress'].includes(status)) return 'running';
  if (['queued', 'waiting_approval', 'waiting_input'].includes(status)) return status;

  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(advertised)) return 'cancelled';
  if (['failed', 'error'].includes(advertised)) return 'failed';
  if (advertised === 'notloaded' || advertised === 'not_loaded') return 'not_loaded';
  if (live === 'idle' || advertised === 'idle') return 'idle';
  return 'unknown';
}

function normalizeStatus(value) {
  return typeof value === 'string' ? value.trim().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replaceAll('-', '_') : '';
}

function mapRequest(threadId, request, state) {
  const params = request?.params ?? {};
  if (!request?.method || request.id == null) return null;
  const kind = requestKind(request.method);
  if (!params.turnId && kind !== 'mcp') return null;
  const item = findTurnItem(state, params.turnId, params.itemId);
  return {
    threadId,
    requestId: String(request.id),
    turnId: params.turnId ?? null,
    kind,
    payload: {
      method: request.method,
      itemId: textOrNull(params.itemId, 100),
      reason: textOrNull(params.reason, 4_000),
      command: textOrNull(params.command, 20_000),
      cwd: textOrNull(params.cwd, 2_000),
      grantRoot: textOrNull(params.grantRoot, 2_000),
      availableDecisions: normalizeDecisions(params.availableDecisions),
      questions: normalizeQuestions(params.questions),
      isBlocking: params.isBlocking === true,
      autoResolutionMs: finiteNumberOrNull(params.autoResolutionMs),
      permissions: jsonValueOrNull(params.permissions, 50_000),
      fileChanges: jsonValueOrNull(params.fileChanges ?? item?.changes ?? item?.fileChanges, 50_000),
      serverName: textOrNull(params.serverName, 500),
      mode: textOrNull(params.mode, 40),
      message: textOrNull(params.message, 4_000),
      url: textOrNull(params.url, 4_000),
      elicitationId: textOrNull(params.elicitationId, 200),
      requestedSchema: jsonValueOrNull(params.requestedSchema, 50_000),
    },
    updatedAt: normalizeTimestamp(params.startedAtMs ?? Date.now()),
  };
}

function requestKind(method) {
  return ({
    'item/commandExecution/requestApproval': 'command',
    'item/fileChange/requestApproval': 'file',
    'item/permissions/requestApproval': 'permissions',
    'item/tool/requestUserInput': 'user_input',
    'mcpServer/elicitation/request': 'mcp',
  })[method] ?? 'unsupported';
}

function findTurnItem(state, turnId, itemId) {
  if (!turnId || !itemId) return null;
  const entities = state?.turnHistory?.history?.entitiesByKey ?? {};
  const turn = entities[`turn:${turnId}`] ?? Object.values(entities).find(value => value?.turnId === turnId);
  return turn?.items?.find(item => item?.id === itemId || item?.itemId === itemId) ?? null;
}

function normalizeDecisions(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string').slice(0, 10);
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 20).map(question => ({
    id: textOrNull(question?.id, 100),
    header: textOrNull(question?.header, 100),
    question: textOrNull(question?.question, 2_000),
    isOther: question?.isOther === true,
    isSecret: question?.isSecret === true,
    options: Array.isArray(question?.options) ? question.options.slice(0, 20).map(option => ({
      label: textOrNull(option?.label, 200), description: textOrNull(option?.description, 1_000),
    })).filter(option => option.label) : null,
  })).filter(question => question.id && question.question);
}

function jsonValueOrNull(value, maxBytes) {
  if (value == null || typeof value !== 'object') return null;
  try {
    const encoded = JSON.stringify(value);
    return Buffer.byteLength(encoded, 'utf8') <= maxBytes ? JSON.parse(encoded) : null;
  } catch { return null; }
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function latestAgentMessage(turn) {
  if (!turn?.items) return null;
  return turn.items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string').at(-1)?.text.slice(0, 20_000) ?? null;
}

function textOrNull(value, max) { return typeof value === 'string' ? value.slice(0, max) : null; }
function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now();
  return number < 10_000_000_000 ? Math.floor(number * 1_000) : Math.floor(number);
}
