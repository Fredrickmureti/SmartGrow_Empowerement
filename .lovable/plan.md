
# Employee Loan Subsystem — Architecture Repair

## What I verified (not assumed)

Direct database and code reads confirm the following, all currently broken:

**1. ESS loan requests fail on a self-inflicted constraint.**
`request_employee_loan(jsonb)` computes `v_monthly := 0` for the `percent_of_net` method (line 124), then inserts into `employee_loans`, which carries `CHECK (monthly_deduction > 0)`. Every percentage-based self-service request dies with a raw Postgres check violation. Additionally `employee_loans.business_id` is `NOT NULL` while the ESS payload sends `null` whenever the employee has no business assignment — a second guaranteed failure with an opaque message.

**2. The admin lifecycle calls RPCs that do not exist.**
Comparing `src/hooks/useEmployeeLoans.ts` against the actual catalogue of functions in the database:

| UI calls | Database actually has |
|---|---|
| `employee_loan_suspend` | *(does not exist)* |
| `employee_loan_pause_recovery` | `employee_loan_pause(_loan_id,_until,_reason)` |
| `employee_loan_resume_recovery` | `employee_loan_resume(_loan_id)` |
| `employee_loan_write_off(_loan_id,_reason,_journal_date)` | `employee_loan_write_off(_loan_id,_reason,_cosigner)` |
| `employee_loan_restructure(_new_term_months,_new_interest_rate,…)` | `employee_loan_restructure(_kind,_new_principal,_new_installments,_new_start_date,_new_monthly,_reason)` |
| `employee_loan_record_manual_repayment(_payment_date,_bank_account_id,_reference)` | `…(_amount,_repayment_date,_notes)` |

Every one of these returns a PostgREST "function not found" error, which the hooks surface as a generic toast — this is why error messages look unrelated to the action.

**3. Duplicate overloads make two functions unresolvable.**
`generate_loan_schedule` exists twice (`(_loan_id)` and `(_loan_id,_dry_run)`) and `approve_employee_loan` exists twice (`(_loan_id,_decision,_notes)` and `(p_loan_id)`). A single-argument call is ambiguous and fails at the API layer. `approve_employee_loan` is dead legacy — the live path is `employee_loan_lifecycle_approve`.

**4. Loan accounting cannot post at all.**
All four seeded loan types (`LOAN`, `SAL_ADV`, `EMERGENCY`, `ASSET`) have `NULL` for `gl_receivable_account_id`, `gl_disbursement_clearing_account_id`, `interest_income_account_id` and `writeoff_account_id`. `system_account_roles` contains no loan roles, and `default_account_settings` has no loan keys. `supabase/functions/_shared/loan-gl/handlers.ts:77,171` therefore rejects every disburse/accrue/settle with a 400. Loans are the only payroll-adjacent domain with no default account provisioning — garnishments, PAYE, NSSF and net salary all have seeded roles.

**5. Skip policy validation is disconnected from the form lifecycle.**
`loan_types_validate_policy_bounds()` raises `skip caps configured but allow_skip is false`. The Loan Types form disables the cap inputs when `allow_skip` is off but never clears previously entered values, so toggling skip off and saving throws a constraint error about fields the user cannot see — matching the reported symptom.

**6. Approvals are half-migrated, not parallel-built.**
`request_employee_loan` already inserts into `approval_requests` with `entity_type='employee_loan'` and looks up `approval_workflows`, but: the Studio entity registry (`ApprovalRulesManager.tsx` `ENTITY_ACTIONS`) has no loan entry so no workflow can ever be configured; and `employee_loan_lifecycle_approve` approves the loan without ever resolving the `approval_requests` row. Loans therefore create orphaned pending approval requests forever. The SoD self-action layer *is* correctly wired (`sod_employee_loans_guard`, catalogue entries for `loan.approve`, `write_off`, `restructure`, etc.) and must be kept as-is.

**7. Lifecycle gaps.** No trigger generates a repayment schedule on approval (it is a manual RPC), and no `governance_duties` rows exist for loan origination vs. approval vs. disbursement, so the SoD conflict report is blind to loans.

