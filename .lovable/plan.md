# Payroll canonical-values architecture investigation — findings & fix plan

## 1. Architecture trace (end-to-end)

```text
Salary structure / contract
        │
        ▼
compute-payroll (edge fn)         ← engine, SINGLE SOURCE OF TRUTH
        │  computes independently:
        │    gross_pay          = basic + housing + transport + other + reimbursements
        │    taxable_income     = gross − pre-tax (NSSF+SHIF+AHL when flagged)
        │    taxable_base       (mirror of taxable_income)
        │    per-rule employee_amount / employer_amount → payslip_lines
        ▼
public.payslips  (columns: gross_pay, taxable_income, taxable_base, net_pay, …)
public.payslip_lines  (per rule_code amounts)
        │
        ├──► post-payroll-gl        reads gross_pay ✔ correct
        ├──► generate-payslip-pdf   reads gross_pay ✔ correct
        ├──► payrollData / register reads gross_pay ✔ correct
        ├──► certificate-engine     path-bindings for P9 etc. ✔ correct
        │
        └──► generate-statutory-return
                 │
                 uses returnSourceResolver.ts
                 sources: sum_taxable_amount → sums payslips.taxable_income (fallback gross_pay)
                          sum_basic_pay, sum_allowances, sum_employee_amount, sum_employer_amount, sum_rule.*
                          (NO sum_gross_amount source exists today)
                 │
                 reads `body.columns[].source` from
                 public.localization_pack_return_templates (SEED DATA)
                 │
                 ▼
        CSV / PDF return  ← the mislabeled value surfaces here
```

## 2. Where the defect lives — proven

**Not** the engine, **not** the schema, **not** the resolver logic. The engine correctly persists `gross_pay = 94,000` and `taxable_income = 84,365.06` as two distinct columns.

The defect is a **seed-data / template-binding mistake** in
`supabase/migrations/20260620001436_406718e2-4677-4bf2-93a2-fbdf733b4bf1.sql`,
which inserts six KE return templates whose "Gross Pay" columns are bound to `source: 'sum_taxable_amount'`:

| Template | Column key | Column label | Wrong source |
|---|---|---|---|
| P10       | `gross_pay`     | Gross Pay        | sum_taxable_amount |
| P10A      | `gross_pay`     | Gross Pay        | sum_taxable_amount |
| P10D      | `gross_pay_ytd` | Annual Gross Pay | sum_taxable_amount |
| **NSSF_RET** | `gross_pay`  | Pensionable Pay  | sum_taxable_amount |
| SHIF_RET  | `gross_pay`     | Gross Pay        | sum_taxable_amount |
| AHL_RET   | `gross_pay`     | Gross Pay        | sum_taxable_amount |

The resolver source `sum_taxable_amount` explicitly documents "sum of payslips.taxable_income" — its name is honest; the template is what lies. There is **no** `sum_gross_amount` source in `_shared/returnSourceResolver.ts` today, so even fixing the binding requires adding one (basic+allowances is not full gross — it excludes overtime/bonus/commission/reimbursements).

Additionally, "Pensionable Pay" on the NSSF return is not the same concept as gross either — NSSF Act defines pensionable earnings as capped gross (Tier I / Tier II bands). The current design has no persisted `pensionable_earnings` column; NSSF/SHIF/AHL each compute off `params.base` inside the engine but the base used is not stored. For NSSF specifically, "Pensionable Pay" per the NSSF by-product spec = min(gross, upper limit) — currently unmodelled.

## 3. Blast radius

- All six KE statutory returns above misreport gross columns as taxable.
- P9 tax certificate and GL postings are unaffected (they read `payslips.gross_pay` directly through separate code paths).
- Payroll register, analytics, PDF payslip: unaffected.
- Future country packs would be able to make the same mistake — the resolver offers `sum_taxable_amount` but no `sum_gross_amount`, encouraging misuse.

## 4. Ownership of the fix (correct architectural layer)

