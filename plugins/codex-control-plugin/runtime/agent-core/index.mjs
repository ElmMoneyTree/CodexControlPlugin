import { DesktopIPC, DesktopTasks } from '../desktop-ipc/index.mjs';
import { AppTools } from './src/app-tools.mjs';
import { resumeWithCodexCli } from './src/cli-resume.mjs';
import { CommandJournal, journalPath } from './src/journal.mjs';
import { RelayClient } from './src/relay-client.mjs';
import { RolloutReader } from './src/rollouts.mjs';
import { buildAgentState } from './src/state.mjs';
import { LocalThreadCatalog } from './src/thread-catalog.mjs';
import { ConversationReader } from './src/conversation.mjs';
import { normalizeProjects, normalizeCreation, readChatGPTConversation } from './src/new-chat.mjs';
import { pendingAsyncInputs } from '../desktop-ipc/async-input.mjs';

export class CodexDeviceAgent {
  constructor(config, { taskLimit = 50, activeSnapshotLimit = 12, platform = process.platform } = {}) {
    this.config = config;
    this.platform = platform;
    this.taskLimit = taskLimit;
    this.activeSnapshotLimit = activeSnapshotLimit;
    this.relay = new RelayClient({ relayUrl: config.relayUrl, token: config.deviceToken });
    this.journal = new CommandJournal(journalPath(config.configPath));
    this.snapshots = new Map();
    this.rollouts = new RolloutReader();
    this.conversations = new ConversationReader(this.rollouts);
    this.catalog = new LocalThreadCatalog();
    this.resumeTask = resumeWithCodexCli;
    this.threadBackends = new Map();
  }

  async connectDesktop() {
    if (this.ipc?.socket?.writable) {
      if (!this.appTools && Date.now() >= (this.appToolsRetryAt ?? 0)) await this.discoverAppTools();
      return;
    }
    try { this.tasks?.close(); } catch { /* The old IPC connection is already gone. */ }
    try { this.ipc?.close(); } catch { /* Best-effort cleanup before reconnecting. */ }
    this.ipc = await new DesktopIPC().connect();
    this.tasks = new DesktopTasks(this.ipc);
    this.appTools = null;
    await this.discoverAppTools();
  }

  async discoverAppTools() {
    try { this.appTools = await AppTools.discover({ platform: this.platform, credentials: { deviceId: this.config.deviceId, token: this.config.deviceToken } }); }
    catch { /* Existing IPC reads/replies remain available without app tools. */ }
    this.appToolsRetryAt = Date.now() + 10_000;
  }

