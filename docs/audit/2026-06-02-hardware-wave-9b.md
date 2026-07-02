# Hardware Platform — Wave 9b (Structural Cleanup)

## Verified from Wave 9 Batch A

- `DeviceRegistryCard` is mounted on `/platform/hardware/devices`.
- Runtime card + diagnostics link present.
- Arch guard `platform-hardware-has-editor.test.ts` exists and now points
  at the new page location.
- POS Settings hardware tab is CTA-only (`pos-settings-no-hardware-editor`).
- `useDeviceRegistry` had zero live consumers (shim only).

## Shipped this wave

1. **Pages relocated** to the platform tree.
   - `src/pages/pos/HardwareDevices.tsx` → `src/apps/platform/hardware/HardwareDevices.tsx`
   - `src/pages/pos/HardwareDiagnostics.tsx` → `src/apps/platform/hardware/HardwareDiagnostics.tsx`
   - All imports updated (`apps/platform/hardware/routes.tsx`, test files,
     architecture guards).
2. **Dual-mounting removed.** `src/apps/pos/routes.tsx` no longer mounts
   the hardware pages; `App.tsx` redirects (`/pos/hardware-*` →
   `/platform/hardware/*`) remain.
3. **Deprecated shim deleted.** `src/hooks/pos/useDeviceRegistry.ts`
   removed. ESLint rule `no-legacy-device-registry` and its registration
   in `eslint.config.js` removed.
4. **Legacy mirror dropped.** Supabase migration drops table
   `pos_hardware_configs` and any reverse-mirror trigger / function,
   with a fail-fast pre-flight check. `HardwareDiagnostics.tsx` repurposed
   to diff canonical `device_assignments` against the Electron SQLite
   cache instead of the dead mirror.
5. **Allow-lists shrunk.**
   - `no-raw-hardware-ipc` legacy-table allow-list emptied.
   - `no-legacy-pos-hardware-configs.test.ts` allow-list shrunk to
     generated types + scoped-tables config + the test itself.
   - `businessScopedTables.ts` no longer enumerates the dropped table.
6. **New arch guards.**
   - `no-legacy-pos-hardware-pages.test.ts` — forbids any import of the
     old `@/pages/pos/HardwareDevices(.Diagnostics)` paths.
   - `hardware-single-chokepoint.test.ts` — forbids non-allowlisted files
     from reading `window.pos.{usb,serial,hid}` directly; every hardware
     op must funnel through `hardwareClient`.
7. **Header comments scrubbed** of stale `useDeviceRegistry` /
   `pos_hardware_configs` mirror references in the surviving hooks.

## Deferred to Wave 9c / 9d (per the approved plan)

| Item | Wave |
|---|---|
| First live cross-module consumer of `useInventoryLabelPrinter` + `DeviceScope` fix | 9c |
| `runtimeCapability()` capability probe + Electron-degraded surface in Runtime card | 9d |
| Per-driver renderer-copy collapse + invert `hardware-driver-duplication.test.ts` | 9d |
| `HARDWARE_RUNTIME.md` + memory updates | 9d |

## Rollback

- Code: revert this commit; the legacy `@/pages/pos/HardwareD*` imports
  reappear, the shim file is recreated from git history, the arch tests
  are deleted.
- DB: restore `pos_hardware_configs` from PITR; nothing in app code reads
  it anymore, so a missing-restore is non-fatal for the renderer.

## Files changed

```
src/apps/platform/hardware/HardwareDevices.tsx       moved from pages/pos/
src/apps/platform/hardware/HardwareDiagnostics.tsx   moved + dead-mirror sections removed
src/apps/platform/hardware/routes.tsx                imports updated
src/apps/pos/routes.tsx                              hardware routes removed
src/hooks/pos/useDeviceRegistry.ts                   DELETED
src/hooks/pos/useHardwareProxy.ts                    comment scrub
src/hooks/pos/index.ts                               comment scrub
src/hooks/useDeviceAssignments.ts                    comment scrub
src/hooks/useDeviceForRole.ts                        comment scrub
src/hooks/hardware/useHardwareRegistryCrud.ts        comment scrub
src/lib/businessScopedTables.ts                      drop pos_hardware_configs entry
eslint.config.js                                     no-legacy-device-registry removed
eslint-rules/no-legacy-device-registry.js            DELETED
eslint-rules/no-raw-hardware-ipc.js                  legacy-table allow-list emptied
src/test/architecture/platform-hardware-has-editor.test.ts        path update
src/test/architecture/no-legacy-pos-hardware-configs.test.ts      allow-list shrunk
src/test/architecture/no-legacy-pos-hardware-pages.test.ts        NEW guard
src/test/architecture/hardware-single-chokepoint.test.ts          NEW guard
src/test/pos/hardware-devices-page.test.tsx                       path update
supabase/migrations/<timestamp>_drop_pos_hardware_configs.sql     NEW migration
```

No new dependencies, no driver-tree changes, no preload changes.