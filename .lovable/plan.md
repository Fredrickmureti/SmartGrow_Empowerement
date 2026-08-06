# Payment Settlement Architecture — Live Status Plan

Authoritative status. Update this file after every completed phase.

Last updated: 2026-08-06 (end of Phase C6)

## Architectural vision

One posting engine (`post_journal_entry_atomic`), one settlement engine per
direction (`record_multi_invoice_payment` for AR, `record_multi_bill_payment`
for AP), and one server-side atomic writer per reversal concern. No client-side
settlement sagas. Every guarantee is frozen by a CI ratchet.

Reference ADRs: 0123 (posting monopoly), 0125 (AR payment reversal),
0126 (AP reversal parity), 0127 (invoice void).

## Completed and verified

| Phase | Scope | Verification |
|---|---|---|
| 1–2 | Posting monopoly. Only `post_journal_entry_atomic` / `update_…` / `void_…` insert journal rows. | `pg_proc` scan: no other function inserts journal rows. Ratchet test. |
| 3 | Bank reconciliation matches, never mints payments. | `reconcile_bank_transaction_atomic` delegates to the settlement engines. |
| 4 | Expense settlement via `post_expense_gl` + `src/lib/finance/expenseSettlement.ts`. | Source read. |
| 5 | POS payment sessions (open/tender/reverse/commit/cancel/sweep) + client + tests. | Tables, 7 RPCs and 4 architecture tests present. |
| C1 | `employee_loan_apply_repayment` duplicate overloads collapsed. | Single signature in `pg_proc`. |
| C2 | Legacy `record_bill_payment_atomic` retired in favour of `record_multi_bill_payment`. | Absent from `pg_proc`. |
| C3 | AR payment reversal → `void_payment_atomic` (period guard, idempotent, reason-coded). | ADR 0125, ratchets. |
| C4 | AP reversal parity → `void_bill_payment_atomic`; `bill_payments` gains status/void columns; `bill_payment_reversal_events` audit trail; dashboards exclude voided. | ADR 0126, ratchets, 11/11 architecture tests. |
| C5 | Invoice void consolidated into `void_invoice_atomic`: JE reversal (main + COGS), header stamp, cascade to `void_payment_atomic`, stock restore — one transaction. Client saga deleted. Fixed latent bug: `void_payment_atomic` defaulted to a non-existent `payment_voided` enum member. | ADR 0127, 2 new ratchets, 11/11 architecture tests, typecheck clean. |
| C6 | Reversal contract + behavioural DB coverage: `supabase/tests/payment_reversal_test.sql`. | Contract assertions (single overload, SECURITY DEFINER + pinned `search_path`, no raw journal inserts, period guard on every reversal RPC, enum-valid reason codes) verified live against the database. |

## Currently active

None — Phase C6 closed. The roadmap advances to Phase B.

## Known caveat carried forward

The behavioural block (section 7) of `supabase/tests/payment_reversal_test.sql`
has **not** been executed: this sandbox has no direct `psql` access and the
available DB tooling cannot roll back a `DO` block, so running it would leave
test rows in the live database. It is written to be run by the SQL test harness
(or any transaction that rolls back). The next agent should execute it in an
environment that can, and treat a failure there as a Phase C6 regression.

## Pending roadmap (chronological)

### Phase B — POS accounting boundary (next, highest remaining risk)
1. Trace `_pos_record_payment` → `finalize_table_order` → register period close
   → `_pos_stmt_enqueue_gl_post` end to end; document the POS settlement
   contract in an ADR.
2. Verify the statement-close GL path posts through `post_journal_entry_atomic`,
   is idempotent per register period, and cannot leave a closed register with
   unposted cash. Route any leg that mints payments or skips the engine through
   the canonical engines.
3. Confirm POS credit sales (`usePOSCreditSale`) settle AR through
   `record_multi_invoice_payment`, not a POS-local path.

### Phase C7 — Employee advances posting path
Bring `employee_advances` onto `post_journal_entry_atomic` and the canonical
settlement entrypoints; delete any local composer.

### Phase D — Ratchet the invariants further
Extend `src/test/architecture/journal-posting-monopoly.test.ts` so CI also
fails on: payment minting outside the four sanctioned writers
(`record_multi_invoice_payment`, `record_multi_bill_payment`,
`record_advance_payment`, POS session commit), and duplicate RPC overloads for
any settlement function.

### Phase E — Reconciliation completeness
Verify `unapply_payment_atomic` and `reallocate_payment_atomic` emit
compensating allocations append-only per ADR 0027, and that reconciliation
never re-derives balances the ledger view already owns.

## Instructions for the next agent

1. **Verify before you build.** Confirm Phase C5/C6 landed correctly and to
   enterprise standard:
   - `void_invoice_atomic` exists with exactly one overload, is SECURITY
     DEFINER with a pinned `search_path`, guards closed periods, returns
     `already_voided` on repeat, and contains no raw journal inserts.
   - `src/hooks/useTransactionReversal.ts#voidInvoice` calls only the RPC plus
     the separate credit-note document step — no JE loops, no invoice status
     writes, no `restore_invoice_stock_atomic` call.
   - `bunx vitest run src/test/architecture/journal-posting-monopoly.test.ts`
     is green (expect 11 tests).
   - Run the behavioural section of `supabase/tests/payment_reversal_test.sql`
     in a rollback-capable environment (see caveat above).
2. **Then resume at Phase B**, in order. Do not start unrelated work, and do
   not leave a phase partially implemented — each phase ends production-ready,
   documented in an ADR, and frozen by a ratchet.
