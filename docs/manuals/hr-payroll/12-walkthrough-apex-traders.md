# 12 · Walkthrough — Apex Traders

## Purpose
Trace the exact code paths a brand-new tenant runs from sign-up to first payroll closing, with every table mutation and JE called out. Use this as a mental rehearsal before doing it in real life.

> Cast: **Asha** (Owner), **Brian** (Accountant), **Carol** (HR Manager), **Daniel** (Employee).
> Country: Kenya (purely as a pack example — the engine never names it).

## Month 0 — Sign-up & first login (Asha)
1. Asha signs up at `/signup` → `auth.users` row created → `profiles` row created (trigger).
2. App routes through `OnboardingSetup.tsx`. Asha names the workspace "Apex Traders".
3. Behind the scenes: `organizations`, `businesses`, `user_roles(role='owner', user_type='internal')`, `user_business_access`, `member_permission_groups("Internal Users")` are written.
4. Asha picks country **Kenya** → `OnboardingSetup` invokes `install-localization-pack` → RPC `install_localization_pack_atomic(business_id, pack_id='ke_v1', installed_by)`:
   - INSERT `tax_rates` from `localization_pack_tax_templates`
   - INSERT `accounts` from `localization_pack_account_templates` (parent_code → parent_id second pass)
   - INSERT `payroll_statutory_rules` from `localization_pack_payroll_templates` (PAYE, SHIF, NSSF, AHL, NITA — each with `computation_method` + `parameters`)
   - INSERT `installed_localization_packs(pack_version='1.0.0', status='active')`
   - `payroll_finalize_pack_install_v2(org, business)` → proposes/creates payroll GL mappings into `default_account_settings` (protected by `trg_default_account_settings_payroll_role`).
5. Asha completes onboarding wizard → opens dashboard.

