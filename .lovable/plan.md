# Hardware Platform Consolidation — Continuation Plan

## 0. Verification of prior engineer's claims

The prior plan (`.lovable/plan.md`) declared Phases 1 and 2a/2b complete. Direct inspection confirms most of that is real, but with gaps that must be closed before continuing:

**Confirmed done**
- Frontend hooks (`usePrinterProfiles`, `useDeviceForWorkflow`, `useResolvedDeviceForDocument`, `useInventoryLabelPrinter`, `labelDispatch` resolver, `WorkflowBindingsCard`, `HardwareCapability`, `EdgeRelayMount`) read/write `device_assignments` + `device_workflow_bindings`.
- RPC `resolve_device_for_workflow` exists.
- Architectural guard tests for label dispatch and POS mismatch rewritten against the unified registry.

**Not done despite being in scope**
- Legacy tables `printer_profiles`, `printer_workflow_bindings`, `workstation_devices` still exist (verified via `information_schema`) and are still read by two edge functions.
- Legacy RPC `resolve_workflow_printer` still exists.
- Single unified `resolve_device(intent, scope)` RPC (§6 of prior plan) was never created — only the workflow-scoped variant.
- `source_config_id` FK / string-match column still present on `device_assignments`.
- Role-vocabulary CI test (`role-vocabulary.test.ts`) never added.
- `PrintingSettings.tsx`, `PrinterProfilesCard.tsx`, `WorkflowBindingsCard.tsx`, `LocalAgentTransport.ts`, redirect stubs `/pos/hardware-devices`, `/pos/hardware-diagnostics` still shipped.
- POS receipt path (`useHardwareProxy.printReceipt`) still bypasses `PrintClient` and `document_print_policies`.
- `labelDispatch.printLabelByTemplate` still parallel to `PrintClient` (no `'label'` intent).
- ESLint rule `no-hardware-client-outside-printclient` not added.

## 1. Phase 2c — Server-side registry unification (finish Phase 2)

- Rewrite `supabase/functions/generate-document/index.ts` to read the ESC/POS builder profile (`command_language`, `dpi`, `supported_media_ids`, `paper_size`, cutter/drawer flags) from `device_assignments.capabilities` instead of `printer_profiles`.
- Rewrite `supabase/functions/edge/routes/workstation-manifest.ts` to upsert onto `device_assignments` keyed by `(workstation_id, device_key)`; migration adds the matching unique index.
- Refresh remaining tests still asserting on `printer_profiles` shape (`printer-profile-hardware-shape.test.ts`, `pos-receipt-renderer-contract.test.ts`, `pos-settings-profile-mismatch.test.tsx`, `resolvePaperWidth.ts` usage).
- Add missing `role-vocabulary.test.ts` architectural guard (renderer `DeviceRole` union ≡ Electron `HARDWARE_ROLES`); fix drift by adding `clock_terminal`, `biometric_reader` to renderer.

## 2. Phase 3 — One print pipeline

- Introduce `PrintClient` intent `'label'` (with `templateKey`) that swallows the existing `labelDispatch` responsibilities: template lookup, media resolve, ZPL/EPL compile, device dispatch. Move `renderTemplateBody`, `compileLabelDoc`, geometry helpers into `services/printing/`.
- Reduce `labelDispatch.printLabelByTemplate` to a thin adapter over `printClient.print({ intent:'label', ... })`; migrate call sites (`useInventoryLabelPrinter`, `useLabelPrint`, `PrintLabelButton`, Products, FixedAssets) to `printClient` directly; delete the adapter.
- Route POS receipts through `PrintClient`: `useHardwareProxy.printReceipt` becomes `printClient.print({ intent:'pos_receipt', subject: saleId, businessId, branchId })`. `document_print_policies.pos_receipt` becomes readable, not write-only. Kitchen tickets already through `PrintClient`.
- Add unified `resolve_device(p_intent, p_business_id, p_branch_id, p_workstation_id)` RPC returning `(device_assignment_id, transport, driver, capabilities, template_id, media_profile_id, policy_id)`. Consolidates today's `print_policies_resolve` + `resolve_device_for_workflow` + `resolve_label_template` into one round-trip.
- Rewrite `PrintClient` internals against `resolve_device`. Keep `print_policies_resolve` only as an implementation detail until callers are gone.
- New ESLint rule `no-hardware-client-outside-printclient` — `hardwareClient.print*` allowed only inside `src/services/printing/**`.
- Extend `print-single-chokepoint.test.ts` to cover labels and POS receipts.

## 3. Phase 4 — One administration surface

