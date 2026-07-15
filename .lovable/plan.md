
## What the 422 actually is right now

I re-verified the live DB and engine state:

- `ANNUAL_EARNINGS_STATEMENT` (pack_id NULL, generic) — body **has** been republished with `derived_columns` (gross/benefits/deductions/net via `cat:*` tokens). The validator in `generate-tax-certificate/index.ts` (lines 91–152) now passes for this body. The generic template is structurally OK.
- `GH_PAYE_EMPLOYEE_ANNUAL` (Ghana pack `8de30937…`, version **1.0.0**) — body still ships columns `basic / allowances / gross / ssnit / tier2 / reliefs / chargeable / paye` with **no `rule_codes`, no `source_key`, no `derived_columns`**. This is the *same* mis-binding class ADR-0061 flagged; any tenant on the Ghana pack that requests this certificate will still 422 with `MATRIX_NO_RULE_CODES`.
- `P9A` (KE pack 10.1.6) — bound correctly, generates fine.
- `CERT_OF_SERVICE` — not a matrix; unrelated to this class of bug.

So the "still failing" 422 the user is seeing is one (or both) of:
1. The Ghana annual PAYE certificate being requested (unbound).
2. A stale response before the edge function picked up the latest engine changes (already redeployed at 11:32Z per logs).

The generic template's own body is now valid, but three things are still weak:
- **`cat:benefit` is not a real payroll category** — the enum is `earning / deduction / statutory_employee / statutory_employer / relief / tax` (verified against `pivotToMonthlyMatrix`'s SEED_CATEGORIES set). `benefits` column silently sums nothing.
- **Income tax has no country-neutral binding** — the `tax` column was dropped from the generic template; we should introduce `cat:tax` as a first-class category and rebind, so the generic statement is useful (not just gross/net).
- **Ghana template is broken and has no pack version bump** to force tenants to upgrade.

## Plan

### 1. Engine — extend category enum with `tax` and de-dup

`supabase/functions/_shared/monthlyMatrix.ts`
- Extend `SEED_CATEGORIES` (and the aggregation loop) with `"tax"` so `cat:tax` becomes an addressable synthetic column. Every `payslip_lines` row with `category = 'tax'` accumulates here.
- Verify (already true) that `cat:*` keys are additive, not overwritten, per month.

No other engine changes needed — `cat:*` resolution, validator acceptance, and RPC "all rows" fetch path are already in place.

### 2. Generic template — hardened rework (no pack, ships via migration)

Republish `ANNUAL_EARNINGS_STATEMENT` (pack_id NULL) with a **cleaner, wider** column set:

| Column         | Binding                                                          |
|----------------|------------------------------------------------------------------|
| `month`        | month axis                                                       |
| `gross`        | `sum(cat:earning)`                                               |
| `benefits`     | *removed* — was `cat:benefit` (invalid category); merged into `gross` |
| `statutory`    | `sum(cat:statutory_employee)`                                    |
| `other_ded`    | `sum(cat:deduction)`                                             |
| `tax`          | `sum(cat:tax)` — reinstated via new `cat:tax` category           |
| `net`          | `sub(gross, statutory, other_ded, tax)`                          |

Also:
- Keep `rule_codes: []` sentinel + `amount_field: "employee_amount"`.
- Footer `sum_columns` updated to `[gross, statutory, other_ded, tax, net]`.
- YTD Summary section rebound to sum the same derived keys (so summary and matrix agree by construction).

### 3. Ghana PAYE annual certificate — republish + bump pack

Republish `GH_PAYE_EMPLOYEE_ANNUAL` body's matrix with proper bindings:
- `basic` → `source_key: "basic_salary"` (canonical rule code)
- `allowances` → `sum(cat:earning) - basic` via derived `sub(cat:earning, basic)`
- `gross` → `sum(cat:earning)`
- `ssnit` → `source_key: "ssnit_tier1"` (whatever the Ghana pack rule code is — verified against pack seed rules)
- `tier2` → `source_key: "ssnit_tier2"` (or `provident_fund` per Ghana pack)
- `reliefs` → `sum(cat:relief)`
- `chargeable` → `sub(gross, ssnit, tier2, reliefs)`
- `paye` → `sum(cat:tax)`

Bump Ghana pack `version` from `1.0.0` → **`1.1.0`** and emit a `pack_upgrade_proposal` row so tenants see an upgrade prompt.

### 4. Pack upgrade surface

For every affected tenant on the Ghana pack, insert a row into `pack_upgrade_proposals` (proposed_version `1.1.0`, reason: "Fixes Annual PAYE certificate rendering"). This is the mechanism the user meant by "I will upgrade".

Generic template has no pack, so it upgrades in place — no proposal needed. Note that in the release notes.

### 5. Regression tests

- Update `src/test/architecture/annual-earnings-canonical-binding.test.ts` to reflect the new column set and to assert `cat:tax` appears in derived args.
- Add sibling test `ghana-paye-annual-canonical-binding.test.ts` mirroring the same shape for `GH_PAYE_EMPLOYEE_ANNUAL`.
- Extend `monthlyMatrix_test.ts` with a case that verifies rows with `category = 'tax'` accumulate into `cat:tax`.
- The existing `matrix-derived-columns-must-resolve.test.ts` and `statutory-templates-must-bind-canonical-sources.test.ts` will now guard both templates automatically.

### 6. What is NOT changing

- No changes to `compute-payroll`, `payslip_lines`, `payroll_employee_ytd`, RPCs, resolver, PDF renderer, or the KE 10.1.6 pack.
- No hardcoded country-specific logic added to the platform.
- No changes to the client hook `useTaxCertificates.ts`.

## Files touched

```text
supabase/functions/_shared/monthlyMatrix.ts             (+ cat:tax seeding)
supabase/functions/_shared/monthlyMatrix_test.ts        (test)
supabase/migrations/<new>_republish_annual_earnings_v2.sql
supabase/migrations/<new>_republish_ghana_paye_annual_and_bump.sql
src/test/architecture/annual-earnings-canonical-binding.test.ts   (updated)
src/test/architecture/ghana-paye-annual-canonical-binding.test.ts (new)
```

## Open question before I implement

The **`tax` category doesn't yet exist as a canonical `payslip_lines.category` enum** in your rule-type catalog. Two options:

- **(A) Reclassify `paye`/`income_tax` rules to `category = 'tax'`** across packs (KE, GH) in the same migration. Cleanest, but touches pack rule sets. `cat:tax` then works everywhere.
- **(B) Keep the tax column out of the generic template** and only bind it inside country packs via explicit `source_key` (e.g. Ghana `source_key: "paye"`). Generic template shows gross / statutory / other_ded / net only.

I recommend **(B)** — it keeps this change surgical and country-neutral, and Ghana + KE already own their own annual certificates where `paye` is bound explicitly. If you prefer (A) say so and I'll add the reclassification to the migration.
