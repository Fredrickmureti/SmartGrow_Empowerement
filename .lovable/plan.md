## Verification results (checked directly against the database and codebase)

**Genuinely done (confirmed in the live schema):**
- `request_employee_loan` was rewritten and now raises typed `LOAN_*` hints; `_loan_resolve_business` exists.
- Signature drift resolved server-side: single `generate_loan_schedule(_loan_id,_dry_run)`, no `approve_employee_loan` overloads, and `employee_loan_suspend`, `employee_loan_pause`, `employee_loan_resume`, `employee_loan_write_off(_loan_id,_reason,_cosigner)`, `employee_loan_restructure(_loan_id,_kind,…)`, `employee_loan_record_manual_repayment(_loan_id,_amount,_repayment_date,_notes)` all exist.
- Approval-request closure helper `_loan_close_approval_request` exists; schedule auto-generation trigger `trg_employee_loan_autogenerate_schedule` is live on `employee_loans`.
- Loan account roles, eligibility rows, `ensure_loan_gl_accounts`, the `trg_loan_types_default_accounts` trigger and the loan SoD duties/conflicts are all present.

**Claimed or planned but NOT actually in place:**
- The provisioning backfill never ran: `accounts` has **0** rows with a `loan_*` system role, `default_account_settings` has **0** loan keys, and all **4** loan types still have `NULL` GL mappings. Loan accounting still cannot post.
- The frontend was never updated to Phase 2. `useEmployeeLoans.ts` still calls the non-existent `employee_loan_pause_recovery` / `employee_loan_resume_recovery`, passes `_journal_date` to write-off (now `_cosigner`), `_new_term_months/_new_interest_rate` to restructure (now `_kind/_new_installments/_new_start_date/_new_monthly`), and `_payment_date/_bank_account_id/_reference` to manual repayment (now `_repayment_date/_notes`). Every one of these still fails at runtime.
- No architecture test pins loan RPC names/signatures, so this drift is unguarded.
- `loan-gl` handlers still hard-require `loan_types.gl_*`; no fallback to org defaults or system-role accounts.
- `employee_loan` is still absent from the Studio approval entity registry (`ApprovalRulesManager.tsx`), so no loan workflow can be configured.
- No `LOAN_*` translation in the governance error parser; toasts still surface raw Postgres text.
- Loan Types form still does not clear skip-policy fields when `allow_skip` is turned off.

## Remaining work

### Step 1 — Provisioning backfill (migration; the one that timed out)
Run `ensure_loan_gl_accounts` for every existing organisation/business: creates Employee Loans Receivable (1360), Loan Disbursement Clearing (1365), Loan Interest Income (4310), Loan Write-off Expense (6420), writes the four `default_account_settings` keys, and fills them into loan products whose mapping is still empty. Also hook the same call into new-tenant/new-business provisioning so signup lands with loan accounting ready, and re-run after `seed_default_loan_types`.

### Step 2 — GL resolution order in `loan-gl`
Replace the hard requirement with: loan type override → `default_account_settings` loan key → `accounts.system_role` → only then a 400 that names the exact missing role and links to the settings page. Applies to `handleDisburse`, `handleAccrue`, `handleSettle` and the write-off path.

### Step 3 — Frontend RPC alignment
Correct every call in `useEmployeeLoans.ts` (pause/resume, write-off cosigner, restructure kind + new schedule params, manual repayment) and update the callers/dialogs that pass the old shapes. Add an architecture test that reads every `rpc("...")` loan call in `src/` and asserts the name and argument set match the schema, so drift fails CI.

### Step 4 — Approvals surfaced in Studio
Register `employee_loan` in the approval entity registry with actions approve / disburse / write_off / restructure, and verify the lifecycle RPCs close the `approval_requests` row and write `approval_history` (helper exists; confirm it is called on both approve and reject paths and that no orphan pending rows remain).

### Step 5 — Error semantics and Loan Types UX
Extend the governance error parser with the `LOAN_POLICY_*` / `LOAN_CONTEXT_*` hints and business-language messages. In the Loan Types form, clear skip caps when `allow_skip` is switched off and validate bounds client-side with field-level errors instead of relying on the trigger exception.

### Step 6 — ESS request workflow
Show eligibility, product policy bounds, live schedule preview and consent/document requirements before submission, and surface the typed policy errors inline on the offending field.

### Validation
After each step: loan architecture tests, `supabase/tests/loan_policy_and_lifecycle_test.sql`, frontend typecheck, and a real end-to-end run (request → approve → disburse → payroll deduction → settle) confirming journal entries post against the provisioned accounts.