- Platform → Hardware becomes the single home. Tabs: **Devices | Workflows | Media | Templates | Policies | Diagnostics | Print queue**.
- Move `document_print_policies` UI (currently `PrintingSettings.tsx`) under Platform → Hardware → Policies.
- Delete `PrinterProfilesCard.tsx`, `WorkflowBindingsCard.tsx` (functionality already inside DeviceWizard + Devices tab); consolidate any remaining card content.
- `Settings → Company → Printing` becomes a redirect stub to Platform → Hardware → Policies (removed one release later; tracked in Phase 6).
- `DeviceWizard` is the sole registration surface; role required, workflow bindings selected in-wizard, workstation FK selected in-wizard.
- Retire redirect pages `/pos/hardware-devices` and `/pos/hardware-diagnostics`.

## 4. Phase 5 — Transport consolidation

- Keep `local-agent/AgentClient.ts` (matches ADR-0037). Delete `services/hardware/transport/LocalAgentTransport.ts` + `TransportAdapter.resolveTransport()` legacy branch + the contradictory ESLint denylist entry.
- Collapse the ~15 `isElectron()` branches inside `HardwareClient` into a single `TransportRouter.route(assignment)` keyed off `device_assignments.transport ∈ {electron, local_agent, webusb, webhid}`. Drivers unchanged.
- Add architecture test asserting only `TransportRouter` reads `isElectron()` / runtime host state.

## 5. Phase 6 — Legacy removal (single migration + code sweep)

- Migration: `DROP TABLE printer_profiles CASCADE; DROP TABLE printer_workflow_bindings CASCADE; DROP TABLE workstation_devices CASCADE; DROP FUNCTION resolve_workflow_printer(...); ALTER TABLE device_assignments DROP COLUMN source_config_id;` — provide 1-release compatibility views only if a report depends on them (audit first).
- Delete `PrintingSettings.tsx`, `PrinterProfilesCard.tsx`, `WorkflowBindingsCard.tsx`, `LocalAgentTransport.ts`, `TransportAdapter.resolveTransport` legacy branch, redirect stubs, and the `useDeviceForWorkflow.ts` file (superseded by `useDeviceForIntent` returning full `DeviceAssignment`).
- Tighten / prune ESLint rules whose only reason to exist was the deleted code (`no-raw-hardware-ipc` allow-list shrinks to `services/printing` + `services/hardware/transport`; kill guards for symbols that no longer exist).
- Regenerate `src/integrations/supabase/types.ts`.

## 6. Verification (Definition of Done)

- `rg 'printer_profiles|printer_workflow_bindings|workstation_devices|resolve_workflow_printer|source_config_id' src supabase` returns zero hits outside archived migration files.
- `hardwareClient.print*` grep returns hits only inside `src/services/printing/**` (ESLint-enforced).
- One entry point: every printable intent (sales invoice, sales estimate, delivery note, statement, PO, vendor bill, POS receipt, kitchen ticket, label, generic A4) resolves via `printClient.print` + `resolve_device`.
- Single admin home: `/settings/company` has no printing tab; only `/platform/hardware/*` registers printers.
- Role-vocabulary parity test green.
- Structured `hardware.route.decision` log shows one registry, one resolver, one transport per print across sales / purchases / POS / inventory / WMS.
- Symptom regression tests: invoice on missing policy, POS receipt with valid device, product label print, receipt-role scope tie-break — all pass without spurious toasts.

## 7. Technical details

- `resolve_device` RPC signature and return columns as in prior plan §6; RLS scopes via `device_assignments.organization_id` and existing `has_org_access`.
- `device_workflow_bindings` unchanged from Phase 2b shape; add `is_default bool` if not already present.
- `DeviceAssignment.capabilities` Zod schema: `{ command_language: 'zpl'|'epl'|'escpos'|'pdf', dpi?: number, media_profile_ids?: string[], supports_cutter?: bool, supports_drawer_kick?: bool, workflows?: string[], paper_size?: string }` — validated on write in `usePrinterProfiles` and edge upserts.
- `PrintClient` intent enum finalised: `sales_invoice | sales_estimate | sales_delivery_note | sales_statement | purchase_order | vendor_bill | pos_receipt | kitchen_ticket | label | a4_document`. Each maps 1:1 to a `document_print_policies.document_type` row.
- `transport` column enum: `'electron' | 'local_agent' | 'webusb' | 'webhid'`. `TransportRouter` is a pure function of this + runtime host detection.
- Every schema migration follows the CREATE → GRANT → RLS ENABLE → POLICY order per project rules; drop migration reverses in dependency order.

## 8. Out of scope

- Byte-level driver rewrites.
- Edge-function relay protocol changes beyond the new `resolve_device` RPC.
- `document_templates` / `label_templates` schema changes beyond FK re-point.
- Biometric / attendance flows beyond restoring role parity.

## Progress log — 2026-07-26 (Phase 2c partial)

