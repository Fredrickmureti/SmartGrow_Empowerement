# Payroll Readiness ↔ Execution Parity (2026-06-18)

## Symptom
On Faniq Motors the workspace simultaneously displayed:

- "Payroll Ready" badge on `/hr/payroll`
- "Payroll setup required — 1 selected employee(s) failing readiness checks"
  when generating an April 2026 payroll run

## Root cause
The Payroll module shipped **three** readiness paths whose evaluations could
diverge, and the UI badge consumed only the narrowest of them:

| Path | Used by | Evaluates |
|------|---------|-----------|
| A. `payroll_readiness_rules` + `evaluate_payroll_readiness` + `payroll_readiness_blockers` | `usePayrollReadiness("org")` → badge / setup gate | **Org scope only** |
| B. `assert_payroll_ready` (raised exception) | `compute-payroll` edge function | Org + employee + run scopes |
| C. `business_payroll_readiness` / `employee_payroll_readiness` | `/hr/payroll/readiness` per-employee table | Derived directly from `pack_requirements` — could disagree with the rule engine |

Therefore:
- Org rules passed → badge green.
- `compute-payroll` evaluated employee-scope rules at submit time, found a
  fail, and raised `SETUP_REQUIRED` — surfaced as a regex-parsed English
  string with no employee identification.
- The per-employee panel (Path C) could meanwhile claim "Ready" because it
  used a different requirement-derivation than the rule engine.

## Fix — single engine, structured surface

### Database (migration `unify_payroll_readiness`)
1. **`payroll_readiness_summary(org, business, employee_ids, period_start,
   period_end) → jsonb`** — single RPC that re-evaluates org, business and
   employee scopes and returns
   `{ is_ready, org_blockers[], business_blockers[], employee_blockers[],
     counts }`. Employee blockers carry `subject_id`, `subject_label`,
   `rule_code`, `rule_name`, `reason`, `reason_code`, `remediation_label`,
   `remediation_link`, `missing_fields`, `severity`.
2. **`assert_payroll_ready_json(...)`** — same payload shape, plus
   `run_blockers[]` when `p_run_id` is supplied. Returns instead of raising.
3. **`assert_payroll_ready(...)`** — rewired to delegate to
   `assert_payroll_ready_json`; preserves the raised `SETUP_REQUIRED`
   exception for legacy callers but the underlying evaluation now
   matches the badge exactly.

### Edge function (`compute-payroll`)
Switched from `assert_payroll_ready` (raising) to `assert_payroll_ready_json`.
On failure returns HTTP **412** with `{ code: "SETUP_REQUIRED", error,
blockers, counts }` — structured array, no regex needed.

### Frontend
- **`usePayrollReadiness({ employeeIds, businessId, periodStart, periodEnd })`**
  rewritten on top of `payroll_readiness_summary`. Exposes
  `orgBlockers`, `businessBlockers`, `employeeBlockers`, `isReady`,
  `evaluate`, `refetch`. Legacy `("org", subjectId)` signature still
  supported via overloads; legacy `blockers` and `findings` shapes
  preserved for backward compatibility.
- **`useEmployeePayrollReadiness`** is now a thin projection over the same
  summary — no separate SQL, no drift.
- **`PayrollSetupGate`** badge consumes org + business + employee blockers.
  It can no longer go green while execution would fail.
- **`PreRunReadinessSummary`** renders structured per-employee blockers
  with names + remediation links instead of an opaque count.
- **`Runs.tsx`** `classifyPayrollError` prefers the structured payload from
  the edge function (`err.payload.blockers`) over English-string regex.
- **`PayrollSetupGuideDialog`** receives the runtime blockers from the
  edge function payload when present, falling back to the in-page
  readiness blockers otherwise.

## Architectural invariants locked in
1. The "Payroll Ready" badge and `compute-payroll`'s readiness gate share
   one evaluation. Any divergence is now a coding bug in
   `payroll_readiness_summary`, not a design feature.
2. `compute-payroll` returns blockers as structured JSON. UI never has to
   regex an English message to decide remediation.
3. Adding a new readiness check = inserting a row in
   `payroll_readiness_rules`. No new SQL functions, no new RPC, no UI
   change.

## Tenant triage (Faniq Motors)
With the unified summary live, call
`payroll_readiness_summary(<org_id>, <business_id>, NULL, '2026-04-01',
'2026-04-30')` and inspect `employee_blockers`. Each entry now names
the specific employee and the specific rule. The fix is then either
data correction on the employee record or — if the rule is overly
strict for that workspace — a `payroll_readiness_rule_overrides` entry.
No further code changes are required: the architecture now makes the
failure visible before the run is ever created.
