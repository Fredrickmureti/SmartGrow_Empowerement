
## Root cause (verified against the live DB and code)

The blocker `GL_MAPPING_MISSING — loan_repayment_sal_adv_payable` is a **phantom requirement** produced by the readiness/gate function. Nothing in the posting pipeline ever reads or writes that key.

Two resolvers exist for loan repayments, and they disagree on what is required:

1. **Posting resolver (authoritative).** `post-payroll-gl` posts loan-repayment legs through `public.payroll_loan_repayment_gl_targets(run)`. That function resolves the credit leg via `loan_types.gl_receivable_account_id` (with a fallback to the `loan_receivable` role via `_loan_resolve_account`) and the interest leg via `loan_types.interest_income_account_id`. It never touches `default_account_settings['loan_repayment_*_payable']`. This is the enterprise-correct pattern: a repayment reduces a receivable, it does not credit a payable.

2. **Readiness/gate resolver (phantom).** `public.payroll_required_gl_mappings_for_run` aggregates `payslip_lines` by `rule_code` and emits a required `<rule_code>_payable` key for every line that looks like an employee-side deduction. It tries to skip loan lines with `category NOT IN ('earning','loan_repayment')` — but the compute engine actually writes loan-repayment payslip lines with `category = 'deduction'` (verified: `SELECT DISTINCT category, rule_code FROM payslip_lines WHERE rule_code LIKE 'loan_repayment%'` → `deduction / loan_repayment_sal_adv`). So the filter silently misses them, and the gate demands a `_payable` key that the posting engine will never consume.

Result — the exact contradiction the user reported:
- `compute-payroll` writes a `payroll_run_issues` row for `loan_repayment_sal_adv_payable` at severity `blocker`, so approval is refused.
- The Payroll → GL Account Mapping screen only lists canonical mapping keys (core + statutory + custom deductions), and loan-repayment keys are correctly absent from that surface, so it looks "fully configured".
- The user has no remediation path because the demanded key is not real.

There is no data-fix here. Seeding a `loan_repayment_sal_adv_payable` account would just paper over a broken contract between two resolvers; the account would be inert at post time because `payroll_loan_repayment_gl_targets` doesn't read it.

## Enterprise-alignment note

SAP, Oracle Fusion, Workday, and Dynamics all treat employee loans/advances as receivable subledgers owned by the loan/advance module. Payroll deductions reduce that receivable directly; they do not create a parallel payroll payable per loan type. Our posting side already implements this pattern (ADR 0091 — "Loans emit events, finance owns posting"; `loan_types.gl_receivable_account_id`). The gate function is the only place that still speaks the wrong vocabulary.

## Plan

**Phase 1 — Fix the gate's vocabulary (make readiness agree with posting).**

Migration replacing `public.payroll_required_gl_mappings_for_run`:
- Exclude any payslip line whose `rule_code` starts with `loan_repayment` from the `_payable` / `_employer_expense` aggregation. This is the load-bearing predicate — categories are unreliable (compute-payroll tags these as `deduction`), rule_code is deterministic.
- Belt-and-braces: also exclude lines where `source->>'kind' = 'loan_repayment'` or `source->'input_ref'->>'code'` starts with `loan_repayment`, so a future compute-payroll refactor that changes the rule_code shape still can't reintroduce the phantom.
- Leave core keys (`salary_expense`, `net_salary_payable`), statutory `_payable`/`_employer_expense`, and custom-deduction keys untouched — this is a surgical exclusion, not a rewrite.

**Phase 2 — Positive loan-side readiness (real remediation path).**

Extend the same function to emit *the mappings loans actually need*, so if a `loan_type` used in the run is missing its receivable account the user is told the truth:
- For each distinct `loan_id` present in this run's payslip lines (or in `loan_repayments` for the run), join to `loan_types` and emit a virtual readiness row per unmapped loan type:
  - `setting_key = 'loan_type:<loan_type_id>:receivable'`, `kind = 'loan_receivable'`, `required_account_type = 'asset'`, `is_mapped = (loan_types.gl_receivable_account_id IS NOT NULL)`, label = `"<Loan type name> — Receivable"`.
  - Same shape for `interest_income` when the loan type charges interest (`interest_rate > 0`) and `interest_income_account_id IS NULL`, `required_account_type = 'income'`.
- These rows carry a `kind` the UI can route to the Loan Types settings page (`/hr/payroll/loan-types`), not to the generic GL Mapping screen — because that's where these accounts genuinely live.

**Phase 3 — UI: route loan-shaped blockers to the correct remediation surface.**

- In the payroll run blocker list / `MissingMappingsDialog`, when a row's `kind` is `loan_receivable` or `interest_income` (or `setting_key` starts with `loan_type:`), render a "Fix in Loan Types" CTA that deep-links to the loan-types row instead of the GL Mapping table. The generic "Apply suggested" path stays for the canonical keys.
- No change to Payroll → GL Account Mapping's contents — it stays authoritative for the keys it already owns.

**Phase 4 — Clean up existing phantom blockers.**

One-shot SQL in the same migration: delete `payroll_run_issues` rows where `code = 'GL_MAPPING_MISSING'` and `details->>'setting_key'` matches `^loan_repayment_.*_payable$` (and the analogous `_employer_expense` shape, defensively). These were never real. Runs currently stuck in the contradictory "missing but everything configured" state will unblock on the next readiness re-evaluation.

**Phase 5 — Architecture guards (regression protection).**

- `src/test/architecture/payroll-readiness-excludes-loan-repayment.test.ts` — asserts the current `payroll_required_gl_mappings_for_run` body contains the `rule_code NOT ILIKE 'loan_repayment%'` predicate (or equivalent) so a future migration cannot silently reintroduce the phantom.
- `supabase/tests/payroll_readiness_loan_repayment_test.sql` (pgTAP) — seeds a payslip line with `category='deduction'`, `rule_code='loan_repayment_x'`, calls the readiness RPC, and asserts no `_payable` requirement row is returned for it; asserts the loan-side `loan_type:<id>:receivable` row IS returned and is `is_mapped=false` when the loan type has no receivable account.
- `src/test/architecture/loan-repayment-gate-posting-parity.test.ts` — greps `post-payroll-gl` to confirm it still routes loan legs exclusively through `payroll_loan_repayment_gl_targets` and never resolves any `loan_repayment_*_payable` key, keeping the gate and the poster in permanent lock-step.

## Technical details

- `public.payroll_required_gl_mappings_for_run` is `STABLE SECURITY DEFINER`; the migration is a `CREATE OR REPLACE FUNCTION` — no signature change, no downstream call-site edits.
- `compute-payroll`'s mapping short-circuit (`supabase/functions/compute-payroll/index.ts` ~line 5590) is unchanged; it will simply stop receiving the phantom row.
- `post-payroll-gl` is unchanged (already correct).
- The one-shot delete is scoped to `severity='blocker'` `GL_MAPPING_MISSING` rows whose `setting_key` matches the loan-repayment pattern; no other issue rows are touched.
- No changes to `default_account_settings`, `default_account_setting_bindings`, `loan_types`, or the resolver `_loan_resolve_account` — those are already the canonical single source of truth for the loan side.

## Definition of done

- Approval of a run containing loan/advance deductions is not blocked by a `loan_repayment_*_payable` key.
- If a `loan_type` used in the run has no `gl_receivable_account_id`, the run is blocked with a message that names the loan type and deep-links to Loan Types settings.
- Payroll → GL Account Mapping and Payroll Readiness agree on the set of required keys (verified by pgTAP round-trip).
- Architecture guards make the drift non-recurrable.
