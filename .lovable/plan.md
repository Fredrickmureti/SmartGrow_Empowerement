## Done

- Phases 0–5: locations, LPN/tasks, waves/picking/packing, cycle counting, loading/dispatch.
- **Phase 6 — Dock scheduling & appointments** (2026-07-17)
  - `wms_dock_appointments` table with GiST no-overlap exclusion, RLS, service-role grants only (writes RPC-only).
  - RPCs: `schedule_dock_appointment`, `mark_appointment_arrived`, `start_appointment`, `complete_dock_appointment`, `cancel_dock_appointment`, `bind_goods_receipt_appointment`; `open_loading_manifest` extended with `p_appointment_id`.
  - FKs added: `wms_loading_manifests.appointment_id`, `goods_receipts.appointment_id`.
  - Domain events wired: `warehouse.appointment.scheduled|arrived|in_progress|completed|cancelled` in `domainEventBus` + `BusinessSagaMount`.
  - UI: `/warehouse-app/schedule` (per-dock day grid with transitions), `/warehouse-app/schedule/new` (planner), nav entry under Operations.
  - Appointment picker wired into `LoadingManifestPlanner` (outbound, filters by dock + auto-fills carrier/planned departure) and `GoodsReceiptWizardPage` (inbound, binds via RPC after GRN post).
  - Architecture guard `wms-phase6.test.ts` green; RPC signatures visible in `types.ts`.
- **Phase 7 — QC inspection lifecycle** (2026-07-17)
  - `wms_qc_inspections`, `wms_qc_inspection_checks`, `wms_qc_hold_reasons` tables with RLS scoped to `user_business_access`; RPC-only writes.
  - Warehouse flag `warehouses.require_qc_on_receipt` (default false) for future auto-open on GRN.
  - FKs `goods_receipt_items.qc_inspection_id`, `sales_return_items.qc_inspection_id` for source-doc bindings.
  - RPCs: `open_qc_inspection`, `record_qc_check`, `accept_qc_inspection`, `reject_qc_inspection`, `cancel_qc_inspection`. State machine open → in_review → accepted / partially_accepted / rejected / cancelled. Every transition emits `warehouse.qc.*` outbox event with idempotency key `wms.qc.<id>:<state>`.
  - Domain events wired: `warehouse.qc.opened|accepted|rejected|cancelled` in `domainEventBus` + `BusinessSagaMount` (log-only).
  - UI: `/warehouse-app/qc` (queue with state/text filters), `/warehouse-app/qc/:id` (checklist entry + accept/reject/cancel actions), nav entry under Operations.
  - Architecture guard `wms-phase7.test.ts` green (RPC-only writes + saga/bus event coverage).
  - Deferred to Phase 7.1: physical `qc_hold` sub-location stock relocation, GRN auto-open when `require_qc_on_receipt=true`, RTV draft auto-creation from rejects, AQL sampling tables, vendor-portal integration.

## Handoff snapshot (2026-07-17)

### What is truly Done end-to-end

- Phases 0–5: master data, locations, LPN/tasks, putaway, waves/picking/packing, cycle counting, loading/dispatch.
- Phase 6: dock scheduling & appointments (table + exclusion constraint, 6 RPCs, events, UI at `/warehouse-app/schedule`, GRN + manifest binding, guard green).
- Phase 7: QC inspection lifecycle — logical state machine only. Migration, 5 RPCs, events, `/warehouse-app/qc` queue + detail, GRN/return FK bindings, guard green.

### Known gaps carried forward (do NOT skip — required for a real WMS)

These were intentionally deferred so the state machine could land first. They must be closed before Phase 8 starts, otherwise QC is decorative:

1. **Phase 7.1 — QC physical stock effects** (blocks trustworthy inventory):
   - Provision a `qc_hold` sub-location per warehouse (migration + on-demand fallback in `open_qc_inspection`).
   - `open_qc_inspection` must move affected qty from receiving bin → `qc_hold` via `stock_movements` (not just flip a flag).
   - `accept_qc_inspection` must move accepted qty `qc_hold` → default putaway staging; `reject_qc_inspection` must post scrap movement or seed a `purchase_returns` draft for `return_to_vendor`.
   - Auto-open QC on GRN post when `warehouses.require_qc_on_receipt = true`; same hook on sales-return receipt.
   - Architecture guard extension: assert every QC accept/reject writes a matching `stock_movements` row (RPC contract test via `supabase--read_query`).

### Next phase to pick up — Phase 8: Replenishment & slotting