## Month 1, week 1 — Set up HR (Carol)
1. Carol clicks **Add Employee** in `Employees.tsx` → `EmployeeFormDialog.tsx`:
   - Daniel: full name, email, `hire_date`, `department_id`, `job_position_id`, `work_location_id`.
   - INSERT `employees` row (`lifecycle_status='draft'`, `is_active=false`).
   - `employee_number` allocated using `hr_policies.employee_number_format` + next_seq.
   - Trigger `auto_create_default_onboarding` seeds `employee_onboarding(_items)` from the default template + `pack_requirements` (Kenya: KRA PIN, NSSF #, SHIF #).
2. Carol clicks **Activate** → INSERT `employments(status='active', start_date=hire_date, is_primary=true)`. Trigger `sync_employee_from_employments` denormalizes `employees.is_active=true`, `lifecycle_status='active'`.
3. Carol creates a running contract via `EmployeeContractsTab.tsx` → INSERT `employee_contracts(status='running', wage, housing_allowance, transport_allowance, salary_structure_id, time_tracking_source='attendance')`.
4. Carol fills statutory identifiers in the profile → INSERT `employee_statutory_identifiers` rows keyed by `identifier_type` from `country_statutory_catalog`.
5. Carol clicks **Invite** → RPC `upsert_organization_invitation` + edge fn `send-invitation-email`. `employees.user_access_status = 'invited'`.

## Month 1, week 1 — Daniel accepts (Employee)
1. Daniel opens the invite email → `/accept-invitation?token=…`.
2. `validate-invitation` returns `route='signup'`. `AcceptInvitation.tsx` shows the signup branch.
3. Daniel sets a password → `accept-invitation` calls `admin.auth.admin.createUser` then RPC `accept_organization_invitation_atomic`:
   - Upsert `user_roles(role='portal', user_type='portal')`.
   - Auto-link `employees.user_id=Daniel`, `user_access_status='active'`.
   - Replace `member_permission_groups` with "Portal User".
   - `organization_invitations.accepted_at=now()`.
4. Daniel lands on `/me`.

## Month 1, week 2-3 — Time capture (Daniel + Carol)
1. Daniel clocks in via `/me/attendance` → `useAttendanceActions.clockIn` → RPC `attendance_clock_in` with device fingerprint + geo. Row in `attendance(source='web')`.
2. Daniel clocks out — symmetric path. Anomaly detection in `src/lib/attendance/anomalies.ts` flags any oddities; `AnomalyBadge` shows in Carol's roster.
3. Daniel requests a half-day leave via `/me/leave` → INSERT `leave_requests(status='pending', start_period='AM')`. RPC `calculate_leave_days` deducts weekends + `public_holidays`. Edge fn `send-leave-email("submitted")` fires.
4. Carol approves via `LeaveApprovalDialog.tsx` → RPC `approve_leave_request_level1` → status `approved` (or `pending_second_approval` if `leave_types.requires_second_approval`).

## Month 1, end-of-month — Payroll run (Carol + Brian)

### Readiness
1. `usePayrollReadiness("org")` calls RPC `payroll_readiness_blockers` + reads `payroll_readiness_findings`. `isReady=true` ⇒ "New Payroll Run" enabled.

### Create
2. Carol clicks **New Payroll Run** → `CreatePayrollDialog.tsx` (period, run_type=`regular`, employees). Submits.
3. Edge fn `compute-payroll`:
   - `assert_payroll_ready` (gate).
   - `fiscal_periods` not closed.
   - No duplicate regular run.
   - For Daniel: load contract, snapshot rule-set via `resolve_or_publish_rule_set`, compute proration factor.
   - Rules walked in sequence:
     - **Basic** = wage × proration.
     - **Allowances**: housing, transport.
     - **Gross**.
     - **Statutory** (dispatch on `computation_method`):
       - PAYE → `bracket_progressive` with personal relief.
       - SHIF → `percentage_of_gross`.
       - NSSF → `tiered_brackets` (employee + employer shares).
       - AHL → `percentage_of_gross`.
       - NITA → `per_employee_flat` (employer-only).
     - **Loans** (none).
     - **Garnishments** (none).
   - INSERT `payroll_runs(status='draft')`, INSERT `payslips` + `payslip_lines` per employee.
4. Carol previews → clicks **Approve** (`usePayroll.approvePayrollRun`) → `payroll_runs.status='approved'`.

### Post to GL (Brian)
5. Brian clicks **Post to GL** → preflight `validate_payroll_run_mappings` → edge fn `post-payroll-gl`:
   - `user_can_post_payroll` (Brian is not creator/approver).
   - `fiscal_periods` lock check.
   - Idempotency check (no existing JE for this run).
   - JE narration (ADR-0020):
     ```
     reference   = "PR-2026-04"
     description = "Payroll PR-2026-04 - 1 employees"
     source_type = "payroll", source_id = run_id
     ```
   - Lines:
     ```
     DR  salary_expense              totalGross
     CR  paye_payable                paye_employee
     CR  shif_payable                shif_employee
     CR  nssf_payable                nssf_employee
     CR  ahl_payable                 ahl_employee
     CR  net_salary_payable          net_pay

     DR  nssf_employer_expense       nssf_employer
     CR  nssf_payable                nssf_employer
     DR  nita_employer_expense       nita_employer
     CR  nita_payable                nita_employer
     ```
   - `payroll_liabilities` upserted per `rule_code` with `due_date` from `compute_remittance_due_date` and `liability_account_id` from `resolve_liability_account_for_rule`.
   - `payroll_runs.status='posted'`.

### Pay net (Brian)
6. Brian opens `CreatePaymentBatchDialog` → batch built; edge fn `post-payroll-payment-gl`:
   ```
   reference   = "PB-2026-04-01"
   description = "Payroll payment PB-2026-04-01 (run PR-2026-04)"
   source_type = "payroll_payment", source_id = batch.id

   DR  net_salary_payable     batch.total_amount    "clear net pay liability"
   CR  bank.account_id        batch.total_amount    "bank disbursement"
   ```
   - `payment_batch_items.status='paid'`, `payslips.status='paid'`, all paid → `payroll_runs.status='paid'`.

## Month 2, week 1 — Statutory remittances (Brian)
1. Brian opens `/hr/payroll/remittances` (`RemittanceTracking.tsx`). PAYE liability is `open`, `due_date=2026-05-09`, `outstanding_amount=…`.
2. Brian records bank payments to KRA/NSSF/SHIF/NHIF/etc. via `post-remittance-payment`. JE:
   ```
   reference   = "BANK-REF-12345"
   description = "Statutory remittance payment - KRA"
   source_type = "payroll_remittance_payment"

   DR  paye_liability_account     amount
   CR  bank.account_id            amount
   ```
   - INSERT `payroll_remittance_payments` + `payroll_remittance_payment_allocations`.
   - Trigger `trg_recompute_liab_on_alloc` recomputes `payroll_liabilities` → flips status to `'paid'` when fully cleared.

## Daniel checks his payslip
1. Daniel opens `/me/payslips`. Last 3 payslips listed.
2. Click → `<PayslipDetailDialog>` shows line breakdown from `payslip_lines` (grouped earnings / deductions / employer contributions).
3. Daniel clicks **Download PDF** → edge fn `generate-payslip-pdf` (self-service bypass) returns the PDF inline.

## Year-end — Tax certificates (Brian)
1. Brian opens `/hr/payroll/tax-certificates`.
2. Selects template `P9` for fiscal year 2026 and all active employees → edge fn `generate-tax-certificate`:
   - Resolves template from `localization_pack_certificate_templates` matching installed pack (`pack_id=ke_v1`).
   - Pulls YTD per employee via RPC `payroll_employee_ytd_rollup(p_year, p_employee_id)`.
   - Renders tokens via `_shared/renderTokens.ts`.
   - PDF (A4 locked) uploaded to `documents/<org_id>/payroll/tax-certificates/2026/P9/<serial>.pdf`.
   - INSERT `payroll_tax_certificates(status='issued')`.
3. Daniel downloads his P9 from `/me/payslips` → tax certificates section → edge fn `download-tax-certificate` (60s signed URL).

## Quarterly — Statutory return
1. Brian generates the PAYE return via `generate-statutory-return`:
   - Template from `localization_pack_return_templates(template_code='P10', pack_id=ke_v1)`.
   - `payslip_lines` filtered by `rule_codes=['paye']` for the quarter.
   - Reconciliation against `payroll_liabilities.original_amount` for the same rule.
   - CSV (for KRA upload) + PDF (signed for archive) stored at `documents/payroll/statutory-returns/<org_id>/2026/P10/<serial>.csv|pdf`.
   - INSERT `payroll_return_runs(status='generated')`.

## What was not exercised in this walkthrough

- **Reversal**: had Brian needed to undo, `reverse-payroll → payroll_reverse_run_atomic` would have written negating payslips + a void JE in one transaction.
- **Loans / Garnishments**: configured via `loan_types` / `employee_loans` / `employee_garnishments`; engine integration in Chapter 7.
- **Multi-jurisdiction**: had Apex hired a Ugandan, `employees.statutory_country_code='UG'` would have pulled UG rules in the same run with no special-casing — provided a Uganda pack was installed.
- **Talent / Performance**: only relevant after a quarter of operating data exists; flows in Chapter 3.

## What to verify in the real run

Before doing this for a real customer, confirm:
1. `usePayrollReadiness("org").isReady === true` and no `payroll_readiness_findings` with `severity='block'`.
2. `validate_payroll_run_mappings` returns clean for the test run.
3. `fiscal_periods` for the target period is open.
4. The localization pack version installed (`installed_localization_packs.pack_version`) matches the published pack you intended.
5. `user_can_post_payroll` denies the creator (proves SoD is wired for this org).
