# ADR 0062 — Canonical payroll values, and the return-template consumer contract

Status: **Accepted** (2026-07-14)

## Context

A KE NSSF Monthly By-Product return was rendering "Gross Pay" = 84,365.06 for
an employee whose true gross earnings were 94,000. 84,365.06 is precisely the
taxable income (gross − pre-tax NSSF+SHIF+AHL), so the return was surfacing
the wrong canonical value under the right label.

Investigation (see `.lovable/plan.md`, 2026-07-14) proved the defect lives in
the **return template seed data**, not in the payroll engine, not in the
persisted schema, and not in the resolver logic:

- `compute-payroll` correctly computes and persists `payslips.gross_pay` and
  `payslips.taxable_income` as two distinct, correct values.
- `_shared/returnSourceResolver.ts` correctly exposes `sum_taxable_amount` as
  "sum of `payslips.taxable_income`" — the name is honest.
- The KE templates (`P10`, `P10A`, `P10D`, `NSSF_RET`, `SHIF_RET`, `AHL_RET`)
  in `20260620001436_…sql` bind columns labelled "Gross Pay" /
  "Annual Gross Pay" / "Pensionable Pay" to `source: sum_taxable_amount`.

There was also **no** `sum_gross_amount` resolver source at all, so even a
pack author who noticed the mismatch could not have bound to true gross
without adding a new resolver source.

## Decision

1. **Canonical payroll values live on `payslips` and `payslip_lines`.** The
   payroll engine is the single writer. Return generators, certificate
   engines, GL posting, analytics and exports are read-only consumers.
   Neither the resolver nor a template body may recompute a canonical value
   from prior parts.

2. **Canonical value definitions:**

   | Name | Storage | Meaning |
   |---|---|---|
   | `gross_pay` | `payslips.gross_pay` | True gross earnings = basic + housing + transport + other earnings + taxable reimbursements. |
   | `basic_salary` | `payslips.basic_salary` | Basic component only. |
   | `other_earnings` | `payslips.other_earnings` | Non-basic earnings roll-up. |
   | `taxable_income` / `taxable_base` | `payslips.taxable_income`, `payslips.taxable_base` | Gross minus pre-tax deductions the localization pack marks `reduces_taxable_income` (or lists in `pre_tax_deductions[]`). Country-agnostic. |
   | `chargeable_pay` | derived in `_shared/monthlyMatrix.ts` (`gross_pay − total_relief_deductions`) | Post-relief base. |
   | `net_pay` | `payslips.net_pay` | Take-home. |
   | per-rule employee/employer amounts | `payslip_lines.{employee_amount,employer_amount}` | Per statutory or voluntary line. |
   | contribution base per rule | (follow-up) `payslip_lines.contribution_base` | The gross-like base each statutory line was computed against, e.g. the pensionable-pay tier cap for NSSF. Not yet persisted; scheduled follow-up. |

   `pensionable_earnings` is **not** a separately persisted first-class value
   today. Where uncapped, it equals `gross_pay`. Where capped (e.g. NSSF
   tiers), the cap is a pack rule parameter and the resolved value belongs
   on `payslip_lines.contribution_base` — see the follow-up in §5.

3. **Resolver source ↔ canonical value contract.** Every aggregate source
   name in `_shared/returnSourceResolver.ts` MUST match, verbatim, the
   canonical column it sums. Renaming a source implies renaming the
   canonical value.

   | Source | Sums | Added |
   |---|---|---|
   | `sum_employee_amount` | `payslip_lines.employee_amount` over `filters.rule_codes` | (existing) |
   | `sum_employer_amount` | `payslip_lines.employer_amount` over `filters.rule_codes` | (existing) |
   | `sum_gross_amount` | `payslips.gross_pay` | **NEW (this ADR)** |
   | `sum_taxable_amount` | `payslips.taxable_income` (fallback `gross_pay`) | (existing) |
   | `sum_basic_pay` | `payslip_lines.employee_amount` where `category = 'basic'` | (existing) |
   | `sum_allowances` | `payslip_lines.employee_amount` where `category = 'allowance'` | (existing) |
   | `sum_total_amount` | `sum_employee_amount + sum_employer_amount` | (existing) |
   | `sum_rule.<code>.{employee,employer}` | per-rule breakdown | (existing) |
   | `sum_taxable_minus_rules:<a,b,c>` | `sum_taxable_amount − sum_rule.a.employee − …` | (existing) |
   | `count_payslips` | number of eligible payslips | (existing) |

