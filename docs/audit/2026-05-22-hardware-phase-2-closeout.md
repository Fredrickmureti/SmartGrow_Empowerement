# Audit — Hardware Phase 2 closeout, 2026-05-22

## What this turn re-verified

| Phase 2 deliverable | Status before turn | Action taken |
|---|---|---|
| `device_assignments` table + RLS + indexes | Verified present | none |
| Mirror trigger from `pos_hardware_configs` | Verified present | none |
| Backfill of legacy rows via `source_config_id` | Verified present | none |
| `useDeviceAssignments` hook | Verified present | none |
| `ElectronAssignmentHydrator` service | Verified present | none |
| `ElectronHydratorMount` component file | Verified present but **never mounted** | **Mounted in `src/App.tsx`** inside `RealtimeSyncProvider` (has org context, runs once per session) |
| Diagnostics page surfaces canonical registry + hydrator | Missing | **Added** `device_assignments` count row, hydrator status block (active / last sync / rows hydrated / last error) and a **Resync now** button |
| `device_assignments` RLS regression test | Missing | **Added** `supabase/tests/device_assignments_rls_test.sql` (4 catalog assertions: RLS on, per-cmd org-scoped policies, mirror trigger present, anon denied) |
| ESLint guard — direct `pos_hardware_configs` reads outside the shim | Missing | **Added** to `eslint-rules/no-raw-hardware-ipc.js`; only `useDeviceRegistry.ts` and `HardwareDiagnostics.tsx` are allowed to mention the legacy table name |
| Hydrator unit test | Missing | **Added** `src/test/hardware/electron-assignment-hydrator.test.ts` (2 cases, both pass: hydrates each enabled row once + status reporting; no-op when `window.pos.devices` missing) |

## Verification

- `bunx vitest run src/test/hardware/electron-assignment-hydrator.test.ts` → 2/2 pass.
- Diagnostics page renders a new "Hydrator" block with three counters and a Resync button gated on `hydrator.active`. Outside Electron the button is disabled and the row is labelled `not Electron`.
- The mirror trigger continues to keep `pos_hardware_configs` and `device_assignments` in sync, so the legacy hook is unaffected by this turn.

## Intentionally deferred (next plan)

These items from the original Phase 2 plan are **not** done in this turn because each one needs its own focused review and rollback path:

1. **`useDeviceRegistry` → thin shim over `useDeviceAssignments`.** The two hooks have different row shapes (`DeviceConfig` vs `DeviceAssignment`) and write paths (`pos_hardware_configs` insert vs `device_assignments` insert). A safe shim needs either a bidirectional mirror trigger or a field-by-field adapter; mirror is currently one-way (legacy → canonical). Risk of breaking existing writes is too high to fold into this closeout.
2. **Replace the `/pos/hardware-devices` "browser preview only" empty state.** Depends on the hook shim above so both screens read the same rows.
3. **Phase 3 — lift hardware UI out of POS.** Plan stands: new route group `_authenticated/platform/hardware/{index,devices,diagnostics}.tsx` + legacy redirects + sidebar entry. Bounded to a single plan-approved batch.
4. **Phase 4 — collapse the renderer driver tree.** Per-file audit needed; will land with the duplication-guard architecture test.

## Rollback for this turn

- Hydrator mount: delete the `<ElectronHydratorMount />` line in `src/App.tsx`. Mirror trigger keeps both tables in sync.
- Diagnostics row: revert `src/pages/pos/HardwareDiagnostics.tsx` to the prior version.
- ESLint guard: remove the `LEGACY_HW_TABLE` block from the rule.
- Test files: delete them. No other consumer.