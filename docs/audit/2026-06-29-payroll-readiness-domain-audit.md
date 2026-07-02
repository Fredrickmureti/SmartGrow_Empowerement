# Payroll Readiness — Domain Architecture Audit (2026-06-29)

**Author:** Lead Payroll Architect (Lovable agent)
**Scope:** `/hr/payroll/readiness`, the `payroll_readiness_*` engine, and every
surface that calls it.
**Predecessors:** ADR 0036 (country-agnostic payroll), ADR 0039 (employee
branch as assignment), ADR 0040 (single readiness engine), 2026-06-18
execution-parity audit, 2026-05-08 GL readiness audit.

---

## 1. What "Payroll Readiness" means in a mature ERP

Across Odoo, SAP SuccessFactors EC Payroll, Oracle HCM, Workday and Dynamics
365 HR/Payroll the term converges on a single definition:

> **Payroll Readiness is the deterministic gate that asserts every input
> needed to *compute* a payroll run for a defined population in a defined
> period is present, valid, effective on the period dates, and approved
> by the upstream owner of that data.**

It is not a report. It is not a checklist owned by Payroll. It is the
contract Payroll signs with HR, Finance, Compliance and IT before it will
accept responsibility for a run. The defining properties:

1. **Population × Period scoped.** Readiness is always evaluated against
   *these employees* for *this period*, not "in general". An employee
   ready for May is not necessarily ready for June (contract ended,
   terminated, on unpaid leave, identifier expired).
2. **Layered by ownership.** Each layer is evaluated by the system that
   owns the data, never re-derived by Payroll:

   ```text
   Tenant     ─ legal entity, fiscal calendar, localization pack
      │
   Organization ─ statutory rules, GL mapping, payroll period, pay schedule
      │
   Business / LDG ─ business-unit-specific overrides, currency, calendar
      │
   Employee   ─ identity, employment status, statutory identifiers
      │
   Employment ─ employer-of-record relationship (start/end, type)
      │
   Contract   ─ approved, effective, not suspended, in-period
      │
   Compensation ─ structure assigned, components resolved, amounts effective
      │
   Schedule   ─ working time pattern effective in period
      │
   Inputs     ─ timesheets / attendance / leave approved, work entries closed
      │
   Run        ─ period open, no duplicate regular run, prior run posted
   ```
3. **Derived, never authored.** Readiness rules read the canonical
   tables. There is no "readiness checklist" that HR ticks manually.
   Ticking a box without changing the underlying record is forbidden.
4. **Single engine, multiple consumers.** The same evaluation powers
   the readiness dashboard, the per-employee badge on the profile, the
   pre-run summary inside *Create Run*, and the runtime gate inside
   `compute-payroll`. Divergence between any two of those is a bug by
   definition.
5. **Three states, not two.** `pass`, `fail`, `na`. `na` is reserved
   for rules whose prerequisite did not pass — they are *not evaluated*,
   so they cannot lie. `warn` is a softer `fail` that does not block.
6. **Time-travel safe.** A rule evaluated today for the May period
   reads May-effective rows (`effective_from <= '2026-05-31' AND
   (effective_to IS NULL OR effective_to >= '2026-05-01')`). Reading
   "today's" snapshot is a defect.
7. **Remediation-first UX.** Every failure carries `who · what · why ·
   where to fix it`. The page is an operations console, not a status
   report.

These seven properties are the yardstick for the rest of this audit.

---

## 2. Reconstruction of the canonical readiness graph

Required readiness rules for an enterprise payroll engine, grouped by
the lifecycle layer that owns the data, with the **single** source of
truth each one must read. Anything in the current implementation that
reads a *different* table is architectural drift.

### 2.1 Organization scope

| Rule | Owner table(s) | Effective-date semantics |
|---|---|---|
| Localization pack installed for org's country | `installed_localization_packs` | `installed_at <= period_end` |
| Statutory rules active for period | `payroll_statutory_rules` | `effective_from <= period_end AND (effective_to IS NULL OR effective_to >= period_start)` |
| Statutory rules have valid computation method | `payroll_statutory_rules.computation_method` ∈ `pack_rule_type_schemas` | n/a |
| GL accounts mapped for every required key | `default_account_settings` vs `payroll_gl_readiness(...)` | n/a |
| Pay schedule defined | `pay_schedules` | active in period |
| Payroll period exists & open | `payroll_periods` × `fiscal_periods` | covers period; `status != closed` |
| Org currency configured | `organizations.default_currency_id`, `exchange_rates` if multi-currency | rate exists for period_end |

