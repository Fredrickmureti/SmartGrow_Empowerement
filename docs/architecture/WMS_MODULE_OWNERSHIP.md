# WMS Module Ownership & Event Vocabulary

Status: **authoritative** (Phase 2.6). Companion to ADR 0079 (Inventory/Warehouse
split) and ADR 0101 (event catalog).

This document is the single register of:

1. who is allowed to **write** each WMS aggregate,
2. the **one** canonical topic vocabulary (`warehouse.*`),
3. which module **produces** and which modules **consume** each topic.

It is enforced by `src/test/architecture/wms-topic-vocabulary.test.ts`. Adding a
topic to `src/features/warehouse/events/topics.ts` without listing it here fails
the build.

---

## 1. Write ownership per aggregate

| Aggregate | Table | Sole write path | UI entry point |
| --- | --- | --- | --- |
| Task | `wms_tasks` | `wms_transition_task`, `wms_claim_next_task`, `assign_wms_task`, task-type completion RPCs | `src/features/warehouse/aggregates/task/*` |
| License plate | `wms_license_plates` | `wms_transition_lpn`, `move_lpn`, `seal_lpn` | `aggregates/lpn/*` |
| Pick wave | `wms_pick_waves` | `wms_transition_wave`, `release_pick_wave`, `cancel_pick_wave` | `aggregates/wave/*` |
| Carton | `wms_pack_cartons` | `open_pack_carton`, `assign_packaging_to_pack`, `seal_pack_carton`, `load_carton_onto_manifest` | `aggregates/pack/*` |
| Packaging master | `wms_packaging_types`, `_carriers`, `_availability`, `_events` | `wms_packaging_upsert`, `wms_packaging_set_lifecycle`, `wms_packaging_archive`, `wms_packaging_set_carrier_rule`, `wms_packaging_set_availability`, `wms_packaging_consume` (server-internal) | `features/warehouse/packaging/*` (ADR 0105) |
| Loading manifest | `wms_loading_manifests` | `wms_transition_manifest`, `open/close/dispatch_loading_manifest` | `aggregates/manifest/*` |
| QC inspection | `wms_qc_inspections` | `wms_transition_qc`, `open/accept/reject/cancel_qc_inspection` | `aggregates/qc/*` |
| Count session | `wms_count_sessions` | `wms_transition_count_session`, `create_count_session`, `record_count(_scan)`, `post_count_session` | `aggregates/count/*` |
| Trailer visit | `wms_trailer_visits` | `check_in_trailer`, `assign_trailer_to_dock`, `depart_trailer`, `mark_trailer_no_show` | `aggregates/yard/*` |
| Dock appointment | `wms_dock_appointments` | `schedule_dock_appointment`, `_appt_transition` wrappers | `aggregates/yard/*` |
| Cross-dock | `wms_crossdock_opportunities` | `evaluate_crossdock_on_grn`, `confirm_crossdock_stage`, `cancel_crossdock_opportunity` | `aggregates/crossdock/*` |
| Exception | `wms_exceptions` | `wms_raise_exception`, `wms_resolve_exception` | `aggregates/exception/*` |

Rules:

- Pages never call `supabase.rpc` directly; the aggregate wrapper layer owns
  every sanctioned RPC (guarded by `wms-phase*.test.ts` + `wms-guard-parity.test.ts`).
- Stock truth stays in Inventory: WMS never writes `warehouse_stock` /
  `stock_quants` outside the sanctioned movement helpers.

## 2. Emission ownership

State-change topics are emitted **only** by `AFTER` triggers on the aggregate
table (`_wms_emit_task_event`, `_wms_emit_lpn_event`, `_wms_emit_lpn_moved`,
`_wms_emit_state_change`). RPC bodies must not emit those topics — the trigger
sees `OLD`/`NEW` and is the only place that can report `from_state` correctly.

Non-state facts (a carton opened, a count line recorded, a receipt staged, an
appointment moved, a cross-dock match) are emitted in-body by the owning RPC,
because they have no aggregate state transition of their own.

The legacy vocabulary (`warehouse.qc.opened/accepted/rejected`,
`warehouse.yard.*`, `warehouse.pick|pack|putaway.completed`,
`warehouse.count.opened`, `warehouse.manifest.opened`,
`warehouse.putaway.suggested`, `warehouse.grn.received`,
`warehouse.shipment.dispatched`, `warehouse.cycle_count.variance`) was
**removed** in Phase 2.6 — it must never reappear.

