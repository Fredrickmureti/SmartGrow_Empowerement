## Root cause

`physical_count_post` now delegates to `approve_stock_adjustment_atomic`, which writes `stock_movements` rows with `reference_type = 'stock_adjustment'`.

The BEFORE INSERT trigger `enforce_physical_count_freeze` on `stock_movements` only exempts rows where `reference_type = 'physical_count'`. So the exact writer that is *closing* the freeze (the count's own adjustment) is blocked by the freeze it owns. The freeze effectively self-deadlocks on post.

Every other write path (POS, deliveries, transfers, manual adjustments) is correctly blocked — this is only wrong for the count's own reconciliation write.

## Why the previous version worked

The prior `physical_count_post` inserted `stock_movements` directly with `reference_type = 'physical_count'`, so it hit the exemption. When we moved posting into `approve_stock_adjustment_atomic` (correct ADR 0016 direction), the reference_type flipped and lost the exemption.

## Fix (enterprise-grade, no band-aid)

Use the freeze system's existing, first-class escape hatch: the `app.physical_count_freeze_override` session GUC. `physical_count_post` runs `SECURITY DEFINER` inside a single transaction, so it can:

1. Read prior value of `app.physical_count_freeze_override`.
2. `PERFORM set_config('app.physical_count_freeze_override','on', true)` (the `true` = transaction-local, auto-reset at COMMIT/ROLLBACK — cannot leak).
3. Call `approve_stock_adjustment_atomic(v_adj_id, p_user_id)`.
4. Restore the prior GUC value.

This keeps the freeze contract intact for every other caller, keeps ADR 0016 delegation, and uses the same override channel the manager-override RPC already uses — no new bypass surface.

We are NOT going to:
- Change the trigger to exempt `stock_adjustment` — that would silently let *any* stock adjustment bypass any freeze.
- Match by `client_request_id` in the trigger — couples the trigger to physical-count internals and adds a per-row subquery on the hot movement path.

## Migration

Single migration replacing `public.physical_count_post`:

- Same body as today, but wrap the `approve_stock_adjustment_atomic` call in:
  ```sql
  v_prev_override := current_setting('app.physical_count_freeze_override', true);
  PERFORM set_config('app.physical_count_freeze_override', 'on', true); -- txn-local
  v_approve_result := public.approve_stock_adjustment_atomic(v_adj_id, p_user_id);
  PERFORM set_config('app.physical_count_freeze_override',
                     COALESCE(v_prev_override, ''), true);
  ```
- No schema changes, no data changes.

## Verification

- Add a pgTAP-style architecture test asserting `physical_count_post` source contains `set_config('app.physical_count_freeze_override'` around the `approve_stock_adjustment_atomic` call.
- Manual: re-post the failing count. Expect success, `stock_movements` row written with `reference_type='stock_adjustment'` and `reference_id = v_adj_id`, JE created, `physical_counts.state='posted'`, freeze released on state transition, subsequent unrelated writes on the same warehouse no longer blocked.

## Files touched

- New migration: `physical_count_post` replaced with the wrapped-GUC version.
- `src/__tests__/architecture.physical-count-lifecycle.test.ts`: add the GUC-wrap assertion.

No frontend changes.
