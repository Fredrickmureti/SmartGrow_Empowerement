# ADR 0043 — Payroll Run-Type Behavior Matrix (Phase 3.1)

**Status:** Accepted — 2026-06-29
**Owners:** Platform / HR-Payroll
**Relates to:** ADR 0036 (country-agnostic payroll), ADR 0040/0041 (readiness
single engine), ADR 0042 (work-entries single projector).

## Context

The Phase-3 architectural audit (`.lovable/plan.md` §3) found that
`compute-payroll` treated `run_type` as a **label** rather than as
behavior:

- `bonus`, `commission`, `13th_month`, `off_cycle`, `supplemental`,
  `correction` all produced the exact same payslip computation as
  `regular`. Only `termination` had a real branch (exit-clearance gate).
- Recurring salary, loan installments, garnishments and benefit
  deductions all ran regardless of run intent, so a bonus run silently
  paid the employee their full monthly salary on top of the bonus and
  recovered loan installments twice in the same month.
- Bonus / 13th-month withholding methods (annualized, separate-rate)
  were not honored.

Every reference ERP (Odoo HR Payroll, SAP SF EC Payroll, Workday,
Oracle HCM) drives this from a **declarative per-run-type policy**, not
from engine code.

## Decision

We establish a single declarative source of truth — the
`payroll_run_type_policies` catalogue — and lock the engine to read
from it via a security-definer resolver.

### I1. Catalogue ownership
`payroll_run_type_policies(country_code NULL-able, run_type, …)` is the
**only** place that declares what a run type does. Engine code MUST NOT
branch on `runType === '<literal>'` for computation. Validation /
duplicate-detection gates (regular-only-once, parent_run required for
correction/supplemental, exit-clearance for termination) are permitted.

### I2. Resolver
`payroll_get_run_type_policy(p_country_code, p_run_type)` returns the
country-specific row when present, otherwise the global default
(`country_code IS NULL`). This is the only entry point.

### I3. Snapshot on the run
`payroll_runs.run_type_policy_snapshot jsonb` captures the resolved
policy at run creation. Recompute / reverse / audit all read this
snapshot — never the live catalogue — so a policy edit cannot
retroactively change a posted run.

### I4. Seeded canonical defaults
| run_type      | recurring earnings | recurring deductions | statutory | loans | garnishments | accrues leave | accrues benefits | tax method     | population             | parent run required |
|---------------|--------------------|----------------------|-----------|-------|--------------|---------------|------------------|----------------|------------------------|---------------------|
| regular       | ✅                 | ✅                   | ✅        | ✅    | ✅           | ✅            | ✅               | ordinary       | active_in_period       | no                  |
| off_cycle     | ❌                 | ❌                   | ✅        | ❌    | ❌           | ❌            | ❌               | ordinary       | explicit               | no                  |
| bonus         | ❌                 | ❌                   | ✅        | ❌    | ❌           | ❌            | ❌               | annualized     | explicit               | no                  |
| commission    | ❌                 | ❌                   | ✅        | ❌    | ❌           | ❌            | ❌               | ordinary       | explicit               | no                  |
| 13th_month    | ❌                 | ❌                   | ✅        | ❌    | ❌           | ❌            | ❌               | separate_rate  | active_in_period       | no                  |
| termination   | ✅                 | ✅                   | ✅        | ✅    | ✅           | ❌            | ❌               | ordinary       | terminating_in_period  | no                  |
| supplemental  | ❌                 | ❌                   | ✅        | ❌    | ❌           | ❌            | ❌               | ordinary       | parent_run             | yes                 |
| correction    | ❌                 | ❌                   | ✅        | ❌    | ❌           | ❌            | ❌               | ordinary       | parent_run             | yes                 |

### I5. Architecture guard
`src/test/architecture/payroll-run-type-policy.test.ts` fails the build
if a future change reintroduces a literal-run_type computation branch.

## Consequences

**Positive**
- Bonus / off-cycle / 13th-month runs stop paying the recurring salary
  and stop double-recovering loans / garnishments without any engine
  change per country.
- Adding a new run type or tweaking one country's behavior is a row
  insert, not a code change.
- Every posted run carries the exact policy it was computed under, so
  reverse / reconcile / audit are deterministic even after a catalogue
  edit.

**Negative / cost**
- Existing draft / preview tooling that assumed every run had a full
  salary line must read `salarySource` (now `<source>+suppressed_by_<run_type>`)
  to render correctly.
- Bonus tax-method support (`annualized`, `separate_rate`,
  `aggregate`) is declared but its **engine implementation** lands in
  Phase 3.6 (statutory snapshot + tax-method dispatch). Until then the
  `tax_method` column is honored as metadata only.

## Out of scope (handled in later phases)

- Phase 3.2 — Population resolver RPC (consumes `population_source`).
- Phase 3.4 — Correction delta engine (consumes `parent_run` policy).
- Phase 3.5 — Termination liquidation projector (consumes
  `terminating_in_period` policy and accrual flags).
- Phase 3.6 — Statutory snapshot + per-run-type tax-method dispatch.
