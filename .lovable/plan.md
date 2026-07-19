## Root cause (verified in Postgres logs)

Postgres logs from the last commit attempts show the actual failure — repeated:

```
ERROR 23514: new row for relation "business_event_outbox" violates check constraint "business_event_outbox_source_check"
```

The check constraint on `business_event_outbox.source` only allows:
`pos, finance, manual, system, trigger, procurement, purchasing, hr, crm, sales, inventory, warehouse, payroll`.

During a Quick Cash commit, `process_pos_transaction` writes a `stock_movements` row with `movement_type='pos_sale'`. That fires trigger `trg_stock_movement_emit_event` → function `public.trg_stock_movement_emit_event_fn()`, which inserts into `business_event_outbox` with:

```
source = 'stock_movements'   -- INVALID, not in the allowed list
```

This function has **no `EXCEPTION WHEN OTHERS` handler**, so the 23514 propagates up and aborts the whole `pos_payment_session_commit` RPC → the frontend sees `400 Bad Request`.

A second offender exists on the same path: `public.tg_stock_movement_emit_event()` uses `source = 'db_trigger'` (also invalid). It swallows errors via `EXCEPTION WHEN OTHERS`, so it only pollutes logs today, but it is broken and must be fixed too.

Previous "fixes" only patched `trg_pos_transaction_emit_event_fn` and `trg_pos_payment_emit_event_fn`. They never touched the stock-movement emitters, which is why the same 400 keeps returning.

## Fix

Single migration, no application/UI changes:

1. `CREATE OR REPLACE FUNCTION public.trg_stock_movement_emit_event_fn()` — change the inserted `source` from `'stock_movements'` to `'inventory'` (matches the domain the event describes and is in the allow-list). Keep everything else identical.
2. `CREATE OR REPLACE FUNCTION public.tg_stock_movement_emit_event()` — change `source` from `'db_trigger'` to `'inventory'`. Keep the `EXCEPTION WHEN OTHERS` guard.
3. Preventive hardening (same migration): audit every remaining `public` function that inserts into `business_event_outbox` and normalize any `source` value not in the allowed set to a valid domain tag (`inventory`, `warehouse`, `pos`, `procurement`, `finance`, `system`). Specifically re-check the functions flagged earlier: `pos_emit_drawer_event`, `pos_emit_register_period_event`, `pos_emit_return_authorization_event`, `pos_close_card_settlement`, `tg_emit_pos_card_fsm_event`, `emit_qc_event`, `tg_wms_task_emit_event`, `tg_wms_lpn_emit_event`, `tg_stock_adjustment_emit_lifecycle`, `tg_stock_transfer_emit_lifecycle`, `tg_physical_count_emit_lifecycle`, `emit_yard_event`, `emit_crossdock_event`, and the manifest/appointment helpers. Only functions with an invalid `source` literal get rewritten; correct ones are left alone.

## Verification

- Re-query `postgres_logs` for `sql_state_code='23514'` on `business_event_outbox_source_check` after the migration — expect zero new occurrences.
- User retries Quick Cash on the same register; commit should return `200` and the session transitions from `balanced` → `committed`.
- Confirm the new outbox rows show valid `source` values via `SELECT source, count(*) FROM business_event_outbox WHERE created_at > now() - interval '10 min' GROUP BY 1`.

## Out of scope

No changes to `pos_payment_session_commit`, `process_pos_transaction`, the deferred GL trigger, the frontend, or the outbox schema. If we later want to extend the allow-list instead of remapping sources, that is a separate decision.
