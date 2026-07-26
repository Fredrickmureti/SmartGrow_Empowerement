## Root cause (traced, not guessed)

`approve_payroll_run` calls `payroll_required_gl_mappings_for_run`. My prior migration (`20260726010535_...sql`) wrote a CTE:

```sql
loan_types_used AS (
  SELECT DISTINCT lt.id, lt.name, lt.gl_receivable_account_id,
         lt.interest_income_account_id,
         COALESCE(lt.interest_rate, 0) AS interest_rate   -- ❌
    FROM public.employee_loans l
    JOIN public.loan_types     lt ON lt.id = l.loan_type_id
   ...
)
```

Verified against the live schema (`information_schema.columns` for `public.loan_types`): **`loan_types` has no `interest_rate` column**. Interest lives in two different places by design:

| Concept                        | Column                             | Table            |
| ------------------------------ | ---------------------------------- | ---------------- |
| "Does this type charge interest at all?" (policy) | `requires_interest` (bool)         | `loan_types`     |
| Actual rate on an issued loan (contract)          | `interest_rate` (numeric)          | `employee_loans` |

Postgres's own hint (`Perhaps you meant "l.interest_rate"`) points straight at the mistake: I mixed the two.

## Why this is a business-event problem, not a typo

The readiness gate must answer one question per loan type in a run:

> "For this run, does the loan type require an interest-income GL account?"

That's true when **either**:

- the loan type is configured to charge interest at all (`lt.requires_interest = true`), **or**
- any actual issued loan of that type in this run has a non-zero rate (`l.interest_rate > 0`).

Using `requires_interest` alone is too eager for types that *can* charge interest but happen to have zero-rate loans in this run; using `l.interest_rate` alone misses types where interest is guaranteed by policy but the rate column is null on the loan row. The correct signal is the OR of both, aggregated per loan type.

## Fix

Rewrite `loan_types_used` in the same function (single migration, replaces the function in place):

```sql
loan_types_used AS (
  SELECT lt.id, lt.name,
         lt.gl_receivable_account_id,
         lt.interest_income_account_id,
         bool_or(
           COALESCE(l.interest_rate, 0) > 0
           OR COALESCE(lt.requires_interest, false)
         ) AS charges_interest
    FROM public.employee_loans l
    JOIN public.loan_types     lt ON lt.id = l.loan_type_id
    JOIN public.loan_repayments lr ON lr.loan_id = l.id
    JOIN public.payslips        ps ON ps.id = lr.payslip_id
    JOIN public.payroll_runs    pr ON pr.id = ps.payroll_run_id
   WHERE pr.id = p_run_id
   GROUP BY lt.id, lt.name, lt.gl_receivable_account_id, lt.interest_income_account_id
),
```

Downstream references that read `ltu.interest_rate > 0` become `ltu.charges_interest`. Nothing else in the function changes. Receivable requirement is still emitted for every loan type used; interest-income requirement is emitted only when `charges_interest`.

## Guard against regression

Add `src/test/architecture/payroll-readiness-no-nonexistent-loan-columns.test.ts` — inspects the latest migration defining `payroll_required_gl_mappings_for_run` and fails if it references `lt.interest_rate` / `loan_types.interest_rate` (any alias of `loan_types` with `.interest_rate`). Cheap, deterministic, pins the exact regression.

## Files touched

- New migration replacing `payroll_required_gl_mappings_for_run` with the corrected `loan_types_used` CTE and reference rename.
- `src/test/architecture/payroll-readiness-no-nonexistent-loan-columns.test.ts` (new).

No client, no edge function changes — the RPC signature is unchanged.

## Not doing

- No changes to `loan_types` schema (would be masking; `requires_interest` already encodes the policy).
- No changes to `approve_payroll_run` (it just surfaces the RPC's error; fixing the RPC fixes it).
- No touch to the phantom-key cleanup or the UI routing landed in the previous phase — those remain correct.
