import { DesktopIPC, DesktopTasks } from '../desktop-ipc/index.mjs';
import { AppTools } from './src/app-tools.mjs';
import { resumeWithCodexCli } from './src/cli-resume.mjs';
import { CommandJournal, journalPath } from './src/journal.mjs';
import { RelayClient } from './src/relay-client.mjs';
import { RolloutReader } from './src/rollouts.mjs';
import { buildAgentState, readSessionIndex } from './src/state.mjs';

export class CodexDeviceAgent {
  constructor(config, { taskLimit = 50, activeSnapshotLimit = 12 } = {}) {
    this.config = config;
    this.taskLimit = taskLimit;
    this.activeSnapshotLimit = activeSnapshotLimit;
    this.relay = new RelayClient({ relayUrl: config.relayUrl, token: config.deviceToken });
    this.journal = new CommandJournal(journalPath(config.configPath));
    this.snapshots = new Map();
    this.rollouts = new RolloutReader();
    this.resumeTask = resumeWithCodexCli;
  }

  async connectDesktop() {
    if (this.ipc?.socket?.writable) return;
    try { this.tasks?.close(); } catch { /* The old IPC connection is already gone. */ }
    try { this.ipc?.close(); } catch { /* Best-effort cleanup before reconnecting. */ }
    this.ipc = await new DesktopIPC().connect();
    this.tasks = new DesktopTasks(this.ipc);
    this.appTools = await AppTools.discover();
  }

  async collectState() {
    await this.connectDesktop();
    const index = readSessionIndex(undefined, this.taskLimit);
    let caller = null;
    for (const entry of index.slice(0, 5)) {
      try {
        const candidate = await this.refreshCallerContext(entry.id, entry);
        if (candidate) { caller = candidate; break; }
      } catch { /* Only desktop-owned tasks can provide a caller context. */ }
    }

    let listed = index.map(entry => ({ ...entry, status: 'notLoaded' }));
    if (caller) {
      const value = await this.appTools.listThreads(caller, this.taskLimit);
      const visible = [...(value.pinnedThreads ?? []), ...(value.threads ?? [])].filter(item => item.kind === 'codex');
      const byId = new Map(visible.map(item => [item.id, item]));
      for (const entry of index) if (!byId.has(entry.id)) byId.set(entry.id, { ...entry, status: 'notLoaded' });
      listed = [...byId.values()].map(item => {
        const rollout = this.rollouts.read(item.id);
        const status = item.status === 'notLoaded' && rollout?.status ? rollout.status : item.status;
        return { ...item, status, latestMessage: rollout?.latestMessage ?? null, updatedAt: rollout?.updatedAt ?? item.updatedAt };
      });
      const active = listed.filter(item => item.status === 'active' || item.status === 'running' || this.snapshots.get(item.id)?.threadRuntimeStatus?.type === 'active').slice(0, this.activeSnapshotLimit);
      const results = await Promise.allSettled(active.map(item => this.tasks.snapshot(item.id)));
      results.forEach((result, position) => {
        if (result.status === 'fulfilled') this.snapshots.set(active[position].id, result.value);
      });
      const activeIds = new Set(active.map(item => item.id));
      for (const id of this.snapshots.keys()) if (!activeIds.has(id)) this.snapshots.delete(id);
    }

    const currentIds = new Set(listed.map(item => item.id ?? item.threadId));
    for (const id of this.snapshots.keys()) if (!currentIds.has(id)) this.snapshots.delete(id);
    const state = buildAgentState(listed, this.snapshots);
    this.callerContext = state.callerContexts[0] ?? caller;
    return { tasks: state.tasks, requests: state.requests };
  }

  async execute(command) {
    const prior = this.journal.get(command.id);
    if (prior?.state === 'complete') return prior.acknowledgement;
    if (prior?.state === 'running') {
      return { ok: false, result: { error: 'Previous delivery outcome is unknown; command was not replayed' } };
    }
    this.journal.begin(command.id);
    let acknowledgement;
    try {
      if (command.kind === 'command_approval') {
        acknowledgement = { ok: true, result: await this.tasks.approveCommand(command.threadId, command) };
      } else if (command.kind === 'file_approval') {
        acknowledgement = { ok: true, result: await this.tasks.approveFile(command.threadId, command) };
      } else if (command.kind === 'permissions_approval') {
        acknowledgement = { ok: true, result: await this.tasks.approvePermissions(command.threadId, command) };
      } else if (command.kind === 'user_input_response') {
        acknowledgement = { ok: true, result: await this.tasks.submitUserInput(command.threadId, command) };
      } else if (command.kind === 'mcp_response') {
        acknowledgement = { ok: true, result: await this.tasks.respondMcp(command.threadId, command) };
      } else if (command.kind === 'send_message') {
        let result;
        try {
          result = await this.tasks.startTurn(command.threadId, command.text);
        } catch (error) {
          if (!isMissingDesktopOwner(error)) throw error;
          result = await this.resumeTask(command.threadId, command.text);
        }
        try { this.snapshots.set(command.threadId, await this.tasks.snapshot(command.threadId)); } catch { /* The task may complete before its first snapshot. */ }
        acknowledgement = { ok: true, result: { submitted: true, response: result } };
      } else throw new Error(`Unsupported command kind: ${command.kind}`);
    } catch (error) {
      acknowledgement = { ok: false, result: { error: error.message } };
    }
    this.journal.complete(command.id, acknowledgement);
    return acknowledgement;
  }

  async refreshCallerContext(threadId, listed = {}) {
    const snapshot = await this.tasks.snapshot(threadId);
    this.snapshots.set(threadId, snapshot);
    const candidate = buildAgentState(
      [{ id: threadId, title: listed.title ?? snapshot?.title ?? threadId, updatedAt: listed.updatedAt ?? snapshot?.updatedAt }],
      new Map([[threadId, snapshot]]),
    ).callerContexts[0] ?? null;
    if (candidate) this.callerContext = candidate;
    return candidate;
  }

  async cycle() {
    const state = await this.collectState();
    await this.relay.sync(state);
    const commands = await this.relay.commands();
    for (const command of commands) {
      const acknowledgement = await this.execute(command);
      await this.relay.acknowledge(command.id, acknowledgement);
    }
    if (commands.length) await this.relay.sync(await this.collectState());
    return { taskCount: state.tasks.length, requestCount: state.requests.length, commandCount: commands.length };
  }

  close() {
    try { this.tasks?.close(); } catch { /* Best-effort shutdown. */ }
    try { this.ipc?.close(); } catch { /* Best-effort shutdown. */ }
  }
}

export { AppTools, FrameDecoder } from './src/app-tools.mjs';
export { resumeWithCodexCli } from './src/cli-resume.mjs';
export { defaultConfigPath, parseArguments, readConfig, writeConfig } from './src/config.mjs';
export { CommandJournal, journalPath } from './src/journal.mjs';
export { RelayClient } from './src/relay-client.mjs';
export { RolloutReader, parseRollout } from './src/rollouts.mjs';
export { buildAgentState, defaultSessionIndexPath, extractLatestTurn, readSessionIndex } from './src/state.mjs';

function isMissingDesktopOwner(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /no-client-found|thread stream owner became unavailable/i.test(message);
}
