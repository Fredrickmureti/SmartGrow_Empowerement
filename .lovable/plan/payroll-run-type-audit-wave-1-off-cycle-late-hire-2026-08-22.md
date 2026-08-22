# Payroll Run-Type Audit — Wave 1: Off-Cycle / Late Hire

Scope: only the `off_cycle` run type and the behavior it directly causes. No other run types, no unrelated modules, no fixes in this wave.

## 1. Question

What real business event makes a payroll officer select **Off-cycle (late hire / one-off payment)** instead of Regular cycle, what does this ERP actually do when they do, and do the domain meaning, the intended semantics, and the implementation agree?

## 2. External research findings (evidence gathered)

- **ADP — "Off-cycle payroll"**: any payroll processed at a time other than the normal pay period; typical reasons are correcting missed/incorrect pay, termination payouts, bonuses, and payments that cannot wait for the next cycle. Supplemental withholding rules may apply.
  https://www.adp.com/resources/articles-and-insights/articles/o/off-cycle-payroll.aspx
- **Workday — "Concept: Off-Cycle Payments"**: off-cycle transactions occur outside a scheduled on-cycle run and are one of: manual payment, **on-demand payment that replaces or adds to** on-cycle pay, or reversal. Off-cycle is a *processing-timing* construct, not a distinct earnings formula.
  https://doc.workday.com/admin-guide/en-us/payroll/payroll-processing/process-on-demand-off-cycle-payments-by-worker/dan1370797201878.html
- **Dayforce — "Off-Cycle Pay Runs"**: an off-cycle run lives inside an existing pay period, is independent of the scheduled run, and inherits pay group/period from a **parent** regular run.
  https://help.dayforce.com/r/documents/Payroll-Administrator-Guide/Off-Cycle-Pay-Runs
- No authoritative source found that treats **"late hire" as a named off-cycle run type**. In the sources above, a person hired mid-period is handled by the *regular* run with **proration**; off-cycle only becomes relevant when the person was hired *after the run was already processed/cut off* and therefore missed the cycle.

## 3. Domain conclusion (established, not assumed)

Off-cycle = **when** money is paid (outside the scheduled run), not **what** is computed. It is orthogonal to proration. "One-off payment" is a *reason* for an off-cycle run. "Late hire" is **not** standard off-cycle vocabulary; in the domain it is either (a) mid-period hire → regular run + proration, or (b) hired after cutoff → off-cycle run paying the missed (usually prorated) salary.

## 4. ERP intended semantics

Declared in ADR-0043 and seeded in `payroll_run_type_policies` (verified live):

| flag | off_cycle | regular |
|---|---|---|
| applies_recurring_earnings | **false** | true |
| applies_recurring_deductions | false | true |
| applies_statutory | true | true |
| loans / garnishments | false | true |
| accrues leave / benefits | false | true |
| tax_method | ordinary | ordinary |
| population_source | **explicit** | active_in_period |
| requires_parent_run | false | false |

Catalogue note (live row): *"Late-hire / one-off payment. Statutory still applies on the paid amount; recurring streams suppressed."*

## 5. Implementation evidence