## 3. Topic register

### Task — `wms_tasks` (trigger `_wms_emit_task_event`)

| Topic | Meaning | Consumers |
| --- | --- | --- |
| `warehouse.task.available` | task released to the pool | RF queue, labor |
| `warehouse.task.assigned` | assigned to a worker | RF queue, labor |
| `warehouse.task.claimed` | claimed from the pool | RF queue |
| `warehouse.task.in_progress` | execution started | labor |
| `warehouse.task.paused` | operator suspended the task (row_version-scoped idempotency) | labor, RF queue |
| `warehouse.task.resumed` | operator resumed a paused task | labor, RF queue |
| `warehouse.task.completed` | work done (`task_type` on payload) | labor, 3PL billing |
| `warehouse.task.exception` | worker raised a blocker | exception inbox |
| `warehouse.task.cancelled` | withdrawn (`cancel_reason`) | RF queue |

### License plate — `wms_license_plates` (triggers `_wms_emit_lpn_event`, `_wms_emit_lpn_moved`)

| Topic | Meaning | Consumers |
| --- | --- | --- |
| `warehouse.lpn.receiving` | plate created at receiving | receiving board |
| `warehouse.lpn.putaway` | plate en route to storage | putaway board |
| `warehouse.lpn.stored` | plate at its storage bin | inventory projection |
| `warehouse.lpn.picked` | plate picked for an order | wave board |
| `warehouse.lpn.packed` | plate packed | pack station |
| `warehouse.lpn.sealed` | plate sealed | shipping |
| `warehouse.lpn.staged` | staged for loading | loading board |
| `warehouse.lpn.loaded` | loaded on a manifest | loading board |
| `warehouse.lpn.shipped` | left the building | shipping, billing |
| `warehouse.lpn.quarantined` | held by QC | QC inbox |
| `warehouse.lpn.moved` | relocation without state change | audit timeline |
| `warehouse.lpn.voided` | plate voided | audit timeline |

### Cartons — `wms_pack_cartons` (in-body)

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.carton.opened` | `open_pack_carton` | packing analytics |
| `warehouse.carton.sealed` | `seal_pack_carton` | packing analytics, shipping |
| `warehouse.carton.loaded` | `load_carton_onto_manifest` | loading board |
| `warehouse.carton.shipped` | `dispatch_loading_manifest` | shipping, 3PL billing |

### Receiving

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.receiving.opened` | receiving session RPCs | receiving board |
| `warehouse.receiving.line_captured` | receiving session RPCs | receiving board |
| `warehouse.receiving.closed` | receiving session RPCs | receiving board |
| `warehouse.receiving.discrepant` | receiving session RPCs | exception inbox |
| `warehouse.receipt.staged` | `receive_goods_to_wms` | putaway, 3PL billing |

### Returns

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.return.opened` | returns RPCs | returns desk |
| `warehouse.return.inspected` | returns RPCs | returns desk, QC |
| `warehouse.return.dispositioned` | returns RPCs | inventory projection |
| `warehouse.return.closed` | returns RPCs | returns desk |
| `warehouse.return.draft` | `wms_transition_return` | returns desk |
| `warehouse.return.authorized` | `wms_transition_return` | returns desk, finance |
| `warehouse.return.in_transit` | `wms_transition_return` | returns desk |
| `warehouse.return.received` | `wms_transition_return` | returns desk, inventory projection |
| `warehouse.return.inspecting` | `wms_transition_return` | QC |
| `warehouse.return.disposed` | `wms_transition_return` | inventory projection |
| `warehouse.return.cancelled` | `wms_transition_return` | returns desk |
| `warehouse.return.line_captured` | returns execution RPCs | returns desk |
| `warehouse.return.line_inspected` | returns execution RPCs | QC |
| `warehouse.return.line_dispositioned` | returns execution RPCs | inventory projection |
| `warehouse.return.dispositions_posted` | returns execution RPCs | inventory projection, finance |
| `warehouse.return.blocked` | returns execution RPCs | exception inbox |
| `warehouse.return.finance_linked` | returns execution RPCs | finance |

### Exceptions

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.exception.raised` | `wms_raise_exception` | exception inbox, supervisor alerts |
| `warehouse.exception.resolved` | `wms_resolve_exception` | exception inbox |
| `warehouse.exception.acknowledged` | `wms_acknowledge_exception` | exception inbox |
| `warehouse.exception.assigned` | `wms_assign_exception` | exception inbox |
| `warehouse.exception.escalated` | `wms_escalate_overdue_exceptions` | exception inbox, notifications |

