#!/usr/bin/env bash
#
# Deploy the collector to Fly with its commit SHA baked in.
#
# `fly deploy` on its own produces an image whose sessions record
# git_commit_sha = NULL: .dockerignore excludes .git, so the working-tree
# fallback in gitCommitSha() has nothing to read. Losing that link means a
# window of the dataset cannot be tied to the code that produced it, which is
# exactly what you need after a parsing or reconstruction change lands
# mid-collection. So the SHA is passed in as a build argument here.
#
# A dirty tree is deployed but MARKED, because "-dirty" is an honest claim and
# a bare SHA would not be.
set -euo pipefail

cd "$(dirname "$0")/.."

sha="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  sha="${sha}-dirty"
  echo "warning: working tree is dirty; deploying as ${sha}" >&2
fi

echo "deploying ${sha}"
exec fly deploy --build-arg "GIT_COMMIT_SHA=${sha}" "$@"
