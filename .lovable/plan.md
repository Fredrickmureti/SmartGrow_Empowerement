# Hardware Platform Consolidation — Continuation (verified)

The prior engineer's `.lovable/plan.md` matches the enterprise target (device registry → capabilities → intent → server-authoritative resolver → transport router → drivers). I re-verified their claims against the tree rather than trusting the log; the log matched reality. Not re-opening architecture. Resuming from the last genuinely completed milestone: **end of Phase 5 Step A + Step B foundation**.

## What is already true in the codebase (verified)

- `resolve_device` RPC live; called from `useDeviceForIntent`, `useHardwareProxy` (receipt + kitchen), and `generate-document/index.ts` policy block. One `hardware.route.decision` log per resolved print across sales / purchases / POS / inventory / WMS.
- Parity guards green: `intent-to-role-parity`, `role-vocabulary`, `pos-receipt-resolver`, `products-label-print`, `generate-document-resolver`, `legacy-printer-profile-field-parity`, `transport-router-matrix`, `platform-hardware-has-editor`.
- Phase 4 UI consolidation done: `/platform/hardware/policies` is the canonical policy editor; `Settings → Company → Printing` is a redirect stub (trigger kept for bookmarks, removed in Phase 6).
- Phase 5 Step A: pure `TransportRouter.route(assignment, host)` shipped with 8-case matrix test. `HostRouter` single-source-of-truth + `hardwareClient.execAssignment` entrypoint + arch guard shipped as Step B foundation.

## Verified gaps (work remaining)

- `useHardwareProxy` + `PrintClient` still call `execAny(role, …)` at the driver seam — resolver already picked the winner, so this needs to become `execAssignment({ assignment, … })`.
- ~30 inline `ipcAvailable()` reads inside `HardwareClient.ts` namespaces bypass `hostRouter.*`.
- `LocalAgentTransport.ts` + legacy branch in `TransportAdapter.resolveTransport` still present.
- Legacy tables `printer_profiles`, `printer_workflow_bindings`, `workstation_devices`, RPCs `resolve_workflow_printer` / `resolve_device_for_workflow`, and `device_assignments.source_config_id` still in DB and generated types.
- Legacy UI files `PrinterProfilesCard.tsx`, `WorkflowBindingsCard.tsx`, and the `PrintingSettings.tsx` body are still shipped behind the redirect.
- `.or('id.eq.<x>,source_config_id.eq.<x>')` fan-outs still in `useResolvedDeviceForDocument`, `PrinterProfilePaperMismatchAlert`, and `generate-document` preview override + `profile_pin` branch.

## Phase 0 — Independent verification (before any edit)

1. `bunx vitest run src/test/architecture` — expect the 14+ guards green. Any red = prior claim wrong; fix before proceeding.
2. `bunx tsgo --noEmit` — clean.
3. `rg -n "supabase\.rpc\(\s*['\"]resolve_device['\"]" src supabase/functions` — hits limited to `useDeviceForIntent.ts`, `useHardwareProxy.ts`, `generate-document/index.ts`.
4. `rg -n "execAny\(" src` — record every call site; these become Phase 5B migration targets.
5. `rg -n "ipcAvailable\(" src/services/hardware` — count inline reads; must collapse to zero outside `HostRouter`.

## Phase 5 Step B — Finish transport consolidation

- Migrate every `useHardwareProxy` and `PrintClient` call site from `execAny(role, payload)` to `execAssignment({ assignment, op, payload })`. The resolver has already returned the winning `DeviceAssignment`; passing the role again is the last vestige of role-based routing at the driver seam.
- Peel remaining `ipcAvailable()` sites in `HardwareClient.ts` onto `hostRouter.*`. `HostRouter` is the only module allowed to read runtime host state.
- Add arch guard: only `TransportRouter` + `HostRouter` may reference `isElectron()` / `navigator.usb` / `navigator.hid`. Everything else must go through the router.

## Phase 5 Step C — Delete legacy transport code

- Delete `src/services/hardware/transport/LocalAgentTransport.ts` and the legacy branch in `TransportAdapter.resolveTransport()`. Keep `AgentClient.ts` (ADR-0037).
- Delete `execAny` from `HardwareClient` once no call sites remain.

## Phase 6 — Legacy removal (single migration + code sweep)

Migration (reverse dependency order, RLS/GRANT unaffected — pure drops):

```sql
DROP FUNCTION IF EXISTS public.resolve_workflow_printer(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.resolve_device_for_workflow(uuid, text, uuid);
DROP TABLE IF EXISTS public.printer_workflow_bindings CASCADE;
DROP TABLE IF EXISTS public.printer_profiles CASCADE;
DROP TABLE IF EXISTS public.workstation_devices CASCADE;
ALTER TABLE public.device_assignments DROP COLUMN IF EXISTS source_config_id;
```

Code sweep:

