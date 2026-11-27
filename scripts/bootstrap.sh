#!/usr/bin/env bash
# One-command entry point for macOS/Linux.
# Installs Bun only with your confirmation, then delegates to scripts/cli.ts.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is not installed. It is the only runtime this project needs."
  echo 'Install command: curl -fsSL https://bun.com/install | bash'
  read -r -p "Run that now? [y/N] " answer
  case "$answer" in
    [yY]*)
      curl -fsSL https://bun.com/install | bash
      export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
      export PATH="$BUN_INSTALL/bin:$PATH"
      ;;
    *)
      echo "Install Bun with the command above, then re-run this script."
      exit 1
      ;;
  esac
fi

exec bun "$ROOT/scripts/cli.ts" "$@"
