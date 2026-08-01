#!/usr/bin/env bash
# Does this Mac Catalyst .app reach managed code?
#
#   catalyst-launch-probe.sh <app> <workdir>
#
# It cannot ask the app: the failure under investigation aborts inside the mono
# runtime before any managed code runs. So the test is cruder and more reliable
# — start the binary and see whether it is still alive a moment later. A crash
# dumps a native stack and exits; a healthy app sits there with a window.
#
# Both in place and from a copy, because "only works where it was built" and
# "does not work at all" are different diagnoses.
set -uo pipefail

APP="${1:?usage: catalyst-launch-probe.sh <app> <workdir>}"
WORK="${2:?}"
ALIVE_SECONDS="${VIDRA_PROBE_ALIVE_SECONDS:-25}"

mkdir -p "$WORK"
MAIN_EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"

echo "==> app:     $APP"
echo "==> mainExe: $MAIN_EXE"
echo "--- MonoBundle: $(ls "$APP/Contents/MonoBundle" | wc -l | tr -d ' ') entries," \
     "$(ls "$APP/Contents/MonoBundle" | grep -c '\.dll$') dll," \
     "$(ls "$APP/Contents/MonoBundle" | grep -c '\.dylib$') dylib," \
     "$(ls "$APP/Contents/MonoBundle" | grep -c 'aotdata') aotdata"
ls "$APP/Contents/MonoBundle" | grep -iE 'velopack|vidra' | sed 's/^/      /'

run() {
  local label="$1" app="$2"
  local log="$WORK/$label.log"

  "$app/Contents/MacOS/$MAIN_EXE" > "$log" 2>&1 &
  local pid=$!
  sleep "$ALIVE_SECONDS"

  if kill -0 "$pid" 2>/dev/null; then
    echo "  RUNS     $label (still alive after ${ALIVE_SECONDS}s)"
    kill -9 "$pid" 2>/dev/null
    return 0
  fi

  echo "  CRASHES  $label"
  # The line that names the failure, if mono left one anywhere in the output.
  grep -iE 'error|fail|cannot|unable|not found|assert' "$log" | head -10 | sed 's/^/      /'
  sed -n '1,12p' "$log" | sed 's/^/      /'
  return 1
}

run in-place "$APP"

copy="$WORK/copy.app"
rm -rf "$copy"
ditto "$APP" "$copy"
run copied "$copy"

exit 0
