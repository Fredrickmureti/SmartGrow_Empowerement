
## Root cause (investigated end-to-end)

The 422 from `generate-tax-certificate` for **Annual Earnings Statement** is not a transport / auth / RPC failure. It is a **structural refusal** from the edge function's own contract check.

Trace:

1. Client — `useTaxCertificates.ts:260` calls `generate-tax-certificate` with `template_code: "ANNUAL_EARNINGS_STATEMENT"`.
2. Edge function loads the template row from `localization_pack_certificate_templates` (`id 822e9bbd-…`, `pack_id NULL` — the generic/global fallback).
3. It runs `validateCanonicalSourceNode(...)` on every `matrix` node in `body.document`.
4. The matrix at `document[3]` has data columns `gross, benefits, deductions, tax, net` and:
   - no `matrix.rule_codes`,
   - no `columns[*].source_key`,
   - no `derived_columns`.
5. Branch at `index.ts:104-112` fires → `businessError(422, "TEMPLATE_STRUCTURAL_INVALID", reason_code: MATRIX_NO_RULE_CODES)`.

This is exactly the latent bug **ADR-0061** warned about:

> "The same mis-binding pattern exists latently on other certificates rewritten in the same migration (Ghana `GH_PAYE_EMPLOYEE_ANNUAL`, the generic `ANNUAL_EARNINGS_STATEMENT`) and can recur on any future pack."

The template body currently in the DB (migration `20260713001927_…`) declares columns but never tells the matrix engine which `payslip_lines` rule codes/categories to pivot. The engine correctly refuses rather than silently emitting zeros. The refusal is right; the template is wrong.

## Why "just bind rule_codes" is not enough

`ANNUAL_EARNINGS_STATEMENT` has `pack_id IS NULL` — it is the **country-neutral generic** certificate. Real rule codes are country-specific (`paye`, `shif`, `nssf`, `housing_levy`, `nita`…). Hardcoding Kenya codes here would break Ghana, Rwanda, etc.

`monthlyMatrix.ts` today only pivots by `rule_code`. `payroll_employee_monthly_breakdown` already returns `category` per row (`earning`, `deduction`, `statutory_employee`, `statutory_employer`, `relief`), but the pivot ignores it. So today there is **no country-neutral way** to express "sum all earnings" or "sum all statutory deductions" in a matrix.

## Fix — two coordinated changes

### 1. Engine: add category aggregation to `monthlyMatrix` (small, additive)

`supabase/functions/_shared/monthlyMatrix.ts`:

- Extend `pivotToMonthlyMatrix` to additionally accumulate per-category totals into synthetic column keys of the form `cat:<category>` on each monthly row (`cat:earning`, `cat:deduction`, `cat:statutory_employee`, `cat:statutory_employer`, `cat:relief`).
- `applyDerivedColumns` already resolves any string arg via `row[key]`, so `derived_columns` expressions can reference `cat:earning` etc. with zero further changes.
- `collectMatrixRuleCodes` and the validator: treat any `cat:*` token that appears as a `derived_columns` arg as "resolved" (add to the accepted-symbols set in `certificateMatrix.ts::collectDerivedArgOffences` and mirror the same in `generate-tax-certificate/index.ts::validateCanonicalSourceNode` — the validator already recognises "raw rule_code" and "derived key"; we add "category token").
- Mirror the browser-side lint (`src/features/localization/lib/engine/*` if it duplicates the check) so the editor stays in parity.

This is intentionally a small, orthogonal extension — it does not change existing pack behaviour. Any pack that does not use `cat:*` tokens is unaffected.

### 2. Republish `ANNUAL_EARNINGS_STATEMENT` body

New migration (data-only `UPDATE` on `localization_pack_certificate_templates` where `code='ANNUAL_EARNINGS_STATEMENT' AND pack_id IS NULL`) that rewrites `body.document[3]` (the matrix) with:

- `"rule_codes": []` (explicit empty — signals "no raw rule_code columns, all data via derived").
- `"derived_columns"`:
  - `gross` → `sum(cat:earning)` (amount_field `employee_amount`)
  - `benefits` → `sum(cat:earning)` minus a `basic` fallback, or simply `sum(cat:earning)` if the pack does not distinguish (decision below)
  - `deductions` → `sum(cat:statutory_employee, cat:deduction)`
  - `tax` → `sum(cat:statutory_employee)` filtered to income-tax rule codes is NOT possible generically; instead we bind `tax` via a **new** matrix-level directive `"tax_source": "cat:tax"` or drop the `tax` column from the generic template and keep it in country-specific packs. The plan chooses to **drop `tax` from the generic template** and leave tax reporting to the country-specific certificates (P9A, GH_PAYE_EMPLOYEE_ANNUAL). Rationale: "income tax" is not a country-neutral concept and cannot be safely aggregated without a pack-authored classifier.
  - `net` → `sub(gross, deductions)`
- `columns[]` correspondingly: `month`, `gross`, `benefits`, `deductions`, `net` — each data column keyed to a derived key (so the "column has no source_key AND not in derived_columns" branch is satisfied).
- `footer.sum_columns` updated to match.

The YTD summary section stays as-is (it already reads pre-aggregated `totals.gross_pay` / `totals.deductions` / `totals.net_pay` from the payload, not from the matrix).

Open question for you before the migration is written — **do we drop the Income Tax column entirely from the generic template, or do we introduce a `cat:tax` category by reclassifying `paye`/`income_tax` rule codes across packs?** The former is a 1-line drop; the latter is a wider pack-side change.

### 3. Guard tests

- Extend `src/test/architecture/statutory-templates-must-bind-canonical-sources.test.ts` to accept `cat:*` tokens as valid canonical bindings.
- Add a new architecture test: `ANNUAL_EARNINGS_STATEMENT` body must have `derived_columns.length > 0` (regression pin against the exact bug we just found).
- Add a Deno test alongside `monthlyMatrix_test.ts` covering the new `cat:*` synthetic keys.

## Files touched

```text
supabase/functions/_shared/monthlyMatrix.ts          (engine — add cat:* keys)
supabase/functions/_shared/certificateMatrix.ts      (validator — accept cat:*)
supabase/functions/generate-tax-certificate/index.ts (mirror validator change)
supabase/migrations/<new>_republish_annual_earnings.sql (data-only body update)
src/test/architecture/statutory-templates-must-bind-canonical-sources.test.ts
src/test/architecture/<new>-annual-earnings-canonical-binding.test.ts
supabase/functions/_shared/monthlyMatrix_test.ts
```

No client-side / hook / renderer changes are required — the resolver, matrix engine, and PDF pipeline already handle derived columns; we're only widening what a derived arg can reference.

## Out of scope

- Kenya P9A (already fixed in pack 10.1.6).
- Ghana `GH_PAYE_EMPLOYEE_ANNUAL` (same latent bug per ADR-0061 — a separate follow-up; call out but do not fix here unless you approve).
- Any change to `compute-payroll`, `payslip_lines`, `payroll_employee_ytd_rollup`, or the certificate PDF renderer.
