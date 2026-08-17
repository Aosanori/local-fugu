#!/usr/bin/env bash
# magi, straight from a checkout. Resolves bun the same way a Homebrew stub
# would, because the mise shim errors out when no global bun version is set.
set -euo pipefail

# Follow symlinks back to the checkout, so this works when linked onto PATH
# as `magi` from anywhere.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [ "${SOURCE#/}" = "$SOURCE" ] && SOURCE="$DIR/$SOURCE"
done
cd "$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

BUN="$(command -v bun || true)"
if [ -z "$BUN" ] || ! "$BUN" --version >/dev/null 2>&1; then
  BUN="$(ls -d "$HOME"/.local/share/mise/installs/bun/*/bin/bun 2>/dev/null | sort -V | tail -1)"
fi
[ -x "$BUN" ] || { echo "bun not found"; exit 1; }

exec "$BUN" run src/cli.ts "$@"
