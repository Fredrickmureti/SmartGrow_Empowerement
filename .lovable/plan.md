
# Loan Types — Architectural Audit & Remediation Plan

## 1. What a Loan Type actually is today

`public.loan_types` (45 columns) is meant to be the **organizational lending policy** consumed by six subsystems: Employee Self-Service (request wizard), Approvals, Finance/GL, Payroll compute, Payslips, and Reporting.

Consumers found in the codebase:
- `src/pages/hr/payroll/LoanTypesSettings.tsx` — admin CRUD (Payroll → Configuration).
- `src/components/loans/{LoanWizard,RequestLoanWizard}.tsx` + `useEmployeeLoans`, `useMyLoans` — request/creation.
- `supabase/functions/post-loan-disbursement/index.ts` — disbursement JE.
- `supabase/functions/post-loan-settlement/index.ts` — settlement / write-off JE.
- `supabase/functions/compute-payroll/index.ts` — reads only `code` + `salary_rule_code` for payslip line naming.

## 2. Verdict

**Not yet an enterprise policy engine.** The schema was designed for one, but ~55% of the columns are dead metadata, several safety fields are stored-but-not-enforced, and no field on `loan_types` actually drives an approval workflow or a payroll-readiness rule. The list page is a plain grid with no operational KPIs and no drill-through into loans / approvals / GL health.

## 3. Field-by-field consumption matrix (evidence)

Legend: ✅ enforced end-to-end · ⚠️ stored + partially used · ❌ dead metadata (stored, never read by any engine, JE poster, workflow, or UI beyond the form).

| Field | Verdict | Evidence |
|---|---|---|
| `code`, `name`, `kind`, `description`, `is_active` | ✅ | Wizard filters `activeLoanTypes`; compute-payroll uses `code`; UI everywhere. |
| `default_repayment_method` | ✅ | Wizards seed method; compute-payroll branches by loan's `repayment_method`. |
| `default_installments`, `default_max_pct_of_net`, `default_min_net_pay_floor` | ⚠️ | Seeded into wizard as defaults only; not re-validated on server insert. |
| `min/max_installments`, `min/max_principal` | ⚠️ | Validated client-side in `RequestLoanWizard`; **no DB CHECK / RPC guard** — trivially bypassed by any other client. |
| `requires_interest` | ⚠️ | Only hides `interest_rate` dynamic field. Not enforced when method != flat. |
| `requires_schedule` | ⚠️ | Some codepaths generate a schedule; **payroll deduction does NOT refuse loans lacking a schedule**. |
| `requires_approval` | ❌ | Stored boolean. No `approval_requests` / `approval_workflows` row is opened on loan submission; wizards write `employee_loans` directly. |
| `requires_dual_approval` | ❌ | Never read outside `types.ts`. |
| `requires_collateral`, `requires_consent` | ❌ | Never read by any wizard / RPC. |
| `allow_topup`, `allow_restructure` | ❌ | No top-up or restructure flow exists. |
| `allow_skip`, `max_skips_per_loan`, `max_skips_per_calendar_year`, `min_gap_between_skips_days`, `interest_treatment_on_skip`, `schedule_adjustment_on_skip` | ⚠️ | `LoanSkipOverrides` page + compute-payroll comment reference these, but none of the *caps* (max skips, min gap) are enforced. Skip request UX doesn't surface them. |
| `deduction_priority` | ❌ | Not consulted when ordering deductions in compute-payroll (statutory-first is hardcoded; loan order is by creation date). |
| `max_exposure_pct_of_net` | ❌ | Distinct from `default_max_pct_of_net`; never referenced. Duplicate concept. |
| `min/max_tenure_months` | ❌ | Never read; wizard uses installments only. |
| `interest_method` | ❌ | Stored default 'flat'; wizards let the requester pick freely; engine ignores. |
| `dual_control_writeoff` | ❌ | `post-loan-settlement` writes off without a second-approver check. |
| `gl_receivable_account_id`, `gl_disbursement_clearing_account_id` | ✅ | Consumed by both JE posters; missing values block posting with a clear error. |
| `interest_income_account_id` | ❌ | No JE posts interest income anywhere. |
| `writeoff_account_id` | ❌ | `post-loan-settlement` resolves write-off account from `default_account_settings` (`loan_writeoff_expense` / `salary_expense`) and **ignores** the per-type field. |
| `clearing_account_id` | ❌ | Redundant with `gl_disbursement_clearing_account_id`; unused. |
| `salary_rule_code` | ✅ | Used by compute-payroll as payslip line key. |
| `dynamic_field_schema` | ✅ | Rendered by LoanWizard step 2; values persisted on the loan. |

