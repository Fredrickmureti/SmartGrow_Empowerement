# WMS Continuation Plan — Verified Handoff (Round 3)

## Phase 0 — Independent verification (done, evidence-based)

I re-audited every claim in the previous engineer's ledger against the live codebase and the connected database. Results:

### Confirmed genuinely shipped (green)
- **Phase 1 substrate** — `wms_transition_*` RPCs, `wms_events_catalog`, exceptions/receiving/return tables, TS `WMS_TOPIC` catalog: present.
- **Phase 2.0–2.2** — no direct `state`/`status` writes from `src/pages/warehouse/**`; label wrapper `src/features/warehouse/labels/wmsLabels.ts`; scan-intent hook.
- **Phase 2.3 realtime fabric** — `src/features/warehouse/realtime/useWmsRealtimeSync.ts` exists, and the DB confirms **13 WMS tables are on the `supabase_realtime` publication** (`wms_tasks`, `wms_pick_waves`, `wms_pack_cartons`, `wms_loading_manifests`, `wms_qc_inspections`, `wms_count_sessions/lines`, `wms_exceptions`, `wms_receiving_sessions`, `wms_return_orders`, `wms_license_plates`, `wms_manifest_cartons`, `wms_events_catalog`). This claim holds.
- **Phase 2.4 §2/§3** — the four new transition RPCs and the typed wrappers (`useAggregateTransitions.ts`, `useDomainOperations.ts`) exist and pages were migrated onto them.
- **Undocumented extra work** — the ledger never mentions it, but earlier phases 1–14 shipped far more surface than the plan describes: yard, dock, QC, replenishment, slotting, labour, 3PL billing, cross-dock, carton catalogue, a mobile RF shell (`src/pages/warehouse-mobile/*` with an offline `enqueue()` queue), and 21 architecture guards. The plan file badly under-describes the real state.
- **Typecheck** — `tsgo --noEmit` is clean.

### Claims that are FALSE or overstated (now treated as pending)
1. **"All four WMS architecture guards remain green."** Only the four *new* guards were run. Running the full `wms-*` suite gives **4 failed files / 5 failed tests**. The Phase 2.4 §3 page refactor moved `WavePlanner`, `PickList`, `LoadingBay`, `CountReview` off direct `supabase.rpc(...)` calls, which directly contradicts the older guards that *require* those pages to call those RPCs:
   - `wms-phase3` — "WavePlanner calls create_pick_wave and release_pick_wave", "PickList calls complete_pick_task"
   - `wms-phase4c` — "cycle-count screens call the sanctioned RPCs"
   - `wms-phase5` — "dispatch pages call the sanctioned RPCs"
   This is a red CI suite and a genuine architectural contradiction, not a cosmetic failure.
2. **"`warehouse.carton.loaded` emission gap closed" / outbox parity.** The N7 audit was never actually performed. Querying `pg_proc` shows **11 sanctioned RPCs still emit no outbox event at all**: `move_lpn`, `create_pick_wave`, `assign_line_to_carton`, `generate_replenishment_tasks`, `open_qc_inspection`, `accept_qc_inspection`, `reject_qc_inspection`, `cancel_qc_inspection`, `check_in_trailer`, `assign_trailer_to_dock`, `depart_trailer`. `move_lpn` being silent is the most serious — ADR 0079 claims it is *the* audited relocation path, and the Phase 1 guard enforces its exclusivity, yet an LPN move produces no event, so realtime boards, 3PL billing meters and the audit timeline all miss it.
3. **Phase 14 E2E "harness".** All seven specs under `e2e/wms/` and `e2e/wm/` are scaffolds only — no real assertions. Phase 2.3 §5 (two-context realtime smoke) does not exist in any form.
4. **Phase 2.5 partially mis-stated.** The mobile IndexedDB offline queue *does* exist (Phase 13). What is missing is the **pg_cron lease reaper**: `pg_cron` is installed with 46 jobs scheduled, and **none of them is `wms_task_reap_expired`**. Abandoned task leases are never released in production.
5. **Phase 2.6 ownership doc** — `docs/architecture/WMS_MODULE_OWNERSHIP.md` does not exist. Correctly flagged as pending.
6. **N8 cross-dock** — `wms_crossdock_opportunities` and a CrossdockBoard page exist, but `warehouse.receiving.line_captured` still has no subscriber; the table is populated by an operator-triggered scan, not by the receiving event.
7. **N9** — `wms_exceptions` already has `severity` and `resolution` columns (plus `row_version`), but `resolution` is free text, not the typed enum the plan calls for. No SLA/due-by column.
8. **N10 / Phase 4** — no contention toast, no `<OutboxTimeline>` component anywhere in `src/`.

