#!/usr/bin/env bash
# Builds bb for both Mac architectures and merges them into the universal path the bundler reads.
# A universal `tauri build` lipos only the main binary, so without this the bundler fails looking
# for target/universal-apple-darwin/release/bb. Pass the same cargo flags the tauri build gets
# (for example --features devtools) so cargo reuses these artifacts there.
# Run from src-tauri/.
set -euo pipefail

for arch in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --release --bin bb --target "$arch" "$@"
done
mkdir -p target/universal-apple-darwin/release
lipo -create -output target/universal-apple-darwin/release/bb \
  target/aarch64-apple-darwin/release/bb target/x86_64-apple-darwin/release/bb
