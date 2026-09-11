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
    if (!response.ok) throw new Error(value.error ?? `Relay returned HTTP ${response.status}`);
    return value;
  }
}