Rationale (chronological/logical order): with inbound (appointments → GRN → QC → putaway), outbound (waves → pick → pack → manifest → dispatch), and count all in place, the next missing enterprise capability is **keeping pick faces fed and locations optimally slotted**. Do NOT jump to yard, labour, or billing modules first — those depend on stable replenishment signals.

Scope preview (spec to be written before code):

- `wms_replenishment_rules` (min/max per product×location, trigger strategy: min-max, demand-based, wave-driven).
- `wms_replenishment_tasks` — generated moves from reserve → pick face, reusing `wms_tasks` executor.
- RPCs: `generate_replenishment_tasks(p_warehouse_id, p_strategy)`, `complete_replenishment_task(...)`.
- Slotting analytics view: velocity (A/B/C) × pick-face suitability, surfaced read-only in `/warehouse-app/slotting`.
- Events: `warehouse.replenishment.generated|completed`.
- Architecture guard `wms-phase8.test.ts`.

### Rules for the next agent (keep the vision intact)

1. **Finish Phase 7.1 before Phase 8.** QC without stock movements is a lie; downstream replenishment cannot trust on-hand until QC actually parks qty in `qc_hold`.
2. **Never widen client write surface.** All new tables follow the RPC-only pattern; every phase ships an architecture guard.
3. **Every state transition emits an outbox event.** Register the type in `domainEventBus.ts` AND wire a handler (log-only is fine) in `BusinessSagaMount.tsx` so Phase 2 arch guard stays green.
4. **Respect the Inventory ↔ Warehouse split (ADR 0079).** `stock_quants` = what/how much (inventory domain). `wms_*` = where/who/how (warehouse domain). QC, replenishment, slotting all live in `wms_*` and mutate quants only via sanctioned inventory RPCs.
5. **Do not rename or repurpose existing tables.** If a spec references a table that does not exist (as happened with `wms_receipts`), stop and reconcile in the plan file before coding.
6. **Chronological order is non-negotiable:** 7.1 (QC physical) → 8 (replenishment/slotting) → 9 (yard/trailer) → 10 (labour management) → 11 (3PL billing). Skipping steps breaks the event chain.
7. **After each phase:** run all `wms-phase*.test.ts` + `tsgo`, then update this file — move the phase to Done, refresh this handoff snapshot, seed the next Next.

### Verification checklist for the next agent before writing any code

- [ ] Re-read this section end-to-end.
- [ ] Confirm `wms-phase1..7.test.ts` all pass on a clean checkout.
- [ ] Confirm no in-flight migrations (check `supabase/migrations/` tail vs. `types.ts`).
- [ ] Start with Phase 7.1 physical-stock work; do NOT open Phase 8 files until 7.1 is Done.

## Verification of prior work

Spot-checked the handoff in `.lovable/plan.md` against the live database and codebase:

- `wms_*` tables present: `wms_license_plates`, `wms_tasks`, `wms_putaway_suggestions`, `wms_pick_waves`, `wms_pick_wave_lines`, `wms_pack_cartons`, `wms_count_sessions`, `wms_count_lines`, `wms_loading_manifests`, `wms_manifest_cartons`. Phase 5 companion table `warehouse_docks` also present.
- Phase 4b/4c/5 RPCs all installed: `open_pack_carton`, `seal_pack_carton`, `create_count_session`, `post_count_session`, `open_loading_manifest`, `load_carton_onto_manifest`, `close_loading_manifest`, `dispatch_loading_manifest`.
- Architecture guards `wms-phase1/2/3/4b/4c/5.test.ts` are all on disk.
- UI pages for LPN, tasks, putaway, waves, picking, packing, cycle counts, loading/dispatch exist under `src/pages/warehouse/` and are wired through `src/apps/warehouse/nav.ts`.
- ADR trail (0064 quants, 0076 event fabric, 0079 inventory/warehouse split) matches shipped code.
- `domainEventBus` includes every event type Phases 1–5 claim to emit.

**Correction to the handoff:** plan.md's Phase 6 spec references a `wms_receipts` table "already exists from Phase 1". It does not. Inbound receiving is modelled on `inbound_shipments` (ASN) + `goods_receipts` (GRN). Phase 6 will bind the appointment to `goods_receipts` (the concrete arrival event), not a fictional `wms_receipts`.

Everything Done in plan.md is genuinely done. Nothing is in-flight. Resuming at Phase 6.

## Phase 6 — Dock scheduling & appointments

Goal: give inbound receiving and outbound dispatch a first-class appointment/dock-window model so trucks don't collide on a dock and every manifest/GRN can bind to a scheduled slot.

### Migration `wms_phase6_dock_appointments`

Table `public.wms_dock_appointments`:

