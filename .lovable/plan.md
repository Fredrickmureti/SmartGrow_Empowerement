# Payroll Run-Type Audit — Wave 1: Off-Cycle / Late Hire (COMPLETED RECORD)

Scope: `off_cycle` only. No fixes applied in this wave. Simulation was run against the live project with a temporary test employee, which has since been deleted (0 payroll_runs, 0 payslips, 1 employee remaining — the original state).

## 1. Question

What real business event makes a payroll officer choose **Off-cycle (late hire / one-off payment)** instead of Regular cycle; what does the system then do; and do the payroll domain, this ERP's declared intent, and its actual behavior agree?

## 2. External research findings

- **ADP — Off-cycle payroll**: payroll processed at any time other than the normal pay period; typical reasons are correcting missed/incorrect pay, terminations, bonuses, urgent payments. https://www.adp.com/resources/articles-and-insights/articles/o/off-cycle-payroll.aspx
- **Workday — Concept: Off-Cycle Payments**: off-cycle transactions occur outside a scheduled on-cycle run and are manual payments, on-demand payments that *replace or add to* on-cycle pay, or reversals. Off-cycle is a processing-timing construct, not a distinct earnings formula. https://doc.workday.com/admin-guide/en-us/payroll/payroll-processing/process-on-demand-off-cycle-payments-by-worker/dan1370797201878.html
- **Dayforce — Off-Cycle Pay Runs**: an off-cycle run sits inside an existing pay period, independent of the scheduled run, inheriting pay group/period from its parent regular run. https://help.dayforce.com/r/documents/Payroll-Administrator-Guide/Off-Cycle-Pay-Runs
- No authoritative source treats **"late hire" as an off-cycle run type**. A mid-period hire is paid by the *regular* run with proration; off-cycle applies when the person missed the cycle (hired/entered after cutoff or after the run was processed).

## 3. Domain conclusion

Off-cycle answers **when** money is paid, not **what** is computed. It is orthogonal to proration. "One-off payment" is a *reason* for an off-cycle run. "Late hire" is not standard off-cycle vocabulary.

## 4. ERP intended semantics

`payroll_run_type_policies` (live rows, ADR-0043):

| flag | off_cycle | regular |
|---|---|---|
| applies_recurring_earnings | **false** | true |
| applies_recurring_deductions | false | true |
| applies_statutory | true | true |
| loans / garnishments | false | true |
| accrues leave / benefits | false | true |
| tax_method | ordinary | ordinary |
| population_source | explicit | active_in_period |
| requires_parent_run | false | false |

Catalogue note: *"Late-hire / one-off payment. Statutory still applies on the paid amount; recurring streams suppressed."*

## 5. Implementation evidence

- `compute-payroll/index.ts:3024-3030` — with `applies_recurring_earnings=false` the engine zeroes basic/housing/transport/other and stamps `salarySource = "<source>+suppressed_by_off_cycle"`.
- Proration (`:3064-3120`, `calculateProrationFactor` `:179`) is computed from the contract-first employment window **after** suppression — it multiplies zero. Proration is run-type independent.
- Money on an off-cycle run can only come from `variable_earnings[]` (`:2545`, `:3125-3151`, not prorated), attendance overtime, or termination payouts.
- Only `regular` is unique per period (`:1360-1395`); `create_off_cycle_run` is offered as recovery on `REGULAR_RUN_EXISTS`.
- `payroll_resolve_run_population` (ADR-0044): for `explicit`, caller ids still must pass `hire_date <= period_end AND (termination_date IS NULL OR >= period_start)` and "no other open run of the same type".
- UI: `CreatePayrollDialog.tsx:167` label, `:134` banner, `:301` single-employee advice (advisory copy only — no backend constraint); `Runs.tsx:648` "pay a late hire, bonus, or one-off".

## 6. Consumers of `run_type`

