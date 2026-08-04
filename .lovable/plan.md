# Wave Planning — Authoritative Project Status

Subsystem: Outbound Wave Planning / Wave Control Tower (ADR-0112).
Roadmap reference: `.lovable/plan/wave-planning-architecture-audit-and-rebuild-2026-08-04.md`
(the original audit and 7-phase design — unchanged, still the architectural vision).

Status date: 2026-08-04.

---

## Current position

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Lifecycle states + `wave_id` spine + planning columns | Complete |
| 2 | Strategy engine (`wms_wave_strategies`, `wms_plan_waves`) | Complete |
| 3 | Readiness engine (`wms_wave_readiness`, `wms_evaluate_wave`, release gate) | Complete |
| 4 | Release generates picks + replenishment + shortage exceptions | Complete |
| 5 | Wave documents and hardware (pick list, wave summary, labels) | **Not started — ACTIVE NEXT** |
| 6 | Wave Control Tower UI + server contract | Partial (3 of 4 RPCs) |
| 7 | Guards and docs | Partial (arch test + ADR done, pgTAP missing) |

**Active phase: 5.** Phases 1–4 are closed. Phase 6 and 7 each have one named
residual item, listed below; they are finished as part of the same forward
sequence, not deferred indefinitely.

---

## Fully implemented and verified

**Phase 1 — Lifecycle and spine**
- `wms_wave_state` extended with `planned`, `ready`, `suspended`, `completed`, `archived`;
  `wms_transition_wave` edge table extended to match.
- `wave_id` FK + index added to `wms_tasks` and `wms_loading_manifests`, backfilled from
  `metadata` / `source_doc_id`. Wave-level queries no longer scan JSON.
- Planning columns added to `wms_pick_waves`: strategy, carrier, carrier service, dock,
  appointment, cutoff, planned start/release, priority, estimated pick minutes / lines /
  units / cartons, `readiness` jsonb, `released_by`.

**Phase 2 — Strategy engine**
- `wms_wave_strategies` table (per warehouse; kind, selection criteria, grouping keys,
  max orders/lines/units, cut-off offset, auto-release, active window, sequence) with
  GRANT + RLS + policies in the same migration.
- `wms_wave_demand` identifies waveable order lines; `wms_plan_waves` builds **planned**
  waves by grouping key. Auto-waving and manual planning share the one path.

**Phase 3 — Readiness engine**
- `wms_wave_readiness(_wave_id)` returns a per-dimension verdict (inventory coverage,
  reservations, shortages, labour capacity, dock/appointment, carrier cut-off) as
  `ok | warn | block` with reason and drill route.
- `wms_evaluate_wave` persists the snapshot to `wms_pick_waves.readiness`.
- `release_pick_wave` enforces the gate and raises on blocking dimensions.

**Phase 4 — Release generates all work**
- `release_pick_wave` extended (not replaced): stamps `wave_id` on tasks, emits
  replenishment tasks when the pick face cannot cover the wave, and raises high-severity
  `wms_exceptions` rows per shortage. Still atomic, locked, idempotent; reservation
  ownership transfer preserved.

**Phase 6 — Control tower (the delivered part)**
- `wms_wave_health` and `wms_wave_board` RPCs (SECURITY DEFINER, access-asserted,
  granted to `authenticated`). `wms_wave_board.drill_route` corrected to
  `/warehouse-app/picks/<wave_id>`.
- `src/features/warehouse/wave-tower/`: `contract.ts`, `useWaveTower.ts`,
  `WaveStageStrip.tsx`, `WaveReadinessPanel.tsx`, `WaveLifecycleBoard.tsx`,
  `WaveDemandTable.tsx`, `index.ts`.
- `src/pages/warehouse/WavePlanner.tsx` rebuilt on the server contract — zero client-side
  aggregation, no `supabase.from("sales_orders")` query.
- `usePlanWaves` / `useEvaluateWave` / unified `callReleaseWave` in
  `useDomainOperations.ts`; full `WaveState` union in `useAggregateTransitions.ts`.
