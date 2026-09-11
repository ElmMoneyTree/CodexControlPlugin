import { EventEmitter } from 'node:events';

export class DesktopTasks extends EventEmitter {
  constructor(ipc) {
    super(); this.ipc = ipc; this.states = new Map(); this.owners = new Map(); this.pending = new Set();
    this.onBroadcast = message => this.receive(message); ipc.on('broadcast', this.onBroadcast);
    ipc.on('disconnected', () => { this.states.clear(); this.owners.clear(); this.emit('offline'); });
  }
  follow(id, following) {
    const owner = this.owners.get(id); if (!owner) return;
    this.ipc.send({ type: 'broadcast', sourceClientId: this.ipc.clientId, version: 1, method: 'thread-stream-following-changed', targetClientIds: [owner], params: { hostId: 'local', conversationId: id, following } });
  }
  receive(message) {
    const id = message.params?.conversationId;
    if (!this.owners.has(id) || message.sourceClientId !== this.owners.get(id)) return;
    const change = message.params?.change;
    if (change?.type === 'snapshot') {
      this.states.set(id, change.conversationState); this.emit(`snapshot:${id}`, change.conversationState); this.emit('updated', id);
    } else if (change?.type === 'patches') {
      this.states.delete(id); this.emit('changed', id);
    }
  }
  async snapshot(id) {
    if (!this.owners.has(id)) {
      const owner = await this.ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: id });
      this.owners.set(id, owner.handledByClientId); this.follow(id, true);
    }
    return new Promise((resolve, reject) => {
      const name = `snapshot:${id}`;
      const cleanup = () => { clearTimeout(timer); this.off(name, received); };
      const received = state => { cleanup(); resolve(state); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Task snapshot timeout')); }, 7_000);
      this.once(name, received);
      this.ipc.request('thread-follower-load-complete-history', { conversationId: id }, { targetClientId: this.owners.get(id) }).catch(error => { cleanup(); reject(error); });
    });
  }
  approve(id, input) { return this.approveCommand(id, input); }
  async approveCommand(id, { requestId, turnId, decision }) {
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('Unsupported command approval decision');
    return this.withLiveRequest(id, { requestId, turnId, method: 'item/commandExecution/requestApproval' }, async request => {
      if (!request.params.availableDecisions?.some(value => value === decision)) throw new Error('Decision not offered by desktop');
      await this.reply(id, 'thread-follower-command-approval-decision', { requestId: request.id, decision });
    });
  }
  async approveFile(id, { requestId, turnId, decision }) {
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('Unsupported file approval decision');
    return this.withLiveRequest(id, { requestId, turnId, method: 'item/fileChange/requestApproval' }, async request => {
      await this.reply(id, 'thread-follower-file-approval-decision', { requestId: request.id, decision });
    });
  }
  async approvePermissions(id, { requestId, turnId, decision }) {
    if (!['accept', 'decline'].includes(decision)) throw new Error('Unsupported permission approval decision');
    return this.withLiveRequest(id, { requestId, turnId, method: 'item/permissions/requestApproval' }, async request => {
      const permissions = decision === 'accept' ? cloneObject(request.params.permissions) : {};
      await this.reply(id, 'thread-follower-permissions-request-approval-response', {
        requestId: request.id, response: { permissions, scope: 'turn' },
      });
    });
  }
  async submitUserInput(id, { requestId, turnId, answers }) {
    return this.withLiveRequest(id, { requestId, turnId, method: 'item/tool/requestUserInput' }, async request => {
      const response = validateUserAnswers(request.params.questions, answers);
      await this.reply(id, 'thread-follower-submit-user-input', { requestId: request.id, response });
    });
  }
  async respondMcp(id, { requestId, turnId, action, content }) {
    if (!['accept', 'decline', 'cancel'].includes(action)) throw new Error('Unsupported MCP response action');
    return this.withLiveRequest(id, { requestId, turnId, method: 'mcpServer/elicitation/request', optionalTurn: true }, async request => {
      let safeContent = null;
      if (action === 'accept') {
        if (request.params.mode === 'url') throw new Error('URL elicitation must be completed in the provider flow');
        safeContent = validateMcpContent(request.params.requestedSchema, content);
      }
      await this.reply(id, 'thread-follower-submit-mcp-server-elicitation-response', {
        requestId: request.id, response: { action, content: safeContent },
      });
    });
  }
  async withLiveRequest(id, { requestId, turnId, method, optionalTurn = false }, operation) {
    const key = `${id}:${requestId}`;
    if (this.pending.has(key)) throw new Error('Request already being processed');
    this.pending.add(key);
    try {
      const state = await this.snapshot(id);
      const request = state.requests?.find(item => String(item.id) === String(requestId)
        && (optionalTurn && turnId == null ? true : item.params?.turnId === turnId));
      if (!request) throw new Error('Request expired or already resolved');
      if (request.method !== method) throw new Error('Request type changed before submission');
      await operation(request);
      this.states.delete(id);
      return { submitted: true };
    } finally { this.pending.delete(key); }
  }
  reply(id, method, params) {
    return this.ipc.request(method, { conversationId: id, ...params }, { targetClientId: this.owners.get(id) });
  }
  close() {
    for (const id of this.owners.keys()) this.follow(id, false);
    this.ipc.off('broadcast', this.onBroadcast); this.states.clear(); this.owners.clear();
  }
}

