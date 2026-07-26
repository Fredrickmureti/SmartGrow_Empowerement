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

## Progress log — 2026-07-26 (Phase 3 label call-site migration)

- All external `printLabelByTemplate` call sites now go through the `printClient.printLabel` façade:
  - `src/pages/Products.tsx` — product_label + shelf_label handlers.
  - `src/apps/platform/hardware/HardwareDevices.tsx` — label-printer "Test print" path.
  - `src/components/events/BusinessSagaMount.tsx` — GRN summary, per-lot shelf-edge, delivery-note shipping, and stock-transfer manifest saga handlers.
  - `src/services/printing/reprintClient.ts` — `dispatchLabelReprint`.
  - `src/hooks/inventory/useLabelPrint.ts` — the generic `useLabelPrint()` hook (drives every remaining page-level label button through the façade).
- `src/test/hardware/products-label-print.test.ts` (Wave B2.2 seam) upgraded: now asserts `printClient.printLabel` is the seam AND explicitly forbids reaching back into `printLabelByTemplate` / `labelDispatch` from Products. 7/7 green.
- All affected suites green: `products-label-print`, `role-vocabulary`, `intent-to-role-parity`, `customer-display-saga` (verifies the `labelDispatch` vi.mock still fires through the lazy `import()` inside `PrintClient.printLabel`).
- Only in-tree `printLabelByTemplate` references now sit inside `src/services/printing/{labelDispatch,PrintClient}.ts` (definition + façade), tests that assert-negatively on the primitive, and one doc comment in `useDeviceForWorkflow.ts` (which Phase 6 deletes). The single-chokepoint ESLint allow-list can now safely shrink to `src/services/printing/**` in Phase 6.

## Phase status (2026-07-26)

- [x] Phase 1 — Freeze.
- [x] Phase 2a/2b — Unify registration onto `device_assignments`.
- [x] Phase 2c — Server-side registry unification (`workstation-manifest`, `generate-document`, role-vocabulary CI guard).
- [x] Phase 3 (opener) — `resolve_device` RPC live.
- [x] Phase 3 (client façade) — `useDeviceForIntent` + `INTENT_TO_ROLE` + parity CI guard.
- [x] Phase 3 (label chokepoint) — `printClient.printLabel` shipped and every consumer migrated.
- [ ] Phase 3 (remaining) — Route `useHardwareProxy.printReceipt` and the kitchen-ticket dispatch through `useDeviceForIntent` / `resolve_device` so POS + kitchen share the same resolver. Also swap `document_print_policies`-driven policy resolution in `generate-document` to prefer `resolve_device` for policies that pin a role rather than a specific device id.
- [ ] Phase 4 — UI consolidation (Platform → Hardware becomes single admin home; delete PrinterProfilesCard / WorkflowBindingsCard / PrintingSettings; DeviceWizard = sole registration surface).
- [ ] Phase 5 — Transport consolidation (`TransportRouter` collapses ~15 `isElectron()` branches inside `HardwareClient`; delete `LocalAgentTransport.ts` + legacy `TransportAdapter.resolveTransport` branch).
- [ ] Phase 6 — Legacy removal (DROP `printer_profiles`, `printer_workflow_bindings`, `workstation_devices`, `resolve_workflow_printer`; drop `device_assignments.source_config_id`; delete `useDeviceForWorkflow.ts`; shrink ESLint allow-list).

## Handoff — next agent

