
# Loan lifecycle → Finance engine consolidation

## What the investigation found (verified against the live database)

The `23502 entry_number` error is a symptom of architectural drift, not a numbering bug.

**Canonical Finance posting path** (`post_journal_entry_atomic`) exists and is used by 20+ RPCs — invoices, credit notes, customer payments, refunds, POS statements/settlements/cash movements, deliveries, stock adjustments. It provides, in one place:
- source-based idempotency (`source_type` + `source_id` + `source_subtype` → returns the existing entry instead of double-posting),
- ≥2-line and debit/credit balance validation,
- pre-computed header totals with the recompute trigger suppressed,
- consistent org/business/branch stamping on header **and** lines.

Journal numbers come from `generate_next_je_number(org, business)` — an advisory-locked, `je_number_sequences`-backed allocator with self-heal against existing maxima. There is **no** `entry_number` default and **no** trigger on `journal_entries` that assigns one (confirmed by inspecting all 17 triggers and the column definition; `entry_number` is `NOT NULL`, default `NULL`).

**`employee_loan_disburse` bypasses both.** It hand-writes `INSERT INTO journal_entries (...)` — omitting `entry_number` entirely — plus its own `journal_entry_lines` insert (lines also miss `organization_id`). So the loan module re-implemented the posting engine, badly, and the NOT NULL constraint is the first thing that notices. Only four other functions still direct-insert (`confirm_bill_atomic`, `record_multi_bill_payment` — both of which *do* call the numbering allocator — plus `void_journal_entry_atomic`, `revalue_fx_balances` and a couple of backfills, which are legitimate special cases).

Wider gaps found in the same subsystem:
- **No bank movement.** No loan RPC touches `bank_transactions`. Disbursement credits the bank GL account but never creates the bank-ledger row, so loan payouts can never be reconciled in the bank reconciliation workspace.
- **Repayments and write-offs have no GL at all.** `employee_loan_record_manual_repayment` moves `amount_repaid`/`outstanding_balance` and logs a lifecycle event, but posts nothing (no Dr Bank / Cr Loan receivable). `employee_loan_write_off` flips status to `written_off` with dual control, but never posts the bad-debt entry — even though `loan_types.writeoff_account_id` and `interest_income_account_id` exist for exactly that purpose. Loan receivable in the GL therefore drifts from `employee_loans.outstanding_balance` after the first repayment.
- **Correct parts to preserve:** the state machine (`_loan_assert_transition`), SoD/self-action guards, dual control, account resolution via `_loan_resolve_account` → `resolve_default_account`, and `loan_log_event`, which already writes the audit row **and** publishes to `business_event_outbox`. Row-level idempotency via `disbursement_journal_entry_id` is also already there.

## Plan — status: all phases complete

**Phase 1 — Repoint disbursement onto the engine — DONE**
`employee_loan_disburse` keeps every guard and posts via
`generate_next_je_number` → `post_journal_entry_atomic(_source_type := 'loan_disbursement', _source_id := loan.id)`, narration by loan number per ADR-0020. Dr loan receivable / Cr bank.

**Phase 2 — Bank movement — DONE**
`_loan_record_bank_movement` writes the `bank_transactions` row inside the same transaction, keyed `loan-disb:<id>` / `loan-repay:<id>` so retries cannot duplicate it.

**Phase 3 — Close the GL lifecycle — DONE**
- `employee_loan_record_manual_repayment`: Dr bank/cash, Cr loan receivable + interest income split, `source_type='loan_repayment'`, `source_id = repayment id`, plus the bank row.
- `employee_loan_write_off`: Dr `writeoff_account_id`, Cr loan receivable, `source_type='loan_write_off'`.
- `employee_loan_reverse_repayment`: mirrored entry through the engine, `source_type='loan_repayment_reversal'`; never updates a posted entry.
- Payroll-driven deductions: `post-payroll-gl` used to bucket `loan_repayment` payslip lines with statutory deductions, crediting `<rule_code>_payable` — a liability — so the GL receivable drifted permanently after the first deduction. It now calls `payroll_loan_repayment_gl_targets(run)` (aggregates the run's non-reversal `loan_repayments`, splits via `_loan_split_repayment`) and credits loan receivable + interest income. `payroll_required_gl_mappings_for_run` no longer demands `_payable` for loan rule codes. No double count: the payroll leg posts inside the payroll JE, the manual RPC posts per repayment row.

**Phase 4 — Idempotency, concurrency, retries — DONE**
Engine source-key lookup + `disbursement_journal_entry_id` short-circuit + `SELECT … FOR UPDATE` give at-most-once posting per loan and per repayment; fiscal-period and org write-locks now apply uniformly.

**Phase 5 — Guardrails and docs — DONE**
- `src/test/architecture/loan-posting-engine-ownership.test.ts` (no private posting, distinct `source_type`, no UUIDs in narration).
- `src/test/architecture/payroll-loan-repayment-gl.test.ts` (payroll loan lines never hit a payable).
- `finance_loan_receivable_integrity_check` reconciles GL loan receivable against outstanding **principal** (ledger carries principal only).
- ADR 0091 — Loans own state and events; Finance owns posting and numbering.
- `supabase/tests/loan_gl_posting_test.sql` — RPC surface, engine usage, `entry_number` ownership, per-event `source_type`, split conservation.


## Technical notes
- All work is in Postgres migrations (RPC bodies); the frontend hooks (`useEmployeeLoans`) keep calling the same RPC names, so no UI change is needed beyond surfacing the new bank-account/value-date semantics already present.
- Existing loan rows with a disbursement entry are untouched; a one-shot backfill will number/repair only entries that failed to post (there should be none, since the insert aborted).
- No `entry_number` patching, no placeholder or random numbers: numbering stays owned solely by `generate_next_je_number`.
