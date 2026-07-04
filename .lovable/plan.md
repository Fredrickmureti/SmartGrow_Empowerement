
# Continuation Plan — Custom Deduction Types (post-handoff)

## Verified status of previous agent's work

Independently traced against the codebase — not taken on trust:

**Slice 1 — DONE (verified).**
- Migration `20260704151154` adds `payroll_rule_types.computation_method` (NOT NULL, CHECK-constrained to the 6 methods compute-payroll dispatches), drops the orphan `business_id`, tightens the DELETE policy, and rewrites the table comment to say "Rule Type Definitions… NOT a deduction engine".
- pgTAP guard `supabase/tests/payroll_rule_types_catalog_invariants_test.sql` pins the new column, the CHECK, the absent `business_id`, no inbound FKs, and the single DELETE policy.
- Frontend rename to *Rule Type Definitions*, dead `is_bracket`/`is_active`/soft-delete fixes, computation_method persistence — reflected in `CustomDeductionTypes.tsx`, `CustomDeductionTypeDialog.tsx`, `usePayrollRuleTypes.ts`, `PayrollRoutes.tsx`, `navs.ts`.

**Slice 2 schema — DONE (verified).**
Migration `20260704152623` creates `custom_deduction_types`, `employee_custom_deductions`, `employee_custom_deduction_events` with enums, RLS, GRANTs, version triggers, lifecycle-event trigger, reserved-code guardrail, realtime publication. `types.ts` regenerated.

**Slice 2 everything else — NOT DONE.** No hooks, no UI, no compute-payroll branch, no `post-payroll-gl` wiring, no `payroll_readiness_rules` entry, no pgTAP for the new tables. This is where the previous agent stopped.

## What I'll build (remaining stages)

### Stage A — Hooks (data layer, no UI yet)
- `src/hooks/payroll/useCustomDeductionTypes.ts` — list/create/update/soft-delete, business-scoped, invalidates on realtime.
- `src/hooks/payroll/useEmployeeCustomDeductions.ts` — per-employee list, assign, approve, suspend, resume, cancel; writes lifecycle events implicitly via the DB trigger.
- `src/hooks/payroll/useCustomDeductionEvents.ts` — timeline reader.

### Stage B — Catalog UI
- Route: `/hr/payroll/configuration/custom-deductions` (new file under `PayrollRoutes.tsx`, nav entry under Configuration).
- Page: list with kind/tax-treatment/GL-mapped badges, "unmapped GL" warning row, empty-state that links to Loans/Advances/Garnishments so users don't misuse it.
- Dialog: code + label + description, `deduction_kind`, `tax_treatment`, `is_taxable`, `is_employer_contribution`, `computation_method`, dynamic parameters (`amount` / `rate` / `formula`), GL liability + expense pickers (accounts filtered by type), `payslip_group`, `sort_order`, `requires_approval`, `cumulative_cap` default, `min_net_floor` default, `is_active`.

### Stage C — Assignment UI on the employee profile
- New tab/section "Custom Deductions" on `/hr/employees/:id` under Payroll.
- Table of assignments with status chip, effective window, running `cumulative_recovered` / `cumulative_cap` progress, override amount/rate.
- Assign dialog (pick type → prefill from type → override → effective dates → approval gate). Status transitions via explicit actions (Approve, Activate, Suspend, Resume, Cancel) — never a raw dropdown, so the lifecycle event trigger records intent.
- Lifecycle timeline drawer reading `employee_custom_deduction_events`.

