#!/usr/bin/env bash
set -euo pipefail

# Ubuntu CI only. Local builds use the same .swift-version and WASI SDK via
# swiftly; the fixture itself is built by the public @swifttui/build API.
cd "$(dirname "$0")/.."
swift_version="$(tr -d '[:space:]' < .swift-version)"
case "$swift_version" in
  6.4.0) sdk_checksum="f07b7be3c586d92d7a07051fc6d303b87ebea67eadc40640ba59d5a8b79aa86d" ;;
  *) echo "No pinned WASI SDK checksum for Swift $swift_version" >&2; exit 1 ;;
esac

export SWIFTLY_HOME_DIR="$HOME/.local/share/swiftly"
export SWIFTLY_BIN_DIR="$HOME/.local/bin"
export PATH="$SWIFTLY_BIN_DIR:$PATH"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
curl -fsSL "https://download.swift.org/swiftly/linux/swiftly-1.1.4-$(uname -m).tar.gz" \
  -o "$tmpdir/swiftly.tar.gz"
tar -xzf "$tmpdir/swiftly.tar.gz" -C "$tmpdir"
"$tmpdir/swiftly" init --skip-install --quiet-shell-followup --assume-yes
source "$SWIFTLY_HOME_DIR/env.sh"
swiftly install --use --assume-yes "$swift_version"
swiftly run swift --version
swiftly run swift sdk install \
  "https://download.swift.org/swift-${swift_version}-release/wasm-sdk/swift-${swift_version}-RELEASE/swift-${swift_version}-RELEASE_wasm.artifactbundle.tar.gz" \
  --checksum "$sdk_checksum"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$SWIFTLY_BIN_DIR" >> "$GITHUB_PATH"
fi
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "SWIFTLY_HOME_DIR=$SWIFTLY_HOME_DIR" >> "$GITHUB_ENV"
  echo "SWIFTLY_BIN_DIR=$SWIFTLY_BIN_DIR" >> "$GITHUB_ENV"
fi
