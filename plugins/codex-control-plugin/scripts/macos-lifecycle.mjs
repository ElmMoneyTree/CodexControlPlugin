import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { appendLog, writeStatus } from './daemon-lib.mjs';

// One controller owns one process group. A fast desktop restart must wait for
// the old worker to close before acquiring the daemon's single-instance lock.
export class DesktopLifecycle {
  constructor({ launch, terminate, onStopped = () => {}, onError = () => {}, retryMs = 3000, killAfterMs = 5000 }) {
    Object.assign(this, { launch, terminate, onStopped, onError, retryMs, killAfterMs });
    this.running = false;
    this.closed = false;
    this.child = null;
    this.stopping = false;
  }

  setRunning(running) {
    this.running = running && !this.closed;
    if (this.running) this.start();
    else {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      if (this.child) this.stop();
      else this.onStopped();
    }
  }

  start() {
    if (!this.running || this.closed || this.child || this.retryTimer) return;
    let child;
    try { child = this.launch(); }
    catch (error) { this.onError(error); this.retry(); return; }
    this.child = child;
    child.once('error', error => this.onError(error));
    child.once('close', () => {
      clearTimeout(this.killTimer);
      // A crashed launcher must not leave an orphan daemon in its group.
      this.terminate(child, 'SIGKILL');
      const wasStopping = this.stopping;
      this.child = null;
      this.stopping = false;
      if (!this.running) this.onStopped();
      else if (wasStopping) this.start();
      else this.retry();
      this.finishClose?.();
    });
  }

  retry() {
    if (!this.running || this.closed) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.start(); }, this.retryMs);
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.child;
    this.terminate(child, 'SIGTERM');
    this.killTimer = setTimeout(() => this.terminate(child, 'SIGKILL'), this.killAfterMs);
  }

  async close() {
    this.closed = true;
    this.setRunning(false);
    if (this.child) await new Promise(resolve => { this.finishClose = resolve; });
  }
}

function terminateGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function watchDesktop(data, root) {
  const logPath = path.join(data, 'agent.log');
  const controller = new DesktopLifecycle({
    launch: () => spawn(process.execPath, [path.join(root, 'scripts/macos-agent.mjs'), 'run', '--data', data], {
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, CODEX_CONTROL_AGENT_DESKTOP_SUPERVISED: '1' },
    }),
    terminate: terminateGroup,
    onStopped: () => {
      const file = path.join(data, 'status.json');
      let previous = {};
      try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const { pid, detail, desktopUnavailableSince, ...status } = previous;
      writeStatus(file, { ...status, source: 'codex-plugin', state: 'stopped', stopReason: 'codex-desktop-stopped', updatedAt: new Date().toISOString() });
    },
    onError: error => appendLog(logPath, `Desktop lifecycle worker failed: ${error.message}`),
  });
  const observer = spawn(path.join(root, 'runtime/macos/desktop-lifecycle-helper'), [], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: observer.stdout });
  const stop = () => observer.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let observed = false;
  const startupTimer = setTimeout(stop, 10_000);
  const ended = new Promise((resolve, reject) => {
    observer.once('error', reject);
    observer.once('close', (code, signal) => {
      if (signal === 'SIGTERM' && observed) resolve();
      else reject(new Error(`Desktop lifecycle observer ended (${signal || code}).`));
    });
  });
  // Attach a handler immediately; a missing helper can fail before iteration.
  ended.catch(() => {});
  try {
    for await (const line of lines) {
      const state = JSON.parse(line);
      if (typeof state.running !== 'boolean') throw new Error('Invalid desktop lifecycle observation.');
      observed = true;
      clearTimeout(startupTimer);
      controller.setRunning(state.running);
    }
    await ended;
  } finally {
    clearTimeout(startupTimer);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    observer.kill('SIGTERM');
    lines.close();
    await controller.close();
  }
}
