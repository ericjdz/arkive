#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Cleaning previous build"
rm -rf dist src/viewer/dist

echo "==> Building CLI + server + library (tsup)"
npx tsup

echo "==> Building viewer (Vite)"
if [ -f "src/viewer/vite.config.ts" ]; then
  npx vite build --config src/viewer/vite.config.ts
else
  echo "    (skipping — viewer/vite.config.ts not present yet)"
fi

echo "==> Copying viewer dist into package dist"
if [ -d "src/viewer/dist" ]; then
  mkdir -p dist/viewer
  cp -R src/viewer/dist/. dist/viewer/
fi

echo "==> Ensuring CLI entry is executable"
if [ -f "dist/cli/index.js" ]; then
  chmod +x dist/cli/index.js
fi

echo "==> Build complete"
ls -la dist
