#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
echo "Publishing @poping/yome@${VERSION} to npm (web auth flow)..."

npm publish --access public --auth-type=web
