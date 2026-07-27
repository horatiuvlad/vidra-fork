#!/usr/bin/env bash
# Verify the signing properties of a packaged macOS build.
#
# Usage: verify-macos-artifact.sh <path/to/App.dmg> <path/to/cli.js>
#
# The substantive checks live in the CLI (`vidra verify`), which is the same
# code `vidra build` runs — so there is one implementation of "is this
# shippable", and a developer sees exactly what CI sees.
#
# This script keeps ONE deliberately independent assertion on top: a raw
# `codesign --verify` against the mounted app. A test should not let the thing
# under test be its own judge — if `verifyMacSignature` regressed to always
# returning ok, the CLI-based check alone would happily pass.
set -euo pipefail

DMG="${1:?usage: verify-macos-artifact.sh <App.dmg> <cli.js>}"
CLI="${2:?missing cli.js path}"

echo '==> vidra verify (the same checks `vidra build` performs)'
node "$CLI" verify "$DMG"

# --- independent oracle -------------------------------------------------------
# Deliberate duplication: re-derive the verdict without going through the code
# that produced it. Path knowledge still comes from the CLI, so only the
# *assertion* is repeated, not the bundle layout.
echo "==> independent re-check"
MOUNT="$(mktemp -d)"
cleanup() {
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$MOUNT"
}
trap cleanup EXIT

hdiutil attach "$DMG" -mountpoint "$MOUNT" -nobrowse -quiet
APP="$(find "$MOUNT" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$APP" ] || { echo "::error::no .app inside the disk image"; exit 1; }

if ! codesign --verify --strict --deep --verbose=2 "$APP" 2>&1; then
  echo "::error::independent codesign --verify disagrees with the CLI"
  exit 1
fi

FLAGS="$(codesign -d --verbose=2 "$APP" 2>&1 | grep -E '^CodeDirectory' || true)"
echo "    $FLAGS"
if ! echo "$FLAGS" | grep -q 'runtime'; then
  echo "::error::hardened runtime absent — independent check disagrees with the CLI"
  exit 1
fi

echo "==> signing verification passed (CLI + independent check agree)"
