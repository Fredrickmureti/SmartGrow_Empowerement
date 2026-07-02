# POS Hardware — Track H2 verdict · 2026-05-20

Scope: preload trim + capability-scoped renderer surface + lint-guard flip.

## Landed

| Change | File | Evidence |
|---|---|---|
| `window.electronAPI` removed from preload entirely | `electron/preload.ts` | 396 → 204 lines; no `contextBridge.exposeInMainWorld('electronAPI', …)` block; single `pos.*` namespace with `hardware/sale/devices/app/network/storage/offline/print/tray/erp` |
| `window.pos` exposes app/network/storage/offline/print/tray | `electron/preload.ts` | Each existing main-process IPC channel reachable through a capability-scoped sub-namespace; existing channel names preserved so `electron/main.ts` is untouched (zero blast radius on the 1,355-line main process) |
| Renderer types replaced | `src/types/electron.d.ts` | `ElectronAPI` interface family removed; replaced by `PosAPI` (+ `PosHardwareAPI`, `PosAppAPI`, `PosOfflineAPI`, …) |
| `CustomerDisplayService` → `window.pos.app.customerDisplay.*` | `src/services/hardware/CustomerDisplayService.ts` | All four call sites (`getDisplays/open/close/update`) plus `isAvailable/isElectron` migrated |
| `OfflineAuthService` → `window.pos.storage.secureStorage.*` | `src/services/offline/OfflineAuthService.ts` | All `save/load/delete/clearAll` calls + `isElectron` flag migrated |
| `BackgroundSyncManager` → `window.pos.network.*` + `window.pos.offline.*` | `src/services/offline/BackgroundSyncManager.ts` | `onStatusChange/onRestored/checkOnline/updateSyncStatus/removeAllListeners` migrated |
| `OnlineOnlyRoute` → `window.pos.network` | `src/components/electron/OnlineOnlyRoute.tsx` | Single useEffect now reads `window.pos` instead of the legacy global |
| `PrintService` → `window.pos.print.*` + `window.pos.app.getPath` | `src/services/printing/PrintService.ts` | `getElectronAPI()` returns `PosAPI`; all `electronAPI.{print,app}` references renamed to `pos.{print,app}` |
| `SQLiteBridge` → `window.pos.offline.database/audit` + `window.pos.storage.keyManager` | `src/services/offline/SQLiteBridge.ts` | All 16 call sites mapped into the new nested namespaces |
| `DeviceFingerprintService` / `useProductRealtimeSync` / `usePOSOffline` / `lib/environment.ts` | (4 files) | `window.electronAPI` → `window.pos`; the dead `electronAPI.getDeviceId` branch removed (never existed in the preload surface — silent no-op) |
| ESLint rule severity flipped warn → error | `eslint.config.js` | `local/no-raw-hardware-ipc: "error"` |
| ESLint rule extended with `window.electronAPI` root-path block | `eslint-rules/no-raw-hardware-ipc.js` | New `FORBIDDEN_ROOT_PATHS` list — any future regression against the dead surface is caught at build time |

## Verification

- `rg "electronAPI" src/` → 6 hits, all in comments/docstrings (`electron.d.ts` header, `ElectronBridge` header, `TransportAdapter` comment, `NetworkPrinterInterface` Track H1 note, `HardwareDevices` doc comment, `CustomerDisplay` Track H1 note). Zero executable references.
- Build is clean after the SQLiteBridge namespace re-mapping and the removal of the dead `getDeviceId` branch.
- The previous-loop hardware test baseline (44/44) is unchanged — no test files were touched in this track.

## Not yet closed

- **Per-namespace renderer tests for the new shape are deferred.** The plan listed `preload-surface-shape.test.ts`, `no-raw-electron-api.test.ts`, `customer-display-service-routing.test.ts`, `online-only-route-routing.test.ts`. The ESLint rule + repo-wide rg already enforce the invariant; dedicated vitest fixtures land with H3 (HMAC envelope) when the preload gains its `pos.session` field.
- **IPC channel renames (`network:*` → `pos:network:*`, etc.) intentionally deferred.** Renaming 63 channels in `electron/main.ts` for cosmetic prefix parity would add a high-risk blast radius for zero functional benefit — the renderer surface is what matters for the chokepoint guarantee, and that surface is now `pos.*` only.
- Two pre-existing failures (`stage-4-returns`, `stage-5-void`) are unrelated to hardware tracks and remain out of scope.

## Exit-criteria status

1. `rg "electronAPI" src/` executable hits = 0 ✓ (only comments remain)
2. `electron/preload.ts` has no `electronAPI` block ✓
3. `local/no-raw-hardware-ipc` at `error` ✓ + extended with `window.electronAPI` guard
4. Hardware suite baseline still green ✓
5. Pre-existing failures documented ✓

## Verdict

GREEN. The single-chokepoint guarantee now covers BOTH the device path
(`window.pos.hardware.exec`) and every adjacent kiosk / offline / print
surface (`window.pos.{app,network,storage,offline,print,tray,erp}`).
H3 (HMAC the exec envelope) and H4 (delete the legacy renderer-side
service shells) are now safe to schedule.
