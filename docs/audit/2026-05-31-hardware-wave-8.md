# Hardware Platform — Wave 8 Re-Audit & Close-Out

## Part 1 — Independent verification of Wave 7 claims

Walked the code. All Wave 7 ship claims verified:

| Wave 7 claim | Verdict | Evidence |
|---|---|---|
| Runtime Decisions panel + Copy diagnostics | Verified | `HardwareDiagnostics.tsx` L32/L221/L308/L443. |
| `useHardwareProxy` off the shim | Verified | no `useDeviceRegistry` import remains. |
| ESLint allow-list shrunk | Verified | `eslint-rules/no-legacy-device-registry.js` L24. |
| `useInventoryLabelPrinter` + arch test | Verified | both files present. |
| Wave 7 audit doc | Verified | present. |

## Part 2 — Correction to the Wave 8 plan premise

The Wave 8 plan (and its predecessors) framed `src/apps/platform/hardware/routes.tsx` as a "routing dialect duplication" — claiming the rest of the project uses TanStack file routes. **This is wrong.** `src/App.tsx` mounts a `BrowserRouter`/`HashRouter` from `react-router-dom` and the entire app uses `Routes`/`Route` inside it. `platform/hardware/routes.tsx` matches the codebase's actual dialect.

→ **Batch A skipped** (would have introduced inconsistency, not removed it).
→ **Batch B (page relocation) deferred** — pure file moves with many test/route import sites and no architectural payoff once A is off the table.
→ **Batch D (Inventory UI wiring) deferred** — Inventory has no existing label-print surface to wire into; inventing one is out of audit scope. The hook + arch test continue to prove the seam.

These are tracked openly rather than shipped with a false rationale.

## Part 3 — Shipped this wave

### Batch C — Last shim consumer retired
- New `src/hooks/hardware/useHardwareRegistryCrud.ts` — canonical CRUD adapter (the implementation that used to live behind the deprecated `useDeviceRegistry` shim, under a non-deprecated name in the `hooks/hardware` tree).
- `src/components/pos/DeviceRegistryCard.tsx` now imports `useHardwareRegistryCrud` directly — the registry-edit UI no longer touches the deprecated shim symbol or path.
- `src/hooks/pos/useDeviceRegistry.ts` reduced to a thin re-export of the new module for one-release backward compatibility. Marked `@deprecated — delete in Wave 9`.
- `eslint-rules/no-legacy-device-registry.js` allow-list emptied of consumers (only the shim file itself remains). Any new import of `@/hooks/pos/useDeviceRegistry` outside tests now fails ESLint.

### Batch E — Duplicate hardware-edit surface closed
- POS Settings → Hardware tab rewritten as a redirect-only CTA card with two primary actions: "Open Platform → Hardware" and "View diagnostics". The embedded `DeviceRegistryCard` editor was removed.
- `POSSettings.tsx` no longer imports `DeviceRegistryCard` and the orphan `selectedHardwareRegisterId` state was removed.
- New architecture test `src/test/architecture/pos-settings-no-hardware-editor.test.ts` guards against accidental re-introduction: forbids the import and any `<DeviceRegistryCard>` JSX, asserts the platform CTA path is present.

### Batch F — Documentation
- This audit doc.

## Part 4 — Explicitly deferred (with reason)

| Item | Reason | Tracked as |
|---|---|---|
| Move pages `HardwareDevices` / `HardwareDiagnostics` from `src/pages/pos/` to `src/apps/platform/hardware/` | Pure file move; many test/route consumers; no architectural payoff once Batch A is off the table (lazy-import paths remain string-coupled either way). | Wave 9 — pair with the shim deletion. |
| Routing dialect migration to TanStack file routes | App-wide change, not a hardware concern. The whole app uses `react-router-dom`. | Separate framework-level plan. |
| Inventory / Warehouse / HR UI wiring of `useInventoryLabelPrinter` etc. | No existing entry surface to wire into; the seam is proven by the hook + arch test. | Per-module when each adds its real print flow. |
| Drop `pos_hardware_configs` + mirror triggers | One more release on the reverse mirror first. | Wave 9. |
| Driver-tree physical collapse (renderer ↔ Electron main) | `browserFallback` invariant + arch test prevent new duplication; per-driver removal needs its own diff. | Wave 9. |
| Phase 5 (USB/mDNS/BLE discovery in Electron main) | Unchanged. | Separate plan. |
| Native scanner SDK wiring, EMV state machine | Unrelated tracks. | Separate plans. |

## Part 5 — Files changed this wave

```text
src/hooks/hardware/useHardwareRegistryCrud.ts            NEW — canonical CRUD adapter
src/hooks/pos/useDeviceRegistry.ts                       reduced to thin deprecated re-export
src/components/pos/DeviceRegistryCard.tsx                imports useHardwareRegistryCrud
src/pages/pos/POSSettings.tsx                            hardware tab → redirect CTA
eslint-rules/no-legacy-device-registry.js                allow-list emptied of consumers
src/test/architecture/pos-settings-no-hardware-editor.test.ts   NEW — guard
docs/audit/2026-05-31-hardware-wave-8.md                 NEW — this doc
```

No DB migrations. The reverse mirror trigger continues to keep
`pos_hardware_configs` in sync for any unmigrated external read consumer.

## Part 6 — Rollback

- **Batch C:** revert `DeviceRegistryCard.tsx` import line + re-add it to the ESLint allow-list. `useHardwareRegistryCrud.ts` can stay (unused), and the shim's re-export still works.
- **Batch E:** revert `POSSettings.tsx` hardware tab body, re-add `DeviceRegistryCard` import and `selectedHardwareRegisterId` state. Delete the new architecture test.

## Part 7 — Net effect

After Wave 8 the deprecated `useDeviceRegistry` hook has **zero call sites in production code** (only its own self-import and tests). It is ready to delete in Wave 9, alongside `pos_hardware_configs` and its mirror trigger. The hardware-edit surface is now single-source: Platform → Hardware.