### Pick waves — `wms_pick_waves` (trigger `_wms_emit_state_change`)

| Topic | Meaning | Consumers |
| --- | --- | --- |
| `warehouse.wave.draft` | wave built | wave board |
| `warehouse.wave.released` | released to the floor | RF queue |
| `warehouse.wave.picking` | picking underway | wave board |
| `warehouse.wave.picked` | picking finished | pack station |
| `warehouse.wave.packing` | packing underway | pack station |
| `warehouse.wave.packed` | ready to stage | loading board |
| `warehouse.wave.cancelled` | wave withdrawn | wave board |
| `warehouse.wave.reopened` | manifest cancel released reservations — planner may re-allocate | wave planner, labour |
| `warehouse.wave.planned` | wave planned from open demand (`wms_plan_waves`) | wave planner |

### Loading manifests — `wms_loading_manifests` (trigger)

| Topic | Meaning | Consumers |
| --- | --- | --- |
| `warehouse.manifest.draft` | manifest opened | loading board |
| `warehouse.manifest.loading` | loading underway | loading board |
| `warehouse.manifest.closed` | loading finished | shipping |
| `warehouse.manifest.dispatched` | truck released | shipping, 3PL billing |
| `warehouse.manifest.cancelled` | manifest voided | loading board |
| `warehouse.manifest.tracking_allocated` | carrier tracking number allocated (`wms_allocate_tracking_number`) | dispatch board, shipping |
| `warehouse.manifest.proof_captured` | proof of dispatch captured (`wms_capture_dispatch_proof`) | dispatch board, shipping |

### QC — `wms_qc_inspections` (trigger)

| Topic | Meaning | Consumers |
| --- | --- | --- |
| `warehouse.qc.pending` | inspection opened | QC inbox |
| `warehouse.qc.in_progress` | inspection under way | QC inbox |
| `warehouse.qc.passed` | accepted | inventory projection, 3PL billing |
| `warehouse.qc.failed` | rejected | exception inbox, 3PL billing |
| `warehouse.qc.conditional` | accepted with deviation | QC inbox |
| `warehouse.qc.closed` | inspection filed | QC inbox |
| `warehouse.qc.cancelled` | inspection dropped | QC inbox |

### Cycle counts — `wms_count_sessions` (trigger, plus in-body line event)

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.count.draft` | trigger | count board |
| `warehouse.count.counting` | trigger | count board |
| `warehouse.count.review` | trigger | count board |
| `warehouse.count.recorded` | `record_count`, `record_count_scan` | count analytics |
| `warehouse.count.posted` | trigger | inventory projection, 3PL billing |
| `warehouse.count.cancelled` | trigger | count board |

### Yard — `wms_trailer_visits` (trigger)

| Topic | Meaning | Consumers |
| --- | --- | --- |
| `warehouse.trailer.arrived` | trailer checked in | yard board |
| `warehouse.trailer.docked` | trailer at a dock | yard board, loading board |
| `warehouse.trailer.departed` | trailer left | yard board, 3PL billing (dwell) |
| `warehouse.trailer.no_show` | trailer abandoned before docking | yard board, appointments |
| `warehouse.labour.reclaimed` | no-show cancelled the trailer's open manifests, releasing their `load` tasks | labour/task boards, 3PL billing |

### Dock appointments — `wms_dock_appointments` (in-body)

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.appointment.scheduled` | `schedule_dock_appointment` | yard board |
| `warehouse.appointment.arrived` | `mark_appointment_arrived` | yard board |
| `warehouse.appointment.in_progress` | `start_appointment` | yard board |
| `warehouse.appointment.completed` | `complete_dock_appointment` | yard board |
| `warehouse.appointment.cancelled` | `cancel_dock_appointment` | yard board |
| `warehouse.appointment.rescheduled` | `reschedule_dock_appointment` | dock schedule board |

