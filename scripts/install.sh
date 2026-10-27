#!/usr/bin/env bash
# ff-cli installer, served at https://feralfile.com/ff-cli-install.
#
# Installs the @feralfile/cli npm package into a user-owned prefix, so it needs
# neither sudo nor a writable global npm prefix. Releases ship through npm only
# (release.yml publishes no prebuilt binaries), so this script installs from npm
# and needs Node.js 22 or newer.
#
# Environment overrides:
#   FF_CLI_VERSION      version to install (default: latest)
#   FF_CLI_INSTALL_DIR  npm prefix to install into (default: ~/.local/ff-cli)
#   FF_CLI_BIN_DIR      where the ff-cli link goes (default: ~/.local/bin)
set -euo pipefail

PACKAGE="@feralfile/cli"
MIN_NODE_MAJOR=22
INSTALL_DIR="${FF_CLI_INSTALL_DIR:-$HOME/.local/ff-cli}"
BIN_DIR="${FF_CLI_BIN_DIR:-$HOME/.local/bin}"
VERSION="${FF_CLI_VERSION:-latest}"

fail() {
  echo "ff-cli installer: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 ||
  fail "Node.js ${MIN_NODE_MAJOR} or newer is required and was not found. Install it from https://nodejs.org, then re-run this installer."
command -v npm >/dev/null 2>&1 ||
  fail "npm is required and was not found. It ships with Node.js: https://nodejs.org"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] ||
  fail "Node.js ${MIN_NODE_MAJOR} or newer is required; found $(node --version). Upgrade Node, then re-run this installer."

echo "Installing ${PACKAGE}@${VERSION} into ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
npm install --prefix "$INSTALL_DIR" --no-audit --no-fund --loglevel=error "${PACKAGE}@${VERSION}"
ln -sf "$INSTALL_DIR/node_modules/.bin/ff-cli" "$BIN_DIR/ff-cli"

INSTALLED="$("$BIN_DIR/ff-cli" --version)" || fail "installed, but ${BIN_DIR}/ff-cli does not run"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    FOUND="$(command -v ff-cli || true)"
    if [ -n "$FOUND" ] && [ "$FOUND" != "$BIN_DIR/ff-cli" ]; then
      echo "ff-cli ${INSTALLED} installed to ${BIN_DIR}/ff-cli, but ${FOUND} comes first on your PATH."
      echo "Remove that one, or run ${BIN_DIR}/ff-cli directly."
    else
      echo "ff-cli ${INSTALLED} installed. Run: ff-cli --help"
    fi
    ;;
  *)
    echo "ff-cli ${INSTALLED} installed to ${BIN_DIR}/ff-cli, which is not on your PATH."
    echo "Add this to your shell profile: export PATH=\"${BIN_DIR}:\$PATH\""
    echo "Or run it directly: ${BIN_DIR}/ff-cli --help"
    ;;
esac
