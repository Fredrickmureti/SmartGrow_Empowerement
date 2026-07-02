# Hardware Platform — Wave 6 Re-Audit & Closeout

## Verified independently (walked the code, not the prior summary)

- `device_assignments` table + RLS + forward mirror trigger (`pos_hw_config_mirror`) — present.
- Reverse mirror trigger (`device_assignments → pos_hardware_configs`, loop-guarded via `pg_trigger_depth()`) — present.
- `useDeviceAssignments` hook, `ElectronAssignmentHydrator`, `ElectronHydratorMount` — wired in `src/App.tsx`.
- `/platform/hardware/devices` + `/diagnostics` routes mounted with legacy `/pos/hardware-*` redirects.
- `useDeviceForRole(role, scope)` cross-module hook — present.
- `getHardwareCapabilities` honest capability split (`canPrint` vs `canPrintFallback`) — present.
- ESLint `no-raw-hardware-ipc` — present and `error`-level.

## Shipped this wave

1. **Legacy hook collapse.** `src/hooks/pos/useDeviceRegistry.ts` is now a thin shim over `useDeviceAssignments`. It reads canonical rows and writes directly to `device_assignments`; the reverse mirror trigger keeps `pos_hardware_configs` populated for any external consumer. Public API preserved verbatim so `DeviceRegistryCard` and `useHardwareProxy` keep working unchanged.
2. **ESLint rule `no-legacy-device-registry`** — fails the build if anything outside the allow-list (`useDeviceRegistry.ts` shim, `DeviceRegistryCard.tsx`, `useHardwareProxy.ts`) imports the deprecated hook.
3. **Architecture test `no-legacy-pos-hardware-configs.test.ts`** — keeps direct `pos_hardware_configs` references confined to the shim + diagnostics page + generated types + scoped-tables config.
4. **Platform nav** — added `System → Hardware` entry in `AppSidebar` pointing at `/platform/hardware/devices` (`Cpu` icon, `editSettings` permission).
5. **POS settings hardware tab** — prominent banner deep-linking to Platform → Hardware and announcing the one-release deprecation of the embedded card.
6. **Driver-tree fallback invariant** — `registerDriver` now accepts `{ browserFallback: true }`. Every renderer driver whose role is also covered by a main-process driver (`escpos`, `star`, `citizen`, `bixolon`, `epson`, `escpos_drawer`, all `*_scale`, `secondary_screen_display`, `browser_print`, `epos_printer`) is flagged. Scanners and payment-terminal stubs remain renderer-primary.
7. **Architecture test `hardware-driver-duplication.test.ts`** — fails the build if any of the above driver types is registered without `browserFallback: true`.
8. **Runtime-reason instrumentation** in `HardwareClient.execAny` — records `electron-bypass`, `browser-direct`, or `electron-fallback-unexpected` into a 50-entry ring buffer exposed via `getRecentRuntimeReasons()`. The `electron-fallback-unexpected` case emits a `console.warn` so a stale Electron preload bundle shows up in diagnostics rather than silently falling back.
9. **Memory + docs** — `mem/features/hardware-platform.md` rewritten to reflect single-registry + shim + driver-fallback invariants; this audit doc added.

## Explicitly NOT done this wave (and why)

- **DeviceRegistryCard / useHardwareProxy not migrated off the shim.** The shim now reads the canonical table, so the data path is unified regardless. Migrating 1214 lines of card UI is blast-radius work that adds no correctness; tracked for the next wave.
- **HardwareDiagnostics runtime-reason panel UI** — backend ring buffer + getter shipped, but the visible panel was deferred to avoid touching the diagnostics page in a time-bounded turn. Wire `getRecentRuntimeReasons()` into it as the next slice.
- **Phase 5 in full** (USB/mDNS/BLE discovery in main process), **Inventory/Warehouse/HR consumer wiring**, **dropping `pos_hardware_configs` entirely** — explicit Wave 7+ items.

## Files changed

- `src/hooks/pos/useDeviceRegistry.ts` (rewritten as shim)
- `eslint-rules/no-legacy-device-registry.js` (new) + `eslint.config.js`
- `src/test/architecture/no-legacy-pos-hardware-configs.test.ts` (new)
- `src/test/architecture/hardware-driver-duplication.test.ts` (new)
- `src/services/hardware/drivers/DriverRegistry.ts` (browserFallback flag)
- `src/services/hardware/HardwareClient.ts` (runtime-reason ring + warn)
- `src/components/layout/AppSidebar.tsx` (Hardware nav entry)
- `src/pages/pos/POSSettings.tsx` (deprecation banner)
- `mem/features/hardware-platform.md` (rewritten)

No DB migrations required this wave; the reverse mirror trigger from the prior wave handles all coherence.