### Stage D — Compute-payroll wiring (the real integration)
Edit `supabase/functions/compute-payroll/index.ts`:
1. New Turn placed **after loans/advances, before garnishments** — matches the ordering the audit prescribed (voluntary post-tax deductions come after mandatory recovery, before court-ordered priority items).
2. Pre-tax types (`tax_treatment='pre_tax'`) evaluated **before** PAYE so they lower taxable base. Post-tax after PAYE. This is the tax-treatment ordering invariant the pgTAP will pin.
3. For each active assignment (`status IN ('approved','active')`, `effective_from <= period_end`, `effective_to IS NULL OR effective_to >= period_start`, not yet completed):
   - Compute per `computation_method`: `flat_amount` → `parameters.amount` (or `amount_override`); `percentage_of_gross` → `gross * (rate_override ?? parameters.rate)`; `percentage_of_basic` → basic * rate; `formula` → deferred (raise `NOT_IMPLEMENTED` so it fails loud rather than silently returning 0).
   - Apply `cumulative_cap`: cap this period's amount at `cap - cumulative_recovered`; if remaining ≤ 0, skip.
   - Apply `min_net_floor`: if applying full amount would push net below floor, reduce (do NOT skip — partial recovery is standard for voluntary deductions; garnishments have their own carry-forward, this doesn't).
   - Emit `payslip_lines` row with `source='custom_deduction'`, `source_id=assignment_id`, `category='deduction'` (or `employer_contribution` when `is_employer_contribution`), `payslip_group` copied from type, `sort_order` from type.
   - `is_employer_contribution=true` → line does NOT reduce net; it books to expense + liability only (mirrors employer NSSF pattern already in the engine).
4. After all lines written for the run, `UPDATE employee_custom_deductions SET cumulative_recovered = cumulative_recovered + <applied>` and, when the cap is now hit, `status='completed'` (the DB trigger writes the `completed` event; no manual event insert needed).
5. Reversal path: `payroll_reverse_run_atomic` already reverses `payslip_lines` — extend it to decrement `cumulative_recovered` and, if the assignment was auto-completed by this run, flip status back to `active`. Idempotent via the existing reversal lock.

### Stage E — GL posting
Edit `supabase/functions/post-payroll-gl/index.ts`:
- When aggregating `payslip_lines` where `source='custom_deduction'`, group by `source_id → deduction_type_id → (gl_liability_account_id, gl_expense_account_id)`.
- Employee deduction: `DR salary_expense-equivalent` already booked as part of gross; `CR gl_liability_account_id` for the deduction amount. If `gl_liability_account_id` is NULL on any consumed type, refuse to post with `SETUP_REQUIRED / CUSTOM_DEDUCTION_GL_MISSING` and the list of type codes — matching the existing readiness-payload convention (ADR 0040).
- Employer contribution: `DR gl_expense_account_id`, `CR gl_liability_account_id`.

### Stage F — Readiness rule
Data-only insert into `payroll_readiness_rules`: rule_code `CUSTOM_DEDUCTION_GL_MAPPING`, scope `business`, severity `blocker`, evaluated via a SQL predicate that flags any `custom_deduction_types` row that is `is_active=true`, is referenced by ≥1 `employee_custom_deductions` in `('approved','active')` for the period, and has `gl_liability_account_id IS NULL` (or `gl_expense_account_id IS NULL` when `is_employer_contribution`). Because `payroll_readiness_summary` is the single engine (per ADR 0040), no code changes are required — the rule shows up in the badge, the pre-run panel, and `compute-payroll`'s 412 payload automatically.

### Stage G — pgTAP guards
`supabase/tests/custom_deductions_test.sql`:
- reserved-code guardrail rejects `paye`, `loan`, `garnishment` (INSERT + UPDATE).
- version trigger bumps on material change, holds steady on cosmetic change.
- lifecycle trigger writes exactly one event per status transition.
- cumulative-cap auto-complete: simulate cumulative_recovered reaching cap, verify status → `completed` and a `completed` event exists.
- tax-treatment ordering: architecture-level assertion that a pre_tax custom deduction reduces `payslip_lines.category='statutory'` PAYE base within the same run (fixture-driven).

### Stage H — Architecture tests (TS)
- `src/test/architecture/custom-deductions-engine-branch.test.ts` — fails if `compute-payroll` stops iterating `custom_deduction_types` OR emits a custom-deduction line without setting `source='custom_deduction'` and `source_id`.
- `src/test/architecture/post-payroll-gl-custom-deductions.test.ts` — fails if `post-payroll-gl` posts a run containing `source='custom_deduction'` lines without validating the GL mapping first.

## Explicitly out of scope
- Bulk import/export (Slice 3 candidate — not requested).
- Approval workflow integration (`approval_requests`) beyond `requires_approval`+status transition — deferred until the tenant asks; the schema already supports it.
- Self-service employee visibility toggle — the field can be added later without a migration by extending `custom_deduction_types` in a follow-up.
- Any change to loans/advances/garnishments/statutory (correctly modelled, per Slice 1 audit).

## Order of operations
1. Stages A + B in parallel (hooks + catalog UI) — safe, no engine risk.
2. Stage C (employee assignment UI).
3. Stage D (compute-payroll) + Stage G unit-test the branch behind a feature-detect (rows present → branch active; no rows → no-op — zero risk to existing tenants).
4. Stage E (GL posting) + Stage F (readiness rule) together so the readiness surface prevents an unmapped post.
5. Stage H architecture tests last so they lock in what's just been built.
