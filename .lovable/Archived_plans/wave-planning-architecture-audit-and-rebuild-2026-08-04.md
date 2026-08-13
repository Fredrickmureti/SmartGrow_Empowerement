# Wave Planning — Architecture Audit and Rebuild

## What wave planning actually is

A wave is not a batch of orders. It is a **commitment of finite warehouse capacity to a
subset of outbound demand, for a bounded window, against a physical departure**. The
decision a wave encodes is: *given the labour on shift, the stock actually on hand, the
docks and trailers available, and the carrier cut-offs I must hit — which demand do I turn
into floor work right now, and which do I hold?* Everything downstream (pick, pack, stage,
load, manifest, dispatch) is the mechanical consequence of that decision. Wave Planning is
therefore the **outbound orchestration layer**: it decides and it delegates; it never owns
stock, never owns tasks, never owns docks.

## Findings — current architecture

Verified against the live database and source.

**What exists.** `wms_pick_waves` (15 columns) + `wms_pick_wave_lines`. Seven wave
functions: `create_pick_wave`, `release_pick_wave`, `cancel_pick_wave`,
`wms_transition_wave`, `wms_enqueue_order_for_wave`, `_wms_unwind_cancelled_wave`,
`_wms_wave_on_allocation`. Release (`release_pick_wave`) does real work: it locks the wave,
walks each line, explodes it into one `wms_tasks` row per source bin ordered by
`stock_locations.pick_sequence`, moves the reservation from the sales order to the wave in
`stock_reservations` (`source_type = 'pick_wave'`), is idempotent, and emits an outbox
event. Auto-waving already exists: allocation fires `_wms_wave_on_allocation` →
`wms_enqueue_order_for_wave`, which builds draft waves. Cancellation unwinds tasks and
reservations through the FSM. `wms_pick_waves` is registered in `useWmsRealtimeSync`.