4. **Return templates MUST NOT compute.** A `body.columns[].source` binding
   is a *lookup*, not a formula. Any arithmetic (subtract reliefs, apply a
   cap, split employer/employee) is either:
   - already available as a first-class resolver source, or
   - a new resolver source added to §3, or
   - a new engine-persisted canonical value on `payslips`/`payslip_lines`
     with its own resolver source.

   Inlining arithmetic into a template body is banned.

5. **Follow-up (separate PR): `sum_rule_base.<code>`.** To surface true
   pensionable earnings for NSSF (and equivalents in future country packs)
   without any Kenya-specific code, the engine will start writing
   `payslip_lines.contribution_base` for statutory contribution lines, and
   the resolver will expose `sum_rule_base.<code>` reading it. NSSF's
   "Pensionable Pay" column will then be rebound to `sum_rule_base.nssf`.
   Until then, uncapped earners see pensionable = gross (matches the
   pack's current design — the cap is applied per-contribution, not per pay
   line).

## Consequences

- **Six KE return templates were rebound from `sum_taxable_amount` →
  `sum_gross_amount`** for columns whose label carries "Gross" or
  "Pensionable" semantics (P10, P10A, P10D, NSSF_RET, SHIF_RET, AHL_RET —
  gross columns only; taxable-pay columns on P10/P10A remain on
  `sum_taxable_amount`).
- Future country packs that want to display true gross MUST use
  `sum_gross_amount`. An architecture guard test flags any template column
  whose key/label looks gross-shaped but whose source is
  `sum_taxable_amount`.
- No engine change, no schema change was needed for the correction. The
  follow-up in §5 introduces the only schema change (a nullable numeric
  column on `payslip_lines`).

## Amendment 2026-07-14 — Submission-format parity

Return templates carry **two** declarative column lists:

| List | Consumed by | Producer |
|---|---|---|
| `body.columns[]` | CSV + PDF outputs, in-app preview | `generate-statutory-return` |
| `submission_format.columns[]` | The file the tax authority ingests (`gov_xlsx`, `gov_csv`, `gov_xml`) | `_shared/govFileWriter.ts` |

The initial ADR-0062 fix rebound only `body.columns` for the six KE
templates. The government-portal XLSX kept the old `sum_taxable_amount`
binding, so the *filed* artifact was still wrong even though the
in-app view was correct.

**Rule:** every declarative output surface for a given logical column
must resolve to the same canonical source. A column labelled "Gross
Pay" cannot be `sum_gross_amount` in one surface and
`sum_taxable_amount` in another.

**Enforcement:** `generate-statutory-return` now compares
`body.columns` and `submission_format.columns` by normalized
header/key. If two `sum_*` sources disagree for the same logical
column, generation aborts with `RETURN_TEMPLATE_SOURCE_MISMATCH`
(HTTP 422) rather than emitting a silently-wrong file. Static and
runtime guards under `src/test/localization/` prevent regression:

- `ke-return-gov-file-gross-binding.test.ts` — scans migrations for
  new `submission_format` entries mapping `gross*` headers to
  `sum_taxable_amount`.
- `return-gov-file-column-parity.test.ts` — runtime contract for the
  new mismatch error.


## References

- `.lovable/plan.md` — investigation and fix plan (2026-07-14).
- `docs/adr/0036-country-agnostic-payroll-completion.md` — country-agnostic
  engine contract.
- `docs/adr/0047-statutory-rules-legislative-cockpit.md` — statutory rules
  as pack-declared data.
- `supabase/functions/_shared/returnSourceResolver.ts`
- `supabase/functions/generate-statutory-return/index.ts`
- `supabase/functions/compute-payroll/index.ts` (lines 2757, 3853–3874).
