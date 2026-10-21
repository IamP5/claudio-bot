#!/bin/zsh
# Usage: ios/scripts/swipe-check.sh <simulator-udid> [path/to/ClaudioBot.app]
# Swipes each demo thread down once at each Dynamic Type size and fails when a swipe takes over MAX_SWIPE_S
# (default 10) or the app's mean CPU over the 10 s after it stays above MAX_CPU (default 50%). A swipe that
# settles takes 1 to 4 s here, most of it XCUITest waiting out the scroll's deceleration; a hang takes about 60.
# SCREENS and SIZES override the matrix. ATTACH=1 swipes the app as it already runs (a paired app on a live
# thread) once, at the content size it has, and leaves both alone; the app path is then optional.
# Needs a booted simulator you hold and xcodegen. Otherwise the device's content size is set back to large on exit.
set -u
udid="$1"
app="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/swipe-check.XXXXXX")"
out="$work/swipes.txt"
max_swipe="${MAX_SWIPE_S:-10}"
max_cpu="${MAX_CPU:-50}"
attach="${ATTACH:-0}"
[ "$attach" = 1 ] || trap 'xcrun simctl ui "$udid" content_size large' EXIT

xcodegen generate --quiet --spec "$here/swipe-check/project.yml" --project "$work" || exit 1
xcodebuild -project "$work/SwipeCheck.xcodeproj" -scheme UITests -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath "$work/dd" build-for-testing > "$work/build.log" 2>&1 || { echo "the swipe driver did not build: $work/build.log"; exit 1; }
[ "$attach" = 1 ] || xcrun simctl install "$udid" "$app" || exit 1

app_cpu() {
  local pid=$(pgrep -f "Devices/$udid/.*ClaudioBot.app/ClaudioBot" | head -1)
  [ -n "$pid" ] && ps -o %cpu= -p "$pid" | tr -d ' '
}

screens="${SCREENS:-workrun thread plan streaming longthread}"
sizes="${SIZES:-large accessibility-extra-large accessibility-extra-extra-extra-large}"
[ "$attach" = 1 ] && screens=live && sizes=current
failed=0
for size in ${=sizes}; do
  for screen in ${=screens}; do
    [ "$attach" = 1 ] || xcrun simctl ui "$udid" content_size "$size"
    : > "$out"
    TEST_RUNNER_SCREEN="$screen" TEST_RUNNER_OUT="$out" TEST_RUNNER_ATTACH="$attach" \
      xcodebuild -project "$work/SwipeCheck.xcodeproj" -scheme UITests -destination "platform=iOS Simulator,id=$udid" \
      -derivedDataPath "$work/dd" test-without-building -only-testing:UITests/Swipe/testSwipeDown > "$work/$screen-$size.log" 2>&1
    seconds=$(awk '{print $2}' "$out")
    samples=()
    for i in {1..10}; do samples+=$(app_cpu); sleep 1; done
    cpu=$(printf '%s\n' $samples | awk '{s+=$1; n++} END {printf "%.0f", n ? s/n : 0}')
    verdict=ok
    if [ -z "$seconds" ] || awk -v s="$seconds" -v m="$max_swipe" -v c="$cpu" -v mc="$max_cpu" 'BEGIN {exit !(s > m || c > mc)}'; then
      verdict=FAIL
      failed=1
    fi
    echo "$verdict $screen $size swipe=${seconds:-none}s cpu-after=${cpu}% ($samples)"
    [ "$attach" = 1 ] || xcrun simctl terminate "$udid" dev.claudiobot.app 2>/dev/null
  done
done
exit $failed