## 4. Business-lifecycle trace (what actually happens today)

```text
Employee → RequestLoanWizard.tsx
        → insert employee_loans (status='pending')  ← no approval_requests row, no workflow
        ↓
HR/Payroll admin edits row directly (EmployeeLoans.tsx) to set status='approved'
        ↓
POST /post-loan-disbursement  (idempotent, JE = Dr Receivable / Cr Clearing)
        ↓
compute-payroll:
   • loads active loans (join loan_types(code, salary_rule_code))
   • deducts using loan.repayment_method (not loan_type.default_*)
   • no re-validation against loan_type policy (min-floor, cap, priority)
   • statutory ordering hardcoded; loan_types.deduction_priority ignored
        ↓
Payslip line labelled by salary_rule_code
        ↓
Outstanding balance decremented on loan row
        ↓
POST /post-loan-settlement (early payoff | write-off)
   • write-off account = default_account_settings, NOT loan_type.writeoff_account_id
   • no dual-control check even when dual_control_writeoff = true
```

Modules that **should** appear in the chain but don't: `approval_requests` / `approval_workflows`, `payroll_readiness_findings` (no rule blocks a run when a loan_type is misconfigured), `notifications` (dispatched only after status flip, not on submission), `bank_transactions` (disbursement lands in clearing but no automated bank-payment handoff).

## 5. Structural weaknesses

1. **Approval policy is fiction.** `requires_approval` / `requires_dual_approval` don't create workflow steps; any HR user with row access flips `status` and posts.
2. **Client-only guardrails.** All principal/installment/tenure/floor limits live in the wizard. Any direct insert (bulk import, RPC, another UI) bypasses them.
3. **Duplicate & orphan fields.** `clearing_account_id` vs `gl_disbursement_clearing_account_id`; `default_max_pct_of_net` vs `max_exposure_pct_of_net`; two skip-policy fields never enforced.
4. **Write-off / interest GL leakage.** `interest_income_account_id`, `writeoff_account_id` on the type are ignored by JE posters — Finance can't rely on per-type accounting treatment.
5. **Payroll does not consult the policy at runtime.** No min-net-pay-floor safety check, no deduction-priority ordering, no refusal on missing schedule.
6. **No Payroll Readiness integration.** A loan_type with missing GL / no salary rule doesn't surface as a readiness finding — it only fails at posting time, mid-run.
7. **Skip policy caps unenforced.** `LoanSkipOverrides` writes overrides without checking `max_skips_per_loan`, `max_skips_per_calendar_year`, `min_gap_between_skips_days`.
8. **UX/ops surface is a bare list.** No counts of active loans, outstanding balances per type, GL health, pending approvals, or drill-through.
9. **Localization gap.** No pack-published templates for statutory / country-standard loan programs; every tenant reinvents the same six categories.
10. **Audit gap.** No `loan_type_lifecycle_events` / `commercial_audit_logs` writes when policy changes; `loan_lifecycle_events` exists for loans but not for their governing policy.

## 6. Remediation plan (phased, incremental, non-breaking)

### Phase A — Schema hygiene (migration only)
- Deprecate & drop (or coalesce via view): `clearing_account_id`, `max_exposure_pct_of_net` (keep single `default_max_pct_of_net`).
- Add validation trigger `loan_types_policy_bounds_valid`: min ≤ max on installments/principal/tenure; `default_max_pct_of_net BETWEEN 0 AND 100`; `salary_rule_code` regex.
- Add trigger writing `commercial_audit_logs` on every change to `loan_types`.

### Phase B — Server-side policy enforcement (RPC)
- New SECURITY DEFINER RPC `request_employee_loan(_input jsonb)` that:
  - Validates against loan_type policy (principal min/max, installments min/max, tenure, cap, `requires_collateral/consent` fields present).
  - Inserts `employee_loans` **and** opens an `approval_requests` row wired to a workflow when `requires_approval = true`; adds a second step when `requires_dual_approval = true`.
  - Emits `loan_lifecycle_events` + `notifications` via existing `hr_notify_loan_event`.
- Wizards (`LoanWizard`, `RequestLoanWizard`) call the RPC instead of direct `insert`.
- Add RLS/`BEFORE INSERT` guard on `employee_loans` that refuses direct inserts outside the RPC (`current_setting('app.request_via_rpc', true) = 'on'`).

