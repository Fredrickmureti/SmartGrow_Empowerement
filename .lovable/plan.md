
## What the P9 is showing (and why)

The generated P9 for April shows:

| Col | Header | Value | Should be |
|---|---|---|---|
| L | Tax Charged | 17,692.32 | **20,092.32** |
| M | Personal Relief | 0.00 | **2,400.00** |
| N | Insurance Relief | 0.00 | 0.00 (correct — no premium) |
| O | PAYE Tax | 17,692.32 | 17,692.32 ✓ |

## Root cause (confirmed, not assumed)

Two things are true at once, and only one of them is a bug:

**1. Insurance relief is NOT automatic in Kenya.** The shipped `paye` fiscal rule (v10 pack, effective 2024‑12‑27) encodes it as `kind: rate_of_base`, `base_code: insurance_premium`, rate 15%, cap 5,000/mo — gated on the employee actually paying a qualifying premium. Personal relief IS automatic at 2,400/mo. So col N showing 0 is legitimate for this test employee (no premium input).

**2. The engine DOES apply personal relief, but never surfaces it as a payslip line.** The `paye` payslip line row I read from the DB carries in its `source` jsonb: `gross_tax: 20092.32`, `personal_relief: 2400`, `insurance_relief: 0`, `final_tax: 17692.32`. So the math is right and `payslips.paye_before_relief = 20092.32` is also stored. But there is **no** `payslip_lines` row with `rule_code = 'personal_relief'` (or `'insurance_relief'`).

The P9 template (`P9A`, currently shipped) binds those three columns to the monthly rule‑code stream:

- Col L `paye_gross` — a derived column computed as `paye_net + personal_relief + insurance_relief`.
- Col M `personal_relief` — `source_key: "personal_relief"`.
- Col N `insurance_relief` — `source_key: "insurance_relief"`.

`payroll_employee_monthly_breakdown` pivots `payslip_lines` by `rule_code`. Because no lines are emitted under those codes, both source_keys resolve to 0, which cascades into col L via the derived‑column sum. **This is an engine emission gap, not a P9 mapping bug — the P9 mapping is correct and the fiscal rule is correct.**

## Fix

Emit two additional payslip lines whenever a `bracket_progressive` rule applies reliefs, using the trace already produced in `computeBracketProgressive`:

- `rule_code: 'personal_relief'`, `rule_type: 'relief'`, `category: 'relief'`, `employee_amount: -personal_relief`, taxable=false.
- `rule_code: 'insurance_relief'`, `rule_type: 'relief'`, `category: 'relief'`, `employee_amount: -insurance_relief`, taxable=false.

Sign convention: negative so that summing `paye + personal_relief + insurance_relief` in the P9 derived column yields `paye_gross`. (The P9 `paye_gross` derived expression is `sum(paye_net, personal_relief, insurance_relief)`; storing reliefs as negatives makes that expression algebraically produce the pre‑relief figure without changing the pack.) Amounts are informational — they must NOT alter net pay (already reflected inside the `paye` line's final amount) and must NOT be added to `deductionsDetail` / statutory totals.

Guards:

- Only emit when the value is non‑zero, so we don't clutter payslips for employees with no relief entitlement.
- Guard against double‑emission when the same PAYE rule runs across multiple correction passes (keyed off `rule_code + payroll_run_id`, which is how existing lines are already de‑duplicated).
- `statutory_rule_id` set to the parent PAYE rule id (so drill‑down maps back to the same fiscal rule); `source` carries `{ input_ref: { kind: 'relief', code, parent_rule_code: 'paye' }, computed_from: 'bracket_trace' }`.

No pack change is needed — the P9 template already lists `personal_relief` and `insurance_relief` in `rule_codes[]` and expects those keys on the monthly stream.

## Also verify (as part of this change)

- Confirm the same emission covers the other pack relief kinds already handled in the reliefs pipeline (`ahr_relief`, disability exemption effects). Exemptions and `deduction_cap` reduce the taxable base upstream, not PAYE directly, so they belong elsewhere and are out of scope here — but the trace only exposes the two aggregate totals, so limiting emission to `personal_relief` + `insurance_relief` matches what's traced today.
- Backfill for existing payslips is NOT part of this change. Users regenerate the P9 after re‑running payroll; the next run emits the lines and the P9 becomes correct.

## Tests

- **Unit** (`src/test/payroll/reliefs-emit-as-lines.test.ts`): given a synthetic bracket trace with personal_relief=2400, assert two payslip_lines are pushed with rule_code `personal_relief`/`insurance_relief`, category `relief`, negative employee_amount, taxable=false, and that they do NOT enter the deductions detail total.
- **Contract** (`src/test/localization/ke-p9-relief-columns.test.ts`): given a monthly stream that includes the two relief rule_codes, assert the P9 `matrix` resolver produces col M = 2400, col N = 0, col L = paye_before_relief for the seeded month.
- **Regression pin** (`src/test/payroll/paye-net-unchanged.test.ts`): the `paye` payslip line's `employee_amount` and `payslips.net_pay` are byte‑identical before and after the change on the shipped KE fixture (reliefs are informational only).

## Files touched

- `supabase/functions/compute-payroll/index.ts` — emit the two relief lines from the PAYE bracket trace.
- `src/test/payroll/reliefs-emit-as-lines.test.ts` (new)
- `src/test/localization/ke-p9-relief-columns.test.ts` (new)
- `src/test/payroll/paye-net-unchanged.test.ts` (new)
- `docs/adr/0062-canonical-payroll-values.md` — add a "Relief surfacing" section documenting that reliefs are informational payslip_lines with negative sign, sourced from the bracket trace.

No pack version bump, no data migration, no template edit.
