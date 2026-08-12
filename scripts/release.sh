#!/usr/bin/env bash
# Commit, build (multi-arch), and publish a new claudeweb release.
#
# Usage:
#   scripts/release.sh "Description of what changed"
#
# The description is used as the commit message (if there are staged/unstaged
# changes to commit) and as the GitHub release notes. Always pass something
# specific — it ends up in git history and the release page.
set -euo pipefail

cd "$(dirname "$0")/.."

DESCRIPTION="${1:-}"
if [[ -z "$DESCRIPTION" ]]; then
  echo "Usage: $0 \"description of the changes\"" >&2
  exit 1
fi

REMOTE_IMAGE="ghcr.io/deputynl/claudeweb"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "==> Committing changes"
  git add -A
  git commit -m "$DESCRIPTION"
else
  echo "==> No local changes to commit, skipping"
fi

echo "==> Pushing to origin main"
git push origin main

echo "==> Building and pushing multi-arch image"
docker buildx use multiarch-builder

TAG=$(date -u +%Y%m%d%H%M%S)
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg CACHEBUST=$(date +%s) \
  -t "$REMOTE_IMAGE:latest" \
  -t "$REMOTE_IMAGE:$TAG" \
  --push .

echo "==> Tagging release $TAG"
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"

echo "==> Creating GitHub release"
gh release create "$TAG" --title "$TAG" --notes "$(cat <<EOF
$DESCRIPTION

Image: \`$REMOTE_IMAGE:$TAG\` (also tagged \`:latest\`)
Platforms: linux/amd64, linux/arm64
EOF
)"

echo "==> Done: $TAG"
