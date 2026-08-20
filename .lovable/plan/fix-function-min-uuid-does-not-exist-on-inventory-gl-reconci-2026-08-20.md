# Fix: "function min(uuid) does not exist" on Inventory ⇄ GL Reconciliation and Lot Traceability

## Verified root cause (evidence)

Dumped `pg_get_functiondef` for every inventory reporting function. Exactly one
contains an aggregate over a uuid column:

`public._inventory_layer_valuation_as_of(uuid, uuid, date, uuid, uuid, uuid, uuid, boolean, text)`

```sql
SELECT
  ls.product_id,
  ls.warehouse_id,
  MIN(ls.branch_id) AS branch_id,   -- branch_id is uuid → no min(uuid) in Postgres
  ...
GROUP BY ls.product_id, ls.warehouse_id, ls.lot_number;
```

Postgres has no `min(uuid)` aggregate, so every call raises at execution time.
This helper is the shared valuation basis behind both failing pages
(`reconcile_inventory_subledger_to_gl` and `report_lot_traceability_as_of`),
which is exactly why both fail with the identical message. No other inventory
function aggregates a uuid (`report_inventory_aging_as_of` and
`backfill_opening_inventory_gl` only use `MIN(timestamp)`), and no application
code needs changing.

## Fix (one migration, no behaviour change)

`branch_id` comes from `warehouses.branch_id` and is functionally dependent on
`warehouse_id`, which is already a grouping key. So the correct fix is not a
cast hack but to group by it:

- add `ls.branch_id` to the `GROUP BY` list and select the column directly,
  dropping the `MIN(...)` wrapper.

This keeps the exact same output grain (product × warehouse × lot) because one
warehouse maps to at most one branch, and it removes the non-deterministic
"lexically smallest branch" semantics the `MIN` implied. Everything else in the
function — the authorization asserts, filters, as-of semantics, returned column
list and order — stays byte-identical, so all existing callers
(`report_inventory_valuation_as_of`, `report_stock_ledger` consumers,
`report_lot_traceability_as_of`, `reconcile_inventory_subledger_to_gl`) are
unaffected.

The migration re-creates the function with `CREATE OR REPLACE`, preserving
`STABLE SECURITY DEFINER`, `SET search_path = public`, and the existing EXECUTE
grants (`authenticated`, `service_role` only — no `anon`/`PUBLIC`).

## Validation

1. Call the helper directly after the migration and confirm rows return instead
   of an error.
2. Confirm `report_lot_traceability_as_of` and
   `reconcile_inventory_subledger_to_gl` execute end to end.
3. Run the inventory architecture ratchets
   (`inventory-lot-traceability-basis`, `inventory-valuation-basis-convergence`,
   `inventory-gl-reconciliation-unified`) and require the same 27/27 pass.
4. Confirm both report pages render (auth is `external_unmanaged`, so UI smoke
   depends on the user reloading the pages; the RPC check above is the
   authoritative gate).

## Out of scope

No page, hook, column-spec or export changes. Phase 7.4 (lot genealogy
drill-down) resumes only after this defect is closed.