**True resume point:** not "Phase 2.3 §5". It is **Phase 2.4 §4 — reconcile the contradictory guards and close the outbox emission gap** — because the suite is currently red and eleven state transitions are invisible to the event fabric that every later phase depends on.

---

## Phase 2.4 §4 — Guard reconciliation — DONE

The rule the codebase now follows is: *pages call typed hooks; hooks call RPCs*. The old guards encoded the superseded rule *pages call RPCs directly*. Rewritten, not deleted.

1. `src/test/architecture/wmsGuardUtils.ts` provides `checkRpcOwnership(page, hook, rpc)` — asserts the RPC has exactly one call site in `src/features/warehouse/aggregates/**` AND the page calls the typed hook. Comments are stripped before counting so prose can't be mistaken for a call site.
2. `wms-phase3`, `wms-phase4b`, `wms-phase4c`, `wms-phase5` migrated onto it. RPCs *not* on the domain-RPC ban list (`create_count_session`, `record_count`, `open_loading_manifest`, `close_loading_manifest`, `open_pack_carton`, `assign_line_to_carton`, `complete_pack_task`) keep their page-level call sites and are asserted with `pageCallsRpc`.
3. `wms-guard-parity.test.ts` parses the ban list out of `wms-no-direct-domain-rpc.test.ts` and asserts each banned RPC has exactly one wrapper — the two guard families can no longer drift.
4. **Result:** full `wms-*` suite green (23 files / 84 tests), `tsgo --noEmit` clean.

## Phase 2.4 §5 — Outbox emission parity — DONE (findings corrected)

**The Round-2 audit was wrong.** It grepped for `_wms_emit_outbox`; the actual emitter helper is `_wms_emit_event`. Re-audited:

- The `wms_transition_*` FSMs **do** emit (wave, manifest, qc, count_session, receiving, return, lpn, task, claim_next_task, raise/resolve_exception).
- **21** legacy domain RPCs — not 11 — mutate the same aggregate tables directly, emit nothing, and **none of them delegate** to the emitting FSMs.

Rather than patch 21 function bodies, emission moved to **AFTER triggers on the aggregate tables**, so it cannot be bypassed by any writer, present or future. The triggers reuse the FSMs' exact `wms.<aggregate>:<id>:<transition>` key, so an FSM emission and a trigger emission collapse into one outbox row.

1. `_wms_emit_state_change()` — generic, arg-driven (aggregate, topic prefix, state column, allow-list). The allow-list stops a future enum value from publishing an uncatalogued topic. Wired on `wms_tasks`, `wms_license_plates`, `wms_pick_waves`, `wms_loading_manifests`, `wms_qc_inspections`, `wms_count_sessions`, `wms_trailer_visits`.
2. `_wms_emit_lpn_moved()` — relocation without a status change (`move_lpn`), keyed on `row_version`.
3. `_wms_emit_task_event()` — task-specific, folds `done` and `completed` onto the single catalogued `warehouse.task.completed`.
4. **Rival vocabulary retired.** Discovered mid-phase: legacy `tg_wms_task_emit_event` / `tg_wms_lpn_emit_event` published a *second* naming scheme (`warehouse.plate.moved/.sealed`, `warehouse.task.started`) and the task one used the **same idempotency key** as the canonical producer while writing a different `event_type` — so with `ON CONFLICT DO NOTHING` the published topic for an `in_progress` transition was non-deterministic. Both triggers dropped, their richer payload folded into the canonical emitter, `domainEventBus.ts` + `BusinessSagaMount.tsx` repointed (consumers were log-only placeholders).
5. New topics catalogued + mirrored into `WMS_TOPIC`: `warehouse.lpn.moved`, `warehouse.lpn.sealed`, `warehouse.task.assigned`, `warehouse.trailer.arrived|docked|departed`.
6. `wms-outbox-parity.test.ts` pins all three invariants (triggers live, rival vocabulary stays retired, reaper scheduled).

