#!/bin/zsh
# Usage: ios/scripts/swipe-check.sh <simulator-udid> [path/to/ClaudioBot.app]
# Swipes each demo thread down once at each Dynamic Type size and fails when a swipe takes over MAX_SWIPE_S
# (default 10) or the app's mean CPU over the 10 s after it stays above MAX_CPU (default 50%). A swipe that
# settles takes 1 to 4 s here, most of it XCUITest waiting out the scroll's deceleration; a hang takes about 60.
# SCREENS and SIZES override the matrix; SCREENS also drops the six-command screens swept from xxxLarge to AX5.
# ATTACH=1 swipes the app as it already runs (a paired app on a live thread) once, at the content size it has, and
# leaves both alone; the app path is then optional.
# Needs a booted simulator you hold and xcodegen. Otherwise the device's content size is set back to large on exit.
# It runs under zsh whatever shell starts it, and any failed step ends it with a non-zero status.
if [ -z "${ZSH_VERSION:-}" ]; then exec zsh "$0" "$@"; fi
setopt err_exit pipe_fail no_unset
[ $# -ge 1 ] || { echo "usage: $0 <simulator-udid> [path/to/ClaudioBot.app]" >&2; exit 2; }
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
[ "$attach" = 1 ] || xcrun simctl install "$udid" "$app"

# Prints nothing when the app is not running; that sample then counts as no CPU.
app_cpu() {
  local pid
  pid=$(pgrep -f "Devices/$udid/.*ClaudioBot.app/ClaudioBot" | head -1) || return 0
  [ -n "$pid" ] || return 0
  ps -o %cpu= -p "$pid" | tr -d ' ' || true
}

screens="${SCREENS:-workrun thread plan streaming longthread approvals approvalsanswered composerdraft composerlong composerlapse composerrefused composermode composerqueued stoppedearly composerlongkb composerlapsekb composerrefusedkb composerlapsekbgone}"
sizes="${SIZES:-large accessibility-extra-large accessibility-extra-extra-extra-large}"
# The six-command refusal (a long note), with the keyboard down and up, at every size from xxxLarge, where the bar is
# most crowded. Set SCREENS to leave it out.
extra="${SCREENS:+none}"
[ "$extra" = none ] && extra="" || extra="composersix composersixkb"
extra_sizes="extra-extra-extra-large accessibility-medium accessibility-large accessibility-extra-large accessibility-extra-extra-large accessibility-extra-extra-extra-large"
[ "$attach" = 1 ] && screens=live && sizes=current && extra=""
failed=0
swipe() {
  local screen=$1 size=$2
  [ "$attach" = 1 ] || xcrun simctl ui "$udid" content_size "$size"
  : > "$out"
  TEST_RUNNER_SCREEN="$screen" TEST_RUNNER_OUT="$out" TEST_RUNNER_ATTACH="$attach" \
    xcodebuild -project "$work/SwipeCheck.xcodeproj" -scheme UITests -destination "platform=iOS Simulator,id=$udid" \
    -derivedDataPath "$work/dd" test-without-building -only-testing:UITests/Swipe/testSwipeDown > "$work/$screen-$size.log" 2>&1 \
    || echo "the swipe test failed: $work/$screen-$size.log"
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
  [ "$attach" = 1 ] || xcrun simctl terminate "$udid" dev.claudiobot.app 2>/dev/null || true
}
for size in ${=sizes}; do
  for screen in ${=screens}; do swipe $screen $size; done
done
for size in ${=extra_sizes}; do
  for screen in ${=extra}; do swipe $screen $size; done
done
exit $failed