### 2.2 Business / LDG scope

| Rule | Owner | Effective |
|---|---|---|
| Business has active currency | `business_active_currencies` | in period |
| Business assigned to org's pack | `installed_localization_packs.business_id` | in period |

### 2.3 Employee scope

| Rule | Owner | Effective |
|---|---|---|
| Employee active & not terminated before period start | `employees` + `employments` | `employments.start_date <= period_end AND (end_date IS NULL OR end_date >= period_start)` |
| Active employment of paid type | `employments` | as above |
| Active contract | `employee_contracts` | `status='active' AND start_date <= period_end AND (end_date IS NULL OR end_date >= period_start) AND approved_at IS NOT NULL` |
| Contract has compensation | `contract_compensation_components` | components effective in period |
| Compensation mode set | `employee_contracts.compensation_mode` | non-null |
| Salary structure resolves | `salary_structures` + `salary_structure_rule_sets` | structure effective in period |
| Work schedule assigned | `work_schedules` via `employee_contracts.schedule_id` (or assignment) | effective in period |
| Statutory identifiers cover pack requirements | `pack_requirements` × `employee_statutory_identifiers` | identifier active in period |
| Payment information present (if pack requires) | `bank_accounts` flagged `is_payroll_account AND is_active AND verified_at IS NOT NULL` | n/a |
| Exit clearance cleared (if termination in period) | `employee_exit_clearance` | `cleared_at IS NOT NULL` |
| Timesheets approved (if timesheet-driven pay) | `timesheet_submissions.status='approved'` covering period | full coverage |
| Statutory leave initialized | `leave_allocations` for statutory leave types | exists in period |

### 2.4 Run scope

| Rule | Owner | Effective |
|---|---|---|
| Period not fiscally closed | `fiscal_periods.status` | open at run time |
| No duplicate regular run for population × period | `payroll_runs` | uniqueness check |
| Prior period posted to GL | `payroll_runs.gl_posted_at` | for previous period |
| Loan-skip overrides documented | `payroll_run_loan_skip_overrides` | per included employee |

---

## 3. Inventory of the current implementation

### 3.1 Engine layer (good)

After ADR 0040 the engine is consolidated to:

```text
payroll_readiness_rules           ← catalog (20 rules seeded)
payroll_readiness_eval_rule(...)  ← per-rule evaluator
evaluate_payroll_readiness(...)   ← topological orchestrator (writes findings)
payroll_readiness_findings        ← finding history
payroll_readiness_summary(...)    ← single-call jsonb façade
assert_payroll_ready_json(...)    ← runtime gate (412 from compute-payroll)
```

Verified live: 20 active rules across `org/employee/run` scopes,
`prerequisite_rule_codes` populated, every contract-dependent rule
prerequisited on `employee.active_contract`. The post-ADR-0040 column
contract (`status / reason / missing_fields / details`) is in place,
the legacy `business_payroll_readiness` RPC is dropped, and the
contract pgTAP test exists.

### 3.2 UI layer (the actual problem surface)

The `/hr/payroll/readiness` page (`src/pages/hr/payroll/sections.tsx`
`PayrollReadiness`) renders **two stacked panels**:

1. `OrgReadinessPanel` — calls `usePayrollReadiness("org")` and renders
   structured org blockers with remediation buttons. **This panel is
   architecturally correct.**

