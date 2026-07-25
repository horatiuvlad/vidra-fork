#!/usr/bin/env bash
# Launch the packaged macOS app and prove the bridge works end to end.
#
# Usage: launch-macos-app.sh <path/to/App.dmg>
#
# The scaffolded app's MainPage has been replaced by tests/smoke/e2e-main-page.cs.in,
# which calls into JavaScript over the typed contract and writes the returned
# value to $VIDRA_E2E_PROOF before exiting. So a proof file appearing means the
# *production* asset path, the protocol-v2 handshake, and a full C#->JS->C#
# round-trip all worked inside a real packaged build.
#
# It also catches the failure mode that signing changes are most likely to
# introduce: wrong hardened-runtime entitlements kill the .NET JIT, and the
# process dies on launch instead of producing a proof.
set -euo pipefail

DMG="${1:?usage: launch-macos-app.sh <App.dmg>}"
TIMEOUT_SECONDS="${VIDRA_E2E_TIMEOUT:-120}"

MOUNT="$(mktemp -d)"
STAGE="$(mktemp -d)"
PROOF="$(mktemp -d)/proof.txt"
LOG="$(mktemp)"
CRASH_DIR="$HOME/Library/Logs/DiagnosticReports"
MARKER="$(mktemp)"

cleanup() {
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$MOUNT" "$STAGE" "$MARKER"
}
trap cleanup EXIT

echo "==> mounting $DMG"
hdiutil attach "$DMG" -mountpoint "$MOUNT" -nobrowse -quiet
APP_SRC="$(find "$MOUNT" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$APP_SRC" ] || { echo "::error::no .app inside the disk image"; exit 1; }
cp -R "$APP_SRC" "$STAGE/"
hdiutil detach "$MOUNT" -quiet
APP="$STAGE/$(basename "$APP_SRC")"

BIN_DIR="$APP/Contents/MacOS"
BIN="$BIN_DIR/$(ls "$BIN_DIR" | head -1)"
[ -x "$BIN" ] || { echo "::error::no executable in $BIN_DIR"; exit 1; }

echo "==> launching $(basename "$BIN")"
# Run the inner binary directly rather than via `open` so stdout/stderr are
# captured and the process is ours to wait on.
VIDRA_E2E_PROOF="$PROOF" "$BIN" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 "$TIMEOUT_SECONDS"); do
  [ -f "$PROOF" ] && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done

if [ -f "$PROOF" ]; then
  VALUE="$(cat "$PROOF")"
  echo "==> bridge round-trip proof: '$VALUE'"
  if [ "$VALUE" != "1" ]; then
    echo "::error::unexpected proof value (want 1, got '$VALUE')"
    sed -e 's/^/    /' "$LOG"
    exit 1
  fi
  echo "==> PASS — packaged app launched and completed a C#<->JS round-trip"
  exit 0
fi

echo "::error::the packaged app produced no bridge proof within ${TIMEOUT_SECONDS}s"
echo "---- app output ----"
sed -e 's/^/    /' "$LOG" || true
if kill -0 "$PID" 2>/dev/null; then
  echo "---- process is still running (the WebView likely never reached the bridge) ----"
else
  echo "---- process exited early ----"
fi
echo "---- crash reports written during this run ----"
find "$CRASH_DIR" -newer "$MARKER" -name '*.ips' -o -newer "$MARKER" -name '*.crash' 2>/dev/null \
  | head -5 | while read -r report; do
      echo "--- $report"
      head -40 "$report"
    done
exit 1
