# Hardware Platform Consolidation — Continuation

The parent prompt is a multi-week platform program. A prior engineer produced `.lovable/plan.md` with a phased plan (Phase 1 → 6) and executed through Phase 3 Step B. I re-verified the codebase directly rather than trust the log, and I am NOT re-opening the architectural direction — the prior plan already matches how enterprise ERPs model hardware (device registry → capabilities → workflow bindings → intent-based resolver → transport router → drivers), which is the correct target. Re-researching from scratch would delete real progress for no architectural gain.

## Verification of prior claims (done this turn, not trusted)

Confirmed against the tree:

- `resolve_device` RPC present in `src/integrations/supabase/types.ts` (L84586). ✅
- `useDeviceForIntent` + `resolveDeviceForIntent` present; `useHardwareProxy.printReceipt` and `printKitchenOrder` both call `resolveDeviceForIntent` with correct intents and emit `hardware.route.decision` logs. ✅
- `printClient.printLabel` façade exists (`PrintClient.ts:485`); only in-tree `printLabelByTemplate(` callers are `labelDispatch.ts` (definition), `PrintClient.ts` (façade), and negative-assertion tests. No consumer regressions. ✅
- `INTENT_TO_ROLE` parity guard, role-vocabulary guard, POS-receipt resolver guard, products-label-print seam guard all present. ✅

Gaps vs. the log:

- `PrintingSettings.tsx`, `PrinterProfilesCard.tsx`, `WorkflowBindingsCard.tsx` still shipped (Phase 4 not started — as logged).
- `generate-document/index.ts` still uses `.or('id.eq.<x>,source_config_id.eq.<x>')` at L2399 and L3039 for both preview override AND policy-pinned reads (Phase 3 Step C pending — as logged).
- `LocalAgentTransport.ts` + `TransportAdapter` legacy branches still present (Phase 5 pending — as logged).
- Legacy tables `printer_profiles`, `printer_workflow_bindings`, `workstation_devices` and RPC `resolve_workflow_printer` still in generated types → still in DB (Phase 6 pending — as logged).
- `source_config_id` column still on `device_assignments` and read by ~8 files (compat window, planned to drop in Phase 6).

The log matched reality. Resume from the documented handoff.

## Work

### Phase 3C — `generate-document` role-pinned reads → `resolve_device`

Two ad-hoc `device_assignments` reads in `supabase/functions/generate-document/index.ts`:

- **L2391–L2405 (preview override)**: keep ID-driven. Preview explicitly pins a `printer_profile_id`; this is not routing.
- **L3009–L3050 (policy-driven)**: split. If `document_print_policies` row carries only a role hint (no `printer_profile_id`), call `supabase.rpc('resolve_device', { _organization_id, _role, _business_id, _scope_kind: null, _scope_id: null })` and take the first row. If the policy pins a specific profile id, keep the current `.or(...)` fan-out (admin intentionally pinned that physical printer).

Emit a server-side `console.info('[hardware.route.decision]', { intent, role, assignmentId, source: 'policy'|'pin' })` at both branches for the Phase 6 DoD grep.

Add Deno test `supabase/functions/generate-document/index_test.ts` stubbing `supabase.rpc('resolve_device', …)`:
- role-only policy → exactly one `resolve_device` call with the right args.
- id-pinned policy → no `resolve_device` call.

### Phase 4 — Single administration surface

Inventory step FIRST (do not delete before mapping):
1. Grep every importer of `PrintingSettings`, `PrinterProfilesCard`, `WorkflowBindingsCard`, and any route registration for `/settings/company?tab=printing`, `/pos/hardware-devices`, `/pos/hardware-diagnostics`.
2. For each field the old surfaces expose (role, workflow bindings, workstation FK, capability flags, media, policies), confirm `DeviceWizard` + `HardwareDevices` + `HardwareCapability` + `HardwareMedia` + `HardwareLabelTemplates` cover it. Close gaps FIRST — do not delete a surface that carries fields the new UI cannot set.

Then consolidate:
- Move `document_print_policies` editor from `PrintingSettings.tsx` into a new `HardwarePolicies.tsx` tab under `/platform/hardware/policies` (added to `HARDWARE_NAV`).
- `Settings → Company → Printing` becomes a one-line redirect to `/platform/hardware/policies`. Scheduled for removal in Phase 6.
- Delete `PrinterProfilesCard.tsx`, `WorkflowBindingsCard.tsx` (functionality already lives in `DeviceWizard` + Devices tab).
- Delete the `PrintingSettings.tsx` body once the redirect stub is live.
- `DeviceWizard` is the sole registration surface.

