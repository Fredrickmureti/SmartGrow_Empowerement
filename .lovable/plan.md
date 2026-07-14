
# Voluntary NSSF — Teaching Run

Goal: show, on your real tenant, exactly where "voluntary NSSF" lives in the payroll architecture, why it does *not* belong in `salary_structures`, and watch every downstream system (payslip line → NSSF return → GL) light up in response to a single tenant-level action.

## Part 1 — How salary structures work (mental model)

Think of a salary structure as a **recipe** attached to an employment contract.

```text
salary_structures            ← the recipe header (Kenya Standard 2026)
   └── payroll_salary_rules  ← ordered ingredients (basic, house, paye, nssf_tier1…)
         └── each rule has: code, category, condition, amount formula, optional pack binding
salary_structure_rule_sets   ← frozen JSON snapshot published for each version
```

At payroll time, the engine reads the **snapshot** (not the live rules), walks it in `sequence` order, evaluates each rule's condition, computes its amount, and emits a **payslip line tagged by `code`**. Return templates (NSSF_RET, P10, P9A) then pull those codes back via `sum_rule.<code>.employee` bindings. The snapshot model is why mid-month edits can't rewrite last week's payslip.

**Two amount modes matter:**
- Engine-computed via a **pack rule** (`statutory_rule_id` set) → PAYE, SHIF, NSSF Tier 1 & 2. The structure just *declares the line exists*; the localization pack owns the math.
- Structure-computed → fixed, %-of-base, or expression. Used for earnings and non-statutory deductions.

## Part 2 — Why voluntary NSSF is NOT a salary-structure rule

Voluntary NSSF (Type-105) in Kenya is:
- **Opt-in per employee** (requires a signed check-off form filed with NSSF).
- **Variable per employee** (KES 2,000 for one, 15,000 for another).
- **Time-bounded** (employees can stop it; NSSF acknowledges the termination).
- **Not part of the employment contract's compensation recipe.**

Odoo models this exact category with `hr.contract.salary.attachment` / *Other Input* lines, **not** as a salary rule on every contract. SAP calls them "recurring payments/deductions (IT0014)". The universal pattern: statutory-adjacent, employee-specific, recurring deductions live in an **enrollment table**, and the payroll engine picks them up as inputs — they don't pollute the salary structure.

Our equivalent is already built:

```text
custom_deduction_types            ← tenant catalog (e.g. "NSSF Voluntary")
   payroll_rule_code = 'nssf_voluntary'   ← binds to Kenya pack's declared rule code
employee_custom_deductions        ← per-employee enrollment (amount, start, end)
```

The engine (`compute-payroll/index.ts`) now emits payslip lines with `rule_code = nssf_voluntary` when a type has that binding set — which is exactly what the NSSF return VOLUNTARY column reads.

Bottom line: **salary structures = the contract's compensation recipe. Voluntary NSSF = an employee-level statutory attachment.** Wrong home would either force every Kenyan employee to carry a zero line or duplicate opt-in logic across contracts.

## Part 3 — What we'll do and observe

One tenant: **Joshua Holdings** (`bf392ca6-a743-435c-ae41-5bf25199470d`).

1. **Read** the current Kenya payroll setup on this business: active salary structure(s), which employees are on them, and whether any `custom_deduction_types` with `payroll_rule_code = 'nssf_voluntary'` already exists.
2. **Seed the tenant catalog** — insert (if missing) one `custom_deduction_types` row:
   - `code = 'nssf_voluntary'`, `name = 'NSSF Voluntary (Type 105)'`
   - `payroll_rule_code = 'nssf_voluntary'` (this is the binding to the Kenya pack)
   - GL role: `tier3_payable` via the pack's account mapping
   - `deduction_type = 'fixed'`, taxable = false, pre-tax = false
3. **Enroll one employee** — pick the first active Kenyan employee, insert an `employee_custom_deductions` row for KES 2,000/month, starting the current payroll period.
4. **Run a payroll period** for that employee (dry compute via the existing `compute-payroll` edge function) and read back:
   - The payslip line with `rule_code = 'nssf_voluntary'` and `amount = 2000` under deductions.
   - The NSSF return preview (`localization_pack_return_templates` → NSSF_RET) — the VOLUNTARY column now sums to 2000 for this employee.
   - The journal entry preview — DR net-pay clearing / CR `tier3_payable` for 2000 (routed via the `custom_deduction_types.gl_account_role` binding).
5. **Toggle behaviour** — set the employee's enrollment `end_date` to a past date and re-run: line disappears, VOLUNTARY column zeroes, GL entry drops. This proves the enrollment table (not the structure) is the single control point.
6. **Contrast probe (read-only)** — dump the active salary structure's rules and show that adding a `nssf_voluntary` rule there would either (a) require a per-employee override table anyway to hold the amount, or (b) force a zero line on every non-participant. Same conclusion Odoo reached.

All results captured as annotated SQL / edge-function outputs in a short report so you can see the cause → effect chain.

## Part 4 — Technical notes

- No schema changes. The wiring from the previous migration (`custom_deduction_types.payroll_rule_code`, pack token registry entry, engine `emittedCode` derivation) is what makes this experiment possible without touching the engine again.
- No pack changes. The Kenya pack already declares the `nssf_voluntary` rule code and its NSSF_RET binding; the advisory template row documents the recommended shape.
- No structure changes. The Kenya salary structure stays clean — no voluntary NSSF rule added, matching Odoo/SAP conventions.
- If Joshua Holdings has no active Kenyan employee, we stop at step 1 and report; we won't fabricate employees.
- The payroll run in step 4 uses the existing `compute-payroll` edge function in dry-run mode — no period is finalised, no GL is actually posted.

## Deliverable

A short walkthrough document with SQL snapshots at each step showing:
- Before: no voluntary NSSF anywhere.
- After enrollment: payslip line + NSSF return VOLUNTARY column + GL preview all showing 2,000.
- After termination: all three revert to zero.
- Salary structure JSON unchanged throughout — proof the recipe is untouched.
