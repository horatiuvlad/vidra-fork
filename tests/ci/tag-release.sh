#!/usr/bin/env bash
# Tag the commit a release was published from, as v<version.json>.
#
# Called by both release workflows after a successful publish. Either one can
# run first, or alone, or both at once, so finding the tag already on this
# commit is the ordinary case and not an error. Finding it on a *different*
# commit is: two publishes of one version from two trees is exactly the thing
# the tag exists to make visible.
set -euo pipefail

VERSION="$(node -p "require('./version.json').version")"
TAG="v$VERSION"
HEAD_SHA="$(git rev-parse HEAD)"

# `git ls-remote` reports an annotated tag by its *tag object* sha; the commit it
# points at is the peeled `^{}` entry, and asking for `refs/tags/<tag>` by pattern
# filters that entry out. Read the peeled one, or the comparison below can never
# match and the second workflow to publish fails on a tag it should accept.
remote_commit() {
  git ls-remote --tags origin |
    awk -v t="refs/tags/$TAG" '$2 == t "^{}" { peeled = $1 } $2 == t { plain = $1 } END { print (peeled != "" ? peeled : plain) }'
}

existing="$(remote_commit)"

if [ -z "$existing" ]; then
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git tag -a "$TAG" -m "$TAG"
  if git push origin "refs/tags/$TAG"; then
    echo "==> tagged $TAG at $HEAD_SHA"
    exit 0
  fi
  echo "==> lost the tag push race, re-reading"
  existing="$(remote_commit)"
fi

if [ "$existing" = "$HEAD_SHA" ]; then
  echo "==> $TAG already points at this commit"
  exit 0
fi

echo "::error::$TAG already exists on origin at $existing, but this release is $HEAD_SHA"
exit 1