- `supabase/functions/edge/routes/workstation-manifest.ts`: rewritten to upsert into `device_assignments` (transport = 'local_agent', keyed by `(workstation_id, device_key)`). Legacy `workstation_devices` no longer written by the LAN-agent manifest path. Agent-side roles (`drawer`, `display`, `eft_terminal`, `biometric`) mapped to canonical `HARDWARE_ROLES`; wire-level transport preserved in `config.wire_transport`. Devices missing from a manifest cycle are marked `status='offline'` (scope: same workstation_id + transport='local_agent').
- `supabase/functions/generate-document/index.ts`: both `printer_profiles` reads (preview override + policy-driven physical profile) now read from `device_assignments` with `.or('id.eq.<x>,source_config_id.eq.<x>')` to honour both new and legacy IDs during the Phase 2b mirror window.
- `src/test/architecture/role-vocabulary.test.ts`: new CI guard locking parity between Electron `HARDWARE_ROLES` and renderer `DeviceRole`. Green.
- Typecheck: green. Architecture suite: only pre-existing failures (`no-english-regex-on-readiness-reasons`, `no-printservice-shim` — `PrintPreviewDialog.tsx`) unrelated to this turn.

Next: retire the last `workstation_devices` consumers (agent status endpoints + any remaining edge reads), then land the `resolve_device` RPC (Phase 3 opening).

## Progress log — 2026-07-26 (Phase 3 opening)

- `public.resolve_device(_organization_id, _role, _business_id?, _scope_kind?, _scope_id?)` shipped as `SETOF device_assignments`, `STABLE`, `SECURITY INVOKER`. Mirrors `useDeviceForRole` tie-break exactly (explicit scope > active business > `is_default` > earliest created). Granted `EXECUTE` to `authenticated` + `service_role`. Migration linter surfaced only pre-existing warnings — none introduced by this function.
- Confirmed no runtime consumers of `workstation_devices` remain in the codebase; only doc/comment references survive, so Phase 6 can drop the table without a code sweep.

Next: swap `generate-document` and any POS printer/kitchen dispatch to call `resolve_device` instead of ad-hoc `SELECT ... FROM device_assignments`, then build the client `useDeviceForIntent` façade over the same tie-break contract.

## Progress log — 2026-07-26 (Phase 3 client façade)

- `src/hooks/useDeviceForIntent.ts`: new server-authoritative façade over the `resolve_device` RPC. Exports a canonical `INTENT_TO_ROLE` map (`receipt→receipt_printer`, `kitchen_ticket→kitchen_printer`, `label→label_printer`, `a4_document|packing_slip→a4_printer`) so PrintClient, edge functions, and UI all agree on the intent→role bridge. Query is keyed by `(org, role, businessId, scopeKind, scopeId)` with a 15 s stale window — the resolver is cheap but hot lanes call it once per print. Tie-break lives 100 % on the server; the hook has no local sort.
- `generate-document`'s two ad-hoc `device_assignments` reads intentionally stay ID-driven (policy or preview pins a specific profile) — `resolve_device` is not the right primitive there. The intent-driven swap targets POS dispatch (`useHardwareProxy.printReceipt`) and kitchen-ticket dispatch, planned for the next turn.

Next: route `useHardwareProxy.printReceipt` and the kitchen-ticket dispatch path through `useDeviceForIntent` / `resolve_device`, then start Phase 3's `PrintClient` label intent so `labelDispatch` becomes a thin adapter.

## Progress log — 2026-07-26 (Phase 3 parity guard)

- `src/test/architecture/intent-to-role-parity.test.ts`: locks three invariants on `INTENT_TO_ROLE` — coverage of every `PrintIntent` union member, mapping only into canonical `DeviceRole` values, and no stale entries. Parses the two source files directly (regex over union types with comment stripping) so a drift in either union fails CI immediately. 3/3 tests green.
- Contract now enforced end-to-end: `PrintIntent` ⇢ `INTENT_TO_ROLE` ⇢ `DeviceRole` (also asserted parity with Electron `HARDWARE_ROLES` in the earlier `role-vocabulary.test.ts`), so a new intent cannot ship without a role, and a typo'd role cannot ship at all.

## Progress log — 2026-07-26 (Phase 3 label chokepoint)

- `src/services/printing/PrintClient.ts`: added `printClient.printLabel(input)` — thin façade delegating to `printLabelByTemplate`. Existing consumers (Products, FixedAssets, HardwareDevices, BusinessSagaMount) keep working; new label call sites should reach for `printClient.printLabel` so the single-chokepoint ESLint allow-list can shrink to `src/services/printing/**` in Phase 6 without any per-caller migration. Lazy `import()` of `labelDispatch` avoids circular imports since labelDispatch itself uses `hardwareClient` today.
- Typecheck: green.

Next: migrate the four external `printLabelByTemplate` call sites (Products, FixedAssets, HardwareDevices, BusinessSagaMount) to `printClient.printLabel`, then route `useHardwareProxy.printReceipt` / kitchen dispatch through `resolve_device`.
