# ADR-0044 — Payroll Run Population Resolver (Phase 3.2)

- **Status:** Accepted
- **Date:** 2026-06-29
- **Supersedes / Extends:** ADR-0043 (Run-Type Behavior Matrix)

## Context

Up to Phase 3.1 the engine trusted the caller's `employee_ids` array as the
definitive population for a payroll run. The Create Payroll dialog could
therefore send any list — including employees who were terminated before the
period, never hired by the period, or who already lived in another open run
of the same type. The engine would dutifully cut them a payslip.

ADR-0043 turned the run-type *behavior* into data on
`payroll_run_type_policies`. One of those columns, `population_source`, was
seeded for every canonical run type:

| run_type | population_source |
|---|---|
| regular, 13th_month | `active_in_period` |
| termination | `terminating_in_period` |
| correction, supplemental | `parent_run` |
| off_cycle, bonus, commission | `explicit` |

Nothing consumed it. Phase 3.2 closes that loop.

## Decision

Introduce **`public.payroll_resolve_run_population`**, a `SECURITY DEFINER`,
`STABLE` SQL function that is the single source of truth for "which
employees does this run pay?". It is the only function allowed to decide.

### Inputs (intent, not authority)

`(org, business, period_start, period_end, run_type, country_code,
parent_run_id, explicit_employee_ids)`

`explicit_employee_ids` is treated as a **hint** — it is only authoritative
when the resolved policy's `population_source = 'explicit'`, and even then
each id must independently satisfy the active-in-period gate.

### Outputs

One row per candidate employee:
`(employee_id, included, inclusion_reason, blockers jsonb)`.

`blockers` is a structured map (`NOT_ACTIVE_IN_PERIOD`,
`ALREADY_IN_OPEN_RUN_OF_SAME_TYPE`, …) so the UI can deep-link the user to
the exact remediation page rather than show a blob of English.

### Engine contract

`compute-payroll` calls the resolver **after** policy resolution and:

1. For non-dry runs, **fails closed** with `POPULATION_REJECTED` if any
   caller-supplied id was excluded. We never silently drop people from
   payroll — that is an audit incident.
2. For dry runs (UI preview), narrows the working set to the resolver's
   approved subset and surfaces `blockers` so the dialog can show *why*
   someone was filtered out.
3. Returns `POPULATION_RESOLVE_FAILED` (500) if the resolver itself errors —
   we never proceed on best-effort population data.

### Cross-cutting rules baked into the resolver

- **Active-in-period gate**: hire_date ≤ period_end AND
  (termination_date IS NULL OR ≥ period_start). Bypassed only for
  `population_source IN ('parent_run', 'terminating_in_period')`.
- **No concurrent open run of the same type**: if the employee already has a
  payslip in another non-finalized run of the same `run_type` whose period
  overlaps, they are excluded. Bypassed for `parent_run` sources
  (corrections/supplementals are *expected* to coexist with their parent).

## Consequences

- The engine is no longer the integrity boundary for population — the RPC
  is. UI, edge functions, future schedulers, and one-off scripts all get
  the same answer.
- New `population_source` values (e.g. `'pay_group'`, `'cost_center'`) only
  need a new branch in the resolver — engine code is untouched.
- Architecture guard `payroll-population-resolver.test.ts` locks the
  contract: any future change that bypasses the resolver fails CI.

## Not in scope (deferred)

- Pay-schedule / pay-group membership filtering — the schema does not yet
  carry an employee→schedule mapping. When it does, it becomes one more
  CTE inside the resolver, not a new code path in the engine.
- Readiness blockers are still evaluated separately by
  `assert_payroll_ready_json` immediately after resolution. Phase 3.6 will
  fold the snapshot of those rules into the resolver's output for full
  audit parity.