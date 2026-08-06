# Payment Settlement Architecture — Verification Verdict and Remaining Phases

Last verified: 2026-08-06 (this turn, against the live database and codebase).

## Phase 1 — Independent verification of the previous engineer's claims

Confirmed **true**:

- **C4 (AP reversal parity)** is real. `void_bill_payment_atomic` exists, carries
  a fiscal-period guard, and reverses through the journal void path rather than
  raw journal inserts. `useTransactionReversal.voidBillPayment` is now a thin RPC
  call — no client loop over bills, no delete of `bill_payments`.
- **C5 (invoice void)** is real. `void_invoice_atomic` exists with a period guard;
  the client calls it as a single RPC and the old saga is gone.
- **Posting monopoly still holds.** None of the settlement or reversal functions
  inspected contain raw inserts into `journal_entries` / `journal_entry_lines`;
  `record_multi_invoice_payment`, `record_multi_bill_payment`,
  `record_advance_payment`, `unapply_payment_atomic` and `post_pos_statement_gl`
  all post through `post_journal_entry_atomic`.
- **Phase B is further along than the plan states.** Per-sale POS GL
  (`post_pos_sale_gl`) has been deliberately demoted to a shadow-posting recorder
  and writes no ledger rows; the authoritative path is statement close →
  `accounting_events` + outbox (`_pos_stmt_enqueue_gl_post`, idempotency key
  `pos:pos_statement:<id>:v1`) → `outbox-dispatcher` → `post_pos_statement_gl` →
  posting engine. The contract violation checks in the dispatcher are explicit.
- **C7 is partly done already.** `disburse_employee_advance` posts through
  `post_journal_entry_atomic`, and the client hook only calls that RPC.

Confirmed **incomplete or newly found**:

1. **POS credit sale is a client-orchestrated document saga.**
   `src/hooks/pos/usePOSCreditSale.ts` reserves an invoice number, then inserts
   `invoices`, then `invoice_items`, then updates `pos_transactions` — four
   round-trips with no transaction. A mid-sequence failure leaves a completed POS
   sale with a partial or missing AR invoice. This is the same class of defect
   ADR 0125/0126 removed from reversals, and it is now the highest remaining risk.
2. **The POS statement posting contract is undocumented.** The mechanism is
   sound but there is no ADR fixing it, and no ratchet forbidding a future
   re-introduction of per-sale posting or a second POS→GL path.
3. **The C6 behavioural SQL was never executed.** `supabase/tests/payment_reversal_test.sql`
   exists, but the previous engineer recorded that its behavioural block never ran.
   Until it runs in a rollback-capable harness the reversal guarantees are
   asserted structurally, not behaviourally.
4. **Advance recovery, not disbursement, is still open.** Disbursement posts
   correctly; historical advances disbursed before Phase C have no journal and
   pre-C2 recoveries sit against `advance_recovery_payable` instead of the
   receivable.

## Phase 2 — Remaining plan

### B3 — POS credit sale single writer (next, highest risk)
Add `public.create_pos_credit_sale_invoice_atomic(_pos_transaction_id, _client_request_id)`:
reserve the invoice number, insert the invoice header and lines from the POS
transaction's own items, link it back to `pos_transactions`, and emit the
accounting/business event — all in one transaction, idempotent by POS transaction
id so a retry returns the existing invoice rather than a duplicate. Any AR cash
leg continues through `record_multi_invoice_payment`. `usePOSCreditSale` becomes
a single RPC call. Ratchet: no client insert into `invoices` / `invoice_items`
from POS code.

### B4 — Freeze the POS accounting contract
ADR 0128 documenting statement-centric POS posting: per-sale posting is shadow
only, the register-period statement is the accounting document, idempotency is
per statement, and a closed register cannot carry unposted cash. Extend the
posting-monopoly ratchet to fail CI on any new POS→GL path or on
`post_pos_sale_gl` regaining a journal write. Add a reconciliation check that
surfaces closed statements stuck in `posting_status = 'pending'`.

### C6b — Execute the reversal behavioural suite
Run `supabase/tests/payment_reversal_test.sql` in a rollback-capable harness and
fix whatever it exposes. Add the missing AP counterpart
(`bill_payment_reversal_test.sql`): multi-allocation void restores each bill from
the live allocation sum, a double void returns `already_voided` with no second
journal, the `bill_payments` row survives, and a void in a closed period raises.

### C7 — Advance recovery convergence
Route advance recovery onto the receivable rather than
`advance_recovery_payable`, with a one-off corrective posting for rows already
recorded the wrong way. Add short-circuit idempotency branches to
`unapply_payment_atomic` and `unreconcile_payment_atomic` to match
`void_payment_atomic`.

### Deferred — needs a business decision, not code
Historical backfill of pre-Phase-C advance disbursements: funding account and
posting period must be chosen deliberately. I will raise this rather than
bulk-post.

## Technical notes
- Verification method: `pg_proc` definition scans for raw journal inserts,
  engine usage and period guards; source reads of `useTransactionReversal.ts`,
  `usePOSCreditSale.ts`, `useEmployeeAdvances.ts` and `outbox-dispatcher/index.ts`.
- Each phase closes with `tsgo --noEmit`, the architecture ratchets in
  `src/test/architecture/journal-posting-monopoly.test.ts` and siblings, and an ADR.
- No source files were modified during verification.
