#!/usr/bin/env bash
# Fails unless the built .app carries bb beside bashboard, with every binary built for every
# architecture the target names. Usage: assert-bundle.sh <rust target>, from the repo root.
set -euo pipefail

target=$1
app=$(find "src-tauri/target/$target/release/bundle/macos" -maxdepth 1 -name '*.app' | head -n 1)
if [ ! -x "$app/Contents/MacOS/bb" ]; then
  echo "::error::$app/Contents/MacOS/bb is missing"
  ls -la "$app/Contents/MacOS" || true
  exit 1
fi
file "$app/Contents/MacOS/"*

# A thin bb in a universal bundle would fail on the other architecture yet pass the check above.
case "$target" in
  universal-apple-darwin) want="arm64 x86_64" ;;
  aarch64-apple-darwin) want="arm64" ;;
  x86_64-apple-darwin) want="x86_64" ;;
  *) echo "::error::unknown target $target"; exit 1 ;;
esac
for bin in bashboard bb; do
  have=$(lipo -archs "$app/Contents/MacOS/$bin" | tr ' ' '\n' | sort | xargs)
  if [ "$have" != "$want" ]; then
    echo "::error::$bin has architectures '$have', expected '$want'"
    exit 1
  fi
done
codesign -dv "$app" 2>&1 | head -n 5
