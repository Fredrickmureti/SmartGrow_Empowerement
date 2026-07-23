## Diagnosis (verified against code + database)

Enterprise ownership is already correct in this codebase:

- **Annual Earnings Statement** is a payroll-engine report. Its single writer is `supabase/functions/_shared/annualEarningsResolver.ts` and its versioned contract is `AnnualEarningsStatementDTO v1` (`annualEarningsTypes.ts`). Dispatcher `generate-annual-earnings-statement` is thin.
- **Country certificates (P9/P60/IRP5/...)** are localization-pack extension bodies spliced into the base template via `payroll_certificate_template_extensions` (ADR-0091). They do not fork the engine.
- **Statutory returns** (`generate-statutory-return`) and **tax certificates** (`generate-tax-certificate`) both go through `resolveCertificateYtd` — the canonical YTD reader — enforced by ESLint (`no-payslip-lines-in-certificates`) and the arch tests.

So the ownership model does not need to be re-drawn. What is actually broken is the resolver's read of canonical payroll data, plus a duplicate aggregation path that produced the empty YTD Summary and made the base DTO non-single-source. Fix at the root, not the template.

### Root causes

1. **Empty YTD Summary and empty matrix.** `resolveAnnualEarnings` reads `row.month` from RPC `payroll_employee_monthly_breakdown`, but the RPC returns `month_index` (confirmed via `pg_get_functiondef`). Every row is dropped (`mIdx = 0 → continue`), so `months[]` stays zero-filled. `ytd` is then derived by summing those zero months → the entire Year-to-Date Summary renders as 0.

2. **Duplicate YTD aggregation.** Even after (1) is fixed, YTD totals are computed twice: once by summing months in the resolver, once by `resolveCertificateYtd` from the canonical `payroll_employee_ytd` view. That violates single-writer: the same figure has two derivations that will drift (taxable is the obvious one — `category='taxable'` does not exist in payslip_lines; only `taxable_amount` per row does, so summing months gives 0 while the rollup has real values).

3. **`taxable` channel is dead code.** `routeCategoryToChannel('taxable')` never fires — production categories are `earning|benefit|statutory_employee|statutory_employer|deduction|relief`. `ytd.taxable` must come from summing `taxable_amount` on the rollup, not from a non-existent category.

4. **Identity placeholders render `—` instead of being either authoritative or intentionally omitted.** Employer legal_name/address/contact and employee employment_period fall through to `fallback: "—"` in the template even when the underlying config is genuinely missing. Enterprise reports should show authoritative data or omit the row, not decorate it with an em-dash.

5. **`content_hash_short` in the page footer has `fallback: "—"`.** The resolver always writes it, so the fallback is misleading — remove it so a missing hash is a bug, not a designed state.

## Fix — payroll-engine layer only

### A. `supabase/functions/_shared/annualEarningsResolver.ts`
- Read `row.month_index` (with `row.month` as a legacy alias for safety).
- Make `ytdSource` the single source for every YTD total. Compute:
  - `gross`, `benefits`, `statutory_employee`, `statutory_employer`, `other_deductions`, `reliefs`, `adjustments`, `reversals`, `leave_payouts`, `bonuses` — by summing `employee_amount` grouped by `routeCategoryToChannel(row.category)` over `ytdSource.rows`.
  - `taxable` — by summing `taxable_amount` over all rows (only real source; no category).
  - `net = gross + benefits − statutory_employee − other_deductions` (matches per-payslip net convention already used).
  - `employer_contributions_total = ytdSource.totals.employer`.
  - `pension_total` — keep the existing rule_code-token heuristic (country-neutral, packs opt in via naming).
- Monthly rows: still built from `payroll_employee_monthly_breakdown`, but each month's `taxable` comes from `taxable_amount` per row (not category routing). Monthly `net` uses the same formula.
- Remove the "sum months → YTD" loop; `ytd` is derived only from the canonical rollup. Months and YTD then agree by construction (both read the same underlying `payslip_lines` through the two SECURITY DEFINER views).

### B. `supabase/functions/_shared/annualEarningsTypes.ts`
- Drop the dead `case "taxable"` branch from `routeCategoryToChannel` and add a comment naming `taxable_amount` as the sole source of the taxable channel.

### C. Base template row `ANNUAL_EARNINGS_STATEMENT` (migration)
- Remove `fallback: "—"` on `employer.legal_name`, `employer.registered_address`, `employer.contact`, `employee.department`, `employee.position`, `employee.employment_period.label`, `provenance.content_hash_short`. The compiler already elides `key_value` rows whose binding resolves to `null`/empty, so missing config becomes an omitted row instead of a decorative em-dash. `content_hash_short` is always populated by the resolver — a missing value is now a visible bug (correct signal).
- Keep every other node identical — no cosmetic changes.

### D. Regression tests
- `supabase/tests/annual_earnings_resolver_test.ts` (new Deno test): seed a minimal payslip set and assert `dto.ytd.gross > 0` and `dto.ytd.gross === Σ dto.months[i].gross` — i.e. the two projections agree by construction, and the RPC-column-name bug cannot come back silently.
- Extend `src/__tests__/architecture.annual-earnings-country-agnostic.test.ts` list with any file touched (no new files added outside the guard).

### E. Provenance already satisfies determinism
- `content_hash` strips `generated_at` and `serial_number` and canonical-sorts keys. No change needed. The test in (D) also asserts hash stability across two resolves with the same inputs.

## Out of scope (intentionally)

- No changes to `generate-tax-certificate`, statutory-return generation, localization-pack contract, ESLint rules, or the certificate compiler. Those layers are already architecturally correct.
- No new UI or template polish beyond removing misleading em-dash fallbacks.
- No changes to `payroll_employee_ytd_rollup` / `payroll_employee_monthly_breakdown` SQL — the resolver aligns with them, not the reverse.

## Files touched

```text
supabase/functions/_shared/annualEarningsResolver.ts
supabase/functions/_shared/annualEarningsTypes.ts
supabase/migrations/<new>_annual_earnings_template_no_placeholders.sql
supabase/tests/annual_earnings_resolver_test.ts   (new)
src/__tests__/architecture.annual-earnings-country-agnostic.test.ts   (guard list)
```

## Verification

- Unit: run the new resolver test.
- Manual: invoke `generate-annual-earnings-statement` for an employee with approved payroll history; confirm matrix months are non-zero, YTD Summary matches the sum of months, footer shows a real 12-char content hash, and re-invoking yields the same `content_hash`.
