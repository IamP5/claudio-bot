#!/bin/sh
# Usage: ios/scripts/avatar-sheet.sh <out.png>
# Builds the app's avatar code for macOS and renders every shape and color to one PNG.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="${TMPDIR:-/tmp}/claudebot-avatar-sheet"
xcrun swiftc -swift-version 6 -target arm64-apple-macos15 -o "$bin" \
  "$root/scripts/avatar-sheet/main.swift" \
  "$root/ClaudeBot/Views/Avatar.swift" "$root/ClaudeBot/Views/Theme.swift" "$root/ClaudeBot/Model/Protocol.swift"
"$bin" "${1:-avatars.png}"
