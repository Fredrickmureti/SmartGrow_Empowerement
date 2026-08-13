# Settlement Convergence — Verification Verdict and Remaining Work

## What I verified (this turn, against the live database and codebase)

**Confirmed true**

- *Posting monopoly (Phase 1/2)*: a scan of every `public` function shows only
  `post_journal_entry_atomic`, `update_journal_entry_atomic` and
  `void_journal_entry_atomic` contain raw inserts into `journal_entries` /
  `journal_entry_lines`. No other DB function bypasses the engine.
- *Edge functions*: `post-payroll-gl`, `post-loan-interest-accrual`,
  `process-recurring-invoices` and `reverse-payroll-payment` all post through
  `post_journal_entry_atomic`; their remaining `journal_entries` reads are
  idempotency lookups only, which is correct.
- *Reconciliation demoted (Phase 3)*: `reconcile_bank_transaction_atomic`
  delegates to `record_multi_invoice_payment` and the posting engine, and does
  not insert payments itself.
- *Expense settlement (Phase 4/F5)*: `post_expense_gl` exists server-side and
  `src/lib/finance/expenseSettlement.ts` is the single client entrypoint.

**Confirmed stale / wrong in the previous engineer's log**

- The log says *"Phase 5 — POS settlement boundary (not started). POS
  transactions live in client `useState` with no `pos_payment_sessions`
  table."* This is false. `pos_payment_sessions`,
  `pos_payment_session_tenders`, `pos_payment_session_apply_log` all exist,
  with seven lifecycle RPCs (`open`, `record_tender`, `reverse_tender`,
  `commit`, `cancel`, `allocated`, `sweep_abandoned`), a client
  `src/lib/pos/paymentSessionClient.ts`, consumers in `POSTerminal.tsx` and
  `apps/pos/terminal/tender/TenderWorkspace.tsx`, and four architecture tests.
  Phase 5 is substantially built; the plan file was never updated.
- The log lists `record_bill_payment_atomic` as pending review. That function
  does not exist in the database — nothing to retire.

**New findings not in the previous plan**

1. `pos_payment_session_commit` is balanced and idempotent, but it hands
   tenders to `_pos_record_payment` / `finalize_table_order` rather than to a
   canonical settlement engine, and it does not touch the posting engine. POS
   GL appears to arrive later via register-period statement posting
   (`_pos_stmt_enqueue_gl_post`). Whether that aggregation path is complete and
   idempotent is **unverified** and is the single biggest open risk.
2. `employee_loan_apply_repayment` exists as two overloads (a ~163-char shim
   and a ~5.2k implementation) — exactly the parallel-implementation pattern
   the parent prompt bans.
3. `record_payment_atomic` is a genuine thin shim over
   `record_multi_invoice_payment` (verified), so that item is done.

## Plan

### Phase A — Correct the record
Rewrite the status file so it reflects the verified state above: Phases 1–4
complete, Phase 5 largely complete, Phase 6 scoped to the real remaining items.

### Phase B — Close the POS accounting boundary (highest risk)
- Trace `_pos_record_payment` → `finalize_table_order` → register period close
  → `_pos_stmt_enqueue_gl_post` end to end and document the POS settlement
  contract in an ADR.
- Verify the statement-close GL path posts through `post_journal_entry_atomic`,
  is idempotent per register period, and cannot leave a closed register with
  unposted cash. If any leg mints payments or skips the engine, route it
  through the canonical engines.
- Confirm POS credit sales (`usePOSCreditSale`) settle AR through
  `record_multi_invoice_payment`, not a POS-local path.

### Phase C — Remove remaining duplicate settlement writers
- Collapse the duplicated `employee_loan_apply_repayment` overloads to one
  implementation (drop the redundant signature after checking call sites).
- Bring the `employee_advances` posting path onto `post_journal_entry_atomic`
  and the canonical settlement entrypoints; delete any local composer.

### Phase D — Ratchet the invariants
Extend `src/test/architecture/journal-posting-monopoly.test.ts` (or add a
sibling) so CI also fails on: new payment-minting outside the four sanctioned
writers (`record_multi_invoice_payment`, `record_multi_bill_payment`,
`record_advance_payment`, POS session commit), and duplicate RPC overloads for
settlement functions.

### Phase E — Reconciliation completeness pass
Verify `unapply_payment_atomic` and `reallocate_payment_atomic` (both currently
post through the engine) emit compensating allocations append-only per
ADR 0027, and that reconciliation never re-derives balances the ledger view
already owns.

## Technical notes
- Verification method: `pg_proc` source scan for raw journal inserts,
  `information_schema` table existence checks, and ripgrep over `src/` and
  `supabase/functions/`.
- No source files were modified during verification.
