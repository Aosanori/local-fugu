#!/usr/bin/env bash
# Terminal MAGI console. Resolves bun the same way serve.sh does, because the
# mise shim errors out when no global bun version is set.
set -euo pipefail

cd "$(dirname "$0")/.."

BUN="$(command -v bun || true)"
if [ -z "$BUN" ] || ! "$BUN" --version >/dev/null 2>&1; then
  BUN="$(ls -d "$HOME"/.local/share/mise/installs/bun/*/bin/bun 2>/dev/null | sort -V | tail -1)"
fi
[ -x "$BUN" ] || { echo "bun not found"; exit 1; }

exec "$BUN" run scripts/magi.ts