**Strengths.** Reservation ownership transfer on release is correct and is the hard part
most implementations get wrong. Release is atomic, locked and idempotent. Wave/release
separation (SAP EWM's distinction) is already respected. Domain boundaries hold: Inventory
owns quants and reservations, Warehouse owns tasks, the wave orchestrates.

**Weaknesses — the gaps that matter.**

1. **No strategy engine.** `strategy` is a free-text column with no table, no rules, no
   evaluator. Every one of carrier / route / zone / customer / priority / express /
   temperature / replenishment / truck / dock / consolidation waves is unsupported. Waves
   are grouped by "whatever the supervisor ticked" or "whatever allocated".
2. **No readiness contract.** Nothing is evaluated before release — not shortages, not
   labour capacity, not dock or trailer availability, not carrier cut-off, not quality
   holds or inventory freezes. Release either succeeds or short-picks silently
   (`v_short`), and the supervisor learns about the shortage on the floor.
3. **Lifecycle is execution-only.** `wms_wave_state` = draft, released, picking, picked,
   packing, packed, cancelled. There is no `planned`, no `ready`, no `suspended`, no
   `completed` distinct from `packed`, no `archived`. There is no planning phase at all —
   only a draft that jumps straight to floor work.
4. **`wms_tasks` has no `wave_id` column.** Only `wms_pick_wave_lines` and
   `wms_pack_cartons` carry `wave_id`; tasks carry it in `metadata` JSON and
   `source_doc_id`. Every wave-level progress or labour query is a JSON scan.
5. **Release generates pick tasks only.** No replenishment task when the pick face is
   short, no exception task on shortage, no equipment/forklift task, no explicit packing or
   staging work — packing is inferred by a trigger on wave state.
6. **Zero labour integration.** `wms_labour_plan` / `wms_labour_demand` /
   `wms_operator_scorecard` exist and are rich, and the wave engine calls none of them. No
   picker-hour estimate, no projected completion, no "is another wave safe?".
7. **Zero dock / yard / carrier integration.** `wms_loading_manifests` has
   `dock_id`, `carrier_id`, `carrier_service_id`, `appointment_id`, `trailer_visit_id` —
   the wave has none of them. A wave cannot be planned against an appointment or a cut-off,
   and the manifest (the ADR-0109 outbound spine) does not reference the wave.
8. **No warehouse topology beyond `pick_sequence`.** No zone waving, no travel-distance
   estimate, no congestion awareness, no forklift routing.
9. **No wave documents.** `generate-document` registers `bill_of_lading`,
   `dispatch_manifest`, `packing_list`, `carrier_label` — no pick list, no wave summary, no
   pallet/carton label triggered at release. Hardware is reached only indirectly: released
   tasks land in `wms_claim_next_task`, so RF terminals do get work, but release itself
   drives no printer and no device.
10. **The UI is a statistics page.** `WavePlanner.tsx` (251 lines) selects sales orders
    from a `supabase.from("sales_orders")` query, aggregates counts client-side in
    `DraftWaveConsole`, and shows Draft / Awaiting release / Recent waves. It answers none
    of the supervisor's real questions. Inbound (ADR-0111) and Outbound (ADR-0109/0110)
    both already have server-side control-tower contracts; wave planning does not — the
    planning half of the same warehouse disagrees with the execution half.

**Verdict.** The execution primitive is sound. The *planning* subsystem does not exist.
This is a build, not a patch — but it builds on the existing release primitive rather than
replacing it.

## Target architecture

```text
Demand  ──► Eligibility ──► Strategy ──► Wave (planned) ──► Readiness ──► Release
              │                │                                │            │
        allocation,       carrier/zone/                    stock, labour,   tasks:
        holds, cutoff     priority rules                   dock, carrier    pick / replen
                                                                            / exception
                                                                              │
                                                                    pack ► stage ► load
                                                                      ► manifest ► dispatch
```

Wave Planning becomes a **control tower with a server-side contract**, following the exact
pattern ADR-0111 established for inbound: SECURITY DEFINER RPCs own every rule, the client
aggregates nothing, realtime replaces polling, and an architecture regression test guards
the invariants.

## Implementation phases

**Phase 1 — Lifecycle and spine.** Extend `wms_wave_state` with `planned`, `ready`,
`suspended`, `completed`, `archived`; extend `wms_transition_wave`'s edge table
accordingly. Add `wave_id` (FK, indexed) to `wms_tasks` and backfill from
`source_doc_id`; add `wave_id` to `wms_loading_manifests`. Add planning columns to
`wms_pick_waves`: `strategy_id`, `carrier_id`, `carrier_service_id`, `dock_id`,
`appointment_id`, `cutoff_at`, `planned_start_at`, `planned_release_at`, `priority`,
`estimated_pick_minutes`, `estimated_lines`, `estimated_units`, `estimated_cartons`,
`readiness` jsonb, `released_by`.

**Phase 2 — Strategy engine.** `wms_wave_strategies` (per warehouse: kind ∈ carrier,
route, zone, customer, priority, express, temperature, replenishment, truck, dock, batch,
consolidation; selection criteria jsonb; grouping keys; max orders/lines/units; cut-off
offset; auto-release flag; active window; sequence). `wms_evaluate_wave_strategies` scores
eligible demand and `wms_plan_waves(_warehouse_id, _strategy_id)` builds **planned** waves
by grouping key. `wms_enqueue_order_for_wave` is rewritten to delegate to the strategy
engine so auto-waving and manual planning share one code path.

**Phase 3 — Readiness engine.** `wms_wave_readiness(_wave_id)` returns a structured verdict
per dimension — inventory coverage, reservations, shortages, labour capacity (from
`wms_labour_plan` / `wms_labour_demand`), equipment, dock and appointment, trailer/yard,
carrier cut-off, quality holds and inventory freezes, congestion — each `ok | warn | block`
with a reason and a drill route. `wms_transition_wave` gates `planned → ready` and
`ready → released` on it, raising `WMS_WAVE_NOT_READY` with the blocking dimensions, exactly
as ADR-0110 gates dispatch on `WMS_PROOF_REQUIRED`. A per-warehouse setting decides which
dimensions block versus warn, and a supervisor override is recorded as an audit row.

**Phase 4 — Release generates all work.** `release_pick_wave` is extended (not replaced) to
stamp `wave_id` on tasks, and to emit, alongside picks: replenishment tasks when the pick
face cannot cover the wave, exception tasks per shortage, staging and loading work, and the
document requests below. Task ownership stays with `wms_tasks`; the wave never writes
`stock_quants`.

**Phase 5 — Wave documents and hardware.** Register `wave_pick_list`, `wave_summary`,
`pallet_label` and `carton_label` as `generate-document` fetchers over one wave bundle, and
request them from the tower through `printDocument` with A4 / `label` intents — the same
single print entry point ADR-0086/0088 mandate. No standalone printing. RF work continues
to flow through `wms_claim_next_task`, now wave-scoped.

**Phase 6 — Wave Control Tower UI.** New feature module
`src/features/warehouse/wave-tower/` (contract.ts, hooks, presentation, barrel), consumed
by a rebuilt `WavePlanner.tsx`. Four RPCs: `wms_wave_health`, `wms_wave_board`,
`wms_wave_demand` (orders awaiting wave / eligible / blocked, with block reason),
`wms_wave_capacity` (labour hours available vs required, equipment, dock board, projected
completion, congestion). The page shows demand → planned → ready → released → in progress,
with per-wave labour estimate, projected completion, SLA/cut-off risk, shortages, carrier
and dock assignment, and a release control that mirrors the server verdict. All aggregation
in SQL. `WAVE_QUERY_PREFIXES` registered in `useWmsRealtimeSync`; no polling.

**Phase 7 — Guards and docs.** `src/test/architecture/wave-control-tower.test.ts` (no
client aggregation, no direct table writes, single release path, realtime registered) plus
`supabase/tests/wms_wave_planning_test.sql` (pgTAP: lifecycle edges, readiness gate,
reservation conservation, idempotent release, task/wave linkage). ADR-0112 records the
decision.

## Technical notes

- Every new RPC is SECURITY DEFINER, asserts access via `_wms_assert_business_access`, and
  is granted to `authenticated`; new tables get GRANT + RLS + policies in the same
  migration.
- `release_pick_wave` remains the only release write path; `cancel_pick_wave` and the FSM
  remain the only unwind path. Mobile/offline replay names are preserved as delegates.
- Reservation conservation is the load-bearing invariant: no phase may create a second
  path that writes `stock_reservations` for a wave.
- Migrations are additive; the existing draft-wave flow keeps working while `planned` /
  `ready` roll in behind the strategy engine.
