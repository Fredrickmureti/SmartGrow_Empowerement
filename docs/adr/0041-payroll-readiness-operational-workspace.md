# ADR-0041 — Payroll Readiness as an Operational Workspace

Status: Accepted · 2026-06-29

## Context

The Payroll Readiness page previously projected the engine's structured
findings into a fixed set of UI booleans (`has_contract`, `has_salary`,
`has_schedule`, `has_statutory_ids`, `has_bank`) by regex-matching rule
codes in the React hook. This had three consequences:

1. **Drift.** New rules added to `payroll_readiness_rules` were
   invisible to the UI unless their code happened to match the regex.
2. **Lost semantics.** `warn`, `na`, and `fail` collapsed into a single
   "Missing" / "Set" badge, hiding remediation context.
3. **No period scoping.** Readiness was evaluated against "today" and
   ignored the payroll period being prepared.

## Decision

Payroll Readiness is the **authoritative gatekeeper** for payroll
execution. There is exactly one engine:

- `evaluate_payroll_readiness(org, business, scope, ids, period_start, period_end)`
  — writes findings to `payroll_readiness_findings`.
- `payroll_readiness_eval_rule(rule, org, business, subject, period_start, period_end)`
  — pure evaluator, period-effective.
- `payroll_readiness_summary(...)` — org-scope blockers and
  per-employee block counts.
- `payroll_readiness_employee_matrix(...)` — full per-(employee × rule)
  status map plus structured findings for the readiness workspace.
- `payroll_period_employees(...)` — population for a given period.

The UI consumes these payloads as-is. It must not regex-match on rule
codes, derive readiness independently, or invent booleans on top of the
engine output. New rules surface automatically the moment they are
added to `payroll_readiness_rules`.

## Invariants

1. **Single source of truth.** Every readiness signal is computed by
   `payroll_readiness_eval_rule` and read back from
   `payroll_readiness_findings`.
2. **No default-pass on missing prerequisites.** A contract-dependent
   rule defaults to `fail` when no contract is effective for the
   period, never `pass`.
3. **Period-effective.** Rule branches use `period_start..period_end`
   for contract/employment/statutory effectivity. With no period
   supplied they fall back to `CURRENT_DATE` and behave like the legacy
   evaluator.
4. **Dependency-aware.** `prerequisite_rule_codes` on each rule causes
   dependent rules to short-circuit to `na` when an upstream rule
   fails, so a payroll engineer cannot satisfy a downstream check
   accidentally.
5. **Remediable.** Every rule that can fail carries
   `remediation_label` and `remediation_link`. The UI renders the link
   on every blocker.
6. **Population-driven.** The readiness page enumerates employees from
   `payroll_period_employees`, not from `v_employees_safe`. Mid-period
   joiners and leavers are included.

## Consequences

- The architecture guard
  `src/test/architecture/no-regex-on-readiness-rule-codes.test.ts`
  prevents the regex-projection regression from re-entering the
  codebase.
- The pgTAP test
  `supabase/tests/payroll_readiness_engine_contract_test.sql` pins the
  engine's column contract.
- Adding a new readiness rule requires:
  (a) an insert into `payroll_readiness_rules` with a `check_kind`,
  (b) a branch in `payroll_readiness_eval_rule`,
  (c) optionally a `remediation_link` template using `:employee_id`.
  No UI change is required.
