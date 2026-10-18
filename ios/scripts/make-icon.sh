#!/bin/sh
# Usage: ios/scripts/make-icon.sh [out.png]
# Renders the app icon from ClaudioBot/Views/Brand.swift, the same drawing the launch splash uses.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="${TMPDIR:-/tmp}/claudiobot-brand-icon"
xcrun swiftc -swift-version 6 -target arm64-apple-macos15 -o "$bin" \
  "$root/scripts/brand-icon/main.swift" \
  "$root/ClaudioBot/Views/Brand.swift" "$root/ClaudioBot/Views/Avatar.swift" \
  "$root/ClaudioBot/Views/Theme.swift" "$root/ClaudioBot/Model/Protocol.swift"
"$bin" "$@"
