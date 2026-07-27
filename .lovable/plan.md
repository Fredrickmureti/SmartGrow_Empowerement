# Hardware Platform Consolidation — Verification Result & Completion Plan

## Phase 0 — Verification of the previous engineer's claims (done, this turn)

I re-checked every claim in `.lovable/plan.md` against the tree and the live database rather than trusting the log.

**Confirmed true:**
- All 9 hardware architecture guards pass: 39/39 (`print-client-execAssignment`, `useHardwareProxy-execAssignment`, `useInventoryLabelPrinter-execAssignment`, `inventory-label-printer-binding`, `pos-receipt-resolver`, `intent-to-role-parity`, `transport-router-matrix`, `role-vocabulary`, `generate-document-resolver`).
- `execAny(` appears only inside `HardwareClient.ts` — no external consumer of the role-only seam.
- `/platform/hardware/*` is a full admin app (devices, wizard, capability, media, label templates, policies, print queue, diagnostics, topology).
- Legacy shim calls outside the resolver-outage fallback closures are exactly the five sites the handoff listed.

**Confirmed still pending (claims of "remaining" were accurate, not understated):**
- `PrintClient.printReceiptThermal` (`PrintClient.ts:519`) still bypasses the chokepoint; caller `PostPaymentSurface.tsx:208`.
- `labelDispatch.ts:387`, `reprintClient.ts:78,89`, `SharedCommandQueueWorker.ts:180`, `BusinessSagaMount.tsx:273` still use `hardwareClient.exec({role,…})`.
- `PrintingSettings.tsx` (351 lines) still ships and still mounts `PrinterProfilesCard`.
- Legacy DB objects still exist: `printer_profiles`, `printer_workflow_bindings`, `workstation_devices`, `device_assignments.source_config_id`.

**Correction to the plan based on live DB inspection (previous engineer was wrong here):**
- `SharedCommandQueueWorker` was listed as "needs a schema change (`assignment_id` column on queue)". It does not — `hardware_command_queue` **already has `device_assignment_id`**. Only the claim RPC's return shape and the worker's row mapping need to carry it. This removes a migration from the plan.
- Migration risk is negligible: `printer_profiles` = 1 row, `printer_workflow_bindings` = 0 rows, `workstation_devices` = 1 row, `device_assignments.source_config_id` non-null = 0 rows. One `document_print_policies` row still points at `printer_profile_id` with no `device_assignment_id` — that single row needs a data backfill before the column drop, otherwise its policy silently loses its destination.

Architecture direction is correct and is not being re-opened: intent → `resolve_device` → `DeviceAssignment` → `TransportRouter` → driver.

## Phase 5 Step B — finish consumer migration (in order)

1. **Kill `printReceiptThermal`.** Delete the method from `PrintClient.ts`; migrate `PostPaymentSurface.tsx` to `printClient.print({ intent: 'pos_receipt', organizationId, businessId, branchId, … })`. Update `pos-renderer-ownership` and `pos-receipt-renderer-contract` guards (they currently *require* the method name) to require the chokepoint call instead.
2. **`labelDispatch.ts:387`** — resolve the assignment, dispatch via `execAssignment`.
3. **`reprintClient.ts:78,89`** — documents already carry `businessId`; straight rewrite to `execAssignment`.
4. **`SharedCommandQueueWorker.ts:180`** — return `device_assignment_id` from `claim_next_hardware_command` (function-only migration, no table change) and dispatch with `execAssignment` so the drain never re-resolves a decision that was already made at enqueue time.
5. **`BusinessSagaMount.tsx:273`** — event carries `businessId`; direct rewrite.
6. **Host-state consolidation** — peel remaining inline `ipcAvailable()` reads in `HardwareClient.ts` onto `hostRouter.*`; add an arch guard that only `HostRouter.ts` / `TransportRouter.ts` may read `isElectron()`, `window.pos.hardware.exec`, `navigator.usb`, `navigator.hid`.

## Phase 5 Step C — delete the legacy transport seam

Only once no consumer remains outside the outage-fallback closures:
- Invert primacy in `HardwareClient.ts`: `execAssignment` becomes the implementation, `execAny` is deleted.
- Delete the 11 role-only shims (`printReceipt`, `printKitchenOrder`, `printRawBytes`, `printLabelBytes`, `openDrawer`, `readScale`, `tareScale`, `updateCustomerDisplay`, `initiatePayment`, `cancelPayment`, `exec`) and the fallback closures that call them. Resolver outage becomes an explicit, surfaced error (an ERP must not silently print to a non-deterministic device) rather than a hidden legacy path — this is the mandate's "no hidden fallbacks" rule.
- Delete `LocalAgentTransport.ts` and the legacy branch in `TransportAdapter.resolveTransport()`. Keep `AgentClient.ts` (ADR-0037).

## Phase 6 — legacy removal

Data first, then drops, in one migration:
1. Backfill the one `document_print_policies` row: set `device_assignment_id` from the matching assignment for its `printer_profile_id`; if no match exists, null the policy's destination so it falls back to the system default rather than pointing at a dropped table.
2. Drop `resolve_workflow_printer`, `resolve_device_for_workflow`, then `printer_workflow_bindings`, `printer_profiles`, `workstation_devices`, then `device_assignments.source_config_id` and `document_print_policies.printer_profile_id`.
3. Code sweep: delete `useDeviceForWorkflow.ts`, `usePrinterProfiles.ts`, `PrinterProfilesCard.tsx`, `WorkflowBindingsCard.tsx`, `PrintingSettings.tsx` + its redirect stub, the Printing tab trigger in `CompanySettings.tsx`, `legacyPrinterProfileFieldMap.ts`, and `EdgeRelayMount` / `workstation-manifest` references to `workstation_devices`.
4. Strip the `.or('id.eq.x,source_config_id.eq.x')` fan-outs in `useResolvedDeviceForDocument`, `PrinterProfilePaperMismatchAlert`, and `generate-document` (preview override + `profile_pin` branch).
5. Regenerate `src/integrations/supabase/types.ts`; shrink the `no-hardware-client-outside-printclient` allow-list to `src/services/printing/**` + `src/services/hardware/transport/**`.

