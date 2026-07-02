# ADR-0045 — Payroll Correction Runs Emit Signed Deltas, Not Full Payslips

**Status:** Accepted (Phase 3.4)
**Supersedes:** none. Refines ADR-0043 (Run-Type Behavior Matrix) and ADR-0044 (Population Resolver).

## Context

Through Phase 3.3, `compute-payroll` treated `run_type='correction'` as "recompute the whole payslip for the affected employees and insert it as a new payslip row." `payroll_runs.parent_run_id` was stored but never consumed by the engine.

Two concrete failure modes followed:

1. **YTD double-count.** `trg_payslip_lines_ytd` aggregates `payslip_lines.employee_amount` / `employer_amount` additively over every payslip. A full-replacement correction payslip added the recomputed amount on top of the parent's posted amount, so every YTD aggregate, every statutory return, and every tax certificate over-reported by the parent value.
2. **No audit trail of the change.** Reviewing a correction in the UI showed a fresh payslip with no link back to what it was correcting and no breakdown of *what changed*. Accountants reconstructed the diff manually.

## Decision

For `run_type='correction'` with a non-null `parent_run_id`:

1. Population is fixed by ADR-0044 to `population_source='parent_run'` — the resolver returns exactly the employees who had a payslip in the parent run.
2. The engine still computes a full payslip per employee using the current rules (the same code path as a regular run).
3. Before insert, the engine subtracts the parent's posted values from the freshly computed values for every numeric column on `payslips` (gross, statutory, deductions, net, taxable, reliefs, base components) and persists only the signed delta. `payslips.retro_of_payslip_id` is set to the parent payslip.
4. `payslip_lines` are collapsed by `(rule_code, category)` and emitted as signed deltas against the parent's lines. Lines present only in the parent become reversals (negative); lines present only in the new computation are full additions; lines present in both are net deltas. Zero deltas are dropped.
5. Employees whose every numeric field nets to zero (within ½ cent) are dropped entirely from the run and surfaced as a `RUN_NO_CORRECTION_DELTA` info issue — a correction with no changes never produces an empty payslip.

## Why deltas, not "void parent + repost"

- The parent run is already posted to GL, may already be paid out, and may already be referenced by a statutory return. Voiding it requires reversing a JE that downstream systems have consumed. Deltas leave the parent untouched and apply the correction additively at every consumer (YTD trigger, GL posting, statutory returns).
- Auditors can read the delta payslip as-is — it says "this run added $X to gross and $Y to PAYE relative to run #N."
- The signed YTD trigger (`trg_payslip_lines_ytd` with `p_sign=1` on INSERT, summing signed amounts) gives correct totals for free.

## Trade-offs accepted

- `payroll_employee_ytd.payslip_count` increments by one per correction run; it now means "number of payslip *rows*", not "number of pay periods". The few reports that use it are informational.
- Garnishment cumulative `total_paid` and reimbursement stamping on `expenses` are not auto-adjusted on a correction run yet. The engine emits the delta payslip but skips the additive bumps that the regular path does; an operator must reconcile manually until Phase 3.4-followup ships the delta-aware garnishment / reimbursement adjusters.
- A correction cannot itself be corrected via this path (would require chaining deltas). Out of scope; rare in practice.

## Architecture invariants enforced by tests

- `compute-payroll/index.ts` must reference `retro_of_payslip_id` in the correction branch and must read parent payslips/lines from `parent_run_id` before insert. Tested by `src/test/architecture/payroll-correction-delta.test.ts`.
- `RUN_NO_CORRECTION_DELTA` issue code is the canonical "nothing changed" marker — UI filters reference it by string.

## Rollback

Pure code-path change. Reverting the delta block in `compute-payroll/index.ts` returns to the legacy full-replacement behaviour. No migration to undo.