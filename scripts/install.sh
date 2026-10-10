#!/usr/bin/env bash
set -euo pipefail

# arkive — quick installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/arkive/arkive/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/arkive/arkive/main/scripts/install.sh | bash -s -- --dir /path/to/project

# The published package. This MUST be the fully scoped name.
#
# A `curl | bash` installer that runs `npx -y <name>` resolves whatever
# `<name>` points at on the public registry. An unscoped `arkive` is not this
# package, and a registry takeover of that name — or a typo, or a homoglyph —
# would run an attacker's code as the user, with the user's credentials, from a
# command the user believed was arkive's installer. The scoped name is the only
# thing tying the resolution to this project.
# See docs/adr/0006-data-integrity-is-a-product-feature.md.
ARKIVE_PACKAGE="@ericjdz/arkive"

PROJECT_DIR="."
PROJECT_NAME=""
DRY_RUN=0
SHOW_HELP=0

print_help() {
  cat <<EOF
arkive installer

Usage:
  install.sh [--dir <path>] [--name <project-name>] [--dry-run] [--help]

Options:
  --dir <path>     Target project directory (default: current directory)
  --name <name>    Project name (default: directory basename)
  --dry-run        Print the full plan of what \`arkive init\` would write,
                   and write nothing
  --help           Show this help and exit

Behavior:
  1. Verifies node and npx are available.
  2. Runs \`npx -y ${ARKIVE_PACKAGE} init\` against the target directory.

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
    --dry-run)
      DRY_RUN=1
      shift
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

echo "==> arkive installer"

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

# Refuse to run when a document already lives at a path arkive no longer reads.
# Running init would otherwise scaffold an empty document beside the real one,
# which is how commit 62066bc destroyed four recorded decisions. See ADR-0006.
LEGACY_DOC="$PROJECT_DIR/architecture.json"
if [ -f "$LEGACY_DOC" ]; then
  cat >&2 <<EOF

ERROR: an architecture document exists at $LEGACY_DOC

  arkive reads $PROJECT_DIR/arkive/architecture.json. Writing a new one
  would leave your real document orphaned at the old path, which is exactly the
  failure that destroyed four recorded decisions in this repository.

  Nothing has been written. Move it yourself, keep a copy until you have
  confirmed the move, then re-run:

    cp "$LEGACY_DOC" "$LEGACY_DOC.bak"
    mv "$LEGACY_DOC" "$PROJECT_DIR/arkive/architecture.json"

EOF
  exit 1
fi

mkdir -p "$PROJECT_DIR"
ABS_DIR="$(cd "$PROJECT_DIR" && pwd)"
echo "==> Target directory: $ABS_DIR"

CMD=(npx -y "$ARKIVE_PACKAGE" init --dir "$ABS_DIR")
if [ -n "$PROJECT_NAME" ]; then
  CMD+=(--name "$PROJECT_NAME")
fi
if [ "$DRY_RUN" -eq 1 ]; then
  CMD+=(--dry-run)
fi

echo "==> Running: ${CMD[*]}"

if [ "${ARCHLEARN_INSTALL_DRY_RUN:-0}" = "1" ]; then
  echo "(dry run — not executing)"
  exit 0
fi

# `--dry-run` still executes: arkive's own dry run prints the complete plan and
# writes nothing, so the user gets the real plan rather than this script's guess
# at one.
"${CMD[@]}"

echo ""
echo "==> Done. Next steps:"
echo "    cd \"$ABS_DIR\""
echo "    npx ${ARKIVE_PACKAGE} serve   # start MCP server + web viewer"
echo "    npx ${ARKIVE_PACKAGE} status  # check architecture health"
