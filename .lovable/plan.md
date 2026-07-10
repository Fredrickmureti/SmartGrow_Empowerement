
# Payroll Reports — Enterprise Redesign

## 1. Business-event framing

Reports exist because payroll events happen. The current workspace exposes 9 tabbed tables (`payroll_register`, `payroll_summary`, `employer_contributions`, `statutory_liabilities`, `employee_earnings`, `branch_payroll_cost`, `department_payroll_cost`, `payroll_overtime`, `payroll_variance`) — all universal, all sourced from `payroll_runs` + `payslips` + `payslip_lines` + `payroll_remittances` via `render-report` → `_shared/reports/payrollData.ts`. Gaps against the payroll lifecycle:

| Lifecycle stage | Event source | Reportable? | Present today |
|---|---|---|---|
| Contract activated / structure assigned | `employee_contracts`, `salary_structures` | Compensation distribution, structure coverage | ❌ |
| Work entries generated | `payroll_work_entries` | Work-entry breakdown, hours vs pay | ❌ |
| Payroll computed | `payroll_runs`, `payslips`, `payslip_lines` | Register, Summary, Earnings | ✅ |
| Corrections / retro | `retro_pay_adjustments`, `payroll_correction_adjustments`, `payroll_reclassification_audit` | Retro & correction reports | ❌ |
| Approved / posted to GL | `journal_entries` (via `payroll_runs.journal_entry_id`) | Journal preview, posting history, GL by dept/branch | ❌ |
| Liabilities created | `payroll_liabilities`, `payroll_remittances` | Statutory liability aging, remittance status | Partial |
| Payments recorded | `payroll_payment_batches`, `payroll_bank_export_files` | Bank file register, unpaid-payslip aging | ❌ |
| Certificates / returns | `payroll_tax_certificates`, `payroll_return_runs` | Certificate & return registers (country-specific) | ❌ |
| Audit surface | `payroll_period_audit`, `garnishment_audit_log`, `loan_lifecycle_events`, `payroll_run_loan_skip_overrides`, `admin_audit_log` | Changes, overrides, approvals, SoD | ❌ |

## 2. Report catalogue (target)

Categorised set the new workspace ships with. `U` = universal, `L` = localization-driven.

**Operational (U):** Payroll Register · Payroll Summary · Payslip Register · Employee Earnings · Employee Payroll History · Earnings Analysis (by category) · Deduction Analysis · Employer Contribution Summary · Work-Entry Breakdown · Overtime Analysis · Retro & Correction Report · Variance (MoM / YoY) · Payroll Run Comparison.

**Cost / Financial (U):** Department Payroll Cost · Branch Payroll Cost · Cost-Centre Payroll · Payroll Journal Preview (pre-post) · Payroll Journal Posting History · Payroll Expense by GL · Payroll Allocation (analytic) · Accrued Payroll · Payroll Clearing · Payroll Trends.

**Management (U):** Headcount Cost · Overtime Cost Trend · Employer Contribution Trend · Average Salary · Compensation Distribution · Workforce Cost Analysis.

**Compliance (L, published by localization packs):** Statutory Liability Summary · per-authority Tax / Social-Security / Housing / Levy monthly summaries · Annual Statutory Certificate Register · Return Filing Register (draft / submitted / accepted). Rendered through the existing pack pipeline (`localization_pack_return_templates`, `localization_pack_certificate_templates`, `payroll_return_runs`, `payroll_tax_certificates`, `pack_requirements`, `returnSourceResolver`).

**Audit (U):** Payroll Changes · Reversals · Corrections & Manual Adjustments · Override History (loan skip, self-action) · Approval History · Segregation-of-Duties (uses `governance_sod_conflicts`).

## 3. Architecture