2. The per-employee table — calls `useEmployeePayrollReadiness()`
   which projects rows from the same engine, but **collapses each
   employee's structured blockers into 5 booleans via regex on
   `rule_code`**:

   ```ts
   const isContract = (c) => /contract/i.test(c);
   const isSalary   = (c) => /salary|structure/i.test(c);
   const isSchedule = (c) => /schedule|pay[_-]?frequency/i.test(c);
   const isBank     = (c) => /bank/i.test(c);
   const isIdent    = (c) => /ident|kra|nssf|nhif|shif|nita|tin|ssn|paye/i.test(c);
   ```

   The table then renders `Missing` / `Set` / `On file` badges with
   **no reason text, no missing-field list, no remediation link, and
   no distinction between `fail` / `warn` / `na`.** Every value the
   engine produces — severity, prerequisite chain, missing field
   names, remediation URL — is discarded at the UI boundary.

### 3.3 Drift inventory

Concrete architectural defects, in order of severity:

| # | Defect | Where | Why it's wrong |
|---|---|---|---|
| D1 | **Regex projection of rule codes into booleans** | `useEmployeePayrollReadiness.ts` lines 113-128 | Reintroduces a *second* derivation layer (string matching on engine identifiers) on top of the canonical engine. Adding a new rule whose code doesn't match a regex silently disappears from the table. Country-specific identifier rules like `employee.tin_present` already wouldn't be caught by `/kra|nssf|…/`. |
| D2 | **No period scoping from the UI** | `useEmployeePayrollReadiness.ts` does not pass `periodStart/periodEnd` | The page evaluates "ready today" instead of "ready for the period the user is about to run". §1 property 1 violated. |
| D3 | **`pass`/`warn`/`na` collapsed to `Set`/`Missing`** | Same file, badge rendering | A `warn` (e.g. statutory leave not initialized) is shown identically to `pass`; an `na` (prerequisite failed) is shown identically to `fail`. §1 property 5 violated. |
| D4 | **Active-employee list filtered on `is_active` only** | `useEmployeePayrollReadiness.ts` line 75 | Should filter on "has at least one employment overlapping the selected period". A terminated employee with a back-dated payment should still appear; an employee hired after period_end should not. |
| D5 | **Single-employee `useEmployeeReadiness` uses regex twice** | Same file, lines 159-167 | Powers the badge on `EmployeeProfile`. Same drift surface. |
| D6 | **Org panel ignores business + employee blockers** | `sections.tsx` `OrgReadinessPanel` calls `("org")` | The org panel's "ready" badge can be green while the page below it shows 50 blocked employees. The badge contradicts the body of its own page. |
| D7 | **No population picker, no period picker** | `PayrollReadiness` component | The page cannot be used as the "before I create the May run, am I ready?" gate that §1 demands. Today it shows global state. |
| D8 | **Remediation links rendered for org blockers only** | UI omits `b.remediation_link` for employee blockers | The engine produces them; the table throws them away. §1 property 7 violated. |
| D9 | **Employee blockers are not grouped/aggregated** | UI shows one row per employee × all blockers in a tooltip | The "operations console" view requires the inverse rollup: "12 employees missing TIN → fix in one place." |
| D10 | **`employees` table read directly** | `from("v_employees_safe")` is correct, but the row shape projects fields that the canonical view `v_employees_canonical` already provides | Crosses ADR 0039's read-path boundary — minor. |

### 3.4 What is *not* drifted

- The engine contract is sound (ADR 0040 holds).
- `compute-payroll` consumes the same engine (2026-06-18 parity holds).
- The badge on `PayrollSetupGate` reads `usePayrollReadiness` with
  full scope, not the regex hook.
- GL readiness (separate concern, 2026-05-08 audit) is correctly
  integrated as `org.payroll_accounts_mapped`.

---

## 4. Root cause

The engine was rebuilt twice (2026-06-18 unification, ADR 0040
dependency graph) but the `/hr/payroll/readiness` **page UI** has not
been touched since the per-employee booleans were first introduced.
The hook that feeds the page (`useEmployeePayrollReadiness`) was
edited to *call* the new engine but kept its old return shape for
backward compatibility — and the page still consumes that legacy
shape. The result is a correct engine wrapped in a UI that downgrades
every signal it produces.

> **The HTTP 400 was a symptom of the engine. The wrongness of the
> page is a symptom of the UI never being modernized to consume the
> engine's structured output.**

Fixing the 400 (already done) does nothing for D1-D9.

---

## 5. Target architecture

