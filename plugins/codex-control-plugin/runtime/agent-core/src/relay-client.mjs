export class RelayClient {
  constructor({ relayUrl, token = null, timeoutMs = 10_000 }) {
    this.relayUrl = relayUrl.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async enroll(input) {
    return this.request('/agent/enroll', { method: 'POST', body: input, authenticated: false });
  }

  async sync(state) {
    return this.request('/agent/state', { method: 'PUT', body: state });
  }

  async commands() {
    return (await this.request('/agent/commands')).commands;
  }

  async conversationRequests() {
    return (await this.request('/agent/conversation-requests')).requests;
  }

  async projectRequests() { return (await this.request('/agent/project-requests')).requests; }

  async respondProjects(id, catalog) {
    return this.request(`/agent/project-responses/${encodeURIComponent(id)}`, { method: 'POST', body: catalog });
  }

  async respondConversation(id, page) {
    return this.request(`/agent/conversation-responses/${encodeURIComponent(id)}`, { method: 'POST', body: page });
  }

  async acknowledge(id, result) {
    return this.request(`/agent/commands/${encodeURIComponent(id)}/ack`, { method: 'POST', body: result });
  }

  async request(route, { method = 'GET', body, authenticated = true } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (authenticated) {
      if (!this.token) throw new Error('Agent token is missing');
      headers.authorization = `Bearer ${this.token}`;
    }
    const response = await fetch(`${this.relayUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.error ?? `Relay returned HTTP ${response.status}`), { status: response.status });
    return value;
  }
}
