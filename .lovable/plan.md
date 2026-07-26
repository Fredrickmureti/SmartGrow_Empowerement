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

## Progress log — 2026-07-26 (Phase 4 · Step 2/3 — policies tab relocated)

- `src/apps/platform/hardware/HardwarePolicies.tsx` (NEW): thin wrapper around the existing `<PrintingSettings />` so the editor gets an app-shell header. No functional change — same hooks, same RLS, same `document_print_policies` writes.
- `src/apps/platform/hardware/routes.tsx`: registers `policies` route (`/platform/hardware/policies`).
- `src/apps/platform/hardware/nav.ts`: adds a "Policies" nav group with the Print policies entry (FileText icon). Rails now expose the editor alongside Devices / Media / Capability / Labels.
- `src/pages/settings/CompanySettings.tsx`: the Printing tab body is replaced by a redirect card ("Moved to Platform → Hardware → Print policies") with a `Link` to the new home. Tab trigger kept so existing bookmarks land on the redirect stub; Phase 6 removes the trigger + tab entirely.
- Guards: 16/16 green (previous 13 + `platform-hardware-has-editor`). tsgo clean.

Deferred to Phase 4 Step 3b / Phase 6:
- Deleting `PrinterProfilesCard.tsx` / `WorkflowBindingsCard.tsx` — still gated on inventorying whether `DeviceWizard` covers 100% of the fields those cards expose (Step 1 inventory not yet exhaustive).
- Removing the Printing tab trigger from CompanySettings — kept as redirect surface until Phase 6.

## Progress log — 2026-07-26 (Phase 5 Prep + Step A — field-parity map & TransportRouter)

**Phase 5 Prep (field-parity for Phase 6 green-light):**

- `src/apps/platform/hardware/legacyPrinterProfileFieldMap.ts` (NEW): documentation-only map assigning every `printer_profiles` column a new home on the unified surfaces: `assignment.<field>`, `assignment.config.<key>`, `assignment.capabilities.<key>`, `policy.<field>`, `media_profile.<field>`, or explicit `LEGACY_DROPPED` with reason. Covers all 24 columns per generated types.
- `src/test/architecture/legacy-printer-profile-field-parity.test.ts` (NEW): 2 guards —
  1. Every column in `printer_profiles.Row` from `src/integrations/supabase/types.ts` MUST have a mapping entry. Future migrations that add a column trip this test.
  2. The mapping file is documentation-only — importing it at runtime (outside the test) fails the guard, keeping the legacy shape out of the shipped bundle.

**Phase 5 Step A (TransportRouter foundation):**

- `src/services/hardware/transport/TransportRouter.ts` (NEW): pure `route(assignment, host)` decision. Inputs are `device_assignments.transport` (with legacy aliases `usb|serial|network → local_agent`) + a `HostCapabilities` snapshot (`isElectron`, `hasWebUSB`, `hasWebHID`). Returns `{ kind: "electron_native" | "local_agent" | "webusb" | "webhid" | "unavailable", requestedTransport, reason? }`. `sniffHost()` is the ONLY function in the module that reads runtime globals; `route()` is a pure function of its args. `routeWithRuntimeHost()` is the convenience combo callers use.
- Decision matrix codified:
  - `electron` → `electron_native` (Electron only) else `unavailable`.
  - `cups|winspool` → `electron_native` only (OS spooler needs main-process access).
  - `local_agent` → `local_agent` from either host.
  - `webusb|webhid` → `electron_native` inside Electron; matching browser API in a capable browser; else `unavailable`.
  - `enabled === false` → `unavailable` regardless of transport.
- `src/test/architecture/transport-router-matrix.test.ts` (NEW): 8 tests pin the matrix (Electron, capable browser, minimal browser hosts × every transport + legacy aliases + disabled row + unknown value). All 8 green.

**Verification this turn:**
- `bunx vitest run transport-router-matrix legacy-printer-profile-field-parity print-policies-canonical-home` → 14/14 green.

## Phase status (2026-07-26 · end of Phase 5 Step A)

- [x] Phase 1, 2, 3 — complete.
- [x] Phase 4 — UI consolidation (canonical home for print policies is `/platform/hardware/policies`; guard-locked).
- [~] Phase 5 — Transport consolidation. **Step A complete** (pure TransportRouter + decision matrix). **Step B in progress — foundation shipped** (HostRouter single-source-of-truth + `hardwareClient.execAssignment` blessed per-assignment entrypoint + arch guard). **Step B finish pending** (migrate `useHardwareProxy` + `printClient` call sites off `execAny(role, …)` onto `execAssignment({assignment, …})`, then peel the remaining ~30 `ipcAvailable()` sites in `HardwareClient.ts` namespaces off inline reads onto `hostRouter.*`). **Step C pending** (delete `LocalAgentTransport.ts` + `transport/index.ts::resolveTransport`).
- [ ] Phase 6 — Legacy schema removal (green-lit by the field-parity map, but blocked on Phase 5 Step C).

