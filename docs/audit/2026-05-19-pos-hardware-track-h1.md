# POS Hardware — Track H1 (partial) verdict · 2026-05-19

Closes the critical-path slice of G2 and the hardware-folder slice of G1.
The kiosk/offline `electronAPI.{network,secureStorage,offline,backup,db,…}`
surface is intentionally out of scope (those are not hardware concerns and
will be re-namespaced under `window.pos.app.*` in Track H2).

## Landed

| Change | File | Evidence |
|---|---|---|
| Main-process lifecycle IPC: `pos:devices:status`, `pos:devices:reconnect` | `electron/main.ts` | Two new `ipcMain.handle` blocks immediately after `pos:devices:set-terminal`; backed by `deviceManager` + `commandRouter` |
| Customer-display update mirrored onto EventBroker | `electron/main.ts` | `customer-display:update` handler now `eventBroker.publish({type:'customer_display:update', role:'customer_display', data, ts})` before the legacy direct `webContents.send` |
| Preload exposes `window.pos.devices.{status,reconnect}` | `electron/preload.ts` | Two new methods + matching `declare global` type entries |
| `HardwareClient` lifecycle dual-adapter | `src/services/hardware/HardwareClient.ts` | `isRoleAvailable` / `reconnectRole` pick Electron path when `window.pos.hardware.exec` present; new async `getStatuses()` returns DeviceManager truth in Electron, BrowserHardwareAdapter snapshot otherwise |
| `CustomerDisplay.tsx` consumes via `window.pos.hardware.subscribe` | `src/pages/pos/CustomerDisplay.tsx` | Legacy `electronAPI.customerDisplay.onUpdate` listener removed; new subscription filters `customer_display:update` events from the broker |
| `ElectronTransport` collapsed to dead-code stub | `src/services/hardware/transport/ElectronTransport.ts` | Both classes return `{ success:false, error:'…dead code…use hardwareClient' }`; isAvailable() ≡ false; constructors kept only for type-compat with `resolveTransport()` |
| `ElectronBridge` stripped of all `electronAPI.*` calls | `src/services/hardware/ElectronBridge.ts` | Serial methods → deadResult; USB enumeration → WebUSB only; app-control methods → no-op (move to `appControl` in H2) |
| `NetworkPrinterInterface.probeAddress` stripped of Electron branch | `src/services/hardware/interfaces/NetworkPrinterInterface.ts` | Probe now goes through IoT-Box agent only; in Electron, reachability is asserted by main-process NetworkTransport on first send |

## Verification

- `rg "electronAPI\." src/services/hardware src/pages/pos` → 4 remaining hits, all inside `CustomerDisplayService.ts` (deprecated window orchestration, queued for H2) + doc/comment lines.
- `rg "electronAPI\." src/components/electron` → 3 hits in `OnlineOnlyRoute.tsx` (network status, out of hardware scope).
- 25/25 hardware tests green (`command-router`, `device-manager-bootstrap`, `browser-hardware-adapter`, `hardware-client-routing`).

## Not yet closed in H1

- `CustomerDisplayService.{getDisplays,open,close,update}` — calls `electronAPI.customerDisplay.*`. This is window orchestration (open a secondary BrowserWindow), not device IO. Will be re-namespaced under `window.pos.app.customerDisplay.*` in Track H2 when the preload is trimmed.
- `OnlineOnlyRoute.tsx` + `OfflineAuthService` + `BackgroundSyncManager` — `electronAPI.{network,secureStorage,offline}`. Kiosk/offline concerns; out of hardware scope.
- `PrintService.ts` (`electronAPI.print.*`) — document printing (HTML→PDF), separate from POS hardware printer pipeline. Tracked in Track H4.
- Per-role reconnect granularity in DeviceManager — current `pos:devices:reconnect` does a full re-bootstrap. Per-role + circuit-breaker lands in Track H7.
- Sync `isRoleAvailable` returns optimistic `true` under IPC; UI callers should hydrate from `getStatuses()`. Noted in code.

## Verdict

GREEN for the H1 critical-path slice. Lifecycle is now a true dual-adapter
chokepoint matching the exec path. The remaining G1 surface is documented
above and properly scoped to follow-up tracks (H2 for preload/app-control
trim, H4 for legacy service deletion).