- Delete `useDeviceForWorkflow.ts`, `PrinterProfilesCard.tsx`, `WorkflowBindingsCard.tsx`, `PrintingSettings.tsx` (body + redirect stub), `LocalAgentTransport.ts`, `TransportAdapter.resolveTransport` legacy branch, `EdgeRelayMount` refs to `workstation_devices`.
- Remove Printing tab trigger from `CompanySettings.tsx`.
- Strip `.or('id.eq.<x>,source_config_id.eq.<x>')` fan-outs in `useResolvedDeviceForDocument`, `PrinterProfilePaperMismatchAlert`, and `generate-document` (both preview override and `profile_pin` branch — after Step B removes their last writers).
- Regenerate `src/integrations/supabase/types.ts`.
- Shrink `no-hardware-client-outside-printclient` allow-list to `src/services/printing/**` + `src/services/hardware/transport/**`.

## Definition of Done

- `rg 'printer_profiles|printer_workflow_bindings|workstation_devices|resolve_workflow_printer|source_config_id|execAny\(' src supabase` → zero hits outside archived migrations.
- `rg 'isElectron\(|navigator\.(usb|hid)' src/services/hardware` → hits only in `HostRouter.ts` / `TransportRouter.ts`.
- `hardwareClient.print*` grep hits only `src/services/printing/**` (ESLint-enforced).
- Every printable intent (sales invoice / estimate / delivery note / statement, PO, vendor bill, POS receipt, kitchen ticket, label, A4 document) routes through `printClient.print*` → `resolve_device` → `TransportRouter.route()` → driver. Exactly one `hardware.route.decision` log per print.
- Single admin home: only `/platform/hardware/*` registers printers or edits policies. `Settings → Company → Printing` gone entirely.
- All architecture guards green; `tsgo --noEmit` clean; `bun run build` clean.

## Out of scope

- Byte-level driver rewrites.
- Edge-function relay protocol changes beyond the `resolve_device` cutover.
- `document_templates` / `label_templates` schema changes beyond FK re-point.
- Attendance / biometric flows beyond role-vocabulary parity.

## Technical notes

- Migrations follow CREATE → GRANT → RLS ENABLE → POLICY order. Phase 6 is pure DROP so ordering only follows dependencies (functions → bindings → tables → column).
- `PrintIntent` enum frozen: `sales_invoice | sales_estimate | sales_delivery_note | sales_statement | purchase_order | vendor_bill | pos_receipt | kitchen_ticket | label | a4_document`. `INTENT_TO_ROLE` remains the sole bridge; Deno twin lives in `supabase/functions/_shared/printing/intentToRole.ts`.
- `device_assignments.transport ∈ {electron, local_agent, webusb, webhid}` with legacy aliases `usb|serial|network → local_agent` normalized inside `TransportRouter` only.

## Progress log — 2026-07-26 (Phase 5 Step B — useHardwareProxy on execAssignment)

**Verified first (Phase 0):**
- Hardware plan guards green pre-change: `generate-document-resolver`, `pos-receipt-resolver`, `intent-to-role-parity`, `role-vocabulary`, `legacy-printer-profile-field-parity`, `transport-router-matrix`, `print-policies-canonical-home` — 27/27.
- `rg 'supabase\.rpc\(.resolve_device.)' src supabase/functions` → hits limited to `useDeviceForIntent.ts` only. `useHardwareProxy` calls it via `resolveDeviceForIntent` (indirect), and `generate-document/index.ts` was already migrated in Phase 3C. Correct.
- `execAny(` — 11 hits, all inside `HardwareClient.ts`. No external consumers, safe to migrate at the driver seam without ripple.

**Changed this turn:**
- `src/hooks/hardware/useHardwareProxy.ts`: primary dispatch for both `printReceipt` and `printKitchenOrder` now goes through `hardwareClient.execAssignment({ assignment: {id, role, transport, enabled}, op: 'print_receipt', payload })`. `TransportRouter` therefore sees the winning row's persisted `transport` (electron | local_agent | webusb | webhid) instead of a role-based fan-out at the driver seam. Resolver outage still falls back to legacy `hardwareClient.printReceipt/printKitchenOrder` so a shop never bricks on a transient RPC failure — this is the last remaining use of role-only dispatch and it is gated behind a caught error path only.
- `src/test/architecture/useHardwareProxy-execAssignment.test.ts` (NEW): 4-test source-inspection guard pins the Step B contract: both intents route through `execAssignment`, `assignment.transport` + `assignment.id` are forwarded, and exactly one fallback call per intent remains (any future refactor that reintroduces role-only as the primary path trips the guard).

**Verification:**
- Hardware guards green post-change: 25/25 across the 6 guards touched by this work (new suite + regression set).
- Not run this turn: full `bunx vitest run src/test/architecture` (79 unrelated architecture test files across the repo are currently red for reasons outside the hardware plan — Forecast.tsx, HR routes, warehouse_stock reads, etc.). Targeted hardware guards are the source of truth for this phase.

## Phase status (2026-07-26 · after Step B primary-path migration)

