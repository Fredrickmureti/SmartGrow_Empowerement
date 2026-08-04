# ADR-0112 — Wave planning is an orchestration engine, and the tower mirrors it

Status: Accepted · 2026-08-04
Extends: ADR-0101 (WMS domain/event catalog), ADR-0109 (dispatch relieves inventory),
ADR-0111 (Inbound Control Tower).

## Context

`/warehouse-app/waves` was a batching screen: pick orders, press release,
get pick tasks. `wms_pick_waves.strategy` was free text with no engine
behind it; there was no planning state, no readiness evaluation, no link
from a task back to its wave except a JSON metadata key, and no
integration with the labour, dock or appointment modules that decide
whether a wave can actually run. Outbound and inbound therefore
disagreed about warehouse health: inbound had a server-side control
contract, outbound had client-side counting.

## Decision

**The lifecycle expresses planning, not just execution.** `wms_wave_state`
gains `planned`, `ready`, `suspended`, `completed` and `archived`.
`wms_tasks.wave_id` and `wms_loading_manifests.wave_id` are real foreign
keys — the wave is the outbound spine from demand to departure, joining
the manifest spine of ADR-0109.

**Waving is a strategy, executed in SQL.** `wms_wave_strategies` (per
warehouse, ordered, by carrier / zone / customer / cut-off) drives
`wms_plan_waves`, which groups `wms_wave_demand` into planned waves.
Planning proposes; it touches neither stock nor tasks.

**Readiness is a server verdict with one owner.** `wms_wave_readiness` /
`wms_evaluate_wave` score labour capacity, stock coverage and dock
availability into `blocked | at_risk | ready`, persisted on the wave. The
same rule gates `release_pick_wave`, so the button a supervisor sees and
the rule the server enforces cannot diverge; `p_force` is the single,
audited override.

**Release generates all the work the wave implies** — picks, plus
replenishment tasks for shorted pick faces and high-severity
`wms_exceptions` for true shortages — in one transaction, still
reservation-conserving and still idempotent. It remains the only release
write path, with exactly one call site in the wrapper layer.

**The tower reads one contract.** `wms_wave_health`, `wms_wave_board` and
`wms_wave_demand` compute stage membership, progress, risk and drill
routes in SQL. `src/features/warehouse/wave-tower/` owns the TypeScript
contract, thin hooks and presentation; `WavePlanner.tsx` composes from
the barrel and aggregates nothing. `WAVE_QUERY_PREFIXES` is registered in
`useWmsRealtimeSync` for `wms_pick_waves`, `wms_pick_wave_lines`,
`wms_tasks` and `wms_exceptions` — no polling.

## Invariants

1. No client aggregation, ranking or readiness derivation.
2. `release_pick_wave` is the only release path; `wms_transition_wave` is
   the only lifecycle path.
3. Reservation conservation: no phase creates a second reservation system.
4. Refresh is realtime invalidation plus explicit manual refresh.

Regression guard: `src/test/architecture/wave-control-tower.test.ts`.

## Consequences

- Mobile, alerting and the desktop tower consume the same verdict.
- New waving rules are strategy rows or SQL, not UI changes.
- Wave paperwork (`wave_pick_list`, `wave_summary`) is rendered by
  `generate-document` and requested through `printDocument` from
  `WaveDocumentsMenu`; the fetchers are read models and never plan,
  release or transition a wave.
- Capacity is forecast by `wms_wave_capacity`; strategies are provisioned
  by `wms_seed_default_wave_strategies` so the planner is never inert.
- Regression suites: `src/test/architecture/wave-control-tower.test.ts`,
  `src/test/printing/wave-documents-wiring.test.ts`, and
  `supabase/tests/wms_wave_planning_test.sql`.

