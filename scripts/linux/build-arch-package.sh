#!/usr/bin/env bash
# Builds the Arch package (bashboard-<version>-1-x86_64.pkg.tar.zst) into
# src-tauri/target/release/bundle/arch from the .rpm, so it has the same layout (docs/design/app.md
# section 3.13). Run from the repo root after scripts/linux/relayout-packages.sh.
#
# On an Arch machine it runs makepkg directly. Elsewhere (CI's Ubuntu 22.04) it runs itself in an
# archlinux:base-devel container, which also lints with namcap, installs the package with pacman
# so its depends must resolve, and fails if the installed binary has a library ldd cannot find.
set -euo pipefail

bundle=src-tauri/target/release/bundle
out="$bundle/arch"
work="$out/build"

# The steps inside the container, as root, with the repo at /src.
in_container() {
  cd /src
  pacman -Syu --noconfirm --needed namcap >/dev/null
  # makepkg refuses root; the host's uid keeps the output owned by the host user.
  useradd -m -u "$HOST_UID" builder 2>/dev/null || useradd -m builder
  chown -R builder "$out"
  su builder -c "cd '$work' && makepkg -d -f --noconfirm"
  pkg=$(find "$work" -maxdepth 1 -name '*.pkg.tar.zst' | head -n 1)

  # namcap reports errors as "E:" and does not fail on them itself.
  lint=$( (namcap "$work/PKGBUILD"; pacman -U --noconfirm "$pkg" >/dev/null && namcap "$pkg") 2>&1)
  echo "$lint"
  if grep -q ' E: ' <<<"$lint"; then
    echo "::error::namcap reported errors for the Arch package"
    exit 1
  fi
  missing=$(ldd /usr/lib/bashboard/bashboard | grep 'not found' || true)
  if [ -n "$missing" ]; then
    echo "::error::the installed Arch package's binary is missing libraries"
    echo "$missing"
    exit 1
  fi
  echo "installed $(basename "$pkg"); every library resolves"
  mv "$pkg" "$out/"
}

if [ "${1:-}" = --in-container ]; then
  in_container
  exit
fi

rpm=$(find "$bundle/rpm" -maxdepth 1 -name '*.rpm' | head -n 1)
if [ -z "$rpm" ]; then
  echo "::error::no .rpm under $bundle/rpm"
  exit 1
fi
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)
rm -rf "$out"
mkdir -p "$work"
# Arch versions cannot contain a hyphen, so a prerelease 1.0.0-beta.1 becomes 1.0.0_beta.1.
sed "s/^pkgver=.*/pkgver=${version//-/_}/" scripts/linux/arch/PKGBUILD >"$work/PKGBUILD"
cp "$rpm" "$work/bashboard.rpm"
cp LICENSE "$work/LICENSE"

if command -v makepkg >/dev/null && [ "$(id -u)" != 0 ]; then
  (cd "$work" && makepkg -d -f --noconfirm)
  mv "$work"/*.pkg.tar.zst "$out/"
else
  docker run --rm -e HOST_UID="$(id -u)" -v "$PWD:/src" archlinux:base-devel \
    bash /src/scripts/linux/build-arch-package.sh --in-container
fi
rm -rf "$work"
ls "$out"/*.pkg.tar.zst