- **Behavioral**: policy resolution → earnings suppression; loans / garnishments / benefit deductions skipped; population resolver branch; regular-uniqueness gate; parent-run gate (correction/supplemental); exit-clearance gate (termination).
- **Recorded only**: `payroll_runs.run_type`, `run_type_policy_snapshot`, payslip `_salary_source`, run lists/filters, audit logs. No evidence found of `run_type` branching in GL posting, statutory rules, or reports — statutory rules apply to whatever earnings survive.

## 7. Controlled simulation (executed)

Org Joshua Holdings, period 2026-08-01 → 08-31, KE pack. Temporary employee **ZZTEST-OFFCYCLE-1** ("Wave1 LateHire"), contract start 2026-08-20, wage 60,000, no allowances. Dry-run compute via `compute-payroll` as the org owner. Test rows deleted afterwards.

Note observed en route: a newly created employee lands as `lifecycle_status='draft'`, `is_active=false`, and is therefore invisible to the population resolver until activated.

## 8. Expected behavior

S-A regular: prorated salary for Aug 20–31. S-B off-cycle late hire: the missed prorated salary. S-C off-cycle one-off: only the one-off amount plus statutory.

## 9. Actual behavior

| Scenario | Result |
|---|---|
| **S-A** — Regular run, hire 2026-08-20 | Gross **23,225.81** = 60,000 × proration **0.3871**; NSSF 1,393.49, SHIF 638.71, AHL 348.39; net **20,845.22**; `_salary_source = "contract"`. Correct prorated late-hire pay. |
| **S-B** — Off-cycle run, same employee, same period | Gross **0.00**, net **0.00**, `_proration_factor 0.3871` (applied to zero), `_salary_source = "contract+suppressed_by_off_cycle"`. Only line produced: **employer NITA 50.00** on zero pay. A payslip is still generated. |
| **S-B2** — Off-cycle for the July period (hired after period end) | `409 POPULATION_EMPTY` / `NOT_ACTIVE_IN_PERIOD`. The "hired after the run was processed, pay them off-cycle in the prior period" case is refused. |
| **S-C** — Off-cycle, existing employee, 25,000 one-off via `variable_earnings.arrears` | Gross **25,000**, statutory on that amount (NSSF 1,499.94, SHIF 687.50, AHL 375), net **20,437.56**, no salary/loan/garnishment lines. Behaves exactly as a supplemental payment. |

## 10. Verdict

**UI terminology problem (confirmed), plus one minor implementation defect.**

- The engine implements off-cycle as a **supplemental / one-off payment run** — internally consistent with ADR-0043 and with ADP/Workday's supplemental usage. S-C proves it works as designed.
- The UI advertises off-cycle as the **late hire** path. S-B proves the engine cannot serve that: a late hire's first, prorated salary is suppressed to zero, so following the UI's own advice ("switch to Off-cycle" for a late hire) produces a zero-value payslip with no error and no warning. The correct home for a late hire is the **regular** run, which already prorates correctly (S-A).
- Minor defect: an off-cycle payslip with zero gross still emits a fixed employer **NITA 50.00** contribution, creating an employer liability on a zero-pay payslip.
- Adjacent observation (not a defect, out of Wave 1 scope): if a late hire misses a period entirely, there is no supported path to pay them for that closed period other than manual variable earnings on a later run.

## 11. Recommended next action (not implemented — awaiting your decision)

Pick one:

- **(a) Terminology fix (low risk, recommended).** Relabel to "Off-cycle (one-off / supplemental payment)", drop "late hire" from the run-type item, the regular-run conflict banner, and the Runs empty-state copy; point late hires at the regular run's proration. Optionally warn when an off-cycle run computes zero gross for an employee.
- **(b) Policy fix (larger).** Introduce a genuine late-hire semantic as a catalogue row (per ADR-0043 I1) — e.g. an off-cycle variant honoring recurring earnings with employment-window proration and relaxing the active-in-period gate for prior periods — rather than changing engine code.

Separately, whichever is chosen: suppress fixed employer contributions when a payslip's gross is zero.

Wave 1 is closed. Bonus / Commission / 13th-month / Termination / Supplemental / Correction remain untouched.