### I1. Engine remains the only source of truth.
No change. `payroll_readiness_rules` + `evaluate_payroll_readiness`
stand. ADR 0040 invariants hold.

### I2. UI consumes structured blockers, never regex-derives them.
`useEmployeePayrollReadiness` is rewritten to return one row per
employee containing the **raw** `PayrollReadinessBlocker[]` for that
employee plus a per-rule status map keyed by `rule_code` (not by
regex bucket). Boolean projections are deleted.

### I3. Readiness is always evaluated for a chosen *population × period*.
The page gets a period selector (defaulting to the next open
`payroll_periods` row for the active pay schedule) and a population
filter (Active employees · All employees in period · Selected). These
flow through `periodStart` / `periodEnd` / `employeeIds` into
`payroll_readiness_summary`.

### I4. Three rendering modes, switchable from a single toolbar.

- **By employee** — one row per employee × one cell per rule. Each
  cell shows `pass` / `warn` / `fail` / `na` with the rule's
  `remediation_link` on hover; clicking the cell opens a side sheet
  with reason, missing fields and a "Fix now" button. This replaces
  the current 5-boolean table.
- **By rule** — one row per rule, count of affected employees, with
  a "Fix N employees" bulk action linking to the appropriate module
  (e.g. statutory IDs → `/hr/employees?missing=tin`).
- **Org + Business** — the existing `OrgReadinessPanel`, extended to
  also render `business_blockers`. The badge ("Ready / X blockers")
  reflects the union of org + business + employee.

### I5. `na` and `warn` are first-class.
`na` rules render as muted "—" with a tooltip explaining the
unsatisfied prerequisite. `warn` rules render as amber and are
excluded from the blocker count but included in the warning count.
The page header shows `12 ready · 3 warnings · 5 blocked · 2 n/a`.

### I6. Remediation links are mandatory.
Every blocker row exposes its `remediation_link` as a button. Where
the link can be deep-linked (employee profile, contract editor, bank
accounts tab) the URL carries the employee id + the target tab.

### I7. Period-effectiveness pushed into the engine.
The engine's per-rule branches that currently read "the running
contract" are amended to read "the contract effective in
`[period_start, period_end]`". The summary RPC already accepts
period bounds; the rule evaluators must honour them.

### I8. Active-employee scoping is period-aware.
The UI's employee list switches from `v_employees_safe WHERE
is_active` to a small RPC `payroll_period_employees(org, business,
period_start, period_end)` returning the set of employees with any
employment overlapping the period. This becomes the canonical
"who is in scope for the run?" answer and is reused by
`CreatePayrollDialog`.

### I9. The page is the pre-run gate.
`/hr/payroll/runs` "New run" CTA links to the readiness page with
the selected period pre-filled, and the readiness page exposes a
"Create run with ready employees" button that hands the filtered
ready set to `CreatePayrollDialog`. This closes the loop §1 demands.

### I10. No client-side derivation of "ready".
`row.ready` is removed. Whether an employee is ready is asked of the
engine via `summary.is_ready` for the supplied scope. The UI cannot
disagree with the engine because it does not own the truth.

---

## 6. Test surface

- `payroll_readiness_engine_contract_test.sql` — exists, keep.
- New: `payroll_readiness_period_effectiveness_test.sql` — pgTAP
  asserting that a contract whose `end_date` precedes `period_start`
  fails `employee.active_contract` for that period and passes for
  the preceding period.
- New arch test:
  `src/test/architecture/no-regex-on-readiness-rule-codes.test.ts` —
  scans `src/hooks/payroll/**` for `/contract|salary|schedule|bank|
  ident/.test(rule_code)` patterns and fails the build. Prevents
  reintroduction of D1.
- Existing `no-english-regex-on-readiness-reasons.test.ts` already
  guards reasons. Keep.

---

## 7. Out of scope for this audit

- New readiness rules beyond §2's set (those are seeded already or
  are localization-pack concerns).
- Marketplace UI for pack-author-defined rules.
- Re-modelling `employee_contracts` lifecycle (separate ADR).
- A redesign of the readiness *page visuals* beyond what I5-I9
  require.
