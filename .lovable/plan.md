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
