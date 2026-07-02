# ADR 0040 — Payroll Readiness: Single Engine, Rule Dependencies, No Default-Pass

**Status:** Accepted — 2026-06-29
**Owners:** HR-Payroll
**Relates to:** ADR 0036 (country-agnostic payroll), ADR 0039 (employee branch as assignment)

## Context

The Payroll Readiness page (`/hr/payroll/readiness`) failed with HTTP 400
and, before failing, was reporting positively passing checks
(`Salary Configured`, `Work Schedule Configured`, `Active Contract`) for
employees that had no running contract at all.

Root causes found during the architecture audit:

1. **Column-name drift between engine layers.**
   `payroll_readiness_eval_rule` was redefined to return columns named
   `out_status, out_reason, out_missing_fields, out_details`, but the
   consumer `evaluate_payroll_readiness` still read
   `v_eval.status / .reason / .missing_fields / .details`. Postgres
   raised `42703 record "v_eval" has no field "status"`, surfaced by
   PostgREST as HTTP 400.

2. **Silent default-pass on missing prerequisites.**
   Each `WHEN 'employee.contract_*'` branch in `payroll_readiness_eval_rule`
   read the running contract with `SELECT … INTO v_c; IF FOUND AND …`
   and otherwise let the function exit with its initializer
   `v_status := 'pass'`. With no running contract, every contract-dependent
   rule (salary, schedule, payment info, identifiers, exit clearance, …)
   was recorded as `pass`. Readiness lied.

3. **Duplicate readiness surface.** A legacy
   `business_payroll_readiness(uuid)` RPC still existed alongside
   `payroll_readiness_summary`, despite documentation claiming it had
   been retired.

## Decision

The following invariants are locked.

### I1. One engine

The readiness page, the per-employee badge, the `PreRunReadinessSummary`
inside `CreatePayrollDialog`, and the runtime gate `assert_payroll_ready_json`
all consume the **same** engine: `payroll_readiness_rules` →
`payroll_readiness_eval_rule` → `evaluate_payroll_readiness` →
`payroll_readiness_findings`. No client-side or RPC-side duplication of
readiness logic is permitted. `business_payroll_readiness` is dropped.

### I2. Stable column contract

`payroll_readiness_eval_rule` returns OUT columns
`(status, reason, missing_fields, details)`. Renaming any of them is a
breaking change pinned by
`supabase/tests/payroll_readiness_engine_contract_test.sql`.

### I3. Rule dependency graph

Rules carry `prerequisite_rule_codes text[]`. Before evaluating a rule
for a given subject, `evaluate_payroll_readiness` checks the findings
for that subject's prerequisites in the same pass. If any prerequisite
did not pass, the dependent rule is written as `status = 'na'` with
reason `Prerequisite <code> not satisfied.` and its CASE branch is
**not** executed. This guarantees a dependent rule can never spuriously
report `pass` when its prerequisite is absent. Seeded edges:

- Every `employee.contract_*` and identifier/leave/exit rule depends on
  `employee.active_contract`.
- `org.statutory_rules_active` depends on `org.localization_pack_installed`.
- `org.statutory_rules_valid_method` depends on `org.statutory_rules_active`.
- `org.payroll_accounts_mapped` and `org.payroll_period_exists` depend
  on `org.localization_pack_installed`.

### I4. Finding statuses

`payroll_readiness_findings.status ∈ {pass, fail, warn, na}`. Only
`fail` is a blocker. `na` (prerequisite not satisfied) and `warn` are
informational and are not surfaced as blockers in `payroll_readiness_summary`.

### I5. Re-evaluation on every read

`payroll_readiness_summary` re-runs `evaluate_payroll_readiness` for org,
business (when at least one business-scoped rule exists), and the
effective employee set every call. React Query caches the *response*,
not the truth — `staleTime: 15s` is acceptable because the underlying
findings are deterministically rebuilt.

## Consequences

Positive:
- The readiness badge can never disagree with the run-time gate.
- A new readiness rule = one row in `payroll_readiness_rules` + one
  `WHEN` arm in `payroll_readiness_eval_rule`. Dependencies declared
  declaratively in `prerequisite_rule_codes`.
- False-positive `pass` from missing prerequisites is structurally
  impossible.

Negative / cost:
- Adding a rule with new dependencies requires the rules-catalog seed
  to be updated; misuse will surface as `na` rather than `fail` and is
  visible in the findings table.

## Out of scope

- Re-modelling `employee_contracts.status` transitions.
- New readiness rules beyond the existing set.
- UI redesign of the readiness page — the existing surface consumes the
  fixed engine unchanged.

## Retired surfaces (2026-06-29)

To make invariant I1 ("One engine") structurally enforceable, the
following PostgREST-exposed functions were dropped. They were dormant
(no frontend, edge function, trigger, or seed referenced them) but each
was capable of returning a readiness verdict that diverged from the
canonical engine.

- `public.employee_payroll_readiness(uuid)` — recomputed `is_ready`
  from `CURRENT_DATE` only, ignored `payroll_readiness_rules`,
  `prerequisite_rule_codes`, and `payroll_readiness_rule_overrides`,
  and emitted ad-hoc English blocker strings.
- `public.payroll_readiness_blockers(uuid, uuid, text, uuid)` — a
  row-shaped projection of `payroll_readiness_findings` superseded by
  `payroll_readiness_summary`'s structured JSON payload.
- `public.payroll_readiness_eval_rule_ext(payroll_readiness_rules, uuid,
  uuid, uuid, date, date)` — second evaluator with the same signature
  as the canonical `payroll_readiness_eval_rule`. Two evaluators with
  identical signatures is the exact drift surface this ADR forbids.

`supabase/tests/payroll_readiness_engine_contract_test.sql` now denies
reintroduction of any of these names.

