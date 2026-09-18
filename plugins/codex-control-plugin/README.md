# CodexControlPlugin source code

This repository contains the Windows source code for `CodexControlPlugin`, the device-side Codex plugin used by Codex Control.

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
- reply to tasks;
- answer structured user-input requests;
- review and submit supported approval decisions.

The default connection flow is account-based device claiming: on its first trusted session start, the plugin creates a local Ed25519 device identity, opens a short-lived claim page, and waits for a signed-in user to assign the device to a personal or team workspace. Relay addresses, owner IDs, and pairing codes are not entered in the normal flow. The service returns a device-scoped credential and target Relay; tokens and the private key are protected with Windows DPAPI.

The first launch opens the claim page automatically after the plugin hook has been reviewed and trusted. To retry an expired claim or start it directly in PowerShell, run:

```powershell
.\scripts\start-device-claim.ps1
.\scripts\get-agent-status.ps1
```

The first command opens a browser page containing a QR code. Scan it with the signed-in iPhone App, compare the fingerprint, choose a workspace, and approve. The watcher finishes the connection automatically.

If the browser was closed while the claim is still valid, running the same command reopens that exact claim instead of creating a second one. The short-lived claim secret is stored only in the current user's DPAPI-protected pending record and is deleted after approval or expiry.

The command output is credential-safe by default and contains only the device fingerprint and expiry. `-RevealClaimLink` is reserved for an operator's private local terminal and must not be used through Codex or copied into chat logs.

If a schema 1 legacy pairing configuration already exists, the same claim command performs an in-place migration. It authenticates with the existing device credential, preserves the device ID and task state, rotates the credential after approval, and leaves the old connection unchanged if the claim expires. `configure-agent.ps1` remains available only as a compatibility fallback.

Relay and Controller are separate components. This repository contains only the Codex plugin layer.

## Platform

The current implementation supports Windows 10/11 x64. It uses PowerShell hooks, Windows DPAPI, Windows named pipes, and a Windows Node.js runtime in release builds.

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