## Phase 2.5 — Lease reaper — PARTIALLY DONE

1. **DONE.** `cron.schedule('wms-task-lease-reaper', '* * * * *', …)` is live and `active = true`.
2. **DONE by construction.** The reaper flips `state` to `available`, which the `wms_tasks` trigger now turns into `warehouse.task.available` — the reaper body needed no change.
3. **TODO.** Prove offline replay idempotency: replay the same `(device_id, client_scan_id)` twice through the mobile queue and assert exactly one outbox row survives.

## Phase 2.5b — Known defect, next up

`wms_transition_lpn` and `wms_transition_task` build their event payload **after** the `UPDATE … RETURNING` has already overwritten the local record, so `from_status` / `from_state` always equal the *new* state. Every FSM-emitted event in the outbox has a wrong `from_*` field. Fix by capturing the prior state into a local before the UPDATE. (The new triggers report `from_state` correctly, so the two producers currently disagree.)


## Phase 2.6 — Ownership doc

`docs/architecture/WMS_MODULE_OWNERSHIP.md`: producer/consumer matrix per topic, write-owner per aggregate, and the rule that Inventory consumes `warehouse.*` without back-writing. Cross-link ADR 0079 / 0101. Add a guard that every `WMS_TOPIC` value appears in the doc.

## Phase 3 — Module deep-dives (revised order, dependency-first)

Re-ordered because verification changed what is actually weak:

1. **Cross-dock (N8)** — subscribe the receiving line-captured event; match open reservations; emit `warehouse.crossdock.matched`; short-circuit putaway task generation. Currently a board with no automatic trigger.
2. **QC** — now the weakest link: four lifecycle RPCs, zero events. Ships with §5 above, then typed `resolution_kind` enum and quarantine → inventory hold coordination.
3. **Yard / trailer** — same, three silent RPCs; add the trailer FSM state machine on top of the emissions.
4. **Receiving → putaway** — finish ASN → GRN → task fan-out; slotting-rule-driven destination ranking with scan-guarded bin validation.
5. **Replenishment** — event-driven trigger on `stock_quants` change rather than manual generation.
6. **Labour / 3PL billing** — re-meter over the now-complete outbox stream (billing is currently under-counting because 11 event types never fire).
7. **Wave / pick / pack / dispatch** — hardening only; these are the most complete flows.

Each module ships the standard vertical: migration → transition RPC (+ emit) → typed wrapper → page consumption → realtime subscription → real Playwright spec → guard test.

## Phase 4 — UX & error-proofing

- Two-context Playwright realtime smoke (the old 2.3 §5) — moved here, since it belongs with the E2E build-out rather than blocking backend work.
- De-scaffold the seven `e2e/` specs into real assertions, one per module vertical.
- `<OutboxTimeline aggregate id />` reading `business_event_outbox` by idempotency-key prefix — the single audit surface, reusable on LPN, wave, manifest, QC and count detail pages.
- Exception triage screen driven by the typed `resolution_kind` enum + an SLA `due_by` column.
- Multi-operator contention toast (N10) on realtime `claimed` flips by another `assignee_user_id`.
- Unified scan feedback (audio + haptic) across Receiving, Putaway, Pick, Pack, Load, Count, QC.

## Operating rules

- Never write `state`/`status` directly to a WMS aggregate — always a `wms_transition_*` RPC.
- Every sanctioned RPC emits onto `business_event_outbox`. No exceptions after Phase 2.4 §5.
- **Run the entire `wms-*` guard suite, not a subset, before declaring a phase green.** This is the specific failure that produced the red CI in this handoff.
- Update the ledger with evidence (query output, test output), not assertions.