1. **Resolver (platform)** — add a first-class `sum_gross_amount` source that returns `sum(payslips.gross_pay)`. Symmetric to existing `sum_taxable_amount`.
2. **Resolver (platform)** — add a `sum_pensionable_amount` source. Implementation reads a new engine-persisted `pensionable_pay` (see step 3) and falls back to `LEAST(gross_pay, cap)` only if the localization pack declares a cap parameter — but no country-specific logic in the resolver. If we choose to defer engine persistence, ship `sum_gross_amount` now and treat pensionable = gross for the NSSF template until step 3 lands (documented caveat, matches current NSSF Byproduct where the cap is applied per contribution, not per pay line).
3. **Engine (platform, follow-up)** — persist the *base* used for each statutory contribution alongside the amount, e.g. `payslip_lines.contribution_base numeric`, populated when compute-payroll writes NSSF/SHIF/AHL/pension lines. Adds `sum_rule_base.<rule_code>` resolver source. This closes the "pensionable earnings" modelling gap without any Kenya-specific code.
4. **Kenya pack (data-only migration)** — rebind the six templates above to the correct new sources: `gross_pay` columns → `sum_gross_amount`; NSSF "Pensionable Pay" → `sum_rule_base.nssf` once step 3 lands, otherwise `sum_gross_amount` with a documented caveat.
5. **Guard tests** — add an architecture test that flags any `localization_pack_return_templates` column whose `key` contains `gross` but whose `source` is `sum_taxable_amount`, and vice versa (a `taxable_*` key bound to `sum_gross_amount`). Add an ADR "canonical payroll values contract" listing the field semantics and the resolver→column naming discipline.

## 5. Implementation steps (in order, no code yet)

1. Add ADR `docs/adr/00XX-canonical-payroll-values.md` defining: gross_pay, taxable_income, chargeable_income (already in monthlyMatrix), pensionable_earnings, contribution_base, and the rule: **return templates MUST NOT compute; they consume named resolver sources whose names match their semantics**.
2. Extend `supabase/functions/_shared/returnSourceResolver.ts`:
   - New source `sum_gross_amount` → `round2(sum(gross_pay))`.
   - New source `sum_net_pay` (parity, tiny) — optional.
   - Extend `ctx.sums` accumulator in `generate-statutory-return/index.ts` to include `gross`.
   - Mirror the addition in the browser copy if one exists (verify parity file).
3. Migration: `UPDATE public.localization_pack_return_templates SET body = jsonb_set(...)` re-binding the six KE templates' `gross_pay`/`gross_pay_ytd` columns to `sum_gross_amount`. Leave `totals` in sync. Idempotent WHERE guards on the current wrong source value.
4. Regression test (vitest):
   - Fixture payslip: gross 94,000, taxable 84,365.06.
   - Assert NSSF_RET column labeled "Pensionable Pay" now emits 94,000 (or the capped value once step 6 lands), and PAYE-base columns still emit 84,365.06.
5. Architecture guard test (vitest or SQL): scan seed templates for `key ~* 'gross'` bound to `sum_taxable_amount` → fail. Symmetric check for taxable/pensionable mislabelling.
6. Follow-up (separate PR, not in this fix): engine writes `contribution_base` on statutory `payslip_lines`; add `sum_rule_base.<code>` resolver source; rebind NSSF Pensionable Pay to that. This is the proper long-term modelling of pensionable earnings and lets any country express caps declaratively via localization-pack rule parameters.

## 6. Non-goals / explicit avoids

- No hardcoding 94,000 anywhere.
- No renaming of persisted columns.
- No Kenya-specific branch in engine or resolver.
- No duplicated calculation in the return generator — resolver stays the only computation site for aggregates, engine stays the only computation site for per-payslip values.

## Approval

Approve to proceed with steps 1–5 in one PR. Step 6 (engine-persisted `contribution_base` + `sum_rule_base.*` + true pensionable-earnings modelling) will be a follow-up PR so this correction ships without waiting on an engine change; the interim NSSF "Pensionable Pay" = gross is documented and matches current behavior for uncapped earners.
