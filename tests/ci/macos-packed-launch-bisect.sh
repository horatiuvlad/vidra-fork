#!/usr/bin/env bash
# Which step of packing stops a Mac Catalyst app from launching?
#
#   macos-packed-launch-bisect.sh <built.app> <Entitlements.plist> <workdir>
#
# The packed bundle dies inside the mono runtime before any managed code runs,
# and the crash dump says only that it aborted while loading an AOT module —
# mono's explanation goes to os_log, not to stderr. The bundle that comes out of
# `vpk pack` is byte-for-byte the one that went in plus three files, signed by
# the same identity with the same flags, and `codesign --verify --deep --strict`
# passes on both. So reading is not going to settle it.
#
# This applies one transformation at a time and launches after each:
#
#   A  control              a plain copy                     — expected to run
#   B  deep re-sign         codesign --force --deep          — what vpk does last
#   C  vpk's recipe         every MonoBundle file signed
#                           individually, then --deep        — what vpk actually does
#   D  zip round-trip       ditto -c -k then ditto -x -k     — how the app is installed
#
# Whichever variant first fails to produce a proof is the answer.
set -uo pipefail

BUILT="${1:?usage: macos-packed-launch-bisect.sh <built.app> <entitlements> <workdir>}"
ENTITLEMENTS="${2:?}"
WORK="${3:?}"

IDENTITY="${VIDRA_MACOS_CODESIGN_KEY:-}"
KEYCHAIN="${VIDRA_MACOS_KEYCHAIN:-}"
LAUNCH_TIMEOUT="${VIDRA_BISECT_TIMEOUT:-60}"

mkdir -p "$WORK"
MAIN_EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$BUILT/Contents/Info.plist")"
echo "==> built:      $BUILT"
echo "==> mainExe:    $MAIN_EXE"
echo "==> identity:   ${IDENTITY:-<none>}"
echo "==> keychain:   ${KEYCHAIN:-<default>}"

keychain_args=()
[ -n "$KEYCHAIN" ] && keychain_args=(--keychain "$KEYCHAIN")

# Launch a bundle and say whether it produced a proof. Everything about updates
# is switched off: the question is only whether the process reaches managed code.
launch() {
  local label="$1" app="$2"
  local proof="$WORK/$label.json" log="$WORK/$label.log"
  rm -f "$proof"

  VIDRA_NATIVE_PROOF="$proof" \
  VIDRA_NATIVE_MODE=report \
  VIDRA_NATIVE_UPDATE_ENABLED=0 \
    "$app/Contents/MacOS/$MAIN_EXE" > "$log" 2>&1 &
  local pid=$!

  local waited=0
  while [ $waited -lt "$LAUNCH_TIMEOUT" ] && [ ! -f "$proof" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$pid" 2>/dev/null

  if [ -f "$proof" ]; then
    echo "  RUNS   $label"
    return 0
  fi

  echo "  CRASHES $label — first 25 lines of output:"
  sed -n '1,25p' "$log" | sed 's/^/      /'
  return 1
}

copy() {
  local dest="$WORK/$1.app"
  rm -rf "$dest"
  ditto "$BUILT" "$dest"
  echo "$dest"
}

echo
echo "======== A: control (a plain copy)"
launch A-control "$(copy A)"

echo
echo "======== B: codesign --force --deep, the way vpk finishes"
b="$(copy B)"
if [ -n "$IDENTITY" ]; then
  codesign --force --deep --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "${keychain_args[@]}" "$b" 2>&1 | sed 's/^/      /'
fi
launch B-deep-resign "$b"

echo
echo "======== C: vpk's recipe — every MonoBundle file signed individually, then --deep"
c="$(copy C)"
if [ -n "$IDENTITY" ]; then
  for f in "$c"/Contents/MonoBundle/*; do
    codesign --force --timestamp --options runtime \
      --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "${keychain_args[@]}" "$f" >/dev/null 2>&1
  done
  codesign --force --deep --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "${keychain_args[@]}" "$c" 2>&1 | sed 's/^/      /'
fi
launch C-vpk-recipe "$c"

echo
echo "======== D: a ditto zip round-trip, which is how the app is installed"
d="$(copy D)"
rm -rf "$WORK/d.zip" "$WORK/d-extract"
ditto -c -k --sequesterRsrc --keepParent "$d" "$WORK/d.zip"
mkdir -p "$WORK/d-extract"
ditto -x -k "$WORK/d.zip" "$WORK/d-extract"
launch D-zip-roundtrip "$(find "$WORK/d-extract" -maxdepth 2 -name '*.app' -type d -print -quit)"

echo
echo "==> bisect complete"
exit 0
