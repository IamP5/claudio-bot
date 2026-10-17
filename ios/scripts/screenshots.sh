#!/bin/sh
# Usage: ios/scripts/screenshots.sh <simulator-udid> <path/to/ClaudeBot.app>
# Launches the DEBUG build with -demo on each screen and saves PNGs to ios/screenshots/.
set -eu
udid="$1"
app="$2"
out="$(cd "$(dirname "$0")/.." && pwd)/screenshots"
mkdir -p "$out"
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl install "$udid" "$app"
for screen in ${SCREENS:-home new task cloud pair settings}; do
  xcrun simctl terminate "$udid" dev.claudebot.app 2>/dev/null || true
  xcrun simctl launch "$udid" dev.claudebot.app -demo -demoScreen "$screen" >/dev/null
  sleep "${SETTLE:-3}"
  xcrun simctl io "$udid" screenshot "$out/${PREFIX:-}$screen.png" >/dev/null 2>&1
  echo "$out/${PREFIX:-}$screen.png"
done
