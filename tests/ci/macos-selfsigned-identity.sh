#!/usr/bin/env bash
# Create a throwaway code-signing identity in a temporary keychain.
#
# This is what makes the whole signing path testable without an Apple Developer
# Program membership: `codesign` only needs a certificate with a private key and
# the codeSigning EKU — Apple's trust chain matters for `spctl`/notarization,
# not for producing and verifying a signature.
#
# The common name deliberately starts with "Developer ID Application:" so that
# resolveMacCodeSigningIdentity(purpose: "distribution") selects it, exercising
# the real selection logic rather than a test-only shortcut.
#
# Exports (via $GITHUB_ENV when present): VIDRA_MACOS_CODESIGN_KEY
set -euo pipefail

IDENTITY_CN="${VIDRA_CI_IDENTITY_CN:-Developer ID Application: Vidra CI (TESTTEAM01)}"
KEYCHAIN="${VIDRA_CI_KEYCHAIN:-vidra-ci.keychain-db}"
KEYCHAIN_PASSWORD="${VIDRA_CI_KEYCHAIN_PASSWORD:-vidra-ci}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> generating a self-signed code-signing certificate"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
  -subj "/CN=$IDENTITY_CN/O=Vidra CI/C=US" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"

# OpenSSL 3 defaults to AES-256-CBC with a SHA-256 MAC, which Apple's
# `security` tool cannot read — it fails with:
#   SecKeychainItemImport: MAC verification failed during PKCS12 import
# The legacy provider restores the 3DES/SHA-1 encoding macOS expects. LibreSSL
# (/usr/bin/openssl) has no -legacy flag but already writes the old format, so
# fall back to a plain export there.
p12_args=(pkcs12 -export
  -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem"
  -out "$WORKDIR/identity.p12" -passout "pass:$KEYCHAIN_PASSWORD"
  -macalg sha1)

if openssl "${p12_args[@]}" -legacy 2>/dev/null; then
  echo "    (exported with the OpenSSL legacy provider)"
else
  rm -f "$WORKDIR/identity.p12"
  openssl "${p12_args[@]}"
  echo "    (exported with the default provider)"
fi

echo "==> importing into a temporary keychain"
security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"

# Keep the login keychain in the search list so the toolchain still resolves
# everything else it expects.
security list-keychains -d user -s "$KEYCHAIN" "$(security default-keychain -d user | tr -d ' "')"

security import "$WORKDIR/identity.p12" \
  -k "$KEYCHAIN" -P "$KEYCHAIN_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security

# Without this, codesign blocks on an interactive "allow access" prompt.
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null

# Deliberately NOT installed as a trusted root. Trust settings can raise an
# interactive confirmation, which on a headless runner hangs until the job times
# out — and they buy nothing here: codesign signs from the keychain regardless,
# `codesign --verify --strict` checks internal consistency rather than chain
# trust, and `spctl` is expected to reject a self-signed build anyway.
echo "==> identity left untrusted (expected: spctl will reject, codesign will not)"

# NB: `find-identity -v` lists only identities whose certificate chain
# *validates*, which a self-signed certificate never does without a trusted
# root — it would report "0 valid identities found" even though the identity is
# present and perfectly usable. codesign does not require chain trust to sign,
# so check the unfiltered list instead.
echo "==> identities in $KEYCHAIN (unfiltered):"
security find-identity -p codesigning "$KEYCHAIN"
echo "==> identities considered 'valid' (expected to be empty for a self-signed root):"
security find-identity -v -p codesigning "$KEYCHAIN" || true

if ! security find-identity -p codesigning "$KEYCHAIN" | grep -q "$IDENTITY_CN"; then
  echo "::error::self-signed identity was not registered in $KEYCHAIN"
  exit 1
fi

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "VIDRA_MACOS_CODESIGN_KEY=$IDENTITY_CN" >> "$GITHUB_ENV"
fi
echo "==> VIDRA_MACOS_CODESIGN_KEY=$IDENTITY_CN"
