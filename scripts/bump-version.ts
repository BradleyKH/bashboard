// Usage: node scripts/bump-version.ts <semver>
// Sets the app version in package.json, src-tauri/Cargo.toml, and the bashboard entry in
// src-tauri/Cargo.lock, then prints the release commands. tauri.conf.json reads package.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const version = process.argv[2];
if (!version || !SEMVER.test(version)) {
  console.error(`Usage: node scripts/bump-version.ts <semver>   (got: ${version ?? "nothing"})`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function edit(rel: string, pattern: RegExp, replacement: string): void {
  const path = join(root, rel);
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) {
    console.error(`Could not find the version line in ${rel}`);
    process.exit(1);
  }
  writeFileSync(path, text.replace(pattern, replacement));
}

edit("package.json", /^(  "version": ")[^"]*(")/m, `$1${version}$2`);
edit("src-tauri/Cargo.toml", /^(\[package\][^[]*?\nversion = ")[^"]*(")/, `$1${version}$2`);
edit(
  "src-tauri/Cargo.lock",
  /(\[\[package\]\]\r?\nname = "bashboard"\r?\nversion = ")[^"]*(")/,
  `$1${version}$2`,
);

console.log(`Version set to ${version}. Next:`);
console.log(`  git commit -am "Release v${version}"`);
console.log(`  git tag v${version}`);
console.log(`  git push origin main v${version}`);
