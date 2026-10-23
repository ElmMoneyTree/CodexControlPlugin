# CodexControlPlugin source code

This repository contains the macOS and Windows source code for `CodexControlPlugin`, the device-side Codex plugin used by Codex Control.

## Repository roles

- Source code: <https://github.com/ElmMoneyTree/CodexControlPluginCode>
- Direct installation marketplace: <https://github.com/ElmMoneyTree/CodexControlPlugin.git>

This source repository is for development and review. It is not a Codex marketplace and cannot be installed directly with `codex plugin marketplace add`.

Windows users should install the built plugin from the marketplace repository:

```powershell
codex plugin marketplace add https://github.com/ElmMoneyTree/CodexControlPlugin.git
codex plugin add codex-control-plugin@codex-control
```

## What the plugin does

CodexControlPlugin starts a device agent when a Codex session starts or resumes. The agent connects the local Codex Desktop instance to a separately deployed Relay so a Controller can:

- view device and task state;
- receive completed task results;
- forward requested user and assistant text messages from visible local conversations to a phone for local storage;
- forward uploaded, generated, and local Markdown images from visible Codex messages in bounded chunks, with SHA-256 verification and a 25 MiB per-image limit;
- reply to tasks;
- answer structured user-input requests;
- review and submit supported approval decisions.

The default connection flow is account-based device claiming: on its first trusted session start, the plugin creates a local Ed25519 device identity, opens a short-lived claim page, and waits for a signed-in user to assign the device to a personal or team workspace. Relay addresses, owner IDs, and pairing codes are not entered in the normal flow. The service returns a device-scoped credential and target Relay; tokens and the private key are protected with Windows DPAPI.

The first launch opens the claim page automatically after the plugin hook has been reviewed and trusted. To retry an expired claim or start it directly in PowerShell, run:

```powershell
.\scripts\start-device-claim.ps1
.\scripts\get-agent-status.ps1
```

The first command opens a browser page that only displays a QR code and scanning instructions; it has no account login or approval controls. Scan it with the signed-in iPhone App, compare the fingerprint, choose a workspace, and approve. The watcher finishes the connection automatically.

If the browser was closed while the claim is still valid, running the same command reopens that exact claim instead of creating a second one. The short-lived claim secret is stored only in the current user's DPAPI-protected pending record and is deleted after approval or expiry.

The command output is credential-safe by default and contains only the device fingerprint and expiry. `-RevealClaimLink` is reserved for an operator's private local terminal and must not be used through Codex or copied into chat logs.

If a schema 1 legacy pairing configuration already exists, the same claim command performs an in-place migration. It authenticates with the existing device credential, preserves the device ID and task state, rotates the credential after approval, and leaves the old connection unchanged if the claim expires. `configure-agent.ps1` remains available only as a compatibility fallback.

Relay and Controller are separate components. This repository contains only the Codex plugin layer.

Image downloads resolve opaque attachment IDs against visible message events; the Controller never supplies a filesystem path. Generated results use their original embedded bytes when available. Relay forwards chunks in memory, while the iPhone owns downloaded files and deletion. Remote-only images and missing or unsupported files produce an unavailable placeholder. ChatGPT Work cloud images are not yet supported.

## Platform

The plugin supports Windows 10/11 x64 and macOS 11+ on Apple Silicon or Intel.

Windows uses PowerShell hooks, DPAPI, named pipes, and the bundled Windows Node.js runtime. macOS uses a Bash launcher, the user's Keychain, Unix sockets, and a per-user LaunchAgent. The Mac launcher finds Node.js 24+ from Codex's bundled runtime or the local installation.

### macOS setup and status

After installation, review the changed SessionStart hook and open a new Codex task. To connect immediately from the plugin directory:

```bash
bash scripts/macos-agent.sh verify
bash scripts/macos-agent.sh claim
bash scripts/macos-agent.sh status
```

Scan the opened QR page in the signed-in mobile app, select your workspace, and approve. The status must become `connected` with a recent `lastSyncAt`. An installed plugin or an approved claim alone does not confirm task synchronization. Re-running `claim` reopens an unexpired claim; already claimed devices simply start their existing agent.

Mac credentials are stored in Keychain. Public configuration, sanitized status, and logs are in `~/Library/Application Support/Codex Control Agent Plugin`. `bash scripts/macos-agent.sh disconnect` stops and removes this plugin's LaunchAgent and local credentials. Revoke the device in the phone app if its server credential must also be invalidated.

Once registered, the macOS LaunchAgent observes the Codex application's launch and termination through NSWorkspace (`com.openai.codex`). Opening the desktop starts the sync agent without needing to open a chat. Quitting the desktop stops the sync agent immediately, with a five-second bound for forced cleanup; opening it again starts a new single instance. Only the lightweight lifecycle observer remains while Codex is closed. Temporary IPC unavailability while the application is still running does not stop the agent. The existing trusted SessionStart hook registers or upgrades this observer during initial setup; `bash scripts/macos-agent.sh start` also applies an upgrade directly. Windows retains its SessionStart startup and 90-second IPC grace period.

Source builds require Xcode command line tools to run `bash scripts/build-macos-runtime.sh`. This creates universal `runtime/macos/keychain-helper` and `runtime/macos/desktop-lifecycle-helper` executables for release packaging; end users do not need Swift or Xcode. The shared agent reads the current desktop's task-history layout, including `tail:*` entities.

## Source layout