- `WAVE_QUERY_PREFIXES` registered in `useWmsRealtimeSync.ts` against `wms_pick_waves`,
  `wms_pick_wave_lines`, `wms_tasks`, `wms_exceptions`. No polling.

**Phase 7 — Guards (the delivered part)**
- `src/test/architecture/wave-control-tower.test.ts` — 8 passing guards: no client
  aggregation, no direct table writes from the tower, single release path, realtime
  registration present.
- `docs/adr/0112-wave-planning-orchestration-and-control-tower.md` authored.

Verification performed: full TypeScript check clean; architecture guard suite green.
Pre-existing unrelated failures in `wms-phase14.test.ts` (`dispatch_proofs` replay
whitelist) are out of scope for this subsystem.

---

## Pending work

**Phase 5 — Wave documents and hardware (active, do first)**
- Register `wave_pick_list`, `wave_summary`, `pallet_label`, `carton_label` as
  `generate-document` fetchers over a single wave bundle (one query, one payload shape).
- Request them from the tower via the shared `printDocument` entry point with A4 /
  `label` intents, per ADR-0086 / ADR-0088. No standalone print path, no direct
  `window.print`, no per-document fetch in the component.
- Wire the print controls into `WaveLifecycleBoard` release/released rows so the
  workflow is complete at the point of release rather than a detached utility.

**Phase 6 residual — `wms_wave_capacity`**
- Fourth tower RPC: labour hours available vs required (from `wms_labour_plan` /
  `wms_labour_demand`), equipment, dock board, projected completion, congestion.
- Surface through `useWaveTower` and a capacity panel; the tower currently shows
  readiness without the capacity projection the roadmap specifies.

**Phase 7 residual — `supabase/tests/wms_wave_planning_test.sql`**
- pgTAP: lifecycle edge legality, readiness gate blocks release, reservation
  conservation across release/cancel, idempotent double release, task↔wave linkage.

Nothing else in the roadmap is outstanding. No item here is optional.

---

## Instructions for the next agent

**Step 1 — Verify before you build.** Do not start Phase 5 until you have confirmed the
delivered work is correct and enterprise-grade. Specifically check:

1. Every new RPC (`wms_wave_demand`, `wms_plan_waves`, `wms_wave_readiness`,
   `wms_evaluate_wave`, `wms_wave_health`, `wms_wave_board`) is SECURITY DEFINER, calls
   `_wms_assert_business_access`, sets `search_path`, and is granted to `authenticated`.
2. `wms_wave_strategies` has GRANT + RLS + policies; no table is reachable without them.
3. `release_pick_wave` is still the only write path to `stock_reservations` for a wave,
   is still idempotent under double call, and the readiness gate cannot be bypassed by
   `wms_transition_wave`.
4. `wave_id` backfill on `wms_tasks` / `wms_loading_manifests` left no orphan rows, and
   nothing still reads wave linkage out of `metadata` JSON.
5. `WavePlanner.tsx` and the tower components perform no aggregation, no direct table
   writes, and no polling. Run `src/test/architecture/wave-control-tower.test.ts` and a
   full TypeScript check.
6. Run the Supabase linter and resolve anything attributable to the wave migrations.

Record the verification verdict in this file before writing new code. If verification
fails, fix the defect in the phase that owns it and re-verify — do not layer Phase 5 on
a broken foundation.

**Step 2 — Resume in order.** Phase 5 → Phase 6 residual (`wms_wave_capacity`) →
Phase 7 residual (pgTAP). Bring each to a production-ready state — server rule, client
surface, guard — before moving to the next. Do not open unrelated warehouse areas, do
not leave a document type registered but unreachable from the UI, and do not add a
capacity RPC without the panel that consumes it.

**Step 3 — Close out.** When Phases 5–7 are complete and verified, update this file to
mark the subsystem done, append the outcome to ADR-0112, and hand back.