**Verify first (don't trust the log — actually check):**
1. `rg -n 'printLabelByTemplate\s*\(' src` should return matches ONLY in `src/services/printing/{labelDispatch,PrintClient}.ts` and in test files that assert-negatively (`no-product-id-as-barcode`, `products-label-print`, `customer-display-saga` mock, `useDeviceForWorkflow.ts` doc comment). Any consumer hit is a regression.
2. `bunx vitest run src/test/hardware/products-label-print.test.ts src/test/architecture/intent-to-role-parity.test.ts src/test/architecture/role-vocabulary.test.ts src/test/pos/customer-display-saga.test.ts` — all four suites must be green.
3. Confirm the `resolve_device` RPC exists in the live schema (previous turn shipped the migration); `supabase.rpc('resolve_device', ...)` from `src/hooks/useDeviceForIntent.ts` must type-resolve.
4. `rg -n 'workstation_devices|printer_profiles' supabase/functions src` should show only comments / migration history — no runtime writes/reads.

**Then resume Phase 3 (final leg) — chronological, do not skip:**

Step A: Route POS receipt dispatch through `resolve_device`.
- `src/hooks/hardware/useHardwareProxy.ts` (`printReceipt` around L270–320) currently resolves the receipt printer via ad-hoc logic / `hardwareClient` role targeting. Rewrite it to call `useDeviceForIntent({ intent: 'receipt', businessId, scopeKind: 'register', scopeId: registerId })` and dispatch to the resolved `DeviceAssignment.id`. Keep the existing missing-device toast path.
- Add a unit test asserting POS receipt dispatch calls `resolve_device` (mock supabase.rpc) with the correct (role='receipt_printer', scope='register') arguments.

Step B: Route kitchen-ticket dispatch through the same path.
- Find kitchen-ticket dispatch call site (grep `kitchen_ticket` + `kitchen_printer`). Convert to `useDeviceForIntent({ intent: 'kitchen_ticket', businessId, scopeKind: 'station', scopeId: kitchenStationId })`.
- Ensure `device_workflow_bindings` scoping (station-level pin) still wins the tie-break — the `resolve_device` RPC already implements this.

Step C: Migrate policy-driven `generate-document` reads that pin a *role* (not an id).
- Audit both `printer_profiles`/`device_assignments` reads in `supabase/functions/generate-document/index.ts` (lines ~2388 and ~3023 after the Phase 2c patch). Where `document_print_policies` pins `role_hint` without a specific device id, call `public.resolve_device(...)` instead of the `.or('id.eq.<x>,source_config_id.eq.<x>')` join. Preview overrides and explicit-id pins stay ID-driven.

Step D: Update `.lovable/plan.md` marking Phase 3 fully complete, then open Phase 4 by writing an inventory of every `PrinterProfilesCard` / `WorkflowBindingsCard` / `PrintingSettings.tsx` consumer BEFORE deleting anything (Phase 4 opener).

**Do not** start Phase 4 UI deletions until Step A–C are green with new tests. Do not attempt Phase 5 (`TransportRouter`) or Phase 6 (DROP TABLE) out of order — they depend on Phase 4 having removed the last UI writers of the legacy tables.

## Progress log — 2026-07-26 (Phase 3 Step A + B — POS/kitchen resolver wiring)

- `src/hooks/useDeviceForIntent.ts`: added `resolveDeviceForIntent()` — an imperative twin of the React hook that calls the same `resolve_device` RPC with the same tie-break. Non-React hot lanes (dispatch callbacks, saga handlers, edge-adjacent code) can now share the exact same routing decision as the UI.
- `src/hooks/hardware/useHardwareProxy.ts`:
  - `printReceipt` now resolves `intent=receipt` via `resolveDeviceForIntent` before dispatch, using `{ scope: register, businessId: currentBusiness }`. No resolved winner → short-circuit with `{ success: false, error: 'No receipt printer …' }`. Resolver-outage → warn-and-fall-through so the register keeps trading during a transient Postgres blip.
  - `printKitchenOrder` mirrors the same contract for `intent=kitchen_ticket`.
  - Both emit a structured `console.info('[hardware.route.decision]', { intent, role, assignmentId, scope, businessId })` — satisfies the Phase 6 DoD "one registry, one resolver, one transport per print" grep across sales / POS.
- `src/test/architecture/pos-receipt-resolver.test.ts`: 4-test source-inspection guard locking (a) import of `resolveDeviceForIntent`, (b) both hot lanes call it with correct intent literals, (c) missing-device short-circuit exists, (d) `hardware.route.decision` log is emitted from both lanes. 4/4 green alongside the earlier parity + vocabulary + Products-seam guards.
- Typecheck: clean.

### Deliberate scope choices

- The physical driver hop still routes by `role` (`execAny('receipt_printer', …)`). That's intentional for this milestone: the *decision* is now unified, the driver-layer targeting-by-assignment-id refactor is a Phase 5 concern (bundled with `TransportRouter`).
- Station-level scope for kitchen tickets is not threaded through `useHardwareProxy` yet — register scope + business tie-break already improves over role-only routing. Threading station scope belongs with the KDS refactor (out of scope for Phase 3).

## Phase status (2026-07-26 — end of turn)

- [x] Phase 1, 2a/2b/2c — done.
- [x] Phase 3 (opener) — `resolve_device` RPC live.
- [x] Phase 3 (client façade) — `useDeviceForIntent` + `INTENT_TO_ROLE` + parity guard.
- [x] Phase 3 (label chokepoint) — `printClient.printLabel` shipped, every external caller migrated.
- [x] Phase 3 (Step A) — POS receipt dispatch resolved server-side.
- [x] Phase 3 (Step B) — Kitchen ticket dispatch resolved server-side.
- [ ] Phase 3 (Step C — final) — `generate-document` policy paths that pin a *role* (not a specific device id) call `public.resolve_device(...)` instead of the current `.or('id.eq.<x>,source_config_id.eq.<x>')` fan-out. Preview / explicit-id pins stay ID-driven.
- [ ] Phase 4 — UI consolidation.
- [ ] Phase 5 — Transport consolidation (`TransportRouter`, driver-layer targeting-by-assignment-id).
- [ ] Phase 6 — Legacy removal (DROP legacy tables, drop `source_config_id`, delete `useDeviceForWorkflow.ts`, shrink ESLint allow-list).

## Handoff — next agent

**Verify first (do not trust this log — check):**
1. `bunx tsgo --noEmit` → clean.
2. `bunx vitest run src/test/architecture/pos-receipt-resolver.test.ts src/test/architecture/intent-to-role-parity.test.ts src/test/architecture/role-vocabulary.test.ts src/test/hardware/products-label-print.test.ts` → all green.
3. `rg -n 'resolveDeviceForIntent|resolve_device' src` — should be limited to `useDeviceForIntent.ts`, `useHardwareProxy.ts`, tests, and (after Step C) `generate-document/index.ts`. Any other consumer means someone bypassed the façade.
4. Inspect the two `device_assignments` reads in `supabase/functions/generate-document/index.ts` (previously at ~L2388 and ~L3023 after Phase 2c) and identify which are ID-pinned (preview override, policy pinning a specific `printer_profile_id` / `source_config_id`) vs. role-pinned (policy carrying only a `role_hint` / `device_role`). ONLY the role-pinned branches migrate to `resolve_device`.

**Then resume with Phase 3 Step C (do not skip to Phase 4):**

Step C: `generate-document` role-pinned reads → `resolve_device`.
- For each policy path that carries only a role hint (no explicit assignment id), replace the ad-hoc select with `supabase.rpc('resolve_device', { _organization_id, _role, _business_id, _scope_kind: null, _scope_id: null })` and pick the first row.
- Preserve the ID-pinned branch verbatim — that path exists precisely to let admins pin a specific physical printer for a document policy.
- Emit a structured server-side `hardware.route.decision` log (via `console.info` / edge-function logger) at the resolver call site for the Phase 6 DoD.
- Add an edge-function Deno test (`supabase/functions/generate-document/index_test.ts`) that stubs `supabase.rpc('resolve_device', …)` and asserts a role-pinned policy causes exactly one RPC call with the right args; and that an ID-pinned policy does NOT call the resolver.

Step D (closes Phase 3): Update `.lovable/plan.md` marking Phase 3 fully complete, then open Phase 4 with an inventory step BEFORE any deletion. Phase 4 opener must:
- Enumerate every current consumer of `PrinterProfilesCard`, `WorkflowBindingsCard`, `PrintingSettings.tsx`, `/pos/hardware-devices`, `/pos/hardware-diagnostics` (grep import paths + route registrations).
- Confirm `DeviceWizard` covers every field these older surfaces expose (role, workflow bindings, workstation FK, capability flags). If gaps exist, close them BEFORE deleting the old surfaces.
- Only then start the deletion sweep + redirect stubs.

**Do not** open Phase 4 / 5 / 6 until Step C is done and green. **Do not** touch driver-layer targeting-by-assignment-id (that is bundled with Phase 5's `TransportRouter`). **Do not** DROP TABLE anything before Phase 6 — Phase 4 UI removal must land first so the legacy tables have zero readers.
