#!/bin/bash
set -euo pipefail
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/cc-keychain-build.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
for architecture in arm64 x86_64; do
  xcrun swiftc -O -sdk "$sdk_path" -target "$architecture-apple-macosx11.0" \
    -module-cache-path "$build_dir/module-cache-$architecture" \
    "$plugin_root/runtime/macos/keychain.swift" -o "$build_dir/keychain-$architecture"
done
lipo -create "$build_dir/keychain-arm64" "$build_dir/keychain-x86_64" \
  -output "$plugin_root/runtime/macos/keychain-helper"
codesign --force --sign - "$plugin_root/runtime/macos/keychain-helper"
chmod 755 "$plugin_root/runtime/macos/keychain-helper"
