# Variable Inputs — why it's empty, and how to make it usable

## What's actually going on (verified)

The "Variable Inputs" grid on the payroll-create form is **not broken and not locked** — it is deliberately data-driven. It renders one column per row in the `payroll_input_types` table (`src/hooks/payroll/useVariableInputTypes.ts`), scoped to your organization/business. Verified facts:

- `payroll_input_types` currently contains **zero rows** — not just for your org, the whole table is empty.
- Nothing seeds it. Grepping the edge functions shows **no code path anywhere** (including the `localization-pack` installer) that inserts `payroll_input_types` rows.
- There is **no admin screen** to create them. `payroll_input_types` appears in exactly one UI file: the read-only hook behind that grid.
- The table's RLS/grants already allow org admins to insert/update/delete (migration `20260629193747`).
- The registry also gates other features: `post_warehouse_incentive_pay` raises `Payroll input code % is not configured for this business` when the code is missing.

So the design (Odoo `hr.payslip.input.type` / SAP wage-type permissibility / Workday pay-component inputs — all registry-driven, none ship hardcoded columns) is correct and standard. What's missing is the **authoring surface plus a starter set**: right now the message tells you to seed a table you have no way to seed without SQL. That's the gap.

## What to build

### 1. Variable Input Types configuration page
New route `/hr/payroll/configuration/input-types` (gated by `managePayroll`, alongside Work Entry Types and Loan Types), listed on the Configuration hub. Full CRUD over `payroll_input_types` for the current org/business:

- Columns: sequence, code, name, unit (`amount` / `hours` / `days` / `count`), default, min, max, required, structures, active.
- Create/edit form with validation: code is lowercase snake_case, unique per scope; min ≤ default ≤ max; unit required.
- Scope selector: org-wide row vs business-specific override (matching the precedence the hook already implements).
- Structure restriction: multi-select of salary structures; empty = all structures.
- Soft delete via `is_active` toggle so historical runs keep their meaning; hard delete only when the code was never used.

### 2. Starter set ("Add standard inputs")
A one-click action on the empty page that inserts the country-agnostic slots the payroll engine already understands, so the grid becomes usable immediately:

| code | name | unit |
| --- | --- | --- |
| `overtime_amount` | Overtime | amount |
| `overtime_hours` | Overtime hours | hours |
| `bonus_amount` | Bonus | amount |
| `commission_amount` | Commission | amount |
| `arrears_amount` | Arrears / back pay | amount |

These codes match the variable-earning keys `compute-payroll` reads via `ctx.inputs` (per ADR 0010 Gap #2), so amounts typed in the grid flow into the run and get taxed by the normal PAYE path. Rows are inserted inactive-safe (review before use) and fully editable afterwards.

### 3. Fix the dead-end empty state
`VariableEarningsInput.tsx`'s notice currently names a database table at the end user. Replace the copy with a plain-language explanation and a direct link/button to the new configuration page (shown only to users with `managePayroll`).

## Professional verdict

Nothing is locked or license-gated. The behaviour is the right architecture with one missing piece — a self-service editor and sensible defaults. Once step 1 and 2 land, typing overtime/bonus/commission per employee on a payroll run works as you'd expect from ADP/Workday.

## Technical notes

- Table: `public.payroll_input_types` (org+business scoped, unique on `(organization_id, code)` and `(organization_id, business_id, code)`).
- Reuse the existing read hook; add a mutation hook `useVariableInputTypeMutations` with `react-query` invalidation of the `payroll-input-types` key.
- Page follows the pattern of `src/pages/hr/payroll/LoanTypesSettings.tsx`; route added in `src/apps/hr/sub/PayrollRoutes.tsx` and to the Configuration hub in `src/pages/hr/payroll/sections.tsx`.
- No database migration required — table, grants, and RLS already exist.
