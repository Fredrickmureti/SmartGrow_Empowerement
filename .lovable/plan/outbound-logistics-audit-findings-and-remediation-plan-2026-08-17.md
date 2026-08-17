# Outbound Logistics — audit findings and remediation plan

## What the investigation already established

Two of the visible symptoms are not rendering bugs; both were traced to their canonical source and confirmed against the live database.

**1. The NaN metrics are a broken server projection, not a UI default.**
`wms_outbound_shipments` builds each shipment as a `jsonb_build_object(...)`, then aggregates the *whole subquery row* (`jsonb_agg(x ...)`, where `x` also carries `risk_rank`, `sla_sort`, `created_at`). Postgres therefore returns, for every shipment:

```text
{ "jsonb_build_object": { ...the real shipment... }, "risk_rank": 1, "sla_sort": null, "created_at": "..." }
```

So `carton_count`, `carton_sealed`, `carton_manifested`, `carton_loaded` are all `undefined` on the client — `packed - sealed` becomes `NaN`. The same wrapping silently breaks `lifecycle_stage`, `risk`, `blocked_reason`, `has_proof` and the drill routes, which is why the lifecycle board, bottleneck rail and departure timeline look inconsistent. Confirmed live: this function is the only one in the database with that aggregation shape (`get_count_command_center` uses single-column subqueries and is safe).

**2. `[object Object]` is a missing error contract at the RPC boundary.**
`replayGuardedCall` rethrows the raw Supabase `PostgrestError`, which is a plain object, not an `Error`. Every handler that falls back to `String(e)` (`normalizeError` in `useDomainOperations`, the close handler in `LoadingBay`, `MobileDispatch`, `LoadingManifestPlanner`) prints `[object Object]`, and the `WMS_SCAN_SHORTAGE` / row-version branches never match because they test `e instanceof Error`. So genuine business-rule rejections (short scan-out, stale row version, missing proof) are currently invisible to operators — they see a meaningless string and the guard branches silently fail open.

Everything below is scoped so that no new engine is created: dispatch already relieves inventory through `wms_lpn_dispatch` (ADR-0109), state changes already go through `wms_transition_manifest` / `wms_transition_wave`, documents already route through `printDocument` (ADR-0086/0088), and events already flow through `business_event_outbox` (ADR-0076/0101).

## Phase 1 — Repair the canonical outbound projection

- Rewrite the final `SELECT` of `wms_outbound_shipments` so the aggregate takes the shipment object itself (`jsonb_agg(x.row ORDER BY x.risk_rank DESC, ...)`), with sort keys kept as sibling columns rather than folded into the aggregated value.
- Re-verify the contract field-by-field against `OutboundShipment` in `src/features/warehouse/outbound-tower/contract.ts`; `risk` and `drill_route` are asserted present (they are consumed by the board and by `ShipmentActions`).
- Add a pgTAP guard (`supabase/tests/wms_outbound_projection_test.sql`) asserting that every key of the declared contract is present in a returned element and that no element carries a `jsonb_build_object` key — so this class of defect cannot silently return.
- No `|| 0` is added anywhere. A zero renders only when the server means zero.

## Phase 2 — A real result contract for outbound operations

- Introduce one shared translator in `src/features/warehouse/` that turns a Postgres/Supabase failure into a typed outcome: `business_rule` (mapped from the `WMS_*` codes already raised by the FSMs), `concurrency` (`row_version`), `authorization`, `validation`, `system`. It reads `code`, `message`, `details`, `hint` off the Postgres error rather than assuming `instanceof Error`.
- `replayGuardedCall` wraps the raw error into that typed shape without discarding the original (preserved for logging).
- Every outbound call site — `useDomainOperations`, `LoadingBay`, `LoadingManifestPlanner`, `MobileDispatch`, `ShipmentActions`, `DispatchProofForm` — surfaces the translated message. The existing `WMS_SCAN_SHORTAGE` and proof branches are re-pointed at the typed code so they actually fire.
- Keeps `no-raw-error-message-in-toast` discipline: user copy comes from a code→copy map, not from raw SQL text.

## Phase 3 — Close vs Dispatch, verified against the state machine

- Read `wms_transition_manifest` end to end and document the authoritative edges, guards and consequences (scan-out completeness, proof requirement, inventory relief through `wms_lpn_dispatch`, delivery-note bridge, event emission) in an ADR addendum.
- Reconcile the UI with it: `close` is completion of loading (scan-out complete, no more cartons accepted); `dispatch` is departure (proof satisfied, stock relieved, sales fulfilment advanced, events emitted). Buttons, labels, disabled states and tooltips are driven by the server verdict (`wms_manifest_proof_status`, `wms_manifest_short_cartons`) rather than re-derived in the browser.
- Any UI path still capable of implying a state change the FSM would refuse is removed.

## Phase 4 — Outbound documents on the shared pipeline

- Confirm each of `bill_of_lading`, `dispatch_manifest`, `packing_list`, `carrier_label` is registered as a document kind with its own outbound data resolver drawing from manifest, cartons/LPNs, contents, lots/serials, weights, carrier, tracking, dock, parties and tenant/branch context. Where a kind is registered but has no resolver, the menu stops offering it until the resolver exists — no invoice-template reuse, no fabricated totals.
- Document availability in the menu becomes a function of what the server can actually render for that manifest.

## Phase 5 — Exceptions as workable items

- The control-tower exception rail gains, per exception: owner, cause, severity, lifecycle state and the resolution route already modelled by `wms_exceptions` / `wms_resolve_exception`. Display-only red cards become links into the surface that clears them. No new exception engine.

## Phase 6 — Realistic end-to-end verification

- Extend the existing `wms_e2e_ensure_seed` contract (`e2e/support/seed.ts`, `is_sample_data = true`) with one realistic outbound scenario: business → branch → warehouse → customer → two tracked products → sales order → availability → allocation → wave → pick → pack → carton/LPN seal → manifest → carrier + tracking → load → proof → dispatch.
- Playwright specs under `e2e/wms/` walk the happy path and the negative paths that matter here: partial pick, unsealed carton load attempt, duplicate load, duplicate dispatch, concurrent dispatch, missing carrier, missing proof, invalid close, cancelled order.
- Each step asserts database state, not just UI: manifest/wave/carton/LPN state, `stock_movements` and `stock_quants`, delivery-note status, `business_event_outbox` rows and idempotency keys, and audit rows. Seeded rows stay tagged and removable.

## Technical notes

- One migration for Phase 1 (function replacement, no schema change); one for any document-kind registration found missing in Phase 4.
- Multi-tenancy is unchanged: `_wms_assert_business_access` stays the gate, and every query keeps its `business_id` / `warehouse_id` scoping.
- Ordering: Phases 1 and 2 are prerequisites for judging anything else, because until the projection and the error contract are correct, the tower's numbers and every failure message are untrustworthy evidence.
