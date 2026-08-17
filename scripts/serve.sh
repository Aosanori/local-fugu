#!/usr/bin/env bash
# Start the fusion gateway. Resolves bun without needing a global mise version.
set -euo pipefail

cd "$(dirname "$0")/.."

BUN="$(command -v bun || true)"
if [ -z "$BUN" ] || ! "$BUN" --version >/dev/null 2>&1; then
  BUN="$(ls -d "$HOME"/.local/share/mise/installs/bun/*/bin/bun 2>/dev/null | sort -V | tail -1)"
fi
[ -x "$BUN" ] || { echo "bun not found"; exit 1; }

exec "$BUN" run src/server.ts
