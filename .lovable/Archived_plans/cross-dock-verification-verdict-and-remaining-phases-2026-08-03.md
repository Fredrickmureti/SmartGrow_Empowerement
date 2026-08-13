# Cross-Dock Orchestration (ADR 0107) — COMPLETE

Status: **Complete — closed 2026-08-03.** No further work is queued on this
initiative. A future agent should not reopen this plan; new cross-dock work
belongs in a new ADR/plan.

## What was delivered

| Phase | Scope | Status |
|---|---|---|
| 1 | Domain model: `wms_crossdock_state` FSM, `wms_crossdock_opportunities`, `wms_crossdock_history`, RLS + grants, event topics | Complete |
| 2 | Configuration-driven qualification: `wms_crossdock_rules` (shelf life, lot/serial, QC, quantity bounds, auto-approve threshold), scoring in `_wms_crossdock_qualify` | Complete |
| 3 | Orchestration RPCs: approve / reject / start_staging / confirm_staged / mark_loaded / complete / break, task creation and closure, optimistic `row_version` | Complete |
| 4 | Exception handling: `_wms_crossdock_auto_break` plus subscribers on sales orders, sales order items, transfers, QC inspections, dock appointments and docks; `wms_crossdock_requalify_sweep` on pg_cron (15 min) and `wms_crossdock_sweep_expired` (hourly) | Complete |
| 5 | Decision Center UI: lane board (awaiting decision / in execution / closed), enriched `wms_crossdock_board_view`, Realtime subscription replacing polling, bulk approve, rules editor | Complete |
| 6 | Demand coverage + labels: replenishment demand matching from `wms_replen_orders`, `wms.label.crossdock_routing` seeded into `wms_seed_default_label_templates`, `crossdockLabels.ts` wrapper, print action on approved/staging/staged plans | Complete |
| 7 | Metrics + guards: `wms_crossdock_metrics_view` KPI ribbon (flow-through rate, units flowed, touches avoided, storage days avoided, dwell, savings), `crossdock-orchestration.test.ts` architecture guard | Complete |

## Guardrails now enforced by tests

- Every FSM state has a registered `warehouse.crossdock.*` event topic.
- The board issues no direct `supabase.rpc` or table call; all writes go through
  `useCrossdock.ts`.
- No client file inserts/updates/deletes `wms_crossdock_opportunities` or
  `wms_crossdock_history`.
- Auto-break, both sweeps, and both views exist in migrations.
- Detection covers `sales_order`, `transfer` and `replenishment` demand.
- The routing label renders through the print platform, never inline ZPL.

Guards: `src/test/architecture/crossdock-orchestration.test.ts`,
`src/test/architecture/wms-phase12.test.ts`,
`src/test/architecture/wms-label-keys-sync.test.ts`.

## Deliberate non-goals (do not treat as gaps)

- Cross-warehouse cross-dock — owned by ADR 0083 Phase 14.
- Production/work-order demand — no work-order aggregate exists in the schema.
- Carrier cut-off derivation from carrier services; cut-off comes from the
  demand document's expected date.
- Opportunistic re-matching after approval.

Design record: `docs/adr/0107-crossdock-orchestration.md`.
