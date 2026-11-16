#!/usr/bin/env bash
# Fails unless the .deb and .rpm keep bashboard and bb in /usr/lib/bashboard, with
# /usr/bin/bashboard a symlink and no /usr/bin/bb (where it would collide with Babashka), and the
# AppImage carries bb beside bashboard. pty.rs puts bb's folder on the pane PATH and
# hook_install.rs copies the hook from it (docs/design/app.md section 3.13). Run from the repo
# root after scripts/linux/relayout-packages.sh.
set -euo pipefail

bundle=src-tauri/target/release/bundle

# $1 names the package; stdin is its listing, one "<path> -> <target>" or "<path>" per line.
check_layout() {
  local listing
  listing=$(cat)
  for want in usr/lib/bashboard/bashboard usr/lib/bashboard/bb; do
    if ! grep -qx "$want" <<<"$listing"; then
      echo "::error::$1 does not ship $want"
      echo "$listing"
      exit 1
    fi
  done
  if ! grep -qx 'usr/bin/bashboard -> ../lib/bashboard/bashboard' <<<"$listing"; then
    echo "::error::$1 has no usr/bin/bashboard symlink to ../lib/bashboard/bashboard"
    echo "$listing"
    exit 1
  fi
  if grep -qE '^usr/bin/bb( |$)' <<<"$listing"; then
    echo "::error::$1 puts bb in usr/bin"
    exit 1
  fi
  echo "$1 ships usr/lib/bashboard/{bashboard,bb}"
}

deb=$(find "$bundle/deb" -maxdepth 1 -name '*.deb' | head -n 1)
if [ -z "$deb" ]; then
  echo "::error::no .deb under $bundle/deb"
  exit 1
fi
dpkg-deb -c "$deb" | awk '{ $1=$2=$3=$4=$5=""; sub(/^ +/, ""); sub(/^\.\//, ""); print }' | check_layout "$deb"

rpm=$(find "$bundle/rpm" -maxdepth 1 -name '*.rpm' 2>/dev/null | head -n 1)
if [ -z "$rpm" ]; then
  echo "::error::no .rpm under $bundle/rpm"
  exit 1
fi
rpm -qp --qf '[%{FILENAMES}|%{FILELINKTOS}\n]' "$rpm" \
  | awk -F '|' '{ sub(/^\//, "", $1); print ($2 == "" ? $1 : $1 " -> " $2) }' | check_layout "$rpm"

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
