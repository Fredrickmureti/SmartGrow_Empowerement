#!/usr/bin/env node
/**
 * package-electron.mjs
 *
 * Cross-platform Electron packaging driver.
 *
 * Usage:
 *   node scripts/package-electron.mjs --target=win|mac|linux|all [--arch=x64|arm64] [--publish=never|always]
 *
 * Steps:
 *   1. Build the Vite web bundle (with ELECTRON_BUILD=1 → relative base path).
 *   2. Compile electron/*.ts → electron/*.js via tsc.
 *   3. Ensure electron/ deps are installed (native modules: better-sqlite3, serialport, usb).
 *   4. Run electron-builder for the requested platform target(s).
 *   5. Copy resulting installers from electron/release/ → dist-desktop/ with
 *      friendly names like AccrualFlow-Setup-1.0.0-win-x64.exe.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ELECTRON_DIR = join(ROOT, "electron");
const RELEASE_DIR = join(ELECTRON_DIR, "release");
const OUT_DIR = join(ROOT, "dist-desktop");

// ── arg parsing ────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const target = (args.target ?? "all").toLowerCase();
const arch = args.arch ?? null;
const publish = args.publish ?? "never";

const TARGETS = ["win", "mac", "linux"];
const selected = target === "all" ? TARGETS : [target];
for (const t of selected) {
  if (!TARGETS.includes(t)) {
    console.error(`✗ Unknown --target=${t}. Use win|mac|linux|all.`);
    process.exit(1);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    console.log(`\n▶ ${cmd} ${cmdArgs.join(" ")}  (cwd=${opts.cwd ?? ROOT})`);
    const child = spawn(cmd, cmdArgs, {
      stdio: "inherit",
      shell: process.platform === "win32",
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    child.on("exit", (code) =>
      code === 0 ? resolveP() : rejectP(new Error(`${cmd} exited with ${code}`)),
    );
    child.on("error", rejectP);
  });
}

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(ELECTRON_DIR, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

// ── build steps ────────────────────────────────────────────────────────────
async function buildWeb() {
  console.log("\n══ 1/4 Build web bundle (vite) ══");
  await run("npx", ["vite", "build"], { env: { ELECTRON_BUILD: "1" } });
  // Assert relative asset base — `file://` deployment can only load
  // ./assets/* paths. If we see `/assets/`, the ELECTRON_BUILD env
  // didn't take effect and the packaged app will white-screen.
  const indexPath = join(ROOT, "dist", "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`dist/index.html missing after vite build — packaging aborted`);
  }
  const html = readFileSync(indexPath, "utf8");
  if (/(src|href)=["']\/assets\//.test(html)) {
    throw new Error(
      'dist/index.html references absolute "/assets/..." paths. The Vite build ran without ' +
        "ELECTRON_BUILD=1 (base must be './'). Aborting — the packaged app would white-screen.",
    );
  }
  console.log("  ✓ dist/index.html uses relative asset paths");
}

async function buildMain() {
  console.log("\n══ 2/4 Compile electron main process (tsc) ══");
  await run("npx", ["tsc", "-p", "tsconfig.json"], { cwd: ELECTRON_DIR });
}

async function ensureElectronDeps() {
  console.log("\n══ 3/4 Ensure electron/ dependencies ══");
  if (!existsSync(join(ELECTRON_DIR, "node_modules"))) {
    await run("npm", ["install"], { cwd: ELECTRON_DIR });
  } else {
    console.log("  ✓ electron/node_modules present — skipping install");
  }
}

async function packageFor(platform) {
  console.log(`\n══ 4/4 electron-builder → ${platform} ══`);
  const flags = [`--${platform}`, `--publish=${publish}`];
  if (arch) flags.push(`--${arch}`);
  await run("npx", ["electron-builder", ...flags], { cwd: ELECTRON_DIR });
}

function collectArtifacts() {
  if (!existsSync(RELEASE_DIR)) return [];
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const v = pkgVersion();
  const installerExts = new Set([".exe", ".dmg", ".zip", ".AppImage", ".deb", ".rpm", ".msi"]);
  const out = [];
  for (const f of readdirSync(RELEASE_DIR)) {
    const ext = extname(f);
    if (!installerExts.has(ext)) continue;
    const dest = join(OUT_DIR, f);
    copyFileSync(join(RELEASE_DIR, f), dest);
    out.push(dest);
  }
  console.log(`\n📦 Copied ${out.length} installer(s) → ${OUT_DIR}`);
  for (const f of out) console.log(`   • ${basename(f)}`);
  console.log(`   (version ${v})`);
  return out;
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    await buildWeb();
    await buildMain();
    await ensureElectronDeps();
    for (const t of selected) {
      await packageFor(t);
    }
    collectArtifacts();
    console.log("\n✓ Done.\n");
  } catch (err) {
    console.error(`\n✗ Packaging failed: ${err.message}\n`);
    process.exit(1);
  }
})();
