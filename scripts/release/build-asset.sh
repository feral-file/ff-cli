#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT_DIR="${FF_CLI_OUTPUT_DIR:-$ROOT_DIR/release}"
VERSION="${FF_CLI_VERSION:-$(node -p "require('$ROOT_DIR/package.json').version")}"

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
  Darwin)
    OS="darwin"
    ;;
  Linux)
    OS="linux"
    ;;
  *)
    echo "Unsupported OS: $OS_RAW"
    exit 1
    ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH_RAW"
    exit 1
    ;;
esac

ASSET_NAME="ff-cli-$OS-$ARCH"
ARCHIVE_NAME="$ASSET_NAME.tar.gz"

WORKDIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "Building ff-cli bundle..."
cd "$ROOT_DIR"
npm ci
npm run bundle

PACKAGE_DIR="$WORKDIR/$ASSET_NAME"
mkdir -p "$PACKAGE_DIR/bin" "$PACKAGE_DIR/lib"

cp "$ROOT_DIR/dist/ff-cli.js" "$PACKAGE_DIR/lib/ff-cli.js"
cp "$ROOT_DIR/package.json" "$PACKAGE_DIR/package.json"
cp "$ROOT_DIR/LICENSE" "$PACKAGE_DIR/LICENSE"
# Ship the sample config alongside the bundle so `ff-cli config init` / `setup`
# can seed a config. The installer extracts this to the package root, which the
# CLI resolves via a `<bundle>/lib/../config.json.example` lookup candidate.
cp "$ROOT_DIR/config.json.example" "$PACKAGE_DIR/config.json.example"
# The single-file bundle keeps @napi-rs/keyring external because it loads a
# platform-native .node binary. npm installs only the current platform package,
# so copying this namespace keeps release archives small and functional.
mkdir -p "$PACKAGE_DIR/lib/node_modules"
cp -R "$ROOT_DIR/node_modules/@napi-rs" "$PACKAGE_DIR/lib/node_modules/@napi-rs"

cat > "$PACKAGE_DIR/bin/ff-cli" <<'EOF'
#!/usr/bin/env bash
set -e
# Resolve the launcher through any symlinks before computing the package dir.
# The installer symlinks ~/.local/bin/ff-cli -> ~/.local/ff-cli/bin/ff-cli, and
# without this resolution "$0"'s dir would be ~/.local/bin, making the wrapper
# look for ~/.local/lib/ff-cli.js (wrong) instead of the real lib/ next to it.
SOURCE="${BASH_SOURCE[0]:-$0}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$DIR/$SOURCE" ;;
  esac
done
BASE_DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
APP="$BASE_DIR/lib/ff-cli.js"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install Node.js, then run this command again."
  exit 1
fi
exec node "$APP" "$@"
EOF

chmod +x "$PACKAGE_DIR/bin/ff-cli"

cat > "$PACKAGE_DIR/RUNTIME_REQUIREMENTS.txt" <<'EOF'
Runtime requirement:
- Node.js 22 or newer must be installed and available in PATH.

Verify:
- node -v

Run:
- ./bin/ff-cli --help
EOF

mkdir -p "$OUTPUT_DIR"
tar -czf "$OUTPUT_DIR/$ARCHIVE_NAME" -C "$WORKDIR" "$ASSET_NAME"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUTPUT_DIR" && sha256sum "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$OUTPUT_DIR" && shasum -a 256 "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256")
else
  echo "Missing sha256sum/shasum for checksum generation"
  exit 1
fi

echo "Built $ARCHIVE_NAME (version $VERSION) in $OUTPUT_DIR"
