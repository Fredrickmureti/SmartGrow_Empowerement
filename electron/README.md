# AccrualFlow Desktop (Electron)

The desktop build wraps the web app in an Electron shell so it can talk to local hardware (USB/serial thermal printers, cash drawers, scales) and run fully offline via the embedded SQLite cache.

## Quick start

From the **project root**:

```bash
# 1. Install root deps (once)
bun install

# 2. Install Electron deps (once, includes native modules)
cd electron && npm install && cd ..

# 3. Run in dev mode (Vite + Electron with hot reload)
bun run desktop:dev
```

## Packaging installers

One command per platform — output lands in `dist-desktop/`:

```bash
bun run desktop:package:win     # → AccrualFlow Setup *.exe + portable.exe
bun run desktop:package:mac     # → AccrualFlow-*.dmg + .zip
bun run desktop:package:linux   # → AccrualFlow-*.AppImage + .deb
bun run desktop:package         # all three (only works on a CI matrix)
```

Each command:
1. Builds the web bundle with `ELECTRON_BUILD=1` (relative `base: './'` for `file://`).
2. Compiles `electron/*.ts` → `*.js`.
3. Ensures native modules are installed.
4. Runs `electron-builder` for the requested OS.
5. Copies installers to `dist-desktop/`.

Optional flags (pass through the `node scripts/package-electron.mjs` driver):

```bash
node scripts/package-electron.mjs --target=mac --arch=arm64
node scripts/package-electron.mjs --target=win --publish=always
```

## Cross-compilation caveats

| Host OS | Can build for                        | Notes                                       |
| ------- | ------------------------------------ | ------------------------------------------- |
| Linux   | Linux, Windows (with wine optional)  | macOS .dmg cannot be produced from Linux.   |
| macOS   | macOS, Linux, Windows                | Best host for full-matrix builds.           |
| Windows | Windows, Linux                       | macOS builds not possible.                  |

For reliable releases, use a CI matrix (GitHub Actions `ubuntu-latest` + `macos-latest` + `windows-latest`).

## Native modules

`better-sqlite3-multiple-ciphers`, `serialport`, and `usb` are native — they need to be rebuilt against Electron's Node ABI:

```bash
bun run desktop:rebuild
```

`electron-builder` runs this automatically during packaging, but if `desktop:dev` complains about ABI mismatch, run it manually.

## Code signing & notarization (optional)

The build picks up env vars when present and silently skips otherwise:

| Variable                       | Purpose                          |
| ------------------------------ | -------------------------------- |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Windows / macOS code-signing cert |
| `APPLE_ID`                     | macOS notarization Apple ID       |
| `APPLE_APP_SPECIFIC_PASSWORD`  | App-specific password             |
| `APPLE_TEAM_ID`                | Apple Developer team ID           |

Without signing: Windows shows a SmartScreen warning on first launch; macOS users must right-click → Open the first time.

## Troubleshooting

- **Blank white window after packaging** → `vite.config.ts` must have `base: './'` when `ELECTRON_BUILD=1` (already wired).
- **`__dirname is not defined`** → main entry must stay CommonJS (don't rename `main.js` to `.mjs`).
- **`Module did not self-register` for sqlite/serialport/usb** → run `bun run desktop:rebuild`.
- **`hdiutil` missing** → producing a `.dmg` requires macOS; use `.zip` from non-mac hosts.
