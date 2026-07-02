# Hardware Platform — Wave 9c (Cross-module seam + scope cleanup)

## Independent re-audit of Wave 9b (verified before starting 9c)

I walked the code, not the prior summary. Every Wave 9b claim that I
could verify mechanically holds up:

| Claim | Verdict | Evidence |
|---|---|---|
| Pages relocated to `src/apps/platform/hardware/` | ✅ | `HardwareDevices.tsx`, `HardwareDiagnostics.tsx`, `routes.tsx` present; `src/pages/pos/Hardware*` absent. |
| `src/apps/pos/routes.tsx` no longer mounts hardware | ✅ | grep returns nothing. |
| Redirects `/pos/hardware-*` → `/platform/hardware/*` kept | ✅ | `App.tsx` lines 524–525. |
| `src/hooks/pos/useDeviceRegistry.ts` deleted | ✅ | File absent. |
| `eslint-rules/no-legacy-device-registry.js` deleted | ✅ | File absent. |
| `pos_hardware_configs` drop migration | ✅ | `supabase/migrations/20260521123034_*.sql` with fail-fast preflight. |
| `businessScopedTables.ts` no longer lists the table | ✅ | grep returns nothing. |
| New guards `no-legacy-pos-hardware-pages` + `hardware-single-chokepoint` | ✅ | Both files present. |
| `HardwareDiagnostics` repurposed (canonical-vs-Electron-cache diff) | ✅ | File present at new location. |

No silent regressions found. Wave 9b is real.

## Shipped this wave (9c, partial — see "Deferred" below)

1. **`DeviceRegistryCard` relocated.**
   `src/components/pos/DeviceRegistryCard.tsx` → `src/components/hardware/DeviceRegistryCard.tsx`.
   Hardware editor no longer lives under the POS component tree. Sole
   importer (`apps/platform/hardware/HardwareDevices.tsx`) updated.
2. **`useHardwareProxy` relocated.**
   `src/hooks/pos/useHardwareProxy.ts` → `src/hooks/hardware/useHardwareProxy.ts`.
   All six importers updated in place (PrintPreviewDialog, ReceiptPreviewDialog,
   PostPaymentScreen, POSTerminal, POSSettings, DeviceRegistryCard).
   No deprecated re-export shim — clean break, consistent with the
   Wave 9b precedent of ripping shims rather than carrying them.
   Header JSDoc updated: this is now a *platform* hook, not a POS hook.
3. **`useInventoryLabelPrinter` scope hack removed.**
   Previously the hook wrapped `currentBusiness.id` in
   `{ kind: 'register', id }` because no `business` scope kind exists.
   Now it passes `undefined` scope, letting `useDeviceForRole` pick the
   best match across all visible (RLS-scoped) assignments. The
   register-scoped → station-scoped → user-scoped → tenant-default
   priority is preserved inside `useDeviceForRole`; we just stopped
   abusing the `register` kind for business-level lookup.
   This avoids a `device_assignments.scope_kind` CHECK constraint
   migration that would have added a `business` enum value with no real
   semantic difference from "let the org-scoped read pick the default".
4. **New architecture guard** `src/test/architecture/hardware-not-pos-scoped.test.ts`.
   Asserts (a) the legacy POS-tree paths for the relocated files do
   not exist on disk and (b) no `src/` file imports
   `@/components/pos/DeviceRegistryCard` or `@/hooks/pos/useHardwareProxy`.
   Prevents future drift back into POS ownership.

## Deferred to Wave 9c.2 (with reason)

| Item | Reason |
|---|---|
| First live UI consumer of `useInventoryLabelPrinter` on the Products page (bulk "Print Labels" action) | The hook is now scope-clean and importable from any module. Wiring it into `src/pages/Products.tsx` (1475 lines) is a real UX decision — bulk action vs per-row action, label format (ZPL vs ESC/POS), how labels are rendered server-side. Worth a dedicated turn with UX confirmation rather than dropping a shotgun mount into a large existing page. |
| `useHardwareProxy` deprecated re-export at the old path | Skipped intentionally. Five consumers were updated in this commit; nothing else in the tree references the old path. A shim would only carry debt to remove next wave. |

## Deferred to Wave 9d (unchanged from plan)

- `runtimeCapability()` probe in `HardwareClient.ts` + live surface on the Runtime card.
- Per-driver renderer-copy collapse + inversion of `hardware-driver-duplication.test.ts`.
- Rewrite of `docs/architecture/HARDWARE_RUNTIME.md` + memory updates.

## Gaps appended to the plan during re-audit (still open)

These were captured in `.lovable/plan.md` §C and remain unaddressed:

- Two parallel routing systems (`react-router-dom` in `App.tsx` vs
  TanStack `src/routes/`). The hardware redirects only live in `App.tsx`.
- Authoritative capability matrix doc for Web vs Electron vs IoT-agent
  transports — should land alongside the 9d capability probe.
- Driver registry naming/ownership rule (renderer vs main) — decide as
  part of the 9d collapse.

## Files changed

```text
src/components/pos/DeviceRegistryCard.tsx                          MOVED  → src/components/hardware/DeviceRegistryCard.tsx
src/hooks/pos/useHardwareProxy.ts                                  MOVED  → src/hooks/hardware/useHardwareProxy.ts
src/hooks/hardware/useHardwareProxy.ts                             header updated (POS-facing → platform)
src/hooks/inventory/useInventoryLabelPrinter.ts                    drop `register`-scope hack; use undefined scope
src/apps/platform/hardware/HardwareDevices.tsx                     import path updated
src/components/common/PrintPreviewDialog.tsx                       import path updated
src/components/pos/ReceiptPreviewDialog.tsx                        import path updated
src/components/pos/PostPaymentScreen.tsx                           import path updated
src/pages/pos/POSTerminal.tsx                                      import path updated
src/pages/pos/POSSettings.tsx                                      import path updated
src/services/hardware/README.md                                    doc path updated
src/test/architecture/hardware-not-pos-scoped.test.ts              NEW guard
docs/audit/2026-06-03-hardware-wave-9c.md                          NEW — this doc
```

No DB migrations. No driver-tree changes. No preload changes. No new dependencies.

## Rollback

- Code: revert this commit; `git mv` restores the old paths and the six
  import-path updates fall back into place. The new arch guard is also
  removed by the revert.
- DB: nothing to roll back.

## Validation

- `bunx vitest run src/test/architecture src/test/hardware src/test/pos`
  expected green; the new guard ratchets the relocation.
- TypeScript build must succeed — every old import path was rewritten in
  the same commit, no shim left behind.