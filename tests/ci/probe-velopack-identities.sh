#!/usr/bin/env bash
# Two throwaway signing identities in one keychain, for the Velopack probe.
#
# Velopack signs macOS releases with *two* certificates — a "Developer ID
# Application" for the `.app` and a "Developer ID Installer" for the `.pkg`
# (`--signAppIdentity` / `--signInstallIdentity`) — and it discovers them
# through a keychain (`--keychain`). The existing CI identity script makes one
# identity in its own keychain; this makes both in one so `vpk` can find them
# the way a real release would.
#
# Apple's trust chain matters for notarization and Gatekeeper, not for
# *producing* a signature, so a self-signed pair proves everything about the
# signing path short of the notary service itself.
#
# Exports (via $GITHUB_ENV when present):
#   VIDRA_MACOS_CODESIGN_KEY   the app identity (what `vidra build` signs with)
#   VELO_APP_IDENTITY          same, spelled for the probe steps
#   VELO_INSTALL_IDENTITY      the installer identity
#   VELO_KEYCHAIN              absolute path to the keychain file
set -euo pipefail

APP_CN="${VELO_APP_CN:-Developer ID Application: Vidra Probe (TESTTEAM01)}"
INSTALL_CN="${VELO_INSTALL_CN:-Developer ID Installer: Vidra Probe (TESTTEAM01)}"
KEYCHAIN_NAME="${VELO_KEYCHAIN_NAME:-vidra-velopack.keychain-db}"
KEYCHAIN_PASSWORD="${VELO_KEYCHAIN_PASSWORD:-vidra-ci}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

security delete-keychain "$KEYCHAIN_NAME" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security set-keychain-settings -lut 21600 "$KEYCHAIN_NAME"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security list-keychains -d user -s "$KEYCHAIN_NAME" \
  "$(security default-keychain -d user | tr -d ' "')"

make_identity() {
  local cn="$1" slug="$2"
  echo "==> generating a self-signed certificate for: $cn"
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$WORKDIR/$slug.key.pem" -out "$WORKDIR/$slug.cert.pem" \
    -subj "/CN=$cn/O=Vidra Probe/C=US" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning"

  # OpenSSL 3 defaults to an encoding `security` cannot import (it fails with
  # "MAC verification failed during PKCS12 import"); the legacy provider writes
  # the 3DES/SHA-1 form macOS expects. LibreSSL has no -legacy flag and already
  # writes the old format.
  local p12_args=(pkcs12 -export
    -inkey "$WORKDIR/$slug.key.pem" -in "$WORKDIR/$slug.cert.pem"
    -out "$WORKDIR/$slug.p12" -passout "pass:$KEYCHAIN_PASSWORD"
    -macalg sha1)
  if ! openssl "${p12_args[@]}" -legacy 2>/dev/null; then
    rm -f "$WORKDIR/$slug.p12"
    openssl "${p12_args[@]}"
  fi

  security import "$WORKDIR/$slug.p12" \
    -k "$KEYCHAIN_NAME" -P "$KEYCHAIN_PASSWORD" \
    -T /usr/bin/codesign -T /usr/bin/productsign -T /usr/bin/security
}

make_identity "$APP_CN" app
make_identity "$INSTALL_CN" install

# Without this, codesign/productsign block on an interactive "allow access"
# prompt that a headless runner can never answer.
security set-key-partition-list \
  -S apple-tool:,apple:,codesign:,productsign: \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" >/dev/null

# `find-identity -v` lists only chain-validating identities, which a
# self-signed certificate never is — read the unfiltered list.
echo "==> identities in $KEYCHAIN_NAME (unfiltered):"
security find-identity -p codesigning "$KEYCHAIN_NAME"

for cn in "$APP_CN" "$INSTALL_CN"; do
  if ! security find-identity -p codesigning "$KEYCHAIN_NAME" | grep -qF "$cn"; then
    echo "::error::identity was not registered: $cn"
    exit 1
  fi
done

KEYCHAIN_PATH="$(security list-keychains -d user | tr -d ' "' | grep -F "$KEYCHAIN_NAME" | head -1)"
echo "==> keychain path: $KEYCHAIN_PATH"

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "VIDRA_MACOS_CODESIGN_KEY=$APP_CN"
    echo "VELO_APP_IDENTITY=$APP_CN"
    echo "VELO_INSTALL_IDENTITY=$INSTALL_CN"
    echo "VELO_KEYCHAIN=$KEYCHAIN_PATH"
  } >> "$GITHUB_ENV"
fi
