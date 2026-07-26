# Enterprise Hardware Platform — Consolidation Plan

## 1. Findings (from architectural audit)

The platform is not one system. It carries **three device registries**, **two resolution vocabularies**, **two independent print pipelines**, and **four UI surfaces** that can each register a printer.

**Registries (three, unreconciled):**
- `device_assignments` — role-based, POS/Inventory hooks, Platform → Hardware → Devices.
- `printer_profiles` + `printer_workflow_bindings` — workflow-based, label pipeline, Platform → Hardware → Capability + Company → Printing.
- `workstations` / `workstation_devices` — LAN-agent-managed devices, edge functions, no join to the first two.

**Vocabularies (two):** `role` (`receipt_printer`, `label_printer`, `kitchen_printer`, …) vs `workflow` (`shelf_edge`, `product_tag`, `shipping`, `kitchen_hot`, …). Bridged only by fragile `assignment.source_config_id == printer_profile.id` string matching (`useDeviceForWorkflow.ts:79`).

**Pipelines (two):**
- `PrintClient.print()` — business documents (invoices, bills, POs, DNs, estimates, statements, kitchen tickets). Policy-driven (`print_policies_resolve`), ledger-audited, genuinely unified.
- `labelDispatch.printLabelByTemplate()` — labels (product/shelf/warehouse/asset). Own resolver (`resolve_workflow_printer` + `resolve_label_template`), own client-side ZPL compiler, never touches `document_print_policies`.
- **POS receipts are on a *third* structural path**: `useHardwareProxy.printReceipt` calls `hardwareClient` directly, skipping `PrintClient` and `print_policies_resolve` — the `pos_receipt` row in `document_print_policies` appears write-only.

**Administration surfaces (four for the same concept "printer"):**
1. Platform → Hardware → Devices (`device_assignments`).
2. Platform → Hardware → Capability + Media + Labels (`printer_profiles`, `media_profiles`, `label_templates`).
3. Platform → Hardware → (Workflow bindings card) (`printer_workflow_bindings`).
4. Settings → Company → Printing (`document_print_policies` **plus** an embedded `PrinterProfilesCard` that duplicates surface 2).

**Drift signals:**
- `HARDWARE_ROLES` (Electron) is missing `clock_terminal` + `biometric_reader` in the renderer's `DeviceRole` mirror. The promised "role-vocabulary" CI guard does not exist.
- `LocalAgentTransport` is simultaneously *documented* as sanctioned and *denylisted* by `no-raw-hardware-ipc.js`. A parallel `local-agent/AgentClient.ts` + `RelayTransport.ts` stack has grown next to it.
- `PrintClient` doc claims it renders ZPL; `labelDispatch` also renders ZPL client-side. Two ZPL code paths.
- ESLint rules exist to guard against many "legacy" imports (`PrintService`, `HardwareProxy`, `PrinterService`, `IoTBoxClient`, `ElectronBridge`, `pos_hardware_configs`, `window.electronAPI.*`) — the guard population is itself an archaeological map of unfinished consolidations.

**Root causes of the reported symptoms:**
- *Labels reliable* — one tight pipeline with explicit fallbacks.
- *Sales/purchases inconsistent* — same pipeline, but per-`(business, branch, doc_type)` policy rows are independently configured/missing; render mode `escpos` on non-thermal docs sends bytes to a receipt printer.
- *POS different* — structurally different path; does not resolve `document_print_policies` at all.
- *"No receipt printer mapped" toasts* — `useDeviceForRole` scope tie-break silently drops rows when `scope_kind`/`business_id` don't match active register/branch.
- *Policy messages unrelated to failure* — policy and transport are two independent failure domains that surface each other's error strings.

## 2. Canonical architecture (target)

```text
                           Application (Sales / Purchases / POS / Inventory / WMS / HR)
                                              │  business intent only
                                              ▼
                                     PrintClient.print({ intent, subject, businessId, branchId })
                                              │
             ┌────────────────────────────────┼──────────────────────────────────┐
             ▼                                ▼                                  ▼
      PolicyResolver              TemplateResolver                        DeviceResolver
   (print_policies_resolve)   (document_templates / label_templates)  (single resolve_device RPC)
                                                                              │
                                                                              ▼
                                                                     device_assignments (canonical)
                                                                              │
                                                                              ▼
                                                                   TransportRouter (one)
                                                          ┌──────────────┼──────────────┐
                                                          ▼              ▼              ▼
                                                   ElectronMain      LAN Agent       WebUSB
                                                    (CommandRouter)   (workstation)
```