  async collectState() {
    await this.connectDesktop();
    const freshSnapshots = new Map();
    const index = this.catalog.read(this.taskLimit);
    let caller = null;
    for (const entry of (this.appTools ? index.slice(0, 5) : [])) {
      try {
        const rollout = this.rollouts.read(entry.id);
        const candidate = rollout?.latestTurnId ? { threadId: entry.id, turnId: rollout.latestTurnId } : await this.refreshCallerContext(entry.id, entry);
        if (candidate) { caller = candidate; freshSnapshots.set(entry.id, this.snapshots.get(entry.id)); break; }
      } catch { /* Only desktop-owned tasks can provide a caller context. */ }
    }

    let listed = index.map(entry => ({ ...entry, status: 'notLoaded' }));
    let value = null;
    if (caller && this.appTools) {
      try { value = await this.appTools.listThreads(caller, this.taskLimit); }
      catch { this.appTools = null; this.appToolsRetryAt = Date.now() + 10_000; }
    }
    if (value) {
      const visible = [...(value.pinnedThreads ?? []), ...(value.threads ?? [])]
        .filter(item => !item.archived && (item.kind === 'chatgpt' || (item.kind === 'codex' && (!item.hostId || item.hostId === 'local'))));
      const byId = new Map(visible.map(item => [item.id, item]));
      // The desktop list is authoritative. Never re-add hidden/index-only tasks.
      listed = [...byId.values()].map(item => {
        const rollout = item.kind === 'chatgpt' ? null : this.rollouts.read(item.id);
        return { ...item, backend: item.kind, rolloutState: rollout, latestMessage: rollout?.latestMessage ?? null, updatedAt: rollout?.updatedAt ?? item.updatedAt };
      });
      const local = listed.filter(item => item.kind !== 'chatgpt');
      const pending = local.filter(item => hasPendingInput(this.snapshots.get(item.id)));
      const running = local.filter(item => item.status === 'active' || item.status === 'running' || item.rolloutState?.status === 'running' || this.snapshots.get(item.id)?.threadRuntimeStatus?.type === 'active').slice(0, this.activeSnapshotLimit);
      const urgent = new Map([...pending, ...running].map(item => [item.id, item]));
      // Idle chats can still have async questions. Scan them in bounded batches,
      // then keep refreshing discovered requests until the desktop records a reply.
      const idle = local.filter(item => !urgent.has(item.id));
      const idleOffset = (this.idleSnapshotOffset ?? 0) % Math.max(1, idle.length);
      const idleBatch = [...idle.slice(idleOffset), ...idle.slice(0, idleOffset)].slice(0, Math.min(4, this.activeSnapshotLimit));
      this.idleSnapshotOffset = idle.length ? (idleOffset + idleBatch.length) % idle.length : 0;
      const active = [...urgent.values(), ...idleBatch];
      const results = await Promise.allSettled(active.map(item => this.tasks.snapshot(item.id)));
      results.forEach((result, position) => {
        const id = active[position].id;
        if (result.status === 'fulfilled') {
          this.snapshots.set(id, result.value);
          freshSnapshots.set(id, result.value);
        } else {
          this.snapshots.delete(id);
          freshSnapshots.delete(id);
        }
      });
      const activeIds = new Set(active.map(item => item.id));
      for (const id of this.snapshots.keys()) if (!activeIds.has(id)) this.snapshots.delete(id);
    } else {
      // Refresh loaded tasks through IPC when the app tools bridge is unavailable. Rotate older entries so a long-
      // running task remains visible even if its title/index timestamp is old.
      const knownActive = index.filter(item => this.snapshots.get(item.id)?.threadRuntimeStatus?.type === 'active' || hasPendingInput(this.snapshots.get(item.id)));
      const offset = this.snapshotOffset ?? 0;
      const rotated = [...index.slice(offset), ...index.slice(0, offset)];
      const candidates = [...new Map([...knownActive, ...rotated.slice(0, this.activeSnapshotLimit)].map(item => [item.id, item])).values()];
      this.snapshotOffset = index.length ? (offset + this.activeSnapshotLimit) % index.length : 0;
      await Promise.allSettled(candidates.map(async item => {
        try {
          const snapshot = await this.tasks.snapshot(item.id);
          this.snapshots.set(item.id, snapshot);
          freshSnapshots.set(item.id, snapshot);
        }
        catch { this.snapshots.delete(item.id); }
      }));
      listed = index.map(item => {
        const rollout = this.rollouts.read(item.id);
        const snapshot = freshSnapshots.get(item.id);
        return { ...item, status: snapshot ? 'idle' : 'notLoaded', rolloutState: rollout,
          latestMessage: rollout?.latestMessage ?? null, updatedAt: rollout?.updatedAt ?? item.updatedAt };
      });
    }

    const currentIds = new Set(listed.map(item => item.id ?? item.threadId));
    for (const id of this.snapshots.keys()) if (!currentIds.has(id)) this.snapshots.delete(id);
    const state = buildAgentState(listed, freshSnapshots);
    this.callerContext = state.callerContexts[0] ?? caller;
    this.threadBackends = new Map(state.tasks.map(task => [task.threadId, task.backend ?? 'codex']));
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
        const backend = this.threadBackends?.get(command.threadId) ?? command.backend ?? 'codex';
        if (backend === 'chatgpt') {
          if (!this.appTools || !this.callerContext) throw new Error('Desktop ChatGPT tools are unavailable; open an existing desktop chat and retry');
          await this.appTools.sendMessage(command.threadId, command.text, this.callerContext);
          acknowledgement = { ok: true, result: { submitted: true } };
        } else {
        let result;
        try {
          result = await this.tasks.startTurn(command.threadId, command.text);
        } catch (error) {
          if (!isMissingDesktopOwner(error)) throw error;
          result = await this.resumeTask(command.threadId, command.text);
        }
        try { this.snapshots.set(command.threadId, await this.tasks.snapshot(command.threadId)); } catch { /* The task may complete before its first snapshot. */ }
        acknowledgement = { ok: true, result: { submitted: true } };
        }
      } else if (command.kind === 'create_thread') {
        const text = typeof command.text === 'string' ? command.text.trim() : '';
        if (!text || text.length > 20_000) throw new Error('Initial message is required and must be at most 20000 characters');
        if (!['codex', 'chatgpt'].includes(command.backend)) throw new Error('Unsupported chat backend');
        const catalog = await this.projectCatalog();
        if (!catalog.backends.includes(command.backend)) throw new Error('The selected chat backend is unavailable on this desktop');
        if (command.projectId && !catalog.projects.some(project => project.id === command.projectId && project.kind === command.backend)) {
          throw new Error('The selected project is unavailable for this chat backend; refresh the project list');
        }
        const created = await this.appTools.createThread(command.backend, command.projectId, text, this.callerContext);
        const result = normalizeCreation(created, command);
        if (result.threadId) this.threadBackends?.set(result.threadId, command.backend);
        acknowledgement = { ok: true, result };
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
    let state = await this.collectState();
    await this.relay.sync(state);
    const commands = await this.relay.commands();
    for (const command of commands) {
      const acknowledgement = await this.execute(command);
      await this.relay.acknowledge(command.id, acknowledgement);
    }
    if (commands.length) { state = await this.collectState(); await this.relay.sync(state); }
    await this.forwardConversationRequests(state.tasks);
    await this.forwardProjectRequests();
    return { taskCount: state.tasks.length, requestCount: state.requests.length, commandCount: commands.length };
  }

