# POS Wave — authoritative status
(continues .lovable/plan/pos-wave-transaction-engine-canonical-domain-consumer-audit-2026-08-15.md)

| # | Phase | Verdict | State |
|---|---|---|---|
| 0 | Topology | — | recorded in archived plan |
| 1 | Product consumption / read seam | ✅ | verified this loop |
| 2 | UoM & packaging contract | ✅ | verified this loop |
| 3 | Inventory availability | ✅ | verified this loop |
| 4 | Pricing & tax authority | ⚠ | verified with 2 defects (4a, 4b) — fix first |
| 5 | Transaction/commit integrity & saga | — | **ACTIVE** |
| 6-15 | (unchanged) | — | not started |

## Independent verification of the previous engineer's claims (this loop)

Re-ran the six named suites: **65/65 green** (`pos-product-read-seam`,
`pos-availability-authority`, `pos-pricing-tax-authority`,
`pos-server-authoritative-money-math`, `usePOSCart`, `POSTerminal`).

Live-DB checks (`pg_proc`/`pg_indexes`, not code inspection):
- ✅ Exactly ONE overload each of `list_products_with_branch_stock`
  (5-arg), `pos_resolve_line` (10-arg), `pos_quote_cart` (5-arg),
  `finalize_table_order` (4-arg). Claim confirmed.
- ✅ `process_pos_transaction` still passes contact + packaging + display
  UoM into `pos_resolve_line` (`calls_resolve_line`, `assert_pos_caller_
  branch_access` both present in the live definition). Claim confirmed.
- ✅ `pos_register_stock_scope` / `get_available_pos_stock_for_register_batch`
  exist, SECURITY DEFINER, `authenticated`+`service_role` only. Claim confirmed.
- ❌ **Claim FALSE — "EXECUTE revoked from PUBLIC/anon"**. Live ACLs:
  `pos_resolve_line` and `pos_quote_cart` grant EXECUTE to **anon**;
  `process_pos_transaction` grants EXECUTE to **anon AND PUBLIC** (`=X`).
  All three are SECURITY DEFINER, i.e. RLS-bypassing. This is the single
  most serious finding of the loop and is reclassified as Phase 4a.

## Phase 4a — ❌ SECURITY DEFINER POS RPCs reachable by anon/PUBLIC
- Evidence: `proacl` = `{=X, anon=X, authenticated=X, service_role=X}`.
- Why it matters: an unauthenticated caller can reach the commit path and the
  pricing oracle. Internal `assert_pos_caller_branch_access` may raise, but a
  definer function must never be *reachable* from anon — defence in depth is
  the contract every other POS RPC in this wave already follows.
- Canonical owner: POS server surface.
- Action: migration revoking EXECUTE from PUBLIC and anon on
  `process_pos_transaction`, `pos_resolve_line`, `pos_quote_cart`; then sweep
  every `pos_*` / POS-invoked definer function for the same leak and revoke
  in the same migration. Add a guard test asserting no POS RPC is anon-callable.
- Implement now: YES (blocks Phase 5).

## Phase 4b — ⚠ Idempotency race is not collapsed, it errors
- Evidence: `process_pos_transaction` does a read-then-write idempotency
  check (`pos_transaction_idempotency` cache + prior-row lookup) but the live
  definition contains **no `unique_violation` handler**. The unique indexes
  (`pos_transaction_idempotency_pkey`,
  `pos_transactions_idempotency_key_uidx`) therefore raise 23505 to the
  cashier on a genuine concurrent double-tap / retry-storm.
- Why it matters: correct outcome (one sale) but non-deterministic client
  result — the till sees an error for a sale that DID commit, which is exactly
  the "unknown state" the wave forbids.
- Action: wrap the insert in `EXCEPTION WHEN unique_violation THEN` re-read
  the winning row / cached response and return it with
  `idempotent_replay=true`.
- Implement now: YES (part of Phase 5 commit integrity).

## Phase 5 — ACTIVE: transaction/commit integrity & saga
Substrate already exists and must be VERIFIED, not rebuilt:
- Saga RPCs live: `pos_payment_session_open / record_tender / commit /
  cancel / allocated / reverse_tender / sweep_abandoned`, plus a reversal
  workflow (`pos_reversal_workflow_start/step_start/step_record/finalize`).
- Online retail commit already runs openSession → recordTender×N →
  commitSession (`usePOSTransactionOffline.processOnlineTransaction`),
  keyed off `useCommitKey(register, shift)` (sessionStorage-persisted,
  cleared only on success).
- Offline replay already routes through the same lifecycle in
  `SQLiteSyncManager` using the local row id as the base key (the stale
  "Phase C-3 direct insert" comment in `usePOSTransactionOffline` is
  out of date — delete it).
- 15 triggers on `pos_transactions` already cover event emission, GL posting,
  fiscal enqueue, reversal gate, branch stamping and a
  `require_idempotency_key` guard.

Phase 5 work items, in order:
1. Fix 4a (revoke) and 4b (unique_violation collapse).
2. ⚠ **Table-order path bypasses the engine.** `useTableOrder` INSERTs and
   UPDATEs `pos_transactions` drafts directly from the browser, writing
   `subtotal / tax_amount / discount_amount / total` client-side. Phase 4
   made retail money server-authoritative; restaurant carts still are not.
   Action: drafts must be created/mutated through a server RPC that prices
   via `pos_quote_cart`; the browser sends lines, never money.
3. Prove the saga's partial-failure matrix against the live DB: tender
   recorded but commit lost, commit succeeded but ack lost, session
   abandoned mid-tender (sweep), cancel after authorization. Confirm each
   yields exactly one transaction and one inventory effect, and that an
   unknown payment state is never rendered as "failed".
4. Confirm commit is not synchronously coupled to receipt/printing
   (Phase 11 boundary is cheap to check while inside the commit path —
   record the verdict, do not redesign printing).
5. Record the void/return `stock_movements` gap verdict (known
   pre-existing) and either close it here or hand it to Phase 10.

## Known pre-existing failures (not from this wave)
`inventory-branch-filter`, `posScopeContaminationGuard`, `posBranchIsolation`,
`inventoryAuditCorrections` and ~100 other architecture suites were already
red; they belong to later phases / other waves.

## Next agent — start here
Phases 1-4 are verified; do NOT re-audit them. Start at Phase 5 item 1
(the anon/PUBLIC revoke migration), then item 2 (table-order money
authority), then the saga failure matrix. Record each item's verdict here
before moving on.
