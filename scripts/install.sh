#!/usr/bin/env bash
set -euo pipefail

# archlearn — quick installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/archlearn/archlearn/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/archlearn/archlearn/main/scripts/install.sh | bash -s -- --dir /path/to/project

PROJECT_DIR="."
PROJECT_NAME=""
SHOW_HELP=0

print_help() {
  cat <<'EOF'
archlearn installer

Usage:
  install.sh [--dir <path>] [--name <project-name>] [--help]

Options:
  --dir <path>     Target project directory (default: current directory)
  --name <name>    Project name (default: directory basename)
  --help           Show this help and exit

Behavior:
  1. Verifies node and npx are available.
  2. Runs `npx -y archlearn init` against the target directory.

Set ARCHLEARN_INSTALL_DRY_RUN=1 to print what would run without executing.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --name)
      PROJECT_NAME="$2"
      shift 2
      ;;
    --help|-h)
      SHOW_HELP=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_help >&2
      exit 1
      ;;
  esac
done

if [ "$SHOW_HELP" -eq 1 ]; then
  print_help
  exit 0
fi

echo "==> archlearn installer"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required but was not found in PATH." >&2
  echo "Install Node.js 18+ from https://nodejs.org/ and retry." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm/npx is required but was not found in PATH." >&2
    exit 1
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ is required (found $NODE_MAJOR)." >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR"
ABS_DIR="$(cd "$PROJECT_DIR" && pwd)"
echo "==> Target directory: $ABS_DIR"

CMD=(npx -y archlearn init --dir "$ABS_DIR")
if [ -n "$PROJECT_NAME" ]; then
  CMD+=(--name "$PROJECT_NAME")
fi

echo "==> Running: ${CMD[*]}"

if [ "${ARCHLEARN_INSTALL_DRY_RUN:-0}" = "1" ]; then
  echo "(dry run — not executing)"
  exit 0
fi

"${CMD[@]}"

echo ""
echo "==> Done. Next steps:"
echo "    cd \"$ABS_DIR\""
echo "    npx archlearn serve   # start MCP server + web viewer"
echo "    npx archlearn status  # check architecture health"
