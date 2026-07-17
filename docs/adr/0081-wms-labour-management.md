# ADR 0081 — WMS Labour Management

**Status:** Accepted (2026-07-17) · **Related:** 0079 (Inventory vs Warehouse split), Phase 1 (universal task substrate), Phase 10 (this ADR).

## Context

`wms_tasks` (Phase 1) captured `started_at` and `completed_at` on every
operator action but never turned those timestamps into productivity
signal. There was no engineered-labour standard, no earned-hours
computation, no per-operator utilisation. Supervisors couldn't answer
"who is running hot, who is running cold, where is my slack?"

## Decision

Two structural changes and one derived view.

### `wms_task_standards`

Business-scoped master data. Key: `(business_id, task_type, uom)`.
Payload: `seconds_per_uom > 0`, `is_active`, `notes`. Written via
PostgREST by users with the `inventory:write` permission; read by all
business members. This is *master data*, not operational state, so
direct writes are appropriate.

### `wms_tasks.earned_seconds` and `.actual_seconds`

Two new numeric columns, both **trigger-managed**. The BEFORE-UPDATE
trigger `_wms_stamp_labour_metrics`:

1. Rejects direct client writes to either column (any UPDATE that
   changes them without also transitioning `state` is refused —
   only the trigger itself writes them, and `service_role` remains an
   escape hatch for maintenance).
2. On `state` transitioning into `done`, computes
   `actual_seconds = completed_at - started_at` and
   `earned_seconds = quantity * seconds_per_uom` using the active
   standard for `(business_id, task_type)`. Missing standard → `0`
   earned; the task is still recorded, it just doesn't contribute
   productivity credit until a standard is defined.

This trigger approach means Phase 10 requires **no changes** to any of
the existing `complete_*_task` RPCs. Every completion path — pick,
pack, putaway, load, count, replenish, qc, move — already sets
`state='done'`, so the trigger picks them all up automatically.

### `wms_operator_productivity_view`

`(business_id, warehouse_id, operator_id, day)` rollup. `security_invoker=true`
so RLS on `wms_tasks` scopes rows to the caller's business. Utilisation
ratio is `earned/actual`, computed server-side.

## Consequences

- Zero surgery on completion RPCs — trigger owns the stamp.
- Engineered-standard evolution (revising seconds/unit) does not
  retroactively rewrite historical earned figures; standards apply at
  the moment of completion.
- Phase 11 (3PL billing) can additionally consume the same completion
  signal via `business_event_outbox`.

## Non-goals

- No labour-cost accounting (belongs in Finance / Payroll — WMS reports
  hours, not wage rates).
- No fatigue / ergonomic / OSHA reporting.
- No real-time RF-terminal utilisation stream (Phase 16).
