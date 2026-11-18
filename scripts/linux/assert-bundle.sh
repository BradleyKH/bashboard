#!/usr/bin/env bash
# Fails unless the .deb and .rpm keep bashboard and bb in /usr/lib/bashboard, with
# /usr/bin/bashboard a symlink and no /usr/bin/bb (where it would collide with Babashka), and the
# AppImage carries bb beside bashboard. pty.rs puts bb's folder on the pane PATH and
# hook_install.rs copies the hook from it (docs/design/app.md section 3.13). It also checks the
# desktop integration: the webkit and gtk dependencies, a desktop file that takes folders without
# claiming them (no MimeType, which would make it a default folder handler), the Dolphin service
# menu and Nemo action that open folders (section 3.18), and a valid hicolor icon set. Run from the repo root after scripts/linux/relayout-packages.sh.
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
  if ! grep -qx 'usr/share/icons/hicolor/256x256/apps/bashboard.png' <<<"$listing"; then
    echo "::error::$1 has no hicolor/256x256/apps/bashboard.png icon"
    echo "$listing"
    exit 1
  fi
  for want in usr/share/kio/servicemenus/bashboard.desktop usr/share/nemo/actions/bashboard.nemo_action; do
    if ! grep -qx "$want" <<<"$listing"; then
      echo "::error::$1 does not ship $want"
      echo "$listing"
      exit 1
    fi
  done
  if grep -q 'hicolor/[^/]*@' <<<"$listing"; then
    echo "::error::$1 ships an invalid hicolor size folder (the @2 kind)"
    grep 'hicolor/[^/]*@' <<<"$listing"
    exit 1
  fi
  echo "$1 ships usr/lib/bashboard/{bashboard,bb}, the folder actions, and a valid icon set"
}

# $1 names the package; stdin is its dependency list, one per line.
check_depends() {
  local deps
  deps=$(cat)
  for want in webkit2gtk 'gtk[-_]\{0,1\}3'; do
    if ! grep -q "$want" <<<"$deps"; then
      echo "::error::$1 does not depend on $want"
      echo "$deps"
      exit 1
    fi
  done
  echo "$1 depends on webkit2gtk and gtk3"
}

# $1 names the package; stdin is its desktop file.
check_desktop() {
  local desktop
  desktop=$(cat)
  for want in 'Exec=bashboard %F' 'Icon=bashboard' 'StartupWMClass=bashboard'; do
    if ! grep -qxF "$want" <<<"$desktop"; then
      echo "::error::$1 desktop file lacks $want"
      echo "$desktop"
      exit 1
    fi
  done
  if grep -q '^MimeType=.*inode/directory' <<<"$desktop"; then
    echo "::error::$1 desktop file claims inode/directory, which makes it a default folder handler"
    echo "$desktop"
    exit 1
  fi
  if ! grep -qE '^Categories=.+;$' <<<"$desktop"; then
    echo "::error::$1 desktop file has an empty Categories"
    echo "$desktop"
    exit 1
  fi
  echo "$1 desktop file takes folders (Exec=bashboard %F) without claiming inode/directory"
}

deb=$(find "$bundle/deb" -maxdepth 1 -name '*.deb' | head -n 1)
if [ -z "$deb" ]; then
  echo "::error::no .deb under $bundle/deb"
  exit 1
fi
dpkg-deb -c "$deb" | awk '{ $1=$2=$3=$4=$5=""; sub(/^ +/, ""); sub(/^\.\//, ""); print }' | check_layout "$deb"
dpkg-deb -f "$deb" Depends | tr ',' '\n' | check_depends "$deb"
dpkg-deb --fsys-tarfile "$deb" | tar -xO --wildcards './usr/share/applications/*.desktop' | check_desktop "$deb"

rpm=$(find "$bundle/rpm" -maxdepth 1 -name '*.rpm' 2>/dev/null | head -n 1)
if [ -z "$rpm" ]; then
  echo "::error::no .rpm under $bundle/rpm"
  exit 1
fi
rpm -qp --qf '[%{FILENAMES}|%{FILELINKTOS}\n]' "$rpm" \
  | awk -F '|' '{ sub(/^\//, "", $1); print ($2 == "" ? $1 : $1 " -> " $2) }' | check_layout "$rpm"
rpm -qpR "$rpm" | check_depends "$rpm"
# Ubuntu 22.04's rpm2cpio exits 1 after writing a whole payload, so the desktop file is the test.
(rpm2cpio "$rpm" 2>/dev/null || true) | cpio -i --to-stdout --quiet './usr/share/applications/*.desktop' 2>/dev/null | check_desktop "$rpm"

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
desktop=$(find "$work/squashfs-root" -maxdepth 1 -name '*.desktop' | head -n 1)
if [ -z "$desktop" ]; then
  echo "::error::$image has no desktop file"
  exit 1
fi
check_desktop "$image" <"$desktop"