## Execution plan

### Phase 1 — Restore a valid request contract (DB)
- Rewrite `request_employee_loan` so derived amounts are always valid: for `percent_of_net` and other non-fixed methods, persist an indicative installment (`principal / installments`) rather than `0`; payroll continues to recompute per period from `repayment_percent`. Keep the `> 0` invariant — the amount column must never be a sentinel.
- Resolve `business_id` server-side: request payload → employee's business → org's sole business; raise a *typed, explanatory* error only when genuinely ambiguous.
- Wrap every failure in domain-language exceptions with a stable `HINT` code (`LOAN_POLICY_*`, `LOAN_CONTEXT_*`) so the client can translate them.

### Phase 2 — Eliminate signature drift (DB + frontend)
- Drop the dead `approve_employee_loan` overloads and collapse `generate_loan_schedule` to one signature with a defaulted `_dry_run`.
- Add the genuinely missing `employee_loan_suspend`, and align the write-off / restructure / manual-repayment argument lists with what the lifecycle needs (restructure gains an explicit `kind` covering restructure, top-up, refinance, consolidation — the `refinance_kind` check constraint already anticipates all four).
- Update `useEmployeeLoans.ts` to the corrected names and arguments; add an architecture test that asserts every loan RPC referenced in `src/` exists in the schema with a matching signature, so this class of drift cannot recur.

### Phase 3 — Loan accounting provisioned by default
- Add `loan_receivable`, `loan_disbursement_clearing`, `loan_interest_income`, `loan_writeoff_expense` to `system_account_roles` and to the chart-of-accounts template, so every new tenant gets them at signup.
- Resolution order in `loan-gl` handlers becomes: loan type override → org `default_account_settings` → system role account. Manual configuration becomes an override, not a prerequisite.
- Backfill the four existing loan types and the current org's default account settings.

### Phase 4 — Approvals on the existing frameworks
- Register `employee_loan` in the Studio approval entity registry with the actions `approve`, `disburse`, `write_off`, `restructure` so workflows and thresholds become configurable like sales orders.
- Make `employee_loan_lifecycle_approve` / `_reject` resolve the open `approval_requests` row and write `approval_history`, closing the orphan loop. No new approval mechanism is introduced.
- Seed `governance_duties` + `governance_sod_conflicts` for loan origination / approval / disbursement / write-off so the existing SoD report covers loans.

### Phase 5 — Payroll and schedule integrity
- Generate the repayment schedule automatically on transition to `approved`/`active` for loan types with `requires_schedule`, replacing the manual RPC step that currently causes `RUN_LOAN_SCHEDULE_MISSING` run issues.
- Verify restructure, skip-override consumption and termination settlement all recompute the schedule through the single `recompute_loan_schedule` path.

### Phase 6 — UX and error semantics
- Loan Types form: clear and reset skip-policy fields when `allow_skip` is turned off, and validate bounds client-side with field-level messages instead of relying on trigger exceptions.
- Extend the existing governance error parser to also translate the new `LOAN_*` hints, so toasts state the business reason ("Requested tenure exceeds the 24-month policy maximum for Emergency Loan") rather than a Postgres string.
- ESS request wizard: show eligibility, policy bounds, a live schedule preview and the consent/collateral requirements of the selected product before submission.

### Validation
Each phase ends with: the loan architecture tests, `supabase/tests/loan_policy_and_lifecycle_test.sql`, a frontend typecheck, and an end-to-end run of the lifecycle (request → approve → disburse → payroll deduction → settle) executed against the database with a real loan, since no loan records currently exist to regress against.

## Technical notes
- No parallel approval system is created; the SoD guard layer (`self_action_policy`, `governance_assert_not_self`) stays authoritative for self-action and the `approval_requests` family becomes authoritative for multi-step sign-off.
- All schema work goes through migrations; the `employee_loans` check constraints are kept intact — the code is corrected to satisfy them rather than the constraints relaxed.
