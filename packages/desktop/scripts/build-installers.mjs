#!/usr/bin/env node
/**
 * build-installers.mjs — Phase 4.2.8
 *
 * Produces signed AccrualFlow Edge desktop artifacts with
 * `@electron/packager` (electron-builder's 7zip/AppImage toolchain is not
 * usable in our build environment), then emits a channel manifest that the
 * in-app updater (`electron/updater.cjs`) consumes.
 *
 * Usage:
 *   node scripts/build-installers.mjs --target=win|mac|linux|all [--arch=x64|arm64]
 *
 * Signing credentials are read from the environment. NOTHING is invented
 * here: when a credential is absent the corresponding artifact is built
 * UNSIGNED and the script prints exactly which variable to set.
 *
 *   Windows  CSC_LINK              path to .pfx (or base64 of it)
 *            CSC_KEY_PASSWORD      .pfx password
 *   macOS    CSC_NAME              "Developer ID Application: … (TEAMID)"
 *            APPLE_ID              notarization Apple ID
 *            APPLE_APP_PASSWORD    app-specific password
 *            APPLE_TEAM_ID         team id
 *   Channel  EDGE_UPDATE_BASE_URL  https base for published artifacts
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, '..');
const OUT_DIR = join(PKG_DIR, 'release');
const DIST_DIR = join(PKG_DIR, 'dist-desktop');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const TARGETS = { win: 'win32', mac: 'darwin', linux: 'linux' };
const target = (args.target ?? 'all').toLowerCase();
const selected = target === 'all' ? Object.keys(TARGETS) : [target];
for (const t of selected) {
  if (!TARGETS[t]) { console.error(`✗ unknown --target=${t} (win|mac|linux|all)`); process.exit(1); }
}
const arch = args.arch ?? process.arch;

const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8'));
const version = pkg.version;

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((res, rej) => {
    console.log(`\n▶ ${cmd} ${cmdArgs.join(' ')}`);
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit', cwd: PKG_DIR, env: process.env, ...opts });
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    child.on('error', rej);
  });
}

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
  });
}

/** Signing flags for @electron/packager, plus a warning when unsigned. */
function signingArgs(platform) {
  const flags = [];
  if (platform === 'win32') {
    if (process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD) {
      flags.push(`--windows-sign.certificateFile=${process.env.CSC_LINK}`);
      flags.push(`--windows-sign.certificatePassword=${process.env.CSC_KEY_PASSWORD}`);
    } else {
      console.warn('⚠ Windows artifact will be UNSIGNED — set CSC_LINK and CSC_KEY_PASSWORD to sign.');
    }
  }
  if (platform === 'darwin') {
    if (process.env.CSC_NAME) {
      flags.push('--osx-sign.identity=' + process.env.CSC_NAME);
      flags.push('--osx-sign.hardenedRuntime=true');
      flags.push('--osx-sign.gatekeeperAssess=false');
    } else {
      console.warn('⚠ macOS artifact will be UNSIGNED — set CSC_NAME to sign.');
    }
    if (process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD && process.env.APPLE_TEAM_ID) {
      flags.push(`--osx-notarize.appleId=${process.env.APPLE_ID}`);
      flags.push(`--osx-notarize.appleIdPassword=${process.env.APPLE_APP_PASSWORD}`);
      flags.push(`--osx-notarize.teamId=${process.env.APPLE_TEAM_ID}`);
    } else {
      console.warn('⚠ macOS artifact will NOT be notarized — set APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID.');
    }
  }
  return flags;
}

async function packageFor(key) {
  const platform = TARGETS[key];
  // The Edge runtime + service installer must ship inside the app; without
  // it the tray app reports `agent_not_bundled` / `installer_not_bundled`.
  const AGENT_DIR = resolve(PKG_DIR, '..', '..', 'agent');
  if (!existsSync(join(AGENT_DIR, 'dist', 'index.js'))) {
    await run('npm', ['--prefix', AGENT_DIR, 'install', '--no-audit', '--no-fund']);
    await run('npm', ['--prefix', AGENT_DIR, 'run', 'build']);
  }
  await run('npx', [
    '@electron/packager', '.', 'AccrualFlowEdge',
    `--platform=${platform}`, `--arch=${arch}`,
    `--app-version=${version}`,
    `--out=${OUT_DIR}`, '--overwrite',
    `--extra-resource=${AGENT_DIR}`,
    "--ignore=^/src", "--ignore=^/release", "--ignore=^/dist-desktop", "--ignore=^/scripts",
    ...signingArgs(platform),
  ]);
  const dir = join(OUT_DIR, `AccrualFlowEdge-${platform}-${arch}`);
  if (!existsSync(dir)) throw new Error(`packager produced no output at ${dir}`);

  mkdirSync(DIST_DIR, { recursive: true });
  const archiveName = `AccrualFlowEdge-${version}-${key}-${arch}.${platform === 'linux' ? 'tar.gz' : 'zip'}`;
  const archive = join(DIST_DIR, archiveName);
  if (platform === 'linux') {
    await run('tar', ['czf', archive, '-C', OUT_DIR, `AccrualFlowEdge-${platform}-${arch}`]);
  } else {
    await run('zip', ['-qry', archive, `AccrualFlowEdge-${platform}-${arch}`], { cwd: OUT_DIR });
  }
  return {
    key: `${platform}-${arch}`,
    file: archiveName,
    bytes: statSync(archive).size,
    sha256: await sha256(archive),
  };
}

const artifacts = {};
for (const key of selected) {
  const a = await packageFor(key);
  artifacts[a.key] = {
    url: `${(process.env.EDGE_UPDATE_BASE_URL ?? 'https://updates.accrualflow.app/edge').replace(/\/$/, '')}/${version}/${a.file}`,
    sha256: a.sha256,
    bytes: a.bytes,
  };
}

const manifest = {
  channel: args.channel ?? 'stable',
  version,
  pub_date: new Date().toISOString(),
  // Staged rollout: start narrow, widen by re-publishing this file.
  rollout: args.rollout ? Number(args.rollout) : 0.1,
  notes: args.notes ?? `AccrualFlow Edge ${version}`,
  artifacts,
};
const manifestPath = join(DIST_DIR, `${manifest.channel}.json`);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`\n✓ artifacts in ${DIST_DIR}`);
for (const f of readdirSync(DIST_DIR)) console.log(`  · ${f}`);
console.log(`\n✓ channel manifest: ${manifestPath}`);
console.log('  Publish it at the URL the agent checks (EDGE_UPDATE_URL) to release.');
