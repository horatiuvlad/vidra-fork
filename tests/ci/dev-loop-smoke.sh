#!/usr/bin/env bash
# Exercise `vidra dev` end to end: Vite starts, the host builds and launches, and
# a C# edit is picked up by the watcher.
#
# Usage: dev-loop-smoke.sh <path/to/scaffolded/app> <path/to/cli.js> <macos|windows>
#
# C# hot reload is the headline feature of the 0.3 line and had no automated
# coverage at all — unit tests cover argument construction and log
# classification, but nothing ever started a real session. This closes that gap
# with two bounded assertions:
#
#   1. the host reaches the `[vidra] host ready` sentinel that VidraPage prints
#      when VIDRA_DEV_URL is set (proving Vite came up, the host built under
#      `dotnet watch`, launched, and loaded the dev server), and
#   2. touching a C# file makes the watcher react rather than sit idle.
#
# Everything is time-bounded and the session is always torn down, because a
# hanging dev server is exactly the failure this must not cause.
set -uo pipefail

APP_DIR="${1:?usage: dev-loop-smoke.sh <app-dir> <cli.js> <target>}"
CLI="${2:?missing cli.js path}"
TARGET="${3:?missing target}"

READY_TIMEOUT="${VIDRA_DEV_READY_TIMEOUT:-300}"
RELOAD_TIMEOUT="${VIDRA_DEV_RELOAD_TIMEOUT:-120}"
SENTINEL="[vidra] host ready"

LOG="$(mktemp)"
cd "$APP_DIR"

cleanup() {
  if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    # `vidra dev` supervises Vite and a dotnet watch process group, so signal
    # the group and give it a moment to take its children with it.
    kill -TERM "-$DEV_PID" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null || true
    sleep 3
    kill -KILL "-$DEV_PID" 2>/dev/null || kill -KILL "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> starting: vidra dev --target $TARGET"
# `setsid` is util-linux and does not exist on macOS. Enabling job control makes
# bash place the background job in its own process group with the child as
# leader, which gives us the same `kill -- -PID` teardown portably.
set -m
node "$CLI" dev --target "$TARGET" >"$LOG" 2>&1 &
DEV_PID=$!
set +m

waited=0
while [ "$waited" -lt "$READY_TIMEOUT" ]; do
  grep -qF "$SENTINEL" "$LOG" && break
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "::error::vidra dev exited before the host became ready"
    sed -e 's/^/    /' "$LOG"
    exit 1
  fi
  sleep 2
  waited=$((waited + 2))
done

if ! grep -qF "$SENTINEL" "$LOG"; then
  echo "::error::no '$SENTINEL' within ${READY_TIMEOUT}s"
  sed -e 's/^/    /' "$LOG"
  exit 1
fi
echo "==> host ready after ~${waited}s"

# Touch a method body so the watcher has something to pick up. We assert the
# watcher *reacted*, not that a specific hot-reload strategy was chosen: whether
# an edit applies as a delta or forces a restart depends on the installed
# workload set, and both are legitimate outcomes.
MAIN_PAGE="$(find src -name 'MainPage.cs' -print -quit)"
if [ -z "$MAIN_PAGE" ]; then
  echo "::error::could not find MainPage.cs to edit"
  exit 1
fi

echo "==> editing $MAIN_PAGE"
before="$(wc -l < "$LOG")"
printf '\n// touched by dev-loop-smoke at build time\n' >> "$MAIN_PAGE"

waited=0
reacted=0
while [ "$waited" -lt "$RELOAD_TIMEOUT" ]; do
  if tail -n +"$before" "$LOG" | grep -qiE 'hot reload|hot-reload|rebuild|restarting|file changed|watch'; then
    reacted=1
    break
  fi
  kill -0 "$DEV_PID" 2>/dev/null || break
  sleep 2
  waited=$((waited + 2))
done

echo "---- session output ----"
sed -e 's/^/    /' "$LOG" | tail -40

if [ "$reacted" -ne 1 ]; then
  echo "::error::the watcher did not react to a C# edit within ${RELOAD_TIMEOUT}s"
  exit 1
fi

echo "==> PASS — dev session started and reacted to a C# change"