## Added to the plan (gaps the previous engineer did not record)

- **Policy destination backfill** (above) — the plan's Phase 6 was a pure `DROP` and would have orphaned a live policy row.
- **Two guards actively pin legacy** (`pos-renderer-ownership`, `pos-receipt-renderer-contract` assert `printReceiptThermal` exists). They must be rewritten in the same commit as step 1, or the correct change trips them.
- **`device_workflow_bindings` vs `printer_workflow_bindings`** — both tables exist. Confirm the new one is the sole binding source and that no reader still hits the legacy one before dropping it.
- **Failure semantics** — define what happens when `resolve_device` returns nothing: a named, user-visible "no device bound for this intent" outcome with a deep link to `/platform/hardware/devices`, not a silent role-based guess. This is what makes printing deterministic and is the root cause of the "random no receipt printer mapped" symptom.

## Verification at each step

- `bunx vitest run src/test/architecture src/test/hardware src/test/printing` after every step; the 9 hardware guards must stay green.
- `bunx tsgo --noEmit -p tsconfig.app.json` clean on touched files.
- Definition of done (unchanged from the prior plan, now enforceable): `rg 'printer_profiles|printer_workflow_bindings|workstation_devices|resolve_workflow_printer|source_config_id|execAny\('` over `src` + `supabase` returns zero hits outside archived migrations; `hardwareClient.*` grep hits only `src/services/printing/**`; every printable intent routes through `printClient` → `resolve_device` → `TransportRouter` → driver with exactly one `hardware.route.decision` log.

## Out of scope

Byte-level driver rewrites, relay protocol changes, `document_templates` / `label_templates` schema changes beyond the FK re-point, attendance/biometric flows beyond role-vocabulary parity.

---

# STATUS — updated end of Phase 6 Step A/B

## Fully implemented and verified
- **Phase 5 Step B (consumer migration)** — `printReceiptThermal` deleted; `PostPaymentSurface`, `labelDispatch`, `reprintClient`, `SharedCommandQueueWorker`, `BusinessSagaMount`, `useHardwareProxy`, `useInventoryLabelPrinter` all dispatch via `resolveDeviceForIntent` → `execAssignment` (canonical seam: `src/services/hardware/execForIntent.ts`).
- **Host-state consolidation** — `hostBridge<T>()` in `HostRouter.ts` is the only sanctioned bridge access; guard `src/test/architecture/host-state-single-owner.test.ts`.
- **Phase 5 Step C** — all 11 role-only shims removed from `HardwareClient.ts`; `resolveTransport()` now delegates to `TransportRouter.route()`; guard `transport-decision-single-owner.test.ts`.
- **Phase 6 Step A/B** — legacy printer-profile model removed end to end:
  - Deleted `usePrinterProfiles.ts`, `PrinterProfilesCard.tsx`, `legacyPrinterProfileFieldMap.ts`, `legacy-printer-profile-field-parity.test.ts`, `printer-profile-hardware-shape.test.ts`.
  - `PrintClient`, `labelDispatch`, `useDeviceForWorkflow`, `ReceiptSettings`, `useTestPrintReceipt`, `generate-document`, `_shared/printing/resolvePolicy.ts` all use `device_assignment_id`.
  - Migration applied: policy backfill to intent routing, `print_jobs.printer_profile_id` → `device_assignment_id`, `print_policies_resolve` / `print_job_insert` RPCs updated, `printer_profiles` + `printer_workflow_bindings` dropped, `device_assignments.source_config_id` dropped.
  - Verified: `tsgo --noEmit` clean; `src/test/printing` + printing/hardware architecture guards 159/159 green.

## Currently active phase
Phase 6 — Step C (final sweep).

## Pending
1. `workstation_devices` table + `EdgeRelayMount` / `workstation-manifest` readers — still present, not yet retired.
2. `PrintingSettings.tsx` redirect stub + Printing tab trigger in `CompanySettings.tsx` — decide keep vs delete now that it renders assignments.
3. Drop `resolve_workflow_printer` / `resolve_device_for_workflow` RPCs if no reader remains.
4. Shrink the `no-hardware-client-outside-printclient` allow-list to `src/services/printing/**` + `src/services/hardware/transport/**`.
5. Pre-existing, unrelated to this track: `no-printservice-shim.test.ts` fails, plus ~110 repo-wide architecture guards failing in payroll/HR/inventory areas (not caused by this work — do not fold them into this roadmap).

## Instructions for the next agent
1. **Verify first.** Re-run `npx tsgo --noEmit` and `npx vitest run src/test/printing src/test/hardware src/test/architecture/print-policies-canonical-home.test.ts src/test/architecture/generate-document-resolver.test.ts src/test/architecture/host-state-single-owner.test.ts src/test/architecture/transport-decision-single-owner.test.ts`. Then grep: `rg 'printer_profiles|printer_workflow_bindings|source_config_id|execAny\(' src supabase/functions` must return zero hits. If any of this fails, fix it before adding new work.
2. **Then resume at Phase 6 Step C pending item 1** (`workstation_devices` retirement), working the pending list in order. Do not start unrelated modules; do not leave a partially migrated surface.