- Policy resolver: `payroll_get_run_type_policy`, snapshot onto `payroll_runs.run_type_policy_snapshot` (ADR-0043 I2/I3).
- `supabase/functions/compute-payroll/index.ts:3024-3030` — when `applies_recurring_earnings=false` the engine zeroes `basicSalary`, `housingAllowance`, `transportAllowance`, `otherEarnings` and stamps `salarySource = "<source>+suppressed_by_off_cycle"`.
- Proration is computed **after** suppression (`:3064-3120`) from the contract-first employment window (`contract.start_date`, else `employees.hire_date`) — i.e. it multiplies already-zeroed amounts. Proration is therefore **independent of run type** and driven by the employment window (`calculateProrationFactor`, `:179`).
- Remaining money for an off-cycle run can only come from `variable_earnings[]` (`:2545`, `:3125-3151`, not prorated — treated as actuals), attendance-derived overtime, or termination payouts.
- Uniqueness: only `regular` is unique per period (`:1360-1395`); off-cycle may coexist. On `REGULAR_RUN_EXISTS`, the API offers `create_off_cycle_run` as a recovery option.
- Population: `payroll_resolve_run_population` (ADR-0044). For `explicit`, caller ids are candidates but each **must still pass the active-in-period gate** (`hire_date <= period_end AND (termination_date IS NULL OR >= period_start)`), plus "no other open run of the same type". Non-dry runs fail closed with `POPULATION_REJECTED`.
- UI copy: `CreatePayrollDialog.tsx:167` label, `:134` conflict banner, `:301` "pick a single employee" (advisory text only — no backend single-employee constraint found); `Runs.tsx:648` "pay a late hire, bonus, or one-off without touching the regular run."

## 6. Consumers of `run_type` (what actually changes vs what only records it)

- **Behavioral**: policy resolution + earnings suppression; loans/garnishments/benefits skipped; population resolver branch; regular-uniqueness gate; parent-run gate (correction/supplemental only); exit-clearance gate (termination only).
- **Recorded only**: `payroll_runs.run_type`, `run_type_policy_snapshot`, payslip `_salary_source`, run lists/filters, audit logs.
- **To be confirmed in simulation**: GL posting (`post-payroll-gl`), statutory/YTD accumulation, payroll reports — no evidence yet found that any of them branch on `run_type`.

## 7. Controlled simulation (to run on approval)

Test employee + contract starting mid-period, in a period whose regular run already exists/posted. Then, on an isolated test org/business:

- **S-A** hired Aug 20, Aug 1–31 period → include in Regular run; observe proration factor and pay.
- **S-B** hired Aug 23, Regular already posted → create Off-cycle run for that employee only; compute → inspect payslip earnings, statutory, net; post → inspect JE, liabilities, audit trail, YTD.
- **S-C** existing employee, one-off payment via `variable_earnings` on an Off-cycle run → verify amount flows, statutory computed on it, no salary/loan/garnishment lines.

## 8. Expected behavior (per established semantics)

S-A: regular run pays prorated salary. S-B: off-cycle pays the missed prorated salary for the late hire. S-C: off-cycle pays only the one-off amount plus statutory.

## 9. Actual behavior (evidence-based prediction, pending simulation)

S-C matches. **S-B does not**: because `applies_recurring_earnings=false`, an off-cycle run for a late hire produces a payslip with **zero salary** unless the officer manually types the amount into variable earnings. Proration is applied to zero and is thus inert on this path. Additionally, if the employee's `hire_date` is after `period_end`, the active-in-period gate excludes them entirely (`POPULATION_REJECTED`), which is precisely the "hired after the run was processed, pay them in the next-period off-cycle" case.

## 10. Verdict (provisional — confirm by simulation before any fix)

**Semantically ambiguous + UI terminology problem.** The catalogue and engine implement off-cycle as a *supplemental/one-off* run (recurring streams suppressed), which is internally consistent and matches ADP/Workday's supplemental-payment usage. The UI label, conflict banner, and empty-state copy advertise it as the **late hire** path, which the engine does not serve: a late hire's prorated first salary is suppressed to zero. The two disagree.

## 11. Recommended next action

1. Run the S-A/S-B/S-C simulation on an isolated test business and record actual payslip/JE/audit output in this section — the verdict is not final until then.
2. Then choose exactly one resolution and document it before coding:
   - **(a) Terminology fix** — relabel to "Off-cycle (one-off / supplemental payment)" and route late hires to the regular run's proration, or to a documented next-period path.
   - **(b) Policy fix** — introduce a distinct late-hire semantic (e.g. off-cycle honoring recurring earnings with an explicit employment-window proration), as a catalogue row, not engine code (ADR-0043 I1).
3. No code changes in Wave 1 beyond this record.
