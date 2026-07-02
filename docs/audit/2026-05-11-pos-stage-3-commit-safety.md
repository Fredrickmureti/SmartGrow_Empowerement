# Stage 3 — Transaction Engine Commit Safety

Date: 2026-05-11
Scope: Make every paid POS commit immutable, idempotent, branch-safe, and impossible to accidentally book without tender.

## Pre-existing strengths (kept, not rewritten)

Stage R confirmed that `process_pos_transaction` already had several Stage 3 properties:

- **Idempotency**: `p_idempotency_key text` parameter + `pos_transactions_idempotency_key_uidx` unique partial index on `(organization_id, business_id, register_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. The RPC short-circuits on duplicate and returns the original row. The client picks the key (`crypto.randomUUID()` in `usePOSTransactionOffline`, queue id in `services/offline/TransactionQueue`). **No change needed.**
- **Atomic stock**: `RAISE EXCEPTION ... USING ERRCODE = 'check_violation'` if a tracked product hits the loop without a warehouse, plus stock-reservation overlap check per branch. **No change needed.**
- **Branch context required**: Register without `branch_id` is rejected up-front with `Register has no branch context`. **No change needed.**
- **Org/business mismatch guard**: `RAISE EXCEPTION` if the supplied org/biz don't match the register row. **No change needed.**

## What Stage 3 added

### 1. Receipt snapshot — `pos_transactions.snapshot jsonb`

`ALTER TABLE pos_transactions ADD COLUMN snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`.

Inside the same atomic INSERT, the RPC now builds and stores:

```
{
  schema_version: 1,
  committed_at, transaction_number, transaction_type,
  organization_id, business_id, branch_id, register_id, register_code,
  shift_id, cashier_id, currency,
  customer: { id, name, tin },
  totals:   { subtotal, tax, discount, tip, total, paid, change },
  items:    [...],
  payments: [...],
  notes, idempotency_key
}
```

Reprints, audits, and history detail views must read from `snapshot` rather than joining live product/template/customer rows. This kills the "reprint shows the new product price" class of bug and makes historical receipts immutable even if products are renamed, repriced, or deleted.

Stages 4 (returns) and 12 (history reprint) will switch the read paths to `snapshot` — Stage 3 only writes it.

### 2. `no_payments` guard

Before Stage 3, calling the RPC with `p_transaction_type='sale'`, `p_total > 0`, and an empty `p_payments` array would silently mark the row `payment_status='partial'`, leaving a phantom unpaid sale on the shift. Stage 3 short-circuits this with:

```sql
IF p_transaction_type = 'sale'
   AND COALESCE(p_total, 0) > 0
   AND (p_payments IS NULL OR jsonb_array_length(p_payments) = 0) THEN
  RETURN jsonb_build_object('success', false, 'error', 'no_payments', ...);
END IF;
```

Genuine credit / on-account sales still go through `transaction_type='sale'` with at least one payment line of method `customer_account` (Stage 8 will formalise the AR mapping).

## What Stage 3 deliberately did NOT change

- Idempotency, atomic stock, branch-context guards (all already correct).
- Split-payment math: the existing `v_total_paid < p_total → partial` branch is correct for legitimate AR / partial payments. Stage 3 only fences off the zero-payment case.
- Cash-change line generation: change is already returned in the response and computed server-side as `GREATEST(0, v_total_paid - p_total)`. Generating an explicit cash-back line in `pos_transaction_payments` is deferred to Stage 6 (cash control), where it pairs with the live expected-cash view.

## Tests

`src/test/pos/stage-3-commit-safety.test.ts` — 4 cases, all green:

1. `process_pos_transaction` migration declares `v_snapshot jsonb`, builds a snapshot with `committed_at`, and inserts it into the `snapshot` column.
2. Migration contains the `no_payments` guard with `jsonb_array_length(p_payments) = 0`.
3. Idempotency-key short-circuit is preserved (Stage R regression guard).
4. `Register has no branch context` reject path is preserved.

The pre-existing `posScopeContaminationGuard.test.ts` and `inventoryAuditCorrections.test.ts` continue to pass against the new function body.

## Verdict

Stage 3 = **GREEN**. Commits are now immutable (snapshot), idempotent (existing key + index), branch-required (existing guard), and cannot be silently zero-tendered (new guard).

Next: Stage 4 — returns engine de-decoration (`v_pos_returnable_qty`, `pos_return_reasons`, threshold-driven PIN, refund-tender lock, original-tender default).