  async forwardConversationRequests(tasks) {
    if (!this.conversations || !this.relay.conversationRequests || Date.now() < (this.historyRetryAt ?? 0)) return;
    let requests;
    try { requests = await this.relay.conversationRequests(); }
    catch (error) {
      if (error.status === 404) { this.historyRetryAt = Date.now() + 60_000; return; }
      throw error;
    }
    const visible = new Map(tasks.map(task => [task.threadId, task]));
    const served = new Set(), deadline = Date.now() + (this.imageBurstDurationMs ?? 2_000);
    let imageActivity = false;
    while (true) {
      for (const request of requests) {
        if (served.has(request.id)) continue;
        served.add(request.id);
        let response;
        try {
          if (!visible.has(request.threadId)) throw new Error('Conversation is not visible on this device');
          if (request.kind === 'attachment') {
            if (visible.get(request.threadId).backend === 'chatgpt') throw new Error('Desktop ChatGPT image data is unavailable');
            response = this.conversations.readAttachment(request.threadId, request.messageId, request.attachmentId, request.offset, request.length);
          } else {
            response = visible.get(request.threadId).backend === 'chatgpt'
              ? await readChatGPTConversation(this.appTools, this.callerContext, request.threadId, request.cursor)
              : this.conversations.read(request.threadId, request.cursor);
          }
          imageActivity ||= request.kind === 'attachment' || response.messages?.some(message => message.attachments?.some(image => !image.unavailableReason));
        } catch (error) { response = { error: request.kind === 'attachment' ? 'Image is unavailable on the computer' : error.message }; }
        try { await this.relay.respondConversation(request.id, response); }
        catch (error) {
          if (error.status === 404) continue;
          // A rejected history page belongs to this read request. Surface its
          // error to the phone without taking task/inbox synchronization offline.
          if (error.status !== 400 || response.error) throw error;
          try { await this.relay.respondConversation(request.id, { error: error.message }); }
          catch (failure) { if (failure.status !== 404) throw failure; }
        }
      }
      // Let the phone request subsequent chunks without waiting for another
      // full task-state cycle. Bound the burst so approvals remain responsive.
      if (!imageActivity || Date.now() >= deadline || served.size >= 20) break;
      await new Promise(resolve => setTimeout(resolve, 120));
      requests = await this.relay.conversationRequests();
    }
  }

  async projectCatalog() {
    if (!this.appTools) this.appTools = await AppTools.discover({ platform: this.platform, credentials: { deviceId: this.config.deviceId, token: this.config.deviceToken } });
    if (!this.callerContext) {
      for (const entry of this.catalog.read(10)) {
        const rollout = this.rollouts.read(entry.id);
        if (rollout?.latestTurnId) { this.callerContext = { threadId: entry.id, turnId: rollout.latestTurnId }; break; }
      }
    }
    if (!this.callerContext) throw new Error('Desktop chat creation is unavailable; open an existing desktop chat and refresh');
    const backends = this.appTools.creationBackends();
    if (!backends.length) throw new Error('This desktop version does not support creating chats remotely');
    return { projects: normalizeProjects(await this.appTools.listProjects(this.callerContext)).filter(project => backends.includes(project.kind)), backends };
  }

  async forwardProjectRequests() {
    if (!this.relay.projectRequests || Date.now() < (this.projectsRetryAt ?? 0)) return;
    let requests;
    try { requests = await this.relay.projectRequests(); }
    catch (error) { if (error.status === 404) { this.projectsRetryAt = Date.now() + 60_000; return; } throw error; }
    if (!requests.length) return;
    let response;
    try { response = await this.projectCatalog(); } catch (error) { response = { error: error.message }; }
    for (const request of requests) {
      try { await this.relay.respondProjects(request.id, response); }
      catch (error) { if (error.status !== 404) throw error; }
    }
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
export { LocalThreadCatalog, isVisibleThread } from './src/thread-catalog.mjs';
export { buildAgentState, defaultSessionIndexPath, extractLatestTurn, readSessionIndex } from './src/state.mjs';

function isMissingDesktopOwner(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /no-client-found|thread stream owner became unavailable/i.test(message);
}

function hasPendingInput(snapshot) {
  return Boolean(snapshot?.requests?.length || pendingAsyncInputs(snapshot).length);
}
