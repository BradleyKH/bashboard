#!/usr/bin/env bash
# Rewrites the .deb and .rpm `pnpm tauri build --bundles deb,rpm` made into the layout
# docs/design/app.md section 3.13 describes:
#
#   /usr/lib/bashboard/bashboard   the app
#   /usr/lib/bashboard/bb          the pane CLI, on no PATH but a pane's
#   /usr/bin/bashboard             symlink to the app
#
# Tauri's bundler puts every Cargo bin in /usr/bin, where bb collides with Babashka, and its
# deb and rpm options can only add files. Each package is rebuilt from its own payload, never
# one from the other: the bundler patches the binary with the package type for the updater
# (`bundle_type()`), so the .deb's and the .rpm's binaries differ. Run from the repo root after
# the build; it replaces both packages in place. Needs dpkg-deb, rpm2cpio, cpio, and rpmbuild.
set -euo pipefail

bundle=src-tauri/target/release/bundle
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Moves usr/bin/{bashboard,bb} under $1 into usr/lib/bashboard and links the app back. The
# bundler copies icons with the build machine's modes (0777 in the .rpm), so data files are
# made 0644.
relayout() {
  mkdir -p "$1/usr/lib/bashboard"
  mv "$1/usr/bin/bashboard" "$1/usr/bin/bb" "$1/usr/lib/bashboard/"
  ln -s ../lib/bashboard/bashboard "$1/usr/bin/bashboard"
  find "$1/usr/share" -type f -exec chmod 0644 {} +
}

find_one() {
  local found
  found=$(find "$bundle/$1" -maxdepth 1 -name "*.$1" | head -n 1)
  if [ -z "$found" ]; then
    echo "::error::no .$1 under $bundle/$1" >&2
    exit 1
  fi
  echo "$found"
}

deb=$(find_one deb)
root="$work/deb"
dpkg-deb -R "$deb" "$root"
if [ -L "$root/usr/bin/bashboard" ]; then
  echo "$deb already has the /usr/lib/bashboard layout"
else
  relayout "$root"
  if [ -f "$root/DEBIAN/md5sums" ]; then
    (cd "$root" && find . -path ./DEBIAN -prune -o -type f -printf '%P\0' | sort -z | xargs -0 md5sum) \
      >"$root/DEBIAN/md5sums"
  fi
  dpkg-deb --root-owner-group -Zxz -b "$root" "$deb" >/dev/null
  echo "rewrote $deb"
fi

rpm=$(find_one rpm)
rpm_abs=$(realpath "$rpm")
payload="$work/rpm"
mkdir -p "$payload"
# Ubuntu 22.04's rpm2cpio exits 1 after writing a whole payload, so the extracted app is the test.
rpm2cpio "$rpm_abs" >"$work/payload.cpio" || true
(cd "$payload" && cpio -idm --quiet <"$work/payload.cpio")
if [ ! -e "$payload/usr/bin/bashboard" ]; then
  echo "::error::could not extract $rpm"
  exit 1
fi
if [ -L "$payload/usr/bin/bashboard" ]; then
  echo "$rpm already has the /usr/lib/bashboard layout"
  exit 0
fi
relayout "$payload"

q() { rpm -qp --qf "%{$1}" "$rpm" 2>/dev/null; }
arch=$(q ARCH)
# Tauri's declarations are sonames (libwebkit2gtk-4.1.so.0()(64bit)), which every rpm distro
# resolves whatever it names the package; AutoReq stays off so the list is exactly these.
requires=$(rpm -qp --requires "$rpm" 2>/dev/null | grep -v '^rpmlib(' | sed 's/^/Requires: /')
files=$(cd "$payload" && find . -mindepth 1 \( -type f -o -type l \) -printf '"/%P"\n' | sort)

mkdir -p "$work/rpmbuild/SPECS"
spec="$work/rpmbuild/SPECS/$(q NAME).spec"
cat >"$spec" <<EOF
# The binaries are already stripped and carry no debug info to split out.
%global debug_package %{nil}
%global __os_install_post %{nil}
%define _build_id_links none

Name: $(q NAME)
Version: $(q VERSION)
Release: $(q RELEASE)
Summary: $(q SUMMARY)
License: $(q LICENSE)
URL: $(q URL)
BuildArch: $arch
AutoReqProv: no
$requires

%description
$(q DESCRIPTION)

%install
mkdir -p %{buildroot}
cp -a "$payload/." %{buildroot}/

%files
%defattr(-,root,root,-)
%dir /usr/lib/bashboard
$files
EOF

rpmbuild -bb --quiet --define "_topdir $work/rpmbuild" "$spec"
cp "$work"/rpmbuild/RPMS/"$arch"/*.rpm "$rpm"
echo "rewrote $rpm"
