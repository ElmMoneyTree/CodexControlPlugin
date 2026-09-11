---
name: codex-control-plugin
description: Connect, inspect, reconfigure, or disconnect this Windows Codex device from a Codex Control Relay using the bundled plugin agent. Use when the user asks to pair this device, check its controller connection, change its Relay, or remove the connection.
---

# CodexControlPlugin

Use the bundled PowerShell scripts in this plugin. Resolve all script paths relative to this `SKILL.md` through the plugin root; do not download or install a separate Device Agent.

## Connect or reconfigure

If the standalone `Codex Device Agent` application is running, tell the user to exit it before pairing this plugin so the same computer is not shown twice in Controller.

Collect these non-secret values from the user if they are missing:

- Relay HTTP(S) origin
- Current one-time pairing code from Controller
- Device name
- Optional account label

Run `scripts/configure-agent.ps1` with `-RelayUrl`, `-PairingCode`, `-DeviceName`, and optionally `-AccountLabel`. Never print, persist in chat, or request the device token returned by Relay; the script protects it with Windows DPAPI for the current user.

After configuration, run `scripts/get-agent-status.ps1`. Report the state, Relay origin, device name, last successful sync, task count, and pending request count. Treat `connected` as success. If the state is `starting`, wait briefly and read status again.

## Inspect status

Run `scripts/get-agent-status.ps1`. If no status exists, explain that the plugin has not started yet and run `hooks/session-start.ps1` once before checking again.

## Disconnect

When the user explicitly asks to disconnect this device, run `scripts/disconnect-agent.ps1`. This stops only the plugin-owned Agent and deletes its local pairing configuration. It does not alter Relay or Controller installations.

## Boundaries

- This plugin currently supports Windows Codex Desktop.
- A changed plugin hook must be reviewed and trusted before Codex runs it.
- Do not bypass hook trust.
- Do not expose `agent-config.json`, decrypted tokens, or environment values containing credentials.
