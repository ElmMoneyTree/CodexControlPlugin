---
name: codex-control-plugin
description: Connect, inspect, reconfigure, or disconnect this Windows Codex device from a Codex Control Relay using the bundled plugin agent. Use when the user asks to pair this device, check its controller connection, change its Relay, or remove the connection.
---

# CodexControlPlugin

Use the bundled PowerShell scripts in this plugin. Resolve all script paths relative to this `SKILL.md` through the plugin root; do not download or install a separate Device Agent.

## Claim this device

If the standalone `Codex Device Agent` application is running, tell the user to exit it before pairing this plugin so the same computer is not shown twice in Controller.

Use device claiming by default. The trusted SessionStart hook automatically creates the first short-lived claim and opens its page. Inspect `scripts/get-agent-status.ps1` first. If no usable claim is pending, confirm that the user is signed in to the Codex Control mobile app, then run `scripts/start-device-claim.ps1`. If a current claim is pending, running the same script safely reopens it instead of creating another. The production connection service URL is built in; only pass `-RelayUrl` when the user explicitly uses a different deployment. The script opens a one-time claim page in the browser and returns only a safe device fingerprint and expiry summary. Never pass `-RevealClaimLink` through Codex or repeat a secret-bearing URL into chat; that option exists only for an operator working directly in a private local terminal.

Tell the user to scan the QR code with the signed-in mobile app, choose a personal or team workspace, compare the displayed fingerprint, and approve the claim on their phone. Then read `scripts/get-agent-status.ps1`; if the state is `claim-pending` or `claim-waiting`, wait briefly and read status again. Treat `connected` as success. Never expose the poll token, private device key, device token, `pending-claim.json`, or `agent-config.json`.

If a legacy schema 1 Agent configuration already exists, do not disconnect it. Run the same claim script without changing Relay URL. The script performs an in-place account migration and keeps the old configuration usable unless approval succeeds. Explain that the device ID and task state are preserved while the credential is rotated.

## Legacy pairing fallback

Use legacy pairing only when the user explicitly requests it or the connection service does not support device claims. Collect these non-secret values if they are missing:

- Relay HTTP(S) origin
- Current one-time pairing code from Controller
- Device name
- Optional account label

Run `scripts/configure-agent.ps1` with `-RelayUrl`, `-PairingCode`, `-DeviceName`, and optionally `-AccountLabel`. Never print, persist in chat, or request the device token returned by Relay; the script protects it with Windows DPAPI for the current user.

Run `scripts/configure-agent.ps1` with the legacy Relay values, then inspect status as above.

## Inspect status

Run `scripts/get-agent-status.ps1`. If no status exists, explain that the plugin has not started yet and run `hooks/session-start.ps1` once before checking again.

For an explicit Windows acceptance run, use `scripts/verify-device-claim.ps1` for a non-mutating Relay/runtime/DPAPI preflight. Only add `-BeginClaim` when the user asks to perform or finish real device claiming; it opens or resumes the claim and waits for the Agent's first successful Codex Desktop and Relay sync. Report only its sanitized result.

## Disconnect

When the user explicitly asks to disconnect this device, run `scripts/disconnect-agent.ps1`. This stops only the plugin-owned Agent and deletes its local pairing configuration. It does not alter Relay or Controller installations.

## Boundaries

- This plugin currently supports Windows Codex Desktop.
- A changed plugin hook must be reviewed and trusted before Codex runs it.
- Do not bypass hook trust.
- Do not expose `agent-config.json`, decrypted tokens, or environment values containing credentials.

If a configured Windows device remains claimed or offline, keep Codex Desktop open and run `scripts/restart-agent.ps1`, then inspect `scripts/get-agent-status.ps1`. Preserve its existing device identity; do not disconnect or claim again merely to restart the Agent.
