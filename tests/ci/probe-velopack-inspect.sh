#!/usr/bin/env bash
# Read back what a signature actually says about a macOS bundle.
#
# Usage: probe-velopack-inspect.sh <label> <path/to/App.app> [out.json]
#
# The question this probe exists to answer is whether a signature survives a
# step, so every scenario has to be compared on the same axes: which authority
# signed it, whether the hardened runtime is on, whether the .NET JIT
# entitlements are still embedded, and whether the signature is internally
# consistent. Printing `codesign -dv` and eyeballing it is how two runs end up
# not actually being comparable.
set -uo pipefail

LABEL="${1:?usage: probe-velopack-inspect.sh <label> <App.app> [out.json]}"
TARGET="${2:?usage: probe-velopack-inspect.sh <label> <App.app> [out.json]}"
OUT="${3:-}"

read_flags() { codesign -d --verbose=4 "$TARGET" 2>&1; }
read_ents()  { codesign -d --entitlements - --xml "$TARGET" 2>&1; }

FLAGS="$(read_flags)"
ENTS="$(read_ents)"

authority="$(printf '%s\n' "$FLAGS" | grep -m1 '^Authority=' | sed 's/^Authority=//')"
identifier="$(printf '%s\n' "$FLAGS" | grep -m1 '^Identifier=' | sed 's/^Identifier=//')"
teamid="$(printf '%s\n' "$FLAGS" | grep -m1 '^TeamIdentifier=' | sed 's/^TeamIdentifier=//')"
timestamp="$(printf '%s\n' "$FLAGS" | grep -m1 '^Timestamp=' | sed 's/^Timestamp=//')"
cdflags="$(printf '%s\n' "$FLAGS" | grep -m1 'flags=' | sed 's/.*flags=\([^ ]*\).*/\1/')"

adhoc=false;    printf '%s' "$cdflags" | grep -q 'adhoc'   && adhoc=true
hardened=false; printf '%s' "$cdflags" | grep -q 'runtime' && hardened=true

jit=false;  printf '%s' "$ENTS" | grep -q 'com.apple.security.cs.allow-jit' && jit=true
uem=false;  printf '%s' "$ENTS" | grep -q 'allow-unsigned-executable-memory' && uem=true
dlv=false;  printf '%s' "$ENTS" | grep -q 'disable-library-validation' && dlv=true

verify_out="$(codesign --verify --strict --verbose=2 "$TARGET" 2>&1)"; verify_ok=$?
deep_out="$(codesign --verify --deep --strict --verbose=2 "$TARGET" 2>&1)"; deep_ok=$?
spctl_out="$(spctl --assess --type execute --verbose=2 "$TARGET" 2>&1)"; spctl_ok=$?

esc() { printf '%s' "${1:-}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

json=$(cat <<EOF
{
  "label": $(esc "$LABEL"),
  "target": $(esc "$TARGET"),
  "authority": $(esc "$authority"),
  "identifier": $(esc "$identifier"),
  "teamIdentifier": $(esc "$teamid"),
  "secureTimestamp": $(esc "$timestamp"),
  "codeDirectoryFlags": $(esc "$cdflags"),
  "adhoc": $adhoc,
  "hardenedRuntime": $hardened,
  "entitlementAllowJit": $jit,
  "entitlementUnsignedExecMemory": $uem,
  "entitlementDisableLibraryValidation": $dlv,
  "verifyStrict": $([ $verify_ok -eq 0 ] && echo true || echo false),
  "verifyDeepStrict": $([ $deep_ok -eq 0 ] && echo true || echo false),
  "gatekeeper": $([ $spctl_ok -eq 0 ] && echo true || echo false),
  "verifyOutput": $(esc "$verify_out"),
  "deepOutput": $(esc "$deep_out"),
  "spctlOutput": $(esc "$spctl_out")
}
EOF
)

echo "---- signature: $LABEL ----"
echo "$json"
[ -n "$OUT" ] && { mkdir -p "$(dirname "$OUT")"; printf '%s\n' "$json" > "$OUT"; }
exit 0