- `id uuid pk`, scope columns `organization_id`, `business_id`, `branch_id`, `warehouse_id`
- `dock_id uuid not null references warehouse_docks(id)`
- `appointment_type text check in ('inbound','outbound')`
- `carrier_id uuid null references carriers(id)`
- `reference text` (PO / SO / manifest ref, free text)
- `window_start timestamptz not null`, `window_end timestamptz not null` (check `window_end > window_start`)
- `state text check in ('scheduled','arrived','in_progress','completed','cancelled','no_show') default 'scheduled'`
- `arrived_at`, `completed_at`, `cancelled_reason`, `created_by`, `created_at`, `updated_at`
- `is_sample_data bool default false`

Constraints:

- GiST exclusion constraint (via `btree_gist`): no two non-cancelled/no_show appointments overlap on the same `dock_id`.
- Grants: `GRANT SELECT ON ... TO authenticated`, `GRANT ALL ... TO service_role`. Writes are RPC-only, so no direct INSERT/UPDATE/DELETE grants to authenticated.
- RLS: SELECT scoped by `business_id` matching the caller's active business (same pattern as `wms_loading_manifests`).

FK additions:

- `wms_loading_manifests.appointment_id uuid null references wms_dock_appointments(id)`
- `goods_receipts.appointment_id uuid null references wms_dock_appointments(id)` (inbound binding — replaces plan.md's stale `wms_receipts` reference)

### RPCs

All `SECURITY DEFINER`, `SET LOCAL search_path = public`, outbox emission wrapped in `BEGIN … EXCEPTION WHEN OTHERS THEN RAISE WARNING`:

- `schedule_dock_appointment(p_dock_id, p_type, p_window_start, p_window_end, p_carrier_id default null, p_reference default null)` → validates dock ∈ caller's business, rejects overlap explicitly (exclusion constraint is safety net), emits `warehouse.appointment.scheduled`, returns row.
- `mark_appointment_arrived(p_appointment_id)` → `state='arrived'`, stamps `arrived_at`, emits `warehouse.appointment.arrived`.
- `start_appointment(p_appointment_id)` → `state='in_progress'` (used when dock work actually begins; optional but keeps state machine clean).
- `complete_dock_appointment(p_appointment_id)` → `state='completed'`, stamps `completed_at`, emits `warehouse.appointment.completed`.
- `cancel_dock_appointment(p_appointment_id, p_reason default null)` → emits `warehouse.appointment.cancelled`.
- Extend `open_loading_manifest` to accept optional `p_appointment_id`; validates the appointment is outbound, on the same dock, in state `scheduled|arrived`, and belongs to the caller's business.
- New `bind_goods_receipt_appointment(p_receipt_id, p_appointment_id)` for the inbound side (thin RPC — the receipt row itself is owned by inventory; this only stamps the FK after validating scope + inbound state).

### Events

Register `warehouse.appointment.scheduled|arrived|in_progress|completed|cancelled` in:

- `src/services/events/domainEventBus.ts` (DomainEventType union)
- `src/services/events/BusinessSagaMount.tsx` — log-only handlers so Phase 2 arch guard passes.

### UI (under `/warehouse-app/schedule/*`)

- `DockSchedule.tsx` — per-warehouse day/week grid, one lane per dock, appointments rendered as blocks; click block → detail drawer with state transitions.
- `AppointmentPlanner.tsx` — create/edit form: warehouse → dock → type → window → carrier → reference. Uses `schedule_dock_appointment` RPC; surfaces overlap error inline.
- Wire appointment picker into `LoadingManifestPlanner.tsx` (outbound) — read-only select of scheduled/arrived outbound appointments on the target dock.
- Wire appointment picker into the GRN create flow in `GoodsReceiptWizardPage.tsx` (inbound) — read-only select; commit via `bind_goods_receipt_appointment` after receipt exists.
- Nav: add `Operations → Dock schedule` in `src/apps/warehouse/nav.ts`.

### Architecture guard `src/test/architecture/wms-phase6.test.ts`

Static assertions:

- No client-side `.from('wms_dock_appointments').insert|update|delete` — writes only through the five RPCs (allowlist).
- No client-side write of `wms_loading_manifests.appointment_id` or `goods_receipts.appointment_id` — must go through `open_loading_manifest` / `bind_goods_receipt_appointment`.
- Every `warehouse.appointment.*` DomainEventType has a handler registered in `BusinessSagaMount.tsx`.
- Every new RPC signature exists in `src/integrations/supabase/types.ts` (proves the migration ran and types regenerated).

### Verification at end of phase

- `bunx vitest run src/test/architecture/wms-phase*.test.ts` all green (Phases 1–5 stay green + new Phase 6).
- `bunx tsgo --noEmit` clean.
- Spot-check via `supabase--read_query`: overlap on same dock rejected, cancelled appointment permits overlap.
- Update `.lovable/plan.md`: move Phase 6 block from **Next** to **Done**, refresh verification snapshot, seed **Next** with Phase 7 candidate (QC inspection lifecycle recommended — it unblocks the receiving-inspection step in the business-event chain called out in the parent prompt).

### Order of execution (single-batch discipline)

1. Migration (table + FKs + grants + RLS + exclusion constraint).
2. RPCs (all six/seven in one migration follow-up).
3. Event types + saga handlers.
4. UI pages + nav entry + planner wiring.
5. Architecture guard test.
6. Run full arch test suite + tsgo, then update `.lovable/plan.md`.

### Out of scope for Phase 6

- Carrier appointment self-service portal.
- SMS/email appointment reminders.
- Yard management (trailer positioning) — separate future phase.
- Slot-capacity forecasting / auto-scheduling.

## Next — Phase 7: QC inspection lifecycle

Goal: give inbound receiving and returns a first-class quality-control step so material can be quarantined, sampled, accepted, or rejected before it enters `stock_quants`. Closes the receiving-inspection gap called out in the parent audit.

### Migration `wms_phase7_qc_inspections`

- `wms_qc_inspections` — one per triggering event (GRN, sales return, ad-hoc lot).
  - Scope (`organization_id`, `business_id`, `branch_id`, `warehouse_id`), source (`source_doc_type`, `source_doc_id`), `product_id`, `lot_number` nullable, `serial_number` nullable, `sample_size int`, `sample_strategy text` (`aql`, `full`, `skip`), `state text check in ('open','in_review','accepted','rejected','partially_accepted','cancelled')`, `accepted_qty numeric`, `rejected_qty numeric`, `disposition text` (`return_to_vendor`, `scrap`, `rework`, `use_as_is`), `inspector_id`, `inspected_at`, `notes`.
- `wms_qc_inspection_checks` — line-level checklist rows (`inspection_id`, `check_code`, `check_label`, `expected`, `actual`, `pass bool`, `severity text`, `photo_url`).
- `wms_qc_hold_reasons` — lookup for common reject/hold codes.
- Bind FK: `goods_receipt_items.qc_inspection_id` (nullable), `sales_return_items.qc_inspection_id` (nullable).

### RPCs

- `open_qc_inspection(p_source_doc_type, p_source_doc_id, p_product_id, p_lot_number, p_sample_size, p_sample_strategy)` — creates the inspection in `open`, moves affected qty to a `qc_hold` sub-location on the source warehouse; emits `warehouse.qc.opened`.
- `record_qc_check(p_inspection_id, p_check_code, p_actual, p_pass, p_severity, p_photo_url)`.
- `accept_qc_inspection(p_inspection_id, p_accepted_qty, p_notes)` — releases the accepted qty back to normal stock (writes `stock_movements` from `qc_hold` → default receiving bin); emits `warehouse.qc.accepted`.
- `reject_qc_inspection(p_inspection_id, p_rejected_qty, p_disposition, p_notes)` — for `return_to_vendor` opens a `purchase_returns` draft; for `scrap` posts a scrap movement; emits `warehouse.qc.rejected`.
- `cancel_qc_inspection(p_inspection_id, p_reason)`.

### UI

- `/warehouse-app/qc` — queue: open + in-review inspections with filters (source, product, age).
- `/warehouse-app/qc/:id` — inspection detail with checklist, sample entry, photo attach, accept/reject actions.
- GRN wizard: auto-open QC inspection when the destination warehouse has `require_qc_on_receipt = true` (new `warehouses` flag, default false).
- Sales-return flow: same auto-open on receiving a return line flagged for inspection.

### Events

Register `warehouse.qc.opened|accepted|rejected|cancelled` in `domainEventBus` + `BusinessSagaMount` (log-only initially).

### Architecture guard `src/test/architecture/wms-phase7.test.ts`

- No client-side inserts/updates to `wms_qc_inspections` or `wms_qc_inspection_checks` — RPC-only.
- Every `warehouse.qc.*` event registered.
- Sub-location `qc_hold` provisioned per warehouse by a migration side-effect (or by the RPC on demand).

### Out of scope for Phase 7

- AQL sampling table auto-computation (support sample_size as input only for now).
- Vendor-portal RTV integration.
- Predictive QC scoring / anomaly detection.