### Phase C — Payroll compute & readiness integration
- In `compute-payroll`, load the full loan_type row and:
  - Refuse loan deduction if `requires_schedule` and none exists → emit `payroll_run_issues`.
  - Order loan deductions by `deduction_priority` after statutory.
  - Apply `default_min_net_pay_floor` as a hard clamp; short-recover the balance to the next period; emit issue.
- Add three `payroll_readiness_rules`:
  - `loan_type_gl_complete` (receivable + clearing set on every active type used by active loans).
  - `loan_type_writeoff_account_present` (when any loan in the run is at write-off status).
  - `loan_schedule_present` (all active loans of a `requires_schedule` type have `loan_repayment_schedule` rows).

### Phase D — Finance/JE completeness
- `post-loan-disbursement`: unchanged (already good).
- `post-loan-settlement`: use `loan_type.writeoff_account_id` first, then default mapping; refuse write-off if `dual_control_writeoff` and no second approver recorded.
- New `post-loan-interest-accrual` invoked per period from compute-payroll when `requires_interest`; uses `interest_income_account_id`.

### Phase E — Skip policy enforcement
- In `LoanSkipOverrides` submission RPC, enforce `allow_skip`, `max_skips_per_loan`, `max_skips_per_calendar_year`, `min_gap_between_skips_days`, `interest_treatment_on_skip`, `schedule_adjustment_on_skip`.

### Phase F — LoanTypes UX overhaul (Payroll Officer landing)
Replace the plain list with an operational cockpit. Top strip KPIs:
- Active loan types · Types missing GL · Types with active loans · Total outstanding balance · Pending approvals · Runs at risk (readiness findings).

Per-row expansion / drill-through:
- Employees on this type · outstanding balance · pending requests · GL health chip (receivable/clearing/writeoff/interest) · approval-policy chip · usage stats (last 90 days) · quick links: *View loans*, *Approval queue*, *GL mappings*, *Journal entries*, *Readiness findings*.

Expose the fields that are currently hidden in the form: tenure bounds, deduction priority, dual control, collateral/consent, skip caps, interest_method, and the four GL accounts (receivable, clearing, interest income, write-off). Fields that Phase A drops are removed from the form.

### Phase G — Localization pack support
- Add `localization_pack_loan_templates` (pack-published policy templates) + install hook that seeds per-country defaults, overridable by tenants; existing `seed_default_loan_types` becomes the fallback when no pack ships them.

### Phase H — Audit, tests, safety net
- pgTAP tests:
  - `loan_types_policy_enforced_test.sql` — direct insert into `employee_loans` outside RPC is refused; RPC validates bounds.
  - `loan_types_readiness_test.sql` — missing GL / missing schedule surface as findings.
  - `loan_types_skip_caps_test.sql` — overrides beyond caps are refused.
- Vitest for wizards asserting policy-chip rendering matches the loaded type.

## 7. Technical details

Files/edits (grouped by phase — new files or heavy edits):

- Migrations: `supabase/migrations/*_loan_types_policy_engine.sql` (A, B, C, E, G).
- New RPCs: `request_employee_loan`, `approve_employee_loan`, `settle_employee_loan_dual`, `enforce_loan_skip_policy`.
- Edge functions: extend `post-loan-settlement`, new `post-loan-interest-accrual`.
- Frontend: rewrite `src/pages/hr/payroll/LoanTypesSettings.tsx` into a cockpit + form; extend `src/hooks/useLoanTypes.ts` with aggregate queries (`useLoanTypeStats`); update `src/components/loans/{LoanWizard,RequestLoanWizard}.tsx` to call the new RPC and render the full policy chip set; add drill-through routes under `/hr/payroll/loan-types/$id/{loans,approvals,gl,journal,readiness}`.
- Payroll: add loan-policy consultation in `supabase/functions/compute-payroll/index.ts` (deduction ordering + floor + schedule refusal + interest accrual hook).
- Tests: pgTAP files under `supabase/tests/` and vitest under `src/test/hr/`.

## 8. Out of scope for this plan
- Rewriting the general `approval_workflows` engine (we'll wire loans to the existing one).
- Bank export / payments handoff on disbursement (tracked separately in Payments module).
- Country-specific statutory lending programs (Phase G scaffolds them; content ships with each pack).

Approve to move into build mode, or tell me which phases to execute first and I'll re-issue a narrower plan.