### Phase 5 — Transport consolidation

- Introduce `src/services/hardware/transport/TransportRouter.ts`: pure `route(assignment: DeviceAssignment): ITransport` keyed off `device_assignments.transport ∈ {electron, local_agent, webusb, webhid}` + runtime host detection (single `isElectron()` call, encapsulated).
- Rewrite `HardwareClient` so every hardware call goes through `TransportRouter.route(assignment)` — the ~15 scattered `isElectron()` branches collapse to one. Drivers unchanged.
- Delete `services/hardware/transport/LocalAgentTransport.ts` and the legacy `TransportAdapter.resolveTransport()` branch. Retain `AgentClient.ts` (matches ADR-0037).
- Driver-layer targeting-by-assignment-id: `execAny('receipt_printer', …)` in `useHardwareProxy` becomes `exec(assignmentId, …)`, since the resolver already picked the winner. This is the last vestige of role-based routing at the driver seam.
- Architecture test: only `TransportRouter` may reference `isElectron()` / runtime host state.

### Phase 6 — Legacy removal

Single migration + code sweep:

```sql
DROP TABLE printer_profiles CASCADE;
DROP TABLE printer_workflow_bindings CASCADE;
DROP TABLE workstation_devices CASCADE;
DROP FUNCTION resolve_workflow_printer(...);
DROP FUNCTION resolve_device_for_workflow(...);
ALTER TABLE device_assignments DROP COLUMN source_config_id;
```

Code sweep:
- Delete `useDeviceForWorkflow.ts` (superseded by `useDeviceForIntent`), `WorkflowBindingsCard.tsx`, `PrinterProfilesCard.tsx`, `PrintingSettings.tsx`, `LocalAgentTransport.ts`, `TransportAdapter.resolveTransport` legacy branch, `Settings → Printing` redirect stub, `EdgeRelayMount` comment + code that references `workstation_devices`.
- Strip `.or('id.eq.<x>,source_config_id.eq.<x>')` fan-outs in `useResolvedDeviceForDocument`, `PrinterProfilePaperMismatchAlert`, `generate-document` preview override path.
- Regenerate `src/integrations/supabase/types.ts`.
- Tighten ESLint rules whose sole purpose was the deleted code (`no-hardware-client-outside-printclient` allow-list shrinks to `src/services/printing/**` + `src/services/hardware/transport/**`).

### Definition of Done (unchanged from prior plan §6, verified)

- `rg 'printer_profiles|printer_workflow_bindings|workstation_devices|resolve_workflow_printer|source_config_id' src supabase` → zero hits outside archived migrations.
- `hardwareClient.print*` grep hits only `src/services/printing/**` (ESLint-enforced).
- Every printable intent resolves via `printClient.print(...)` + `resolve_device` (labels via `printClient.printLabel` façade).
- Single admin home: `/settings/company` has no printing tab; only `/platform/hardware/*` registers printers or edits policies.
- `hardware.route.decision` structured log fires from exactly one resolver per print across sales / purchases / POS / inventory / WMS.
- Role-vocabulary parity, intent-to-role parity, POS-receipt resolver, products-label-print seam tests all green.

## Out of scope

- Byte-level driver rewrites.
- Edge-function relay protocol changes beyond the `resolve_device` cutover.
- `document_templates` / `label_templates` schema changes beyond FK re-point.
- Attendance / biometric flows beyond role-vocabulary parity.

## Technical notes

- Every schema migration follows CREATE → GRANT → RLS ENABLE → POLICY order. Phase 6 drops reverse in dependency order (bindings → tables → functions → column).
- `resolve_device` signature already shipped: `(_organization_id uuid, _role text, _business_id uuid, _scope_kind text, _scope_id uuid) RETURNS SETOF device_assignments STABLE SECURITY INVOKER`. Reused as-is.
- `PrintIntent` enum stays `sales_invoice | sales_estimate | sales_delivery_note | sales_statement | purchase_order | vendor_bill | pos_receipt | kitchen_ticket | label | a4_document`. `INTENT_TO_ROLE` map is the only bridge.
- Transport enum on `device_assignments`: `'electron' | 'local_agent' | 'webusb' | 'webhid'`. `TransportRouter` is a pure function of that + host detection.

