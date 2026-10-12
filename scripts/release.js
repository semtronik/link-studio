// Maintainer-only release script.
// Bumps version and builds. Commit, tag, push and GitHub Release are manual.
//
// Usage: node scripts/release.js <version>
// Example: node scripts/release.js 0.3.0

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { platform } from 'os';

const version = process.argv[2];

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

function run(cmd) {
  return execSync(cmd, { stdio: 'inherit' });
}

if (!version) {
  fail('Usage: node scripts/release.js <version>\n       Example: node scripts/release.js 0.3.0');
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`Invalid version "${version}" — expected format x.y.z`);
}

const tag = `v${version}`;

console.log(`\n=== Release ${tag} ===\n`);

// 1. Pre-flight checks
console.log('[1/3] Pre-flight checks...');

if (!existsSync('package.json') || !existsSync('src-tauri/Cargo.toml')) {
  fail('Run this script from the link-studio project root.');
}

// 2. Bump versions
console.log('\n[2/3] Bumping versions...');

const pkgPath = 'package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const oldVersion = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`  package.json:      ${oldVersion} -> ${version}`);

const cargoPath = 'src-tauri/Cargo.toml';
const cargoContent = readFileSync(cargoPath, 'utf-8');
const cargoVersionRegex = /^version\s*=\s*"[^"]+"/m;
if (!cargoVersionRegex.test(cargoContent)) {
  fail('Failed to find version field in Cargo.toml — pattern not matched.');
}
const newCargoContent = cargoContent.replace(cargoVersionRegex, `version = "${version}"`);
writeFileSync(cargoPath, newCargoContent);
console.log(`  Cargo.toml:        ${oldVersion} -> ${version}`);

const tauriConfPath = 'src-tauri/tauri.conf.json';
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
console.log(`  tauri.conf.json:   ${oldVersion} -> ${version}`);

// 3. Build
console.log('\n[3/3] Building (npm run tauri build)...');
console.log('  This may take several minutes.\n');
try {
  run('npm run tauri build');
} catch {
  fail('Build failed. Version files have been updated locally — revert with "git checkout -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json" if needed.');
}

// Summary
const os = platform();
const bundleDir = 'src-tauri/target/release/bundle';
console.log(`\n=== Build ${tag} complete ===\n`);
console.log('Local artifacts:');
if (os === 'win32') {
  console.log(`  ${bundleDir}/nsis/Link Studio_${version}_x64-setup.exe`);
  console.log(`  ${bundleDir}/msi/Link Studio_${version}_x64_en-US.msi`);
} else if (os === 'darwin') {
  console.log(`  ${bundleDir}/dmg/Link Studio_${version}_aarch64.dmg`);
  console.log(`  ${bundleDir}/macos/Link Studio.app`);
} else {
  console.log(`  ${bundleDir}/deb/Link Studio_${version}_amd64.deb`);
  console.log(`  ${bundleDir}/appimage/Link Studio_${version}_amd64.AppImage`);
}
console.log('\nNext steps (manual):');
console.log(`  git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json`);
console.log(`  git commit -m "Release ${tag}"`);
console.log(`  git tag ${tag}`);
console.log(`  git push origin main`);
console.log(`  git push origin ${tag}`);
console.log(`\n  Then create the GitHub Release and upload artifacts:`);
console.log(`  https://github.com/semtronik/link-studio/releases/new?tag=${tag}`);
console.log('');
