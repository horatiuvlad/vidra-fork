#!/usr/bin/env bash
# Tag the commit a release was published from, as v<version.json>.
#
# Called by both release workflows after a successful publish. Either one can
# run first, or alone, so finding the tag already on this commit is the ordinary
# case and not an error. Finding it on a *different* commit is: two publishes of
# one version from two trees is exactly the thing the tag exists to make visible.
set -euo pipefail

VERSION="$(node -p "require('./version.json').version")"
TAG="v$VERSION"

existing="$(git ls-remote --tags origin "refs/tags/$TAG" | cut -f1)"
if [ -n "$existing" ]; then
  if [ "$existing" = "$(git rev-parse HEAD)" ]; then
    echo "==> $TAG already points at this commit"
    exit 0
  fi
  echo "::error::$TAG already exists on origin at $existing, but this release is $(git rev-parse HEAD)"
  exit 1
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
echo "==> tagged $TAG at $(git rev-parse HEAD)"
