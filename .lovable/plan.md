## What's actually wrong

Three separate defects, all confirmed against the live database.

### 1. Every WMS state transition is broken (the "Transition rejected" 400)

`wms_transition_receiving` fails with `23514 event_source_domain violates check constraint`.

Cause: there are **two overloads** of the internal helper `_wms_emit_outbox`:

```text
(p_topic, p_idempotency_key, p_organization_id, p_business_id, p_payload)  → writes source = 'wms'   ← BROKEN
(p_topic, p_organization_id, p_business_id, p_payload, p_idempotency_key)  → writes source = 'warehouse'
```

The `event_source_domain` domain allows `'warehouse'` but **not** `'wms'`. Every transition RPC calls positionally in the first order, so they all resolve to the broken overload: `wms_transition_receiving`, `_return`, `_wave`, `_manifest`, `_qc`, `_count_session`, `wms_raise_exception`, `wms_resolve_exception`, `_wms_maybe_enqueue_replen`. This is not specific to "discrepant" — the whole WMS event fabric is dead at the outbox insert.

Fix: one migration that drops the duplicate helper and keeps a single canonical `_wms_emit_outbox` writing `source = 'warehouse'`, with both call orders preserved (keep the two signatures but make both bodies identical and correct, so no caller needs rewriting). Then re-run a transition to confirm 200.

### 2. Wiping transactional data leaves receiving sessions behind

`reset_module__inventory` is the only reset function that mentions WMS at all, and it references just `wms_qc_inspections`. There are **45 `wms_*` tables**, including `wms_receiving_sessions` / `wms_receiving_lines` — none are cleared, which is exactly why your two test sessions survived the wipe.

Fix: add a `reset_module__warehouse` routine that clears WMS execution data for the target business in FK-safe order (sessions, lines, LPNs, tasks, waves, manifests, exceptions, appointments, trailer visits, counts, crossdock links, QC, putaway/replen), remove the stray `wms_qc_inspections` handling from the inventory reset, and register the new module wherever reset modules are enumerated so it runs with the standard wipe. Only transactional/execution rows are removed — warehouse, dock, zone and location master data stays.

### 3. Session detail can't load its lines

The UI requests `wms_receiving_lines?select=...,products(name,sku)` and PostgREST returns `PGRST200`: there is **no foreign key** from `wms_receiving_lines.product_id` to `products`. So opening a session shows no lines at all.

Fix: add the missing FK constraint (`product_id → products(id)`, `ON DELETE RESTRICT`) so the embed resolves. If any orphan `product_id` values exist from the wipe, they are cleaned up in the same migration before the constraint is added.

### Also worth doing

Replace the generic "Transition rejected" toast with the actual server message plus a distinct copy for the two real failure modes (illegal transition vs. row-version conflict), so a backend error like this surfaces meaningfully instead of as a blank rejection.

## Technical notes

- Three migrations: (a) outbox helper repair, (b) warehouse reset module + inventory reset cleanup, (c) receiving-line FK.
- Verification after (a): call `wms_transition_receiving` for session `ae4fcec1…` from `captured → discrepant` and confirm a `business_event_outbox` row lands with `source = 'warehouse'`.
- Frontend change is limited to the error-toast wording in the receiving board/workspace mutation handlers.
- No changes to the lane layout — the board fix from the last turn stays as is.
