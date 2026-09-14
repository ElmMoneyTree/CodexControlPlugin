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

## License

CodexControlPlugin is released under the [MIT License](./LICENSE).
