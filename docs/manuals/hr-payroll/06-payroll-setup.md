# 06 · Payroll Setup

## Purpose
Everything that has to be configured **once** before a payroll run can succeed. The system has a fail-closed readiness gate — "New Payroll Run" stays disabled until all of these are right.

## Prerequisites checklist
1. Tenant has a **Localization Pack** installed (Chapter 5). Without rules + identifiers + GL mappings, readiness will refuse.
2. **Pay schedules** exist for the business and at least one **payroll period** is open.
3. Each employee has a `running` contract with a wage and is linked to a **salary structure** (or a `salary_components` set if you're on the legacy path).
4. Each employee has the **statutory identifiers** required by `pack_requirements`.
5. The org has the **statutory identifiers** required of the employer.
6. **GL mappings** for payroll roles (`salary_expense`, `*_payable`, `*_employer_expense`, `net_salary_payable`) are populated in `default_account_settings` — done either by pack install or via the proposed-mappings UI.
7. **Bank account** for net-pay disbursement exists in `bank_accounts`.

## Configuration surfaces

| Surface | What it sets up |
|---|---|
| `src/pages/hr/payroll/Setup.tsx` | Payroll-level settings — gate that prevents the rest of the module from loading until readiness passes |
| `src/pages/hr/payroll/SalaryStructures.tsx` | Structures + components / rules editor |
| `src/components/payroll/SalaryRuleGraphEditor.tsx` | Odoo-style ordered rule list with condition + amount editor |
| `src/components/payroll/StatutoryRuleEditor.tsx` | `computation_method` form driven by `src/lib/payroll/computationMethods.ts` |
| `src/pages/hr/payroll/Garnishments.tsx` | Wage garnishments per employee |
| `src/pages/hr/payroll/LoanTypesSettings.tsx` | Per-loan-type GL accounts |
| `src/pages/hr/payroll/LoanSkipOverrides.tsx` | Per-run overrides for paused loans |
| `src/pages/hr/payroll/RunGroups.tsx` | Multi-company batch grouping |
| `src/pages/hr/payroll/TaxCertificates.tsx` | Year-end certificate downloads |

## Salary configuration model

### Option A — Legacy `salary_components`
Use when `salary_structures.use_structure_engine = false`. Two-pass resolution in the engine: fixed components first, then percentage components computed against fixed bases. Components mapped by code to `basicSalary / housingAllowance / transportAllowance / otherEarnings`.

### Option B — Structure Engine (recommended)
Use when `salary_structures.use_structure_engine = true`. Stage-D engine in `compute-payroll/structureEngine.ts`. The structure points to ordered `payroll_salary_rules`:

| Rule property | Meaning |
|---|---|
| `code` | Unique stable id, referenced by other rules via `result["CODE"]` |
| `sequence` | Order in which rules execute |
| `category` | `basic, allowance, deduction, employer_contribution, net, gross, other` |
| `condition_select` | `always` or `expression` |
| `amount_select` | `fixed, percentage, expression, statutory_ref` |
| `statutory_rule_id` | When `amount_select='statutory_ref'`, points at `payroll_statutory_rules` |

**Snapshotting**: when the engine runs, it calls RPC `resolve_or_publish_rule_set(structure_id, as_of=period_end)`. This returns an immutable `salary_structure_rule_sets.components` jsonb. Recompute later is byte-identical regardless of subsequent edits to the live rules. The rule-set hash is stored on the payslip for traceability.

### Expression language
Hand-written tokenizer/parser/evaluator in `compute-payroll/expressionEngine.ts`. Whitelist: `BASIC, GROSS, TAXABLE, NET, employee.*, contract.*, worked_hours[code], worked_days[code], result[code]`. Functions: `min, max, round, if`. Hard limits: 2000 chars, 200 tokens, depth 32. **No `eval` is used.**

## Statutory configuration

- Country-active rules live in `payroll_statutory_rules` (seeded by pack install).
- Each rule has a `computation_method` and a `parameters` JSON validated by `pack_rule_type_schemas`.
- The engine never branches on country — only on `computation_method`.
- See `src/lib/payroll/computationMethods.ts` for the six methods (`bracket_progressive`, `tiered_brackets`, `percentage_of_gross`, `graduated_table`, `flat_amount`, `per_employee_flat`), each with a `validate()` and field spec for the UI.

## GL mapping

- Authoritative table: `default_account_settings` (org-level rows + business-level overrides).
- **Only legitimate writers**: RPCs `payroll_apply_proposed_mappings` and `payroll_create_and_map_account`. Direct UPDATE is blocked by trigger `trg_default_account_settings_payroll_role` (ADR-0022) — wrong account types are rejected (`*_payable` must be a liability, `salary_expense` must be expense, never COGS, never header accounts).
- Mapping suggestions UI: `usePayrollMappingFindings`. Backstop validation at post time: RPC `payroll_validate_post_mappings`.

## Payroll settings (`payroll_settings`)

Org-wide knobs:
- `garnishment_aggregate_cap_pct` — cap across all garnishments as % of disposable income.
- `garnishment_minimum_take_home_amount` and `_pct` — floor below which garnishments stop biting.
- `payslip_show_employer_statutory_ids` (default OFF) — prints the employer's registration numbers on payslips.

## Readiness (the gate)

| Hook | What it does |
|---|---|
| `usePayrollReadiness("org")` | Calls RPC `payroll_readiness_blockers(org, business, scope, subject)` + SELECT `payroll_readiness_findings`. `isReady` = `hasEvaluation && blockerRows.length === 0`. |
| `evaluate` mutation | RPC `evaluate_payroll_readiness(...)` → writes findings + a `payroll_readiness_runs` audit row. |
| Engine pre-check | `assert_payroll_ready` RPC inside `compute-payroll` — second layer. |
| `useEmployeePayrollReadiness` | Per-employee findings panel. |
| `payroll_run_issues` | Per-run blockers/warnings written at compute time (e.g., `TIMESHEETS_NOT_APPROVED`, `RULE_SKIPPED_UNKNOWN_METHOD`, `NO_STATUTORY_RULES_FOR_COUNTRY`). |

Scopes: `org | business | employee | run`. Rule definitions in `payroll_readiness_rules`; per-subject waivers in `payroll_readiness_rule_overrides`.

## Loans configuration

Configure each loan kind in `loan_types`:
- `code`, `salary_rule_code` (drives the deduction line code shown on payslips), `gl_receivable_account_id`, `gl_disbursement_clearing_account_id`.

Per-employee loans in `employee_loans` carry `repayment_method ∈ {fixed_installment, percent_of_net, one_off_next_payroll, fixed_amount}`, `min_net_pay_floor`, `max_pct_of_net`, `paused_until`, `outstanding_balance`.

## Garnishments configuration

`employee_garnishments` orders carry `cap_rule ∈ {fixed_amount, percent_disposable, lesser_of_fixed_or_pct}`, `priority`, `kind`, `aggregate_cap_exempt`, `total_owed/total_paid`. `garnishment_kind_defaults` defines per-kind policy (`always_first`, `counts_toward_aggregate_cap`, default `priority`) — child support always_first, for example.

> Full evidence: `./_research/03-payroll-engine.md`.
