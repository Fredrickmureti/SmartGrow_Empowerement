
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

## Plan

**Phase 1 — Repoint disbursement onto the engine**
Rewrite `employee_loan_disburse` to keep every guard (lock, transition assert, account resolution, principal validation) and replace the hand-rolled insert with:
`generate_next_je_number(org, business)` → `post_journal_entry_atomic(..., _source_type := 'loan_disbursement', _source_id := loan.id, _reference := loan_number, _description := 'Loan disbursement <LN-…>' )`, per ADR-0020 narration rules (human document number, never a UUID). Dr loan receivable / Cr bank. Branch taken from the loan row, not the UI.

**Phase 2 — Bank movement**
Insert the matching `bank_transactions` row (withdrawal, value date, loan number reference, link to the journal entry and the loan) inside the same transaction, so disbursements appear in bank reconciliation like vendor payments do. Keyed so a retry cannot duplicate it.

**Phase 3 — Close the GL lifecycle**
- `employee_loan_record_manual_repayment`: post Dr bank/cash, Cr loan receivable (interest split to `interest_income_account_id` when the loan type charges interest), `source_type='loan_repayment'`, `source_id = repayment id` → per-repayment idempotency; plus the bank transaction row.
- `employee_loan_write_off`: post Dr `writeoff_account_id` (bad-debt expense), Cr loan receivable for the outstanding balance, `source_type='loan_write_off'`.
- `employee_loan_reverse_repayment`: reversing entry through the same engine, never an UPDATE of a posted entry.
- Payroll-driven deductions: verify `process_payroll_loan_deductions` settles through the payroll posting path and does not double-count against the manual-repayment posting.

**Phase 4 — Idempotency, concurrency, retries**
The engine's source-key lookup plus the existing `disbursement_journal_entry_id` short-circuit plus `SELECT … FOR UPDATE` give at-most-once posting per loan and per repayment under concurrent clicks and network retries. Verified against fiscal-period locks and the org write-lock trigger, which now apply uniformly because posting goes through one path.

**Phase 5 — Guardrails and docs**
- Architecture test asserting no loan RPC contains `INSERT INTO public.journal_entries` and that every loan GL event carries a distinct `source_type`.
- Integrity check extending the existing `finance_loan_receivable_integrity_check` to compare GL loan-receivable balance against Σ `employee_loans.outstanding_balance`.
- ADR recording the rule: **Loans own state and events; Finance owns posting and numbering.**
- SQL test in `supabase/tests/` covering disburse → repay → write-off, asserting one balanced numbered entry each and idempotency on repeat calls.

## Technical notes
- All work is in Postgres migrations (RPC bodies); the frontend hooks (`useEmployeeLoans`) keep calling the same RPC names, so no UI change is needed beyond surfacing the new bank-account/value-date semantics already present.
- Existing loan rows with a disbursement entry are untouched; a one-shot backfill will number/repair only entries that failed to post (there should be none, since the insert aborted).
- No `entry_number` patching, no placeholder or random numbers: numbering stays owned solely by `generate_next_je_number`.
