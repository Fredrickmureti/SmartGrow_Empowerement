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


## Progress log — 2026-07-26 (Phase 3C — generate-document canonical resolver)

- `supabase/functions/_shared/printing/resolvePolicy.ts`: `ResolvedPolicy` now surfaces `device_assignment_id` and `intent` from `document_print_policies`. SYSTEM_DEFAULT + override branch return `null` for both; SELECT widened accordingly. Additive change — `send-document-email`, `renderReport`, and the client `PrintingSettings.tsx` UI consume only paper/render fields so no downstream break.
- `supabase/functions/_shared/printing/intentToRole.ts` (NEW): Deno twin of the client `INTENT_TO_ROLE` map (`receipt→receipt_printer`, `kitchen_ticket→kitchen_printer`, `label→label_printer`, `a4_document|packing_slip→a4_printer`) + `roleForIntent()` helper. Kept minimal so the parity guard in `intent-to-role-parity.test.ts` continues to describe one canonical mapping.
- `supabase/functions/generate-document/index.ts` (policy block, was L3027): rewritten to the canonical chain:
    1. `policy.device_assignment_id` → direct pin (source = `device_pin`).
    2. `policy.printer_profile_id` → legacy pin (source = `profile_pin`, keeps the `.or(id, source_config_id)` fan-out during the Phase 6 mirror window).
    3. `policy.intent` → `supabase.rpc('resolve_device', { _organization_id, _role, _business_id, _scope_kind: null, _scope_id: null })` (source = `intent_role`). Server-authoritative tie-break — identical to `useHardwareProxy.printReceipt` / `useDeviceForIntent`.
  Emits one `console.info('[hardware.route.decision]', { surface: 'generate-document', documentType, source, assignmentId, intent })` per resolved policy → the Phase 6 DoD grep now succeeds across sales / purchases / POS / inventory / WMS.
- Preview-override branch (L2388) intentionally left ID-driven: preview pins a specific `printer_profile_id`; that is not routing.
- Pre-existing tsgo errors from the last turn (`useOrganization().organization` — the hook actually returns `currentOrg`) fixed in `src/hooks/useDeviceForIntent.ts` and `src/hooks/hardware/useHardwareProxy.ts`. These blocked build:dev.
- `src/test/architecture/generate-document-resolver.test.ts` (NEW): 5-test source-inspection guard — device_pin > profile_pin ordering, `resolve_device`/`roleForIntent` presence, `hardware.route.decision` emission, `.or(...)` fan-out gated behind `profile_pin` only, no `resolve_device` in the preview-override neighbourhood. 5/5 green alongside `pos-receipt-resolver`, `role-vocabulary`, `intent-to-role-parity` (13/13 total).

## Phase status (2026-07-26 · end of Phase 3)

- [x] Phase 1, 2a/2b/2c — done.
- [x] Phase 3 (opener + client façade + label chokepoint + Steps A/B/C) — **COMPLETE**. Every printable intent — labels, POS receipts, kitchen tickets, and every policy-driven PDF/ESC-POS document — now routes through one server-authoritative `resolve_device` chain and emits one `hardware.route.decision` log line per print.
- [ ] Phase 4 — UI consolidation.
- [ ] Phase 5 — Transport consolidation.
- [ ] Phase 6 — Legacy removal.

## Handoff — next agent (Phase 4)

**Verify first (do not trust this log — check):**
1. `bunx vitest run src/test/architecture/generate-document-resolver.test.ts src/test/architecture/pos-receipt-resolver.test.ts src/test/architecture/intent-to-role-parity.test.ts src/test/architecture/role-vocabulary.test.ts` → all green (13 tests).
2. `bunx tsgo --noEmit` → clean (Phase 3C also unblocked the pre-existing `useOrganization().organization` errors).
3. `rg -n "supabase\.rpc\(\s*['\"]resolve_device['\"]" src supabase/functions` — hits limited to `useDeviceForIntent.ts`, `useHardwareProxy.ts`, and `generate-document/index.ts`. Any other hit means someone bypassed the façade.

**Then open Phase 4 with an INVENTORY step (do NOT delete before mapping):**

Step 1 (inventory): grep every consumer of the three legacy admin surfaces:
- `rg -n "PrinterProfilesCard|WorkflowBindingsCard|PrintingSettings" src` — record every importer and every route that mounts them.
- For each field these surfaces expose (role, workflow bindings, workstation FK, capability flags, media, policies), confirm the new home under `/platform/hardware/*` covers it: `DeviceWizard`, `HardwareDevices`, `HardwareCapability`, `HardwareMedia`, `HardwareLabelTemplates`. If gaps exist, CLOSE them BEFORE deleting the old surfaces.

Step 2 (policies tab): move the `document_print_policies` editor from `src/components/settings/PrintingSettings.tsx` into a new `src/apps/platform/hardware/HardwarePolicies.tsx` tab. Add `{ to: "/platform/hardware/policies", label: "Print policies", icon: FileText }` under the "Insights" (or a new "Policy") group in `HARDWARE_NAV`. Register the route in `src/apps/platform/hardware/routes.tsx`.

Step 3 (redirect + delete): `Settings → Company → Printing` becomes a one-line redirect to `/platform/hardware/policies` (`<Navigate to="/platform/hardware/policies" replace />`). Delete `PrinterProfilesCard.tsx` and `WorkflowBindingsCard.tsx` (their content already lives in `DeviceWizard` + Devices tab). Delete the body of `PrintingSettings.tsx`; keep only the redirect shim until Phase 6 removes the shim itself.

**Do not** touch `HardwareClient`'s `isElectron()` branches (Phase 5) or DROP legacy tables (Phase 6) until Phase 4 has removed the last UI writers.
