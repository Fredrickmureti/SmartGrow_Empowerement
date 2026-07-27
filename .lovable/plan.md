
# Hardware Platform Consolidation — Verification & Phase 6 Step C Completion

## Phase 0 — Independent verification of the prior engineer's claims

Re-checked `.lovable/plan.md` against tree and DB. All Phase 5B/5C/6A/6B claims verified against source:

- Confirmed removed: `printReceiptThermal`, all 11 role-only shims in `HardwareClient`, `usePrinterProfiles`, `PrinterProfilesCard`, `legacyPrinterProfileFieldMap`. `execAny(` appears only inside `HardwareClient.ts`; every consumer routes via `execForIntent.ts` → `execAssignment`.
- Confirmed dropped in DB: `printer_profiles`, `printer_workflow_bindings`, `device_assignments.source_config_id`, `print_jobs.printer_profile_id`.
- Residual `printer_profiles` string hits are documentation/comments and test fixtures only — not live code paths.

Pending items on the prior plan are all still open and correctly scoped. Nothing to redo — resume at Phase 6 Step C.

## Phase 6 Step C — final sweep (this plan)

Four ordered work packages. Guard tests (`src/test/hardware`, `src/test/printing`, `src/test/architecture/*hardware*`, `*print*`, `host-state-single-owner`, `transport-decision-single-owner`) must stay green after each package.

### 1. Retire `workstation_devices`

Live readers (verified): `src/components/hardware/EdgeRelayMount.tsx`, `supabase/functions/edge/routes/workstation-manifest.ts`, mounted from `src/App.tsx:283`. `useInventoryLabelPrinter.ts` reference is a historical comment.

- Delete `EdgeRelayMount.tsx` and remove its mount from `src/App.tsx`. `ElectronHydratorMount` already hydrates `device_assignments` — the parallel workstation-based hydration is the exact "hidden legacy path" the mandate forbids.
- Delete `supabase/functions/edge/routes/workstation-manifest.ts` and any route table entry.
- Migration: `DROP TABLE public.workstation_devices` (1 row per prior audit; no FK dependents remain after prior phases).
- Regenerate `src/integrations/supabase/types.ts`.
- Update the comment in `useInventoryLabelPrinter.ts` for accuracy.

### 2. Delete workflow-binding legacy (`resolve_device_for_workflow`)

Readers: `src/hooks/useDeviceForWorkflow.ts`, `src/components/hardware/WorkflowBindingsCard.tsx` (mounted in `HardwareDevices.tsx:500`), `src/services/printing/labelDispatch.ts:246`.

The canonical binding surface is `document_print_policies` edited at `/platform/hardware/policies`. `printer_workflow_bindings` was already dropped, so `resolve_device_for_workflow` is a shell over an empty table.

- `labelDispatch.ts`: remove the `resolve_device_for_workflow` RPC branch entirely; intent → `resolveDeviceForIntent` (same seam every other consumer uses) is the sole path. Label dispatch already carries `intent`, `businessId`, `branchId`.
- Delete `useDeviceForWorkflow.ts`, `WorkflowBindingsCard.tsx`, and its import + usage in `HardwareDevices.tsx`.
- Migration: `DROP FUNCTION resolve_device_for_workflow`, `DROP FUNCTION resolve_workflow_printer` (if either still exists).
- Regenerate types.

### 3. Close the CompanySettings "Printing" tab

`src/pages/settings/CompanySettings.tsx` still ships the `printing` `TabsTrigger` + `TabsContent` redirect stub. Canonical home is `/platform/hardware/policies`.

- Remove the `printing` `TabsTrigger` and `TabsContent value="printing">` block.
- If `?tab=printing` arrives in the URL, redirect (via `<Navigate>` or `useEffect`) to `/platform/hardware/policies` so bookmarks don't 404.
- Rename `src/components/settings/PrintingSettings.tsx` → `src/apps/platform/hardware/PrintPoliciesEditor.tsx` and inline it into `HardwarePolicies.tsx` as its child (drops the last cross-tree import from `components/settings/` into the hardware app).
- Remove the now-orphan `Printer` icon import + `PrintingSettings` import cleanup in `CompanySettings.tsx`.

### 4. Shrink the hardware chokepoint allow-list

`hardware-single-chokepoint.test.ts` currently permits any file under `src/services/hardware/**` to reach `hardwareClient`. Post-migration the only sanctioned callers are `src/services/printing/**` (dispatch layer) and `src/services/hardware/{HardwareClient,execForIntent,transport}.**` (internal wiring).

- Rewrite the allow-list to that whitelist.
- Run `rg 'hardwareClient\.' src` and fold any surviving legit call site into the whitelist explicitly; any hit not in the whitelist gets migrated to `execForIntent` in the same commit.

### 5. Final grep / definition of done

```
rg 'workstation_devices|resolve_workflow_printer|resolve_device_for_workflow|source_config_id|execAny\('   \
   src supabase/functions
```
must return only doc/comment lines under `docs/` and archived SQL under `supabase/migrations/`. `bunx tsgo --noEmit -p tsconfig.app.json` clean. `bunx vitest run src/test/hardware src/test/printing src/test/architecture` — the 9 hardware guards + `host-state-single-owner`, `transport-decision-single-owner`, `print-policies-canonical-home` all green.

Pre-existing repo-wide failures unrelated to hardware (payroll/HR/inventory guards, `no-printservice-shim`) stay out of scope per the prior handoff — they are not caused by this track and folding them in would violate the "don't start unrelated modules" rule.

## Out of scope

Byte-level driver rewrites, relay protocol changes, `document_templates` / `label_templates` schema changes beyond FK re-points, attendance/biometric flows. No new architecture is being introduced — this closes the migration the prior engineer opened.
