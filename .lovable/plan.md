# Inventory Control simulation — resume at Handling Units, then Slotting, then close-out

The previous session certified Replenishment and Cycle Counts end-to-end (10 authoritative repairs). This continues from that exact checkpoint. Nothing already proven gets re-tested.

## Checkpoint

```text
Scenario: Inventory Control end-to-end (Joshua Holdings / Headquarters)
Done:  ✓ fixture  ✓ replenishment trigger→task→movement  ✓ cycle count→variance→adjustment→GL
Next:  → Handling Units full lifecycle (dispatch never completed)
Then:  → Slotting (0 velocity rows, 0 rules — unverifiable today)
Then:  → 3 carried-over defects + final reconciliation
```

Confirmed by direct query: `wms_packaging_types` = 0, `wms_slotting_rules` = 0, `wms_slotting_velocity_view` = 0 rows, 4 license plates exist, dead-letter queue clean.

## Step 1 — Handling Units, full lifecycle

Seed the missing fixture for a legitimate reason: a pallet packaging type and a carton packaging type (tare weight, max weight) so capacity policy is exercisable, on the same warehouse/product already used.

Drive the real business intent "pack this replenished stock into a pallet and dispatch it": create plate → load from PICK-A01 through `wms_lpn_load` (packaging-aware, server-side UoM conversion) → nest a carton in the pallet → move → seal → dispatch → receive_return on one plate.

At each transition verify plate state, contents, `stock_quants.lpn_id`, location, parent/child links, `wms_lpn_events`, the emitted `warehouse.*` business event and its consumer, and that stock balances are unchanged by pure container moves. Exercise capacity: load past `max_weight_kg` with `enforce_handling_unit_capacity` on (expect `WMS_LPN_OVER_CAPACITY`) and off (expect an `wms_exceptions` row). Exercise idempotency: replay a load with a stale `row_version` and confirm exactly one movement.

Any blocker is repaired at the authoritative layer (RPC/trigger/constraint), hardened, covered by an extension to `supabase/tests/wms_lpn_handling_unit_test.sql`, re-run, and the lifecycle resumes.

## Step 2 — Slotting, prove the boundary

Slotting today reads `wms_slotting_velocity_view` only and writes nothing. Verify that claim against the view definition and `wms_slotting_rules` (which no screen appears to use). Generate real velocity by ensuring the picks performed in this simulation fall in the rolling window, then confirm the A/B/C classification is computed from actual pick history rather than empty.

Then answer the integration question with evidence: does slotting feed putaway (`PutawayStrategies`) or replenishment source/destination selection, or is `wms_slotting_rules` an orphan table with no writer and no consumer? If it is analytics-only by design, that boundary is documented and no state transition is forced. If `wms_slotting_rules` is a dead half-built engine, it is reported as an architectural finding rather than silently populated.

## Step 3 — Carried-over defects from the previous session

1. **Counted location lost at the WMS → Physical Count handoff.** Physical counts are warehouse-level; repair #10 only mitigated the damage. Fix: carry the counted location through to the adjustment writer so the decrement lands in the bin that was counted, with a regression test asserting per-location fidelity.
2. **Abandoned count sessions freeze stock forever.** Add an expiry/auto-release path for stale sessions so a walked-away operator cannot lock inventory indefinitely, plus a guard test.
3. **Unregistered `warehouse.*` topics.** `business_event_topic_registration_test.sql` already ratchets exact registration; register the missing topics so any newly emitted handling-unit topics cannot dead-letter.

## Step 4 — Cross-module and final reconciliation

Prove or disprove, with traced events rather than foreign keys: Replenishment ↔ Handling Units (does a replen task move a plate?), Cycle Counts ↔ Handling Units (can a count target plate contents?), Slotting ↔ Putaway. Then reconcile inventory truth once more (bins = warehouse = lot totals, no drift), and deliver the final report: verdict, real business-event map, seeded fixture and its justification, repair log (failure → root cause → fix → hardening → regression → verification), remaining defects, event-integrity, state-machine and architecture assessment.

## Technical notes

- All repairs go through `supabase--migration`; no client-side workarounds, no second writer, no weakened constraints, no legacy fallback retained without proving it is still called.
- Test data stays inside the existing simulation tenant/warehouse and reuses the seeded product and lots; new rows are limited to packaging types and plates.
- Regression coverage extends existing ratchets (`wms_lpn_handling_unit_test.sql`, `inventory_replenishment_lifecycle_test.sql`, `business_event_topic_registration_test.sql`) rather than adding parallel test files.