- **Report metadata registry.** New `payroll_report_definitions` (universal, seeded) + reuse of existing `pack_requirements` rows (`kind = 'report'`) that localization packs publish. Each definition: `key`, `title`, `description`, `category` (`operate|cost|compliance|management|audit`), `scope` (`org|business|branch|department|employee`), `data_availability` (`draft|approved|posted|paid`), `default_filters`, `columns`, `format_profile`, `drilldown_targets`, `currency_mode` (`base|report|multi`), `origin` (`universal|pack:<pack_id>`).
- **Discovery hook** `usePayrollReportCatalogue()` merges universal + installed-pack definitions and filters by user permission / installed apps.
- **Single render pipeline.** `render-report` stays the only entry point. Add builder cases for the new keys inside `_shared/reports/payrollData.ts` (register/summary/earnings/branch/dept/overtime/variance already exist) plus new files `payrollGlData.ts` (journal-preview, posting-history, expense-by-GL, allocation, clearing) and `payrollAuditData.ts` (changes, overrides, SoD). Compliance definitions dispatch into the existing statutory-return / certificate rendering path — no parallel logic.
- **Multi-currency.** Reuse existing base-currency architecture: `ReportContext` already injects `currentBusiness.base_currency`. Extend `PayrollFilters` with `reportCurrency` (defaults to base); server builders read `journal_entries.exchange_rate` / `payslips.gross_pay` + `businesses.base_currency` and translate through `exchange_rates`. No new currency system.
- **Localization publisher extension.** `pack_rule_type_schemas` gains a `report` kind. `PackEditorShell` gets a Reports tab (mirrors TemplateEditor). Publish rules validate `columns[].source` against `returnSourceResolver` and against `payslip_lines.rule_code` referenced in the pack. Certificate/return templates already ship — we now surface them in the Reports workspace as first-class report definitions instead of hiding them under a separate "Returns" page.
- **Dashboard.** Reports landing page becomes a workspace, not a tab bar: KPI strip (last run status, headcount, MTD cost, outstanding liabilities), Recent Runs, Recent / Scheduled / Favourite reports, Compliance-due chips (`payroll_filing_calendar_projection`), Trend charts (12-month gross / employer cost / headcount), quick "Run report" launcher opening a report picker filtered by role.
- **Drill-down.** Standardised in `_meta`: report row → payslip → calculation breakdown (`payslip_lines`) → journal entry → GL transaction. Wire `payroll_liability` meta into `/hr/payroll/remittances` with rule-code deep-link, `payroll_run` into `PayrollRunDetailsDialog`, GL rows into `/finance/journal/entries/:id`.
- **Scheduling / export.** Reuse `scheduled_reports` + `process-scheduled-reports`; every definition automatically gets Schedule / Favourite / Export (PDF / CSV / Excel) through `ReportPageLayout`.

## 4. Root cause of the current failure

`edge-function-logs-render-report` shows repeated `column payslips.basic_salary does not exist` (42703). No source file in `supabase/functions/_shared/reports/*` or `render-report/index.ts` selects `basic_salary` today — the current builder projects only `gross_pay, net_pay, total_deductions` from `payslips`. This means **the deployed `render-report` function is stale** relative to the repo (a previous version selected `payslips.basic_salary` before the country-agnostic rewrite). The fix is a redeploy of `render-report` plus its `_shared` sources; add a regression architecture test asserting `payrollData.ts` never re-references dropped columns.

## 5. Implementation phases

1. **Redeploy + regression guard** — redeploy `render-report`; add `src/test/architecture/payroll-reports-no-legacy-columns.test.ts` that fails if `_shared/reports/payrollData.ts` selects any of `basic_salary`, `other_earnings`, `taxable_income` from `payslips`.
2. **Report metadata layer** — migration for `payroll_report_definitions` (+ GRANTs + RLS `TO authenticated` read-only + service_role writes), seed universal definitions, add `report` kind to `pack_rule_type_schemas`.
3. **Discovery + workspace shell** — `usePayrollReportCatalogue`, refactor `src/pages/hr/payroll/Reports.tsx` into `PayrollReportsWorkspace` (dashboard + catalogue + report viewer) using the design system primitives; keep old tab surface reachable via `?report=<key>` deep links for back-compat.
4. **New builders** — `payrollGlData.ts` (journal preview / posting history / expense-by-GL / allocation / clearing / accrued), `payrollAuditData.ts` (changes, reversals, overrides, approvals, SoD), `payrollWorkEntryData.ts` (work-entry breakdown, overtime cost trend). Wire into `render-report` dispatcher.
5. **Multi-currency projection** — add `reportCurrency` to `PayrollFilters` + translation helper in `_shared/reports/currency.ts` reusing `exchange_rates`.
6. **Localization Reports publisher** — extend `PackEditorShell` with a Reports tab and a `ReportDefinitionEditor` (columns / filters / sources / legal reference / supported formats). Pack install materialises definitions into `pack_requirements(kind='report')`; uninstall removes them.
7. **Dashboard + drill-downs** — KPI strip, trends, compliance chips, standardised `_meta` drill-down router.
8. **Audit reports wiring** — connect existing `payroll_period_audit`, `governance_sod_conflicts`, `admin_audit_log`, override tables.

## 6. Technical notes

- Country-agnostic invariant preserved: universal builders never reference rule codes, identifier names or currencies.
- Every new table follows the `<public-schema-grants>` rule.
- `render-report` remains the only entry point; no new edge functions (protects the 88/100 ceiling per ADR 0005).
- All new report pages use `ReportPageLayout` + `ReportContext` so branding / base currency / export are inherited.
- Trigger-guarded write surfaces (ADR 0005/0022) are untouched — reporting is read-only.

## 7. Non-goals

- No changes to `compute-payroll`, `post-payroll-gl`, `assert_payroll_ready_json`, or the ADR-0022 mapping-integrity path.
- No UI rewrite of `/hr/payroll/runs`, payslips, or remittances (only their drill-down targets are consumed).
- eTIMS / M-Pesa edge consolidation remains out of scope (ADR 0005).
