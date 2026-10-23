#!/bin/bash
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'CodexControlPlugin supports macOS and Windows.' >&2
  exit 1
fi
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"
node_candidates=()
if [[ -n "${CODEX_CONTROL_NODE:-}" ]]; then node_candidates+=("$CODEX_CONTROL_NODE"); fi
# Prefer the desktop's supported runtime. App-tool authority is provided by
# the app-managed MCP bridge; an independent launchd process cannot own it.
if [[ -n "${CODEX_ELECTRON_RESOURCES_PATH:-}" ]]; then node_candidates+=("$CODEX_ELECTRON_RESOURCES_PATH/cua_node/bin/node"); fi
node_candidates+=(
  '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node'
  '/Applications/Codex.app/Contents/Resources/cua_node/bin/node'
  "$HOME/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
  "$HOME/Applications/Codex.app/Contents/Resources/cua_node/bin/node"
)
if [[ -n "${CODEX_MCP_NODE_PATH:-}" ]]; then node_candidates+=("$CODEX_MCP_NODE_PATH"); fi
if command -v node >/dev/null 2>&1; then node_candidates+=("$(command -v node)"); fi
node_candidates+=('/opt/homebrew/bin/node' '/usr/local/bin/node')
for node_binary in "${node_candidates[@]}"; do
  if [[ -x "$node_binary" ]] && "$node_binary" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then
    exec "$node_binary" "$plugin_root/scripts/macos-agent.mjs" "$@"
  fi
done
echo 'Node.js 24+ was not found. Install Node.js or set CODEX_CONTROL_NODE to the bundled Codex Node.js binary.' >&2
exit 1