## Phase 5 Step B — this turn (2026-07-26)

**Shipped:**
- `src/services/hardware/transport/HostRouter.ts` (NEW) — single-source-of-truth for the Electron preload bridge. Exports `ipcAvailable()`, `isElectronHost()`, `hasStalePreload()`, and `hostRouter.snapshot()`. This is the file every hardware caller should consult; direct `window.pos.*` reads are guarded against.
- `src/services/hardware/HardwareClient.ts` — inline `ipcAvailable()` / `isElectronMode()` deleted; both now imported from HostRouter (`isElectronMode` retained as a private thin alias for one loop to avoid touching 30 call sites in the same edit — Step B finish will inline it).
- `hardwareClient.execAssignment({ assignment, op, payload, ... })` (NEW) — blessed per-assignment execution path. Consults `TransportRouter.route(assignment, sniffHost())`, emits a `[hardware.route.decision]` structured log with `stage: "client"` (mirroring the resolver's tag so a single grep traces intent → assignment → transport), short-circuits on `kind === "unavailable"` before touching the driver, then dispatches through `execAny` for the concrete IO. Step B finish will collapse the dispatch into a `switch (decision.kind)`.
- `src/test/architecture/host-router-single-source.test.ts` (NEW · 3 tests) — repository-wide guard that only whitelisted files (`HostRouter`, `TransportRouter`, `environment`, `HardwareClient` [temporary allow-listed until Step B finish], the browser adapter shell, `CustomerDisplayClient`, offline stack, PDF viewer, diagnostics UI, and text-inspection tests) may read `window.pos.hardware` / `window.pos.isElectron`. Removing `HardwareClient.ts` from the allow-list is the Definition-of-Done marker for Step B finish.

**Verification this turn:** `bunx vitest run` across all 5 Phase 4/5 architecture suites — **22/22 green**:
- `generate-document-resolver` (5)
- `transport-router-matrix` (8)
- `legacy-printer-profile-field-parity` (2)
- `print-policies-canonical-home` (4)
- `host-router-single-source` (3)

## Handoff — next agent (Phase 5 Step B — finish)

**Verify first (do not trust this log — check):**
1. `bunx vitest run src/test/architecture/host-router-single-source.test.ts src/test/architecture/transport-router-matrix.test.ts src/test/architecture/legacy-printer-profile-field-parity.test.ts src/test/architecture/print-policies-canonical-home.test.ts src/test/architecture/generate-document-resolver.test.ts` → **22 tests green**.
2. `bunx tsgo --noEmit` → clean.
3. `rg -n "window\\.pos\\.(isElectron|hardware)" src/services/hardware/HardwareClient.ts | wc -l` — expect the count to drop as you migrate namespaces onto `hostRouter.*`. Target: **0**.
4. `rg -n "ipcAvailable|isElectronMode" src/services/hardware/HardwareClient.ts` — every remaining hit should be either the local `isElectronMode` alias (delete it) or an `ipcAvailable()` call that Step B finish converts to `hostRouter.ipcAvailable()`.

**Then finish Step B:**

1. **Migrate execAny → execAssignment at the call sites.** In `src/hooks/hardware/useHardwareProxy.ts` and `src/services/printing/PrintClient.ts`, the resolver returns a `device_assignments` row and today discards it (calls `execAny(role, ...)` blind). Change these to call `hardwareClient.execAssignment({ assignment, op, payload, sourceDoc*, businessEventId, isReprint })`. This puts the transport decision on the exact row the resolver picked, closing the last "two assignments with the same role diverge silently" loophole.
2. **Collapse `execAssignment`'s dispatch** — replace the temporary `execAny` fallthrough with an explicit `switch (decision.kind)` that calls `execElectron` for `electron_native` and `browserHardwareAdapter.exec` for `local_agent | webusb | webhid`. The `execAny` symbol can then be marked `@deprecated` and left only for pre-migration callers.
3. **Peel the remaining namespace inline reads.** Replace every `ipcAvailable()` / `isElectronMode()` inside the `devices`, `customerDisplay`, `agent`, and `bluetooth` namespaces with `hostRouter.ipcAvailable()` / `hostRouter.isElectronHost()`. Delete the local `isElectronMode` alias. Then **remove `"services/hardware/HardwareClient.ts"` from the allow-list in `host-router-single-source.test.ts`** — that removal is the DoD signal for Step B finish.
4. **Do not** delete `LocalAgentTransport.ts` yet — Step C.

Step C (post-B cleanup):
- Delete legacy `resolveTransport()` in `src/services/hardware/transport/index.ts` (superseded by `TransportRouter`).
- Delete `LocalAgentTransport.ts` renderer shim only after `rg` confirms zero importers.
- Retain `AgentClient.ts` (ADR-0037).

**Do not** touch Phase 6 (DROP TABLE) until Step C removes the last renderer reader of the legacy transport shim. The field-parity map is the Phase 6 green-light checklist; use it when writing the drop migration to confirm every column already has a new home.

