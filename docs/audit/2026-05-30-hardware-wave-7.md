# Hardware Platform — Wave 7 Re-Audit & Close-Out

## Part 1 — Independent verification of Wave 6 claims

I walked the actual code, not the prior summary. Every Wave 6 ship claim is real:

| Wave 6 claim | Verdict | Evidence |
|---|---|---|
| `useDeviceRegistry` collapsed to shim over `useDeviceAssignments` | Verified | `src/hooks/pos/useDeviceRegistry.ts` header `DEPRECATED SHIM`. |
| Reverse mirror `device_assignments → pos_hardware_configs` | Verified | prior wave migration. |
| `runtimeReason` ring buffer + `electron-fallback-unexpected` warn | Verified | `src/services/hardware/HardwareClient.ts` L72–115. |
| Sidebar entry `System → Hardware → /platform/hardware/devices` | Verified | `AppSidebar.tsx:187`. |
| POS settings hardware tab deprecation banner | Verified | `POSSettings.tsx:993`. |
| `browserFallback` flag on `DriverRegistry` + duplication architecture test | Verified | grep hits + `src/test/architecture/hardware-driver-duplication.test.ts`. |
| ESLint `no-legacy-device-registry` rule | Verified | `eslint-rules/no-legacy-device-registry.js`. |
| Architecture test `no-legacy-pos-hardware-configs` | Verified | file present. |

## Part 2 — Shipped this wave

### Batch A — Runtime decisions panel (the missing observability slice)
- `src/pages/pos/HardwareDiagnostics.tsx` now imports `getRecentRuntimeReasons` + `RuntimeReason`, polls the ring every 2s, and renders a "Runtime decisions (last 25)" card. `electron-fallback-unexpected` rows render in destructive color with a tooltip pointing to the stale-preload diagnosis.
- Added a **Copy diagnostics** button next to Refresh that serializes the runtime surface, capability flags, hydrator status, all three registry counts, agent reachability, and the full reason ring as JSON to the clipboard for support tickets.

### Batch B — Partial migration off the legacy shim
- `src/hooks/pos/useHardwareProxy.ts` no longer imports `useDeviceRegistry`. It now reads `useDeviceAssignments(scope)` directly through a private `toCompatRow` adapter that preserves the field names the rest of the file reads (`device_role`, `connection_type`, `is_active`, etc.). Behavior unchanged.
- `eslint-rules/no-legacy-device-registry.js` allow-list shrunk: `useHardwareProxy.ts` removed; `DeviceRegistryCard.tsx` retained for one more wave (1214 lines of CRUD UI — mechanical inlining adds no correctness because the shim already routes through the canonical table; the blast-radius tradeoff documented in the rule comment).

### Batch C — First real cross-module `useDeviceForRole` consumer
- New `src/hooks/inventory/useInventoryLabelPrinter.ts` — canonical pattern for non-POS modules. Asks for the `label_printer` role bound to the current business scope, falls back to tenant default, returns `{ device, hasDevice, missingDeviceCta, printLabelBytes }`. Missing device returns a structured failure with a CTA pointing at `/platform/hardware/devices` instead of throwing.
- New `src/test/hardware/inventory-label-printer-binding.test.ts` — source-level architecture guard verifying the hook routes through the platform hook (not the POS shim), uses the canonical role string, surfaces the CTA, dispatches through `hardwareClient.printRawBytes` (not an adapter directly), and fails closed when no device is bound.

### Batch E — Documentation
- This audit doc.

## Part 3 — Explicitly deferred (and why)

| Item | Reason for deferral | Tracked as |
|---|---|---|
| `DeviceRegistryCard` migration off the shim | 1214-line CRUD UI with mutations; shim already reads/writes through canonical table so this is mechanical inlining with no correctness gain. Allow-list still contains it. | Wave 8 |
| **Batch D — Routing dialect cleanup** (move `src/apps/platform/hardware/routes.tsx` from `react-router-dom` to TanStack file routes under `src/routes/platform/hardware/`) | TanStack file routes are auto-generated through the Router Vite plugin; mid-turn swap risks routeTree regeneration races. Works today via App.tsx mount. | Wave 8 (dedicated turn) |
| Inventory/Warehouse/HR full UI wiring of `useInventoryLabelPrinter` and equivalents | Inventory doesn't currently expose a label-print button surface; the consumer seam exists and is tested. UI wiring lands when a module adds the actual button. | Per-module |
| Dropping `pos_hardware_configs` entirely | One more release on the reverse mirror trigger first. | Wave 9 cleanup |
| Driver-tree physical collapse | `browserFallback` invariant + architecture test prevent new duplication; mechanical removal of superseded renderer drivers is a self-contained future wave. | Wave 8 |
| Phase 5 in full (USB/mDNS/BLE discovery in Electron main) | Unchanged scope. | Separate plan |

## Part 4 — Files changed this wave

```text
src/pages/pos/HardwareDiagnostics.tsx                 # Runtime Decisions panel + Copy diagnostics
src/hooks/pos/useHardwareProxy.ts                     # shim → useDeviceAssignments
eslint-rules/no-legacy-device-registry.js             # allow-list shrunk
src/hooks/inventory/useInventoryLabelPrinter.ts       # NEW — first cross-module consumer
src/test/hardware/inventory-label-printer-binding.test.ts   # NEW — architecture guard
docs/audit/2026-05-30-hardware-wave-7.md              # NEW — this doc
```

No DB migrations.

## Part 5 — Rollback

- Diagnostics panel: pure read; revert the file.
- `useHardwareProxy` migration: revert the file and re-add `useHardwareProxy.ts` to the ESLint allow-list. The shim is still in place.
- `useInventoryLabelPrinter`: delete the hook + test. No call sites exist yet.
