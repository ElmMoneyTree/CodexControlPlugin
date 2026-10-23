#!/bin/bash
set -euo pipefail
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/cc-macos-build.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
for helper in keychain desktop-lifecycle; do
  for architecture in arm64 x86_64; do
    xcrun swiftc -O -sdk "$sdk_path" -target "$architecture-apple-macosx11.0" \
      -module-cache-path "$build_dir/module-cache-$architecture" \
      "$plugin_root/runtime/macos/$helper.swift" -o "$build_dir/$helper-$architecture"
  done
  lipo -create "$build_dir/$helper-arm64" "$build_dir/$helper-x86_64" \
    -output "$plugin_root/runtime/macos/$helper-helper"
  codesign --force --sign - "$plugin_root/runtime/macos/$helper-helper"
  chmod 755 "$plugin_root/runtime/macos/$helper-helper"
done
