#!/usr/bin/env bash
# Verify the signing properties of a packaged macOS build.
#
# Usage: verify-macos-artifact.sh <path/to/App.dmg>
#
# What is asserted (all satisfiable with a self-signed identity, i.e. for $0):
#   * the .dmg carries a signature
#   * the .app inside passes `codesign --verify --strict`
#   * the .app is signed with the hardened runtime (flags=...runtime)
#   * the JIT entitlements the .NET runtime needs are actually embedded
#
# What is only *reported*: `spctl --assess`. It is expected to REJECT until the
# build is Developer ID signed and notarized, so a rejection is informational —
# it is the check that flips to green the day real credentials exist.
set -euo pipefail

DMG="${1:?usage: verify-macos-artifact.sh <App.dmg>}"
MOUNT="$(mktemp -d)"
STAGE="$(mktemp -d)"
cleanup() {
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$MOUNT" "$STAGE"
}
trap cleanup EXIT

echo "==> disk image signature"
if codesign --verify --strict --verbose=2 "$DMG" 2>&1; then
  echo "    dmg signature: OK"
else
  echo "::error::the .dmg is not validly signed"
  exit 1
fi

echo "==> mounting $DMG"
hdiutil attach "$DMG" -mountpoint "$MOUNT" -nobrowse -quiet
APP="$(find "$MOUNT" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$APP" ]; then
  echo "::error::no .app found inside the disk image"
  exit 1
fi
# Copy off the read-only mount so later steps can launch it.
cp -R "$APP" "$STAGE/"
APP="$STAGE/$(basename "$APP")"
hdiutil detach "$MOUNT" -quiet

echo "==> app bundle signature"
if ! codesign --verify --strict --deep --verbose=2 "$APP" 2>&1; then
  echo "::error::codesign --verify --strict failed for the .app"
  exit 1
fi

echo "==> code signing flags"
FLAGS="$(codesign -d --verbose=2 "$APP" 2>&1 | grep -E '^CodeDirectory' || true)"
echo "    $FLAGS"
if ! echo "$FLAGS" | grep -q 'runtime'; then
  echo "::error::the app is not signed with the hardened runtime — it cannot be notarized"
  exit 1
fi

echo "==> embedded entitlements"
ENTITLEMENTS="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null || codesign -d --entitlements - "$APP" 2>/dev/null || true)"
echo "$ENTITLEMENTS"
for key in \
  "com.apple.security.cs.allow-jit" \
  "com.apple.security.cs.allow-unsigned-executable-memory" \
  "com.apple.security.cs.disable-library-validation"; do
  if ! echo "$ENTITLEMENTS" | grep -q "$key"; then
    echo "::error::missing entitlement $key — the hardened runtime will kill the .NET JIT at launch"
    exit 1
  fi
done

echo "==> gatekeeper assessment (informational)"
if spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" 2>&1; then
  echo "    spctl ACCEPTED — this build would open on another Mac"
else
  echo "    spctl rejected, as expected for a self-signed, un-notarized build."
  echo "    This is the check that turns green once a Developer ID certificate"
  echo "    and notarization credentials are configured."
fi

echo "==> signing verification passed"
echo "VIDRA_VERIFIED_APP=$APP"
