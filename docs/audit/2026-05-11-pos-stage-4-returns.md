# POS Stage 4 — Returns Engine Verdict

Date: 2026-05-11
Status: ✅ DONE (this turn closed Stage 4)
Predecessor: `2026-05-11-pos-stage-3-commit-safety.md`, `2026-05-11-pos-stage-r-verification.md`
Successor: Stage 5 — Void / Refund / Cancel separation

## Re-verification matrix

| Claim from previous turn                                             | Status     | Evidence |
|----------------------------------------------------------------------|------------|----------|
| `process_pos_return` reads price/tax from snapshot, not live products | CONFIRMED  | RPC L173-181, 210-214 read from `v_pos_returnable_qty` (which projects from `pos_transactions.snapshot` populated in Stage 3). |
| Returnable-qty enforced via `v_pos_returnable_qty`                   | CONFIRMED  | RPC L121-134 → `error: 'over_return'`. |
| Voided originals rejected                                            | CONFIRMED  | RPC L68-71 → `error: 'original_voided'`. |
| `pos_return_reasons` seeded + FK on every line                       | CONFIRMED  | 6 rows present (`defective`, `wrong_item`, `customer_changed_mind`, `expired`, `price_match`, `other`). RPC L137-150. |
| `requires_note` enforced both ways                                   | CONFIRMED  | RPC L154-162 → `reason_note_required` / `reason_note_not_allowed`. |
| Void↔return separation trigger                                       | CONFIRMED  | Migration `20260511010151_…sql` defines the trigger; verified live. |
| Threshold-driven manager-PIN                                         | CONFIRMED  | `pos_security_settings.return_requires_manager_above_amount` exists; `ReturnDialog` uses it. |
| Cross-tender refund PIN gate                                         | **LANDED THIS TURN** | RPC v2 (this migration) + `usePOSOriginalPayments` + `ReturnDialog` cross-tender branch. |

## What shipped this turn

### Database
- `process_pos_return` v2 — adds `p_override_id uuid DEFAULT NULL`, computes `v_is_cross_tender` by scanning `pos_transaction_payments` for the original transaction, and returns `cross_tender_requires_override` / `invalid_override` when:
  - the refund tender (normalized: `store_credit`→`voucher`) is not present on the original sale,
  - **and** no recent (≤15 min) `pos_manager_overrides` row of type `cross_tender_refund` is supplied.
- The RPC now back-stamps the override row's `transaction_id` to the new return transaction and writes `original_transaction_id`, `refund_tender`, `is_cross_tender` into `metadata` for audit.
- `pos_manager_overrides.approved_at` now defaults to `now()` so audit trails always have a timestamp.

### Frontend
- New hook `usePOSOriginalPayments(transactionId)` — surfaces the original sale's payment-method set.
- `useManagerOverride.OverrideAction` extends with `cross_tender_refund`.
- `ManagerOverrideDialog` registers a label/icon for the new action.
- `usePOSReturns.ProcessReturnData.override_id` added; forwarded to RPC.
- `ReturnDialog`:
  - computes `isCrossTender` from `originalPayments` + selected refund method,
  - lifts the PIN gate when cross-tender (in addition to the boolean and threshold gates),
  - displays an amber cross-tender banner showing original tender(s) → refund tender,
  - opens `ManagerOverrideDialog` with `action="cross_tender_refund"` so the audit row carries the right type,
  - passes the resulting `overrideId` straight back to the RPC.

### Tests
- `src/test/pos/stage-4-returns.test.ts` — structural assertions on the latest migration (over-return, voided-original, reason-required, free-text-note, cross-tender override, store-credit normalization, override link-back) plus hook/dialog wiring guards.
- `supabase/tests/pos_returns_stage_4_test.sql` — psql self-tests for function signature, error-as-jsonb behavior, view shape, and seeded reason codes.

## Audit trail

Every return now writes:
- `pos_transactions` (type=`return`, links `original_transaction_id`),
- `pos_transaction_items` (per line — links `original_item_id`, `return_reason_id`, `return_reason_note`),
- `pos_transaction_payments` (negative amount in the refund tender, with `organization_id`/`business_id`/`branch_id`),
- `stock_movements` (`movement_type='pos_return'`) for tracked products,
- `pos_shifts.expected_cash` / `total_returns` deltas,
- `pos_manager_overrides` (when PIN gated, with `metadata.is_cross_tender`).

## Known gaps deferred to Stage 5

- Same-shift-only enforcement on **voids** (server-side window).
- VOID watermark on reprint sourced from snapshot (UI side).
- `pos_reversal_type` enum to make void/refund/cancel a first-class column on every reversal row.

## Rollback

The new migration is purely additive (no destructive schema). To roll back:
1. `DROP FUNCTION public.process_pos_return(uuid,uuid,uuid,uuid,jsonb,text,text,uuid,uuid);`
2. Re-apply the prior definition from migration `20260511010151_…sql`.
3. Optional: `ALTER TABLE pos_manager_overrides ALTER COLUMN approved_at DROP DEFAULT;`