### Cross-dock — `wms_crossdock_opportunities` (in-body)

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.crossdock.matched` | `evaluate_crossdock_on_grn` | cross-dock board |
| `warehouse.crossdock.staged` | `confirm_crossdock_stage` | cross-dock board, shipping |
| `warehouse.crossdock.qualified` | `evaluate_crossdock_on_grn` / crossdock RPCs | cross-dock board |
| `warehouse.crossdock.rejected` | crossdock qualification RPCs | cross-dock board |
| `warehouse.crossdock.approved` | crossdock approval RPC | cross-dock board |
| `warehouse.crossdock.staging` | crossdock staging RPC | cross-dock board |
| `warehouse.crossdock.loaded` | crossdock load RPC | cross-dock board, shipping |
| `warehouse.crossdock.completed` | crossdock link fulfilled | cross-dock board |
| `warehouse.crossdock.broken` | crossdock link broken before staging | cross-dock board, exception inbox |
| `warehouse.crossdock.expired` | crossdock window elapsed | cross-dock board |
| `warehouse.crossdock.cancelled` | `cancel_crossdock_opportunity` | cross-dock board |

### Replenishment — `wms_replenishment_rules` (trigger)

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.replen.enqueued` | `_wms_maybe_enqueue_replen` via `trg_stock_quants_replen` | replenishment board, labour |
| `warehouse.replen.planned` | `plan_replenishment` via `trg_wms_replen_orders_emit` | replenishment control centre |
| `warehouse.replen.approved` | `wms_transition_replen_order` | replenishment control centre, labour |
| `warehouse.replen.dispatched` | `plan_replenishment` / `wms_transition_replen_order` | labour board, operator queue |
| `warehouse.replen.in_progress` | `wms_transition_replen_order` | replenishment control centre |
| `warehouse.replen.completed` | `complete_replenish_task` | replenishment control centre, inventory projection |
| `warehouse.replen.short` | `complete_replenish_task` | exception inbox, replenishment control centre |
| `warehouse.replen.cancelled` | `wms_transition_replen_order` | replenishment control centre |


### Labour planning — `wms_operator_shifts` (in-body, `wms_publish_labour_plan`)

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.labour.plan_published` | `wms_publish_labour_plan` | labour board, workforce |
| `warehouse.labour.gap_detected` | `wms_publish_labour_plan` | labour board, supervisor alerts |

### Packaging materials — `wms_packaging_materials` (in-body)

| Topic | Producer | Consumers |
| --- | --- | --- |
| `warehouse.packaging.created` | `wms_packaging_upsert` | packaging master data |
| `warehouse.packaging.updated` | `wms_packaging_upsert` | packaging master data |
| `warehouse.packaging.archived` | `wms_packaging_archive` | packaging master data |
| `warehouse.packaging.lifecycle_changed` | `wms_packaging_set_lifecycle` | packaging master data |
| `warehouse.packaging.consumed` | `wms_packaging_consume` | packaging master data, 3PL billing |
| `warehouse.packaging.reorder_needed` | `wms_packaging_consume` | packaging master data, purchasing |

## 4. Inventory consumption rules

Inventory treats WMS topics as facts, never as commands:

- `warehouse.lpn.stored`, `warehouse.lpn.shipped`, `warehouse.qc.passed`,
  `warehouse.count.posted` refresh inventory projections only; the stock
  movement itself is already written inside the owning RPC transaction.
- Inventory never writes WMS tables. WMS never writes ledgers.

## 5. 3PL billing mapping

`_wms_map_event_to_activity(event_type, payload)` is the only mapping from the
canonical vocabulary to billable activities:

| Topic (+payload) | Activity |
| --- | --- |
| `warehouse.receipt.staged` | `receive_lpn` |
| `warehouse.task.completed` + `task_type=putaway` | `putaway` |
| `warehouse.task.completed` + `task_type=pick` | `pick_line` |
| `warehouse.task.completed` + `task_type=pack` | `pack_package` |
| `warehouse.manifest.dispatched` | `dispatch_shipment` |
| `warehouse.trailer.departed` | `yard_dwell` |
| `warehouse.qc.passed` / `warehouse.qc.failed` | `qc_inspection` |
| `warehouse.count.posted` | `cycle_count` |