- `.codex-plugin/plugin.json`: Codex plugin metadata.
- `hooks/`: `SessionStart` hook and launcher.
- `runtime/`: shared agent, desktop IPC, and Relay protocol source code.
- `scripts/`: pairing, status, disconnect, and agent process code.
- `skills/`: instructions exposed to Codex.
- `test/`: plugin-specific unit tests.

The JavaScript runtime source is tracked in `runtime/`. The Windows release build only injects `runtime/node.exe`, which remains excluded from this source repository and is included in the separate installation marketplace.

## Test

With Node.js 24 or later installed:

```powershell
node --test test/*.test.mjs
```

Before release, validate the manifest and test `start-device-claim.ps1`, approval, polling, migration, status, and disconnect on Windows 10/11 PowerShell 5.1.

On a Windows acceptance machine with Codex Desktop open, the bundled preflight can verify the live v1 Relay, the embedded runtime, current-user DPAPI, claim completion, credential readability, named-pipe attachment, and first state sync without printing credentials:

```powershell
.\scripts\verify-device-claim.ps1
.\scripts\verify-device-claim.ps1 -BeginClaim
```

## License

CodexControlPlugin is released under the [MIT License](./LICENSE).

### Task visibility

The agent syncs user conversations and automations, excluding internal review/subagent sessions and archived threads by metadata. When available, the Desktop task list is authoritative. Otherwise the agent reads the local thread database in read-only mode; older installations fall back to active session metadata. Raw title-index entries with unknown provenance are not published. Filtering happens before the task limit, and desktop display names take precedence over original prompts.

### Conversation history

With a compatible Relay and iPhone App, the agent responds to explicit phone read requests for user-visible `UserMessage` / `AgentMessage` events (and legacy `user_message` / `agent_message` events). Raw model input, system/developer context, reasoning, and tool output are excluded. Relay forwards each page in memory; only the phone persists the conversation history. The agent does not bulk-upload history or write read responses into the command journal.

Each response reads at most a 1 MiB log window and contains up to 100 messages. The opaque cursor belongs to the phone, so retries or agent/Relay restarts can resume without a server transcript. Text over 100,000 UTF-16 code units is truncated and marked; individual records exceeding the read window are skipped. Saved phone conversations remain readable offline. Deletion and clear-all remove local bodies and preserve content-free sync/deletion markers to prevent old messages from reappearing. Upgrade Relay, plugin, and iPhone App together.

Task completion requires a successful latest-turn record from a fresh Desktop snapshot or a rollout lifecycle event with a turn ID. Idle state, a sidebar completion label, and assistant text alone do not establish completion. New turns replace prior completion; failed, cancelled, not-loaded, idle, and unknown states remain distinct. Snapshots not refreshed during the current sync are not used to infer the current task state.

Async question cards are synchronized to the phone inbox as structured user-input requests, including cards whose model turn has already completed. The agent scans idle chats in bounded batches and continues refreshing discovered requests until a recorded desktop answer resolves them. Answers use the desktop's question-reply format and revalidate the exact question and turn before submission; free-text answers are supported alongside suggested choices. Conversation history keeps the question and answer readable without exposing the reply envelope.

## Creating chats from the phone

The phone can submit an initial message to a new Codex chat or a ChatGPT Work cloud chat, with an optional project of the matching backend. The project picker reads the desktop's current project catalog on demand. Local Codex projects belong to the selected computer; ChatGPT projects use the cloud Work target. Desktop account access still applies, including ChatGPT Work Cloud availability. New chats use the desktop defaults for model and reasoning effort.

The plugin declares an app-managed MCP desktop bridge. Reload the plugin and open or resume a desktop chat after upgrading so the app starts this bridge. On macOS the desktop requires its own process ancestry for app-tool access; a standalone launch agent cannot call that socket directly. The background device agent instead authenticates to the declared MCP bridge with the existing device credential. The MCP surface exposes only a read-only connection-status tool. Phone requests use a separate typed allowlist for catalogs, creation, history, and replies, protected by HMAC signatures, fresh timestamps and nonces. Device secrets remain in Keychain on macOS and DPAPI on Windows. Unix sockets use a private directory and mode `0600`; Windows uses named pipes with a per-user registry and the same credential checks.

A real existing local Codex thread and turn supply the desktop caller identity; an idle saved chat is sufficient. A completely empty desktop must first open a chat on the computer. The device agent checks for newly available app bridges again while connected, so starting or switching desktop chats does not require reconnecting the phone. If a bridge disappears during a mutation, the command's outcome is reported without automatically resubmitting it.

Creation uses the existing durable command journal. A repeated command ID returns its earlier result; an interrupted delivery with an unknown outcome is not replayed. If ChatGPT returns a temporary client ID before the server chat ID exists, the acknowledgement says `status: starting`. The phone waits for the chat to appear in the refreshed list. ChatGPT chats remain visible and support history and follow-up messages through the desktop APIs. History forwards user and assistant text only, and retains truncation flags from the desktop.

Validation includes four backend/project combinations, stale-project rejection, durable retries and restart, pending identities, ChatGPT history and streaming refresh, credential forgery/replay/revocation, and the broker operation allowlist. A read-only macOS runtime check also started an app-owned MCP bridge and an independent temporary launchd client (`parentPid: 1`): authenticated access returned both backend capabilities and five real desktop projects. That check created no chats, and its temporary worker, launchd job, files and test credentials were removed. Real creation behavior is covered by the isolated Relay/device integration test rather than mutating the user's conversations during development.
