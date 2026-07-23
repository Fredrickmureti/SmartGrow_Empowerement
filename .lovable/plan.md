
## Investigation summary (verified against DB + code)

I traced the full pipeline for the one existing payroll run on this tenant (payslip `266baf7d…`, May 2026) and located the architectural defect. It is **not** a template issue and **not** a data-population issue — it is a routing/aggregation bug in `annualEarningsResolver.ts` combined with an incomplete category → channel map.

### Pipeline (as currently implemented)

```text
payroll_runs → payslips → payslip_lines
                 │
                 ├── payroll_employee_ytd_rollup RPC ──► resolveCertificateYtd ──► ytdSource.rows
                 │                                                                    │
                 └── payroll_employee_monthly_breakdown RPC ──► mmRows                │
                                                                    │                 │
                              annualEarningsResolver builds:  months[]           ytd (parallel!)
                                                                    │                 │
                                          v3 certificate compiler.renderMatrix reads months[i][col.key]
                                          v3 compiler.renderSection reads ytd.*
```

Two parallel aggregation paths (`months` from monthly RPC vs `ytd` from YTD rollup) — a violation of the "monthly is projected once, YTD is its aggregate" invariant the request calls out.

### Canonical `payslip_lines.category` values in this DB
`earning`, `deduction`, `post_tax_deduction`, `statutory_employee`, `statutory_employer`, `relief` (verified). There is **no** `benefit` category emitted by `compute-payroll` today.

### Concrete defects in `annualEarningsResolver.ts`

1. **Statutory Employer monthly is always 0.**
   Line 194: `(target as any)[channel] += amt` where `amt = Number(row.employee_amount)`. For `statutory_employer` rows, `employee_amount = 0` and the real number lives in `employer_amount`. Channel `statutory_employer` must consume `employer_amount`. YTD works only because it uses `ytdSource.totals.employer` (line 238).

2. **`post_tax_deduction` category is dropped everywhere.**
   `routeCategoryToChannel` (annualEarningsTypes.ts) has no case for it → returns `null` → the 7 000 garnishment is invisible in both monthly `other_deductions` **and** `ytd.other_deductions`.

3. **Monthly `net` formula omits post-tax deductions.**
   `m.net = m.gross + m.benefits − m.statutory_employee − m.other_deductions`. With (2) fixed, adding `post_tax_deduction` to `other_deductions` makes the arithmetic reconcile with `payslips.net_pay` (94 000 − 27 327.26 − 2 000 − 7 000 = 57 672.74 ✓).

4. **Two independent YTD aggregations.**
   `ytd.gross/benefits/statutory_employee/other_deductions/reliefs/taxable` sum `ytdSource.rows` directly; `months[]` sum from a different RPC. Even after (1)–(3), any future divergence between the two RPCs re-introduces drift. YTD must be the sum of monthly (with employer contributions and taxable stored as first-class monthly fields sourced from the same rows).

5. **`taxable` and `statutory_employer` are not attributes on `months` in a way the template can bind.** They are, but populated incorrectly (see 1) and (for taxable) only via a scalar side-channel — the routing table for `statutory_employer` and the fact that we never add `employer_amount` into any monthly channel means the monthly grid can never carry employer numbers. That is the architectural gap.

6. **Benefits.** No pack currently classifies anything as `benefit` (fringe/benefit-in-kind). The column stays 0 today; that is legitimate. The fix here is architectural: the routing table already accepts `benefit`, and the seed list in `monthlyMatrix.ts` already includes it. Packs may start emitting `benefit`-category lines (BIK: housing, vehicle, employer-paid insurance) and the statement will pick them up automatically. No hardcoding.

### What needs to change

Make **`months[]` the single canonical projection**, carry both employee and employer amounts per channel, derive **YTD as the sum of months**, and complete the category routing so nothing is silently dropped.

## Changes

### 1. `supabase/functions/_shared/annualEarningsTypes.ts`
- Add `post_tax_deduction` → `other_deductions` in `routeCategoryToChannel`.
- Keep `benefit` → `benefits` (localization packs supply BIK classification; no hardcoding).
- Comment: `statutory_employer` channel is fed from `employer_amount`, all other channels from `employee_amount` (documented invariant).

### 2. `supabase/functions/_shared/annualEarningsResolver.ts`
Rewrite the monthly aggregation to be the single writer:

```text
for each row in payroll_employee_monthly_breakdown:
    channel = routeCategoryToChannel(row.category)
    if channel == "statutory_employer":
        months[m].statutory_employer += employer_amount
    elif channel:
        months[m][channel] += employee_amount
    months[m].taxable += taxable_amount          # scalar, proportionally attributed by RPC
    months[m]._employer_total += employer_amount # for YTD.employer_contributions_total

for each m:
    m.net = m.gross + m.benefits
          − m.statutory_employee
          − m.other_deductions      # now includes post_tax_deduction
```

Then compute YTD by folding `months`:

```text
ytd.<channel> = Σ months[m].<channel>          for every channel
ytd.taxable   = Σ months[m].taxable
ytd.net       = Σ months[m].net
ytd.employer_contributions_total = Σ months[m]._employer_total  (equivalent to ytdSource.totals.employer by construction)
ytd.pension_total = as today (rule_code regex over ytdSource.rows — still used only for the pension key)
```

`breakdown.*` (per-rule-code tables) still comes from `ytdSource.rows` (that's a rule-code breakdown, not an aggregate — no double path).

Keep `ytdSource` only for: provenance (`run_ids`, `payslip_ids`, high-water mark), the pension key, and `breakdown.*` grouping. Numeric totals no longer come from it.

### 3. `src/test/payroll/annual-earnings-resolver.test.ts`
Add reconciliation assertions:
- `sum(months[*].gross)                       === ytd.gross`
- `sum(months[*].taxable)                     === ytd.taxable`
- `sum(months[*].statutory_employee)          === ytd.statutory_employee`
- `sum(months[*].statutory_employer)          === ytd.employer_contributions_total`
- `sum(months[*].other_deductions)            === ytd.other_deductions`
- `sum(months[*].reliefs)                     === ytd.reliefs`
- `sum(months[*].net)                         === ytd.net`
- Fixture with `post_tax_deduction` line → asserts it lands in monthly `other_deductions` and monthly `net` matches `payslips.net_pay`.

### 4. Template
No change. `ANNUAL_EARNINGS_STATEMENT` already binds `months[i].{gross,benefits,taxable,statutory_employee,statutory_employer,other_deductions,reliefs,net}` and `ytd.*`. The compiler's `renderMatrix` reads those keys verbatim — once the resolver populates them correctly, the columns fill in.

### Explicitly out of scope
- No template edits, no PDF/HTML changes.
- No new columns, no cosmetic changes.
- No country tokens anywhere (arch test `annual-earnings-country-agnostic` continues to pass).
- Benefits column: architecture is correct; blank today because no pack emits `benefit` category. Not a defect.

## Verification plan
1. `bunx vitest run src/test/payroll/annual-earnings-resolver.test.ts src/test/architecture/annual-earnings-*.test.ts`
2. Invoke `generate-annual-earnings-statement` for the existing employee/2026 and confirm edge log shows `ytd_gross=94000`, `ytd_stat_ee=27327.26`, `ytd_er_total=7099.94`, `ytd_net=57672.74`, and every `months[m].*` reconciles.