function validateUserAnswers(questions, answers) {
  if (!Array.isArray(questions) || !questions.length || !isObject(answers)) throw new Error('User input request is malformed');
  const expected = new Set(questions.map(question => question.id));
  if (Object.keys(answers).some(id => !expected.has(id))) throw new Error('Answer contains an unknown question');
  const normalized = {};
  for (const question of questions) {
    if (question.isSecret) throw new Error('Secret input must be entered on the target device');
    const values = answers[question.id];
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim()) {
      throw new Error(`Question ${question.id} requires one answer`);
    }
    const answer = values[0].trim();
    const labels = new Set((question.options ?? []).map(option => option?.label).filter(Boolean));
    if (labels.size && !question.isOther && !labels.has(answer)) throw new Error(`Answer for ${question.id} is not an offered option`);
    normalized[question.id] = { answers: [answer] };
  }
  return { answers: normalized };
}

function validateMcpContent(schema, content) {
  if (!isObject(schema) || schema.type !== 'object' || !isObject(schema.properties) || !isObject(content)) {
    throw new Error('MCP form schema or response is malformed');
  }
  const fields = Object.keys(schema.properties);
  if (Object.keys(content).some(name => !fields.includes(name))) throw new Error('MCP response contains an unknown field');
  for (const name of schema.required ?? []) if (!(name in content)) throw new Error(`MCP field ${name} is required`);
  const normalized = {};
  for (const name of fields) {
    if (!(name in content)) continue;
    normalized[name] = validateMcpValue(name, schema.properties[name], content[name]);
  }
  return normalized;
}

function validateMcpValue(name, schema, value) {
  const enumValues = schema.enum ?? schema.oneOf?.map(option => option.const).filter(item => item !== undefined);
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`MCP field ${name} must be an array`);
    if (schema.minItems != null && value.length < schema.minItems) throw new Error(`MCP field ${name} has too few values`);
    if (schema.maxItems != null && value.length > schema.maxItems) throw new Error(`MCP field ${name} has too many values`);
    const choices = schema.items?.enum ?? schema.items?.anyOf?.map(option => option.const).filter(item => item !== undefined);
    if (choices && value.some(item => !choices.includes(item))) throw new Error(`MCP field ${name} contains an invalid choice`);
    if (value.some(item => typeof item !== 'string')) throw new Error(`MCP field ${name} must contain strings`);
    return [...value];
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`MCP field ${name} must be true or false`);
    return value;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) throw new Error(`MCP field ${name} must be numeric`);
    if (schema.minimum != null && value < schema.minimum) throw new Error(`MCP field ${name} is below its minimum`);
    if (schema.maximum != null && value > schema.maximum) throw new Error(`MCP field ${name} is above its maximum`);
    return value;
  }
  if (schema.type !== 'string' || typeof value !== 'string') throw new Error(`MCP field ${name} must be text`);
  if (schema.minLength != null && value.length < schema.minLength) throw new Error(`MCP field ${name} is too short`);
  if (schema.maxLength != null && value.length > schema.maxLength) throw new Error(`MCP field ${name} is too long`);
  if (enumValues && !enumValues.includes(value)) throw new Error(`MCP field ${name} contains an invalid choice`);
  return value;
}

function cloneObject(value) {
  if (!isObject(value)) throw new Error('Requested permissions are malformed');
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