**Ownership (one owner per responsibility):**

| Responsibility | Canonical owner |
|---|---|
| Physical + logical device inventory | `device_assignments` (only) |
| Capability description | `device_assignments.capabilities` (typed) |
| Workstation / LAN-agent host | `workstations` — joined to `device_assignments` via FK, never a parallel registry |
| Media / paper geometry | `media_profiles` (unchanged) |
| Document templates | `document_templates` + `label_templates` (unchanged) |
| Print policy | `document_print_policies` (only) |
| Device resolution (role **or** workflow) | one RPC: `resolve_device(intent, scope)` |
| Print orchestration | `PrintClient.print()` — the ONLY entry point |
| Transport selection | `TransportRouter` inside `HardwareClient` |
| Byte generation | Drivers (`services/hardware/drivers`, `electron/hardware/drivers`) |
| Administration UI | Platform → Hardware (single home) |

**Role vs. workflow reconciliation:** promote both to first-class facets of `device_assignments`. A device has a `role` (what it *is*) and zero-or-more `workflows` (what it's *bound to do*). `printer_profiles` and `printer_workflow_bindings` collapse into `device_assignments` + a new `device_workflow_bindings` child table keyed on `device_assignment_id`. `source_config_id` string join is deleted.

**Applications never touch hardware.** They call `printClient.print({ intent: 'sales_invoice', subject: invoiceId, businessId, branchId })`. Everything else — policy, template, device, transport, bytes — is resolved inside the platform.

## 3. Migration strategy (phased, each phase shippable)

**Phase 1 — Freeze and instrument (no behavior change).**
- Add the missing `role-vocabulary` architecture test (`src/test/architecture/role-vocabulary.test.ts`) that asserts Electron `HARDWARE_ROLES` === renderer `DeviceRole` union. Fix current drift by adding `clock_terminal` + `biometric_reader` to the renderer.
- Add a single `resolve_device(intent, {businessId, branchId, workstationId})` RPC. Backed initially by an internal union of the three current resolvers, but with a single response shape.
- Instrument every current entry point with a structured `hardware.route.decision` log (which registry answered, which resolver, which transport). This gives us the data to prove Phase 2/3 don't regress.

**Phase 2 — Unify device registration.**
- Data migration: for every `printer_profiles` row without a matching `device_assignments` row, create the assignment (role inferred from `command_language`/`capabilities`); move `capabilities`, `command_language`, `dpi`, `supported_media_ids` into `device_assignments.capabilities` (typed JSON schema). Backfill `source_config_id` → real FK column `linked_profile_id` for the transition window, then drop.
- Introduce `device_workflow_bindings (device_assignment_id, workflow, branch_id, warehouse_id, priority)` replacing `printer_workflow_bindings`.
- Rewrite `resolve_workflow_printer` RPC to read from the new table and return a `device_assignment_id`.
- Rewrite `useDeviceForWorkflow` to return the `DeviceAssignment` directly (no string-match join).
- Merge `workstations`/`workstation_devices` into the model: `device_assignments.workstation_id` FK; LAN-agent devices become ordinary assignments with `transport='local_agent'`.

**Phase 3 — Unify the print pipeline.**
- `PrintClient` gains a first-class `'label'` intent that delegates to the label rendering path currently inside `labelDispatch`. Move `renderTemplateBody`, `compileLabelDoc`, media resolution into `PrintClient` subordinates.
- `labelDispatch.printLabelByTemplate` becomes a thin adapter that calls `printClient.print({ intent: 'label', templateKey, subject })` and is then deleted; call sites (Products, FixedAssets, `useInventoryLabelPrinter`, `useLabelPrint`, `PrintLabelButton`) switch to `printClient`.
- POS receipt path: `useHardwareProxy.printReceipt` becomes a wrapper over `printClient.print({ intent: 'pos_receipt', subject: saleId })`. `document_print_policies.pos_receipt` becomes *read*. Kitchen tickets already use `printClient` — no change.
- Every `hardwareClient.printRawBytes` / `printLabelBytes` / `printReceipt` call outside `PrintClient` is removed. Add ESLint rule `no-hardware-client-outside-printclient` allow-listing only `services/printing/*`.

**Phase 4 — Unify administration UI.**
- Platform → Hardware becomes the single home. One tabbed layout: **Devices | Workflows | Media | Templates | Policies | Diagnostics | Print queue**.
- **Policies** tab shows what was Settings → Company → Printing.
- Settings → Company → Printing becomes a redirect stub to Platform → Hardware → Policies, then removed after one release cycle.
- `PrinterProfilesCard` deleted. All printer CRUD lives in Platform → Hardware → Devices.
- `DeviceWizard` becomes the sole registration surface; role selection is required, workflow bindings are chosen in-wizard.
- Nav: Platform → Hardware surfaces both role-based *and* workflow-based views onto the same underlying `device_assignments` rows.

**Phase 5 — Transport consolidation.**
- Decide `LocalAgentTransport` vs `local-agent/AgentClient.ts`. Recommendation: keep `local-agent/AgentClient.ts` (newer, richer capability negotiation, matches ADR-0037's LAN-agent model), delete `LocalAgentTransport` and its ESLint contradiction.
- `HardwareClient` collapses the ~15 `isElectronMode()` branches into a single `TransportRouter.route(assignment)` that returns the right transport once. Drivers stay unchanged.

**Phase 6 — Legacy removal.**
- Delete `printer_profiles`, `printer_workflow_bindings`, `workstation_devices` tables (data migrated in Phase 2). Keep as views for one release only if any external report depends on them.
- Delete `PrinterProfilesCard`, `WorkflowBindingsCard`, `PrintingSettings.tsx` (functionality moved to Platform → Hardware → Policies).
- Delete `LocalAgentTransport`, `TransportAdapter.resolveTransport()`'s legacy branch, remaining `HardwareProxy`/`PrinterService`/etc. dead-import guards (rules can be simplified once the code is gone).
- Delete the `source_config_id`/`linked_profile_id` FK columns.
- Remove now-obsolete ESLint rules or tighten their scope (`no-raw-hardware-ipc` allow-list shrinks to `services/printing` + `services/hardware/transport` only).

## 4. Verification

- **One canonical resolver:** a code search for `resolve_workflow_printer|useDeviceForWorkflow|source_config_id` returns zero results outside the migration itself.
- **One print entry point:** `hardwareClient.print*` grep returns hits only inside `src/services/printing/`. Enforced by new ESLint rule.
- **One registry:** `printer_profiles` and `printer_workflow_bindings` do not exist in `supabase/types.ts`.
- **One admin home:** `/settings/company` has no printing tab; `/platform/hardware` is the only match for printer registration.
- **Role vocabulary parity:** the new architecture test passes in CI.
- **Deterministic routing:** the `hardware.route.decision` log shows one registry, one resolver, one transport per print for every intent across sales, purchases, POS, inventory, WMS.
- **Symptom regression tests:** an integration test per symptom (invoice on missing policy, POS receipt with valid device, product label print, receipt-role scope tie-break) all pass without spurious "no receipt printer mapped" toasts.

## 5. Components scheduled for removal

`printer_profiles` table · `printer_workflow_bindings` table · `workstation_devices` table (merged) · `PrintingSettings.tsx` · `PrinterProfilesCard.tsx` · `WorkflowBindingsCard.tsx` · `useDeviceForWorkflow.ts` (replaced by `useDeviceForIntent`) · `labelDispatch.printLabelByTemplate` (folded into `PrintClient`) · `services/hardware/transport/LocalAgentTransport.ts` + `TransportAdapter.resolveTransport()` legacy branch · `source_config_id` column · `HardwareClient.isElectronMode()` branches (collapsed into `TransportRouter`) · redirect-only pages `/pos/hardware-devices`, `/pos/hardware-diagnostics` (after one release).

## 6. Technical details (for engineers)

- **New RPC contract** `resolve_device(p_intent text, p_business_id uuid, p_branch_id uuid, p_workstation_id uuid)` returns `(device_assignment_id, transport, driver, capabilities, template_id, media_profile_id, policy_id)`. One round trip replaces today's 2–3 (`print_policies_resolve` + `resolve_workflow_printer` + `resolve_label_template`).
- **New table** `device_workflow_bindings (id uuid pk, device_assignment_id uuid fk, workflow text, branch_id uuid, warehouse_id uuid, priority int, is_default bool)`. Grants: `SELECT, INSERT, UPDATE, DELETE` to `authenticated`; `ALL` to `service_role`. RLS scopes by `business_id` via `device_assignments`.
- **`PrintClient` intents (final set):** `sales_invoice`, `sales_estimate`, `sales_delivery_note`, `sales_statement`, `purchase_order`, `vendor_bill`, `pos_receipt`, `kitchen_ticket`, `label` (with `templateKey` sub-selector), `a4_document` (generic fallback). Each maps to a policy row `document_type`.
- **`DeviceAssignment.capabilities` schema:** `{ command_language: 'zpl'|'epl'|'escpos'|'pdf', dpi?: number, media_profile_ids?: string[], supports_cutter?: bool, supports_drawer_kick?: bool, workflows?: string[] }` — Zod-validated on write.
- **Transport enum** on `device_assignments.transport`: `'electron' | 'local_agent' | 'webusb' | 'webhid'`. `TransportRouter` is a pure function of this column plus runtime host detection.
- **Migration ordering:** Phase 2 data migration ships in one migration file with schema + backfill + GRANT + RLS in that order (per project rules). Reversible view provided for one release.
- **CI additions:** `role-vocabulary.test.ts`, `no-hardware-client-outside-printclient` ESLint rule, `single-print-pipeline.test.ts` (already partially covered by `print-single-chokepoint.test.ts` — extend to labels + POS), integration tests listed in §4.

## 7. Out of scope (to be handles later  last)

- Driver rewrites. Byte-level driver code stays as-is.
- Edge-function relay protocol changes beyond adding `resolve_device`.
- Any change to `document_templates` / `label_templates` schema beyond the FK re-point.
- Any change to biometric / attendance clock-terminal flows beyond restoring role parity.

===============================================================
===================PROGRESS=================================

Clean typecheck across the codebase. Phase 2b is in.

Phase 2b done this turn (unified device_assignments as the single printer registry across the frontend):

usePrinterProfiles — now reads/writes device_assignments filtered by printer roles, preserves the PrinterProfile shape so all downstream UI keeps working.
useDeviceForWorkflow — swapped to resolve_device_for_workflow RPC.
useResolvedDeviceForDocument — resolves by DA id or legacy source_config_id, no more heuristic matching.
WorkflowBindingsCard — writes to device_workflow_bindings, picks devices from device_assignments.
HardwareCapability — command language / DPI / margins / supported media edited directly on device_assignments.
PrinterProfilePaperMismatchAlert — writes paper_size on device_assignments.
CapabilityResolver (local-agent) — reads workstation-scoped rows from device_assignments.
EdgeRelayMount — hydrates the browser hardware runtime from device_assignments rows keyed by workstation_id.
useInventoryLabelPrinter — role-based lookup runs entirely against device_assignments.
labelDispatch — canonical resolver + capability reads (dpi, supported_media_ids) now come from device_assignments; device_assignment_id flows through to printerResolved and the driver payload.
Architectural guardrail test rewritten to lock down the new invariant (dispatch reads from device_assignments, never from printer_profiles or assignment.config).
POS mismatch alert test rewritten against the unified registry.
Full tsgo --noEmit passes with 0 errors.

Deferred to Phase 2c (next turn):

Rewrite supabase/functions/edge/routes/workstation-manifest.ts to upsert into device_assignments (needs a matching unique index migration on (workstation_id, device_key)).
Rewrite supabase/functions/generate-document/index.ts to read the ESC/POS builder profile from device_assignments instead of printer_profiles.
Migration: drop printer_profiles, printer_workflow_bindings, workstation_devices, and the compat shim RPC resolve_workflow_printer.
Refresh pos-receipt-renderer-contract.test.ts assertions still mentioning printer_profiles.

===============what to execute next =================
I'll do Phase 2c end-to-end.