#!/usr/bin/env bash
# Fails unless the .deb and the AppImage each carry bb in the same folder as bashboard, which is
# where pty.rs puts the pane PATH and hook_install.rs copies the hook from. Run from the repo root.
set -euo pipefail

bundle=src-tauri/target/release/bundle

deb=$(find "$bundle/deb" -maxdepth 1 -name '*.deb' | head -n 1)
if [ -z "$deb" ]; then
  echo "::error::no .deb under $bundle/deb"
  exit 1
fi
files=$(dpkg-deb -c "$deb" | awk '{print $6}' | sed 's|^\./||')
app=$(grep -E '(^|/)bashboard$' <<<"$files" | head -n 1)
if [ -z "$app" ] || ! grep -qx "$(dirname "$app")/bb" <<<"$files"; then
  echo "::error::$deb does not ship bb beside bashboard"
  echo "$files"
  exit 1
fi
echo "$deb ships $(dirname "$app")/bb"

image=$(find "$bundle/appimage" -maxdepth 1 -name '*.AppImage' | head -n 1)
if [ -z "$image" ]; then
  echo "::error::no AppImage under $bundle/appimage"
  exit 1
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(cd "$work" && "$OLDPWD/$image" --appimage-extract >/dev/null)
if [ ! -x "$work/squashfs-root/usr/bin/bashboard" ] || [ ! -x "$work/squashfs-root/usr/bin/bb" ]; then
  echo "::error::$image does not ship bb beside bashboard in usr/bin"
  ls -la "$work/squashfs-root/usr/bin" || true
  exit 1
fi
echo "$image ships usr/bin/bb"
