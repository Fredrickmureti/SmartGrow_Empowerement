# Wave Planning — Verification Verdict and Completion Plan

Subsystem: Outbound Wave Planning / Wave Control Tower (ADR-0112).
Roadmap: `.lovable/plan/wave-planning-architecture-audit-and-rebuild-2026-08-04.md`.
Verification date: 2026-08-04 (independent re-audit of the previous engineer's claims).

---

## Phase 1 — Verification verdict

Every claim was checked against the live database and the codebase, not the log.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Lifecycle states extended | Confirmed | `wms_wave_state` = draft, planned, ready, released, picking, picked, packing, suspended, packed, completed, archived, cancelled |
| `wave_id` spine on tasks + manifests | Confirmed | Both columns exist; no pick task has a null `wave_id` |
| Planning columns on `wms_pick_waves` | Confirmed | strategy, carrier, service, dock, appointment, cutoff, planned start/release, priority, estimates, `readiness`, `released_by`, `suspended_reason` |
| Strategy engine table + `wms_plan_waves` | Confirmed (schema), **inert in practice** | Table has RLS + 4 policies + grants, but zero strategy rows exist, no seeding, and no UI to author a strategy — so planning can never group anything |
| Readiness engine | Partially confirmed | `wms_wave_readiness` scores stock, labour (`wms_labour_plan`), departure (dock/appointment/cut-off) and open exceptions. **No** equipment, quality hold, inventory freeze, congestion, packing-capacity or trailer/yard dimension |
| Readiness gate on release | Confirmed | `release_pick_wave` re-checks readiness and supports an audited `p_force` override |
| Release generates picks + replenishment + exceptions | Confirmed | Present in `release_pick_wave`; single release path preserved |
| Tower RPCs + feature module + rebuilt page | Confirmed | `wms_wave_health`, `wms_wave_board`, `wms_wave_demand` all SECURITY DEFINER, access-asserted, `search_path` set, granted to `authenticated`; `src/features/warehouse/wave-tower/*` and `WavePlanner.tsx` read the contract with no client aggregation |
| Realtime, no polling | Confirmed | `WAVE_QUERY_PREFIXES` registered in `useWmsRealtimeSync` |
| Architecture guard test + ADR-0112 | Confirmed | Both present |
| Phase 5 documents/printing | Confirmed **not started** | No `wave_pick_list` / `wave_summary` / pallet / carton fetcher anywhere |
| `wms_wave_capacity` | Confirmed missing | Function does not exist |
| pgTAP suite | Confirmed missing | No `supabase/tests/wms_wave_planning_test.sql` |

### Defects the previous log did not report

1. **`wms_wave_policies` is a dead table.** It exists, but no function reads it —
   not readiness, not release, not the FSM. The per-warehouse "which dimension blocks
   versus warns" policy the design calls for is unenforced.
2. **The strategy engine is unreachable.** No default strategies are provisioned for a
   warehouse and there is no authoring surface; the tower only offers a picker over an
   empty list, so "Plan waves" is a no-op on every real tenant. Strategy-driven waving
   is therefore not yet true in practice.
3. **Readiness has no equipment / quality-hold / inventory-freeze / congestion
   dimension**, which the audit listed as required release checks.

Net: Phases 1–4 are genuinely built and sound; Phase 6/7 are partial as logged; three
additional gaps are added below. Work resumes at the strategy-reachability defect, then
proceeds through Phase 5 → capacity → guards.

---

## Phase 2 — Remaining work (ordered)

### A. Make the strategy engine real (new — blocks everything downstream)
- Seed a default strategy set per warehouse (carrier, dock/appointment, priority/express,
  customer, catch-all batch) via migration + provisioning on warehouse creation, so
  planning works out of the box.
- Strategy workbench in the tower: list, create, edit, reorder, activate/deactivate,
  with grouping keys, caps and cut-off offset — the same hierarchical pattern the
  Replenishment rule workbench already uses.

### B. Enforce `wms_wave_policies`
- Read the per-warehouse policy inside `wms_wave_readiness` to map each dimension to
  block / warn / ignore; `release_pick_wave` honours the mapped verdict.
- Extend readiness with equipment availability, quality holds, inventory freezes and
  warehouse congestion, each policy-mapped and each carrying a drill route.

### C. Phase 5 — Wave documents and hardware
- Register `wave_pick_list`, `wave_summary`, `pallet_label`, `carton_label` as
  `generate-document` fetchers over one wave bundle.
- Trigger them from the tower through the shared `printDocument` entry point (A4 and
  `label` intents) per ADR-0086/0088 — no standalone print path.
- Print controls live on the release/released rows of `WaveLifecycleBoard`.

### D. Phase 6 residual — `wms_wave_capacity`
- Fourth tower RPC: labour hours available vs required, equipment, dock board,
  projected completion, congestion — all computed in SQL.
- Capacity panel in the tower answering "is releasing another wave safe?".

### E. Phase 7 residual — pgTAP
- `supabase/tests/wms_wave_planning_test.sql`: lifecycle edge legality, readiness gate
  blocks release, policy mapping respected, reservation conservation across
  release/cancel, idempotent double release, task↔wave linkage, strategy grouping.
- Extend the architecture guard to cover the strategy workbench and print entry point.

---

## Technical notes

- All new RPCs stay SECURITY DEFINER, call `_wms_assert_business_access`, set
  `search_path`, and are granted to `authenticated`; new tables ship GRANT + RLS +
  policies in the same migration.
- `release_pick_wave` remains the only release write path; `wms_transition_wave` remains
  the only lifecycle path; no second writer to `stock_reservations`.
- No client-side aggregation is added to the tower; every new number is computed in SQL
  and consumed through `src/features/warehouse/wave-tower/`.
- Migrations remain additive; existing draft-wave and manual release flows keep working.
