# ADR-0111 — Inbound Control Tower

Status: Accepted · 2026-08-04

## Context

`/warehouse-app/dashboard/inbound` was a statistics page: client-side
counts over a handful of tables, exception "classification" done with a
regex over free text in the browser, no lifecycle, no actions, and a
poll for refresh. It could tell a supervisor how many appointments
existed; it could not tell them which truck was about to blow its
window, why, or what to do about it. Outbound already had a server-side
contract (ADR 0109) — inbound did not, so the two halves of the same
warehouse disagreed about health.

## Decision

Inbound is a **control tower** with the same shape as outbound.

- **Server-side contract.** Four SECURITY DEFINER RPCs own every rule:
  `wms_inbound_health`, `wms_inbound_arrivals`,
  `wms_inbound_bottlenecks`, `wms_inbound_dock_board`. Each asserts
  business access via `_wms_assert_business_access`.
- **One spine.** appointment → gate → yard → dock → unload → capture →
  inspect → cross-dock → put-away. Stage membership, health, SLA risk
  and the worst stage are computed in SQL.
- **Arrival, not row.** `wms_inbound_arrivals` returns each arrival as a
  lifecycle: appointment, trailer visit, dwell, dock, receiving session
  progress, discrepancies, QC, cross-dock, put-away, exception counts,
  a server-assigned `lifecycle_stage`, `risk` and `drill_route`.
- **Feature module.** `src/features/warehouse/inbound-tower/` owns the
  TypeScript contract, thin hooks and presentation. Pages compose from
  the barrel only.
- **Realtime, not polling.** `INBOUND_QUERY_PREFIXES` is registered in
  `useWmsRealtimeSync` for `wms_tasks`, `wms_receiving_sessions`,
  `wms_qc_inspections`, `wms_dock_appointments`, `wms_exceptions`,
  `wms_trailer_visits` and `wms_yard_slots`.

## Invariants

1. **No client aggregation.** The page performs no `reduce`/`filter`
   over server rows; counts, ranking and health come from SQL.
2. **No client classification.** The inbound exception taxonomy lives in
   `wms_inbound_bottlenecks`. No regex over exception text in `src/`.
3. **Actions go through guarded routines.** `mark_appointment_arrived`
   and friends — never a direct table write. Where the next step needs
   floor context the tower lacks, it hands off to the owning surface.
4. **One health vocabulary.** Inbound reuses `HealthState`,
   `FlowStageHealth`, `HealthBanner` and `FlowSpine` from the supervisor
   control centre rather than forking them.
5. **No polling.** Refresh is realtime invalidation plus an explicit
   manual refresh.

Regression guard: `src/test/architecture/inbound-control-tower.test.ts`.

## Consequences

- Mobile and alerting can consume the same contract without re-deriving
  rules.
- New inbound signals are added in SQL; the UI needs no change beyond a
  label.
- Dock/yard, QC, cross-dock and put-away remain the systems of record —
  the tower links into them, it does not duplicate them.