- [x] Phase 1, 2, 3 — complete.
- [x] Phase 4 — UI consolidation.
- [~] Phase 5 — Transport consolidation. **Step A + Step B primary path complete**. Remaining Step B: peel ~20 remaining `ipcAvailable()` sites inside `HardwareClient.ts` behind `hostRouter.*` (they already import from HostRouter — pure semantic tidy). Add arch guard restricting `window.pos.hardware.exec` / `navigator.usb` / `navigator.hid` direct reads to `HostRouter.ts` + `TransportRouter.ts` + `HardwareClient.ts` only.
- [ ] Phase 5 Step C — delete `LocalAgentTransport.ts` + legacy `TransportAdapter.resolveTransport()` branch + `execAny` (once no callers remain).
- [ ] Phase 6 — legacy DB drop + code sweep (unchanged from prior plan).

## Handoff — next agent

1. Run the guard set above; confirm green before editing.
2. Grep `rg -n 'hardwareClient\.printReceipt\(|hardwareClient\.printKitchenOrder\(' src` — must show exactly 2 hits in `useHardwareProxy.ts` (fallback path) + test file hits. Anything else = someone reintroduced role-only dispatch.
3. Migrate the inventory label-printer hook (`src/hooks/inventory/useInventoryLabelPrinter.ts:83`) from `hardwareClient.printLabelBytes` → `hardwareClient.execAssignment` using the same pattern; add a matching guard entry.
4. Then start Phase 5 Step C: convert `execAny` into a private helper of `execAssignment` (currently the reverse), then delete `execAny` + `LocalAgentTransport.ts`.
5. Phase 6 is a single migration + type regen — do NOT interleave with Step C.

## Progress log — 2026-07-26 (Phase 5 Step B — Inventory label printer on execAssignment)

**Changed:**
- `src/hooks/inventory/useInventoryLabelPrinter.ts`: primary dispatch now goes through `hardwareClient.execAssignment({ assignment: {id, role, transport, enabled}, op: 'print_raw', payload })` when `useDeviceForRole` surfaced a concrete row. Legacy `hardwareClient.printLabelBytes` is retained only for the workstation-relay fallback (device found by the RPC probe but not by the role selector).
- `src/test/architecture/useInventoryLabelPrinter-execAssignment.test.ts` (NEW): 3-test source-inspection guard — primary path is `execAssignment`, `assignment.id`/`assignment.transport` are forwarded, exactly one fallback call remains.
- `src/test/hardware/inventory-label-printer-binding.test.ts`: relaxed the "dispatches through hardwareClient" assertion from a hardcoded `printRawBytes` to `execAssignment | printLabelBytes`. Direct-driver bans (`browserHardwareAdapter`, `agentClient`) unchanged.

**Verified:** 33/33 across all 8 hardware guards touched by Phase 5 Step B (2 new + 6 regression). No unrelated files edited.

## Phase status (2026-07-26 · after Inventory label-printer migration)

- [~] Phase 5 Step B — POS + Inventory now on `execAssignment`. Remaining consumers to audit: Warehouse (label + pick tickets), HR (biometric), Manufacturing (scales). Grep next: `rg -n "hardwareClient\.(printReceipt|printKitchenOrder|printLabelBytes|printRawBytes|openDrawer|readScale|updateCustomerDisplay|initiatePayment)\(" src` — any hit outside `useHardwareProxy.ts`, `useInventoryLabelPrinter.ts`, and `HardwareClient.ts` itself is a next-turn migration candidate.
- [ ] Phase 5 Step B tidy — peel ~20 `ipcAvailable()` sites in `HardwareClient.ts` behind `hostRouter.*` (pure semantic; import already present).
- [ ] Phase 5 Step C — invert the `execAssignment` → `execAny` relationship (execAssignment becomes primary, execAny becomes a private role-only convenience) then delete `LocalAgentTransport.ts` + `TransportAdapter.resolveTransport()`.
- [ ] Phase 6 — legacy DB drop (`printer_profiles`, `source_config_id`, etc.) — single migration, do NOT interleave with Step C.

## Handoff — next agent

1. Run all 8 guards: `bunx vitest run src/test/architecture/useHardwareProxy-execAssignment src/test/architecture/useInventoryLabelPrinter-execAssignment src/test/hardware/inventory-label-printer-binding src/test/architecture/pos-receipt-resolver src/test/architecture/intent-to-role-parity src/test/architecture/transport-router-matrix src/test/architecture/role-vocabulary src/test/architecture/generate-document-resolver` — must be green before editing.
2. Enumerate remaining role-only call sites with the grep above; migrate each using the same 3-part recipe: (a) accept the resolved `device` from `useDeviceForRole`, (b) call `execAssignment({ assignment: {id, role, transport, enabled}, op, payload })`, (c) add a matching arch guard in `src/test/architecture/`.
3. When zero non-fallback role-only calls remain, promote the primary/fallback ordering: `execAssignment` becomes the only public method, `execAny`/legacy shims move to a `@deprecated` block inside `HardwareClient.ts` — then Phase 5 Step C deletions are safe.
