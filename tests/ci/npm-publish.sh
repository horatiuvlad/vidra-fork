#!/usr/bin/env bash
# Publish the npm package in the current directory, idempotently.
#
# Env:
#   PUSH=true|false        publish for real, or dry-run (default: dry run)
#   PROVENANCE=true|false  attach npm provenance (default: false)
#   NODE_AUTH_TOKEN        npm automation token (required when PUSH=true)
#
# `npm publish` has no `--skip-duplicate` (unlike `dotnet nuget push`), and
# re-publishing an existing version is a hard error — which would make a
# "publish both packages" run fail whenever only one of them was bumped. So we
# check the registry first and skip cleanly, matching the NuGet release's
# semantics.
set -euo pipefail

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
PUSH="${PUSH:-false}"
PROVENANCE="${PROVENANCE:-false}"

echo "==> $NAME@$VERSION"

if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  echo "    already on the registry — nothing to do"
  exit 0
fi

echo "==> installing dependencies"
npm ci || npm install

# `prepublishOnly` builds the package, so both the dry run and the real publish
# exercise the same build path.
args=(publish)
[ "$PROVENANCE" = "true" ] && args+=(--provenance)

if [ "$PUSH" != "true" ]; then
  echo "==> dry run: npm ${args[*]} --dry-run"
  npm "${args[@]}" --dry-run
  echo "    dry run only — nothing was published"
  exit 0
fi

if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  echo "::error::NPM_TOKEN is not set; cannot publish $NAME@$VERSION"
  exit 1
fi

echo "==> publishing: npm ${args[*]}"
npm "${args[@]}"
echo "==> published $NAME@$VERSION"
