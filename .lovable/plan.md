# Loan product configuration & repayment schedule — investigation findings and remediation

Investigation only so far. No code or database object has been changed.

## A. How the chain actually works today

```text
Loan product (mf_loan_products)
  └─ Version (mf_loan_product_versions)      immutable once is_published
        └─ Application (mf_loan_applications) stores product_version_id
              └─ mf_create_loan_from_application()
                    copies version terms onto mf_loans (frozen contract)
                    └─ mf_generate_schedule()   ← the only schedule engine
                          └─ mf_loan_schedule rows (principal/interest/fees/total per installment)
                                └─ mf_record_repayment() allocates against them
```

Everything financial is server-side. The React screens read and display only —
`LoanScheduleDialog` merely sums the stored rows. That part of the design is sound.

Key objects: `mf_generate_schedule`, `mf_add_period`, `mf_periods_per_year`,
`mf_compute_loan_fees`, `mf_loan_fee_total`, `mf_accrue_penalties`,
`mf_create_loan_from_application`, `mf_disburse_loan`, `mf_record_repayment`,
triggers `_mf_lpv_freeze_guard`, `mf_loans_freeze_terms`.

## B. The interest formula as implemented

```text
ppy          = 365 daily / 52 weekly / 26 biweekly / 12 monthly / 4 quarterly
period_rate  = rate/100 ÷ ppy          -- for ANY rate basis except 'per_month'
             = rate/100 × 12 ÷ ppy     -- for 'per_month'
flat:      total interest = principal × period_rate × term_installments
           per installment = total ÷ (term − grace); grace installments carry 0 interest
declining: annuity instalment on (term − grace); interest = balance × period_rate
```

## C. Defect 1 (critical) — the rate basis vocabulary does not match the engine

The database allows four rate bases:
`per_annum`, `per_month`, `per_installment`, `flat_on_principal`.
`mf_generate_schedule` only recognises `per_month` and a value `per_period`
that the database **cannot store**. Everything else falls into the `ELSE`
branch and is silently treated as *per annum*.

| Stored basis | Intended meaning | What the engine does | Verdict |
| --- | --- | --- | --- |
| `per_annum` | annual rate, pro-rated | rate ÷ ppy per period | correct |
| `per_month` | monthly rate | rate × 12 ÷ ppy | correct |
| `per_installment` | rate per installment | **rate ÷ 52** (weekly) | wrong by 52× |
| `flat_on_principal` | rate × principal for the whole loan | **rate ÷ 52 × term** | wrong |
| `per_period` (engine) | — | dead branch, unreachable | dead code |

The live product "Business Loan" v1 is configured `flat / 20% / flat_on_principal /
weekly / 8–12 installments`. The operator means "20% of principal = KES 2,000 on a
10,000 loan". The engine would charge, for 12 weekly installments,
`10,000 × 0.20 ÷ 52 × 12 = KES 461.54`. That is a live mispricing risk, not a
theoretical one.

Also: `mf_create_loan_from_application` defaults a null basis to the string
`'per_year'`, a fifth spelling no constraint allows on `mf_loans`.

## D. The KES 10,000 → ~10,600 case

`mf_loans` and `mf_loan_schedule` are currently **empty** — the transactional
data was reset, so I cannot point at the original row. Arithmetically the number
reproduces exactly on the other published version, "V1 Proof Product"
(`flat`, `12%`, `per_annum`, `monthly`):

```text
period_rate = 0.12 ÷ 12 = 0.01
6 monthly installments:
Principal:      10,000.00
Interest:       10,000 × 0.01 × 6 =   600.00
Fees:                                   0.00   (that version has no fees)
Penalties:                              0.00   (never in the origination schedule)
-----------------------------------------------
Total:                              10,600.00   → 6 × 1,766.67
```

So ~10,600 is *consistent with the engine* for 6 monthly installments at 12% p.a.
flat. It is **not** consistent with the "Business Loan" product (20% weekly),
which would produce a much smaller interest figure. Before I treat this as
"correct", I need you to confirm which product and how many installments that
loan used — I will re-derive against the real row if one can be restored.

## E. Fees

`deducted_from_disbursement` fees are computed at disbursement, netted out of
the cash paid, and never touch the schedule: the client receives 9,500 and owes
10,000 (**model A**). `added_to_first_installment` fees are added to installment 1
only (**model B**). Both models coexist per fee row; fees never capitalise into
principal. Only the second kind appears in the schedule total.

## F. Penalties

`penalty_rate` / `penalty_basis` are never part of the origination schedule.
`mf_accrue_penalties(business, as_of)` runs after delinquency and writes
`mf_loan_charges` rows: `base × rate/100`, where base is the overdue installment
total, overdue principal, or whole outstanding balance. It is a **flat charge per
run keyed by date**, applied to every overdue installment each time it is run —
there is no schedule/cron wiring visible, so accrual frequency is operator-driven.
With `penalty_rate = 0` the basis field is inert.

## G. Grace installments

Implemented as: the first N installments have zero principal; interest is zero for
flat and accrued-but-unpaid-in-the-installment for declining balance; the loan's
principal and (for flat) total interest are compressed into the remaining
`term − grace` installments. Nothing is capitalised, nothing is waived, dates do
not move. This is a defensible definition but it is **nowhere documented or
validated**, and for flat interest it means interest is charged over the grace
period yet collected later.

## H. Versioning

Enforced well: `_mf_lpv_freeze_guard` blocks any edit or delete of a published
version, `mf_loans_freeze_terms` blocks term changes after disbursement, and loan
terms are copied onto `mf_loans` at creation. Two gaps:
- `effective_from` is stored but **never used**. The UI picks the first published
  version by creation date (`useMfLoanProducts.ts:340`), so a future-dated version
  becomes the live price immediately.
- Nothing prevents two versions with the same or overlapping `effective_from`.
- Branch scoping: product versions are business-level only. That matches the
  single-business/multi-branch model; no change proposed.

## I. Form audit summary (defects only)

| Field | Problem |
| --- | --- |
| Interest rate basis | vocabulary mismatch with engine (section C); UI default `per_annum` while a live version uses `flat_on_principal` |
| Interest rate | no upper bound, no requirement rule per method |
| Grace installments | not validated against `min_term_installments`; grace ≥ term silently divides by 1 |
| Min/max installments | no check that the band is sane for the frequency |
| Penalty basis | shown and stored even when rate = 0 |
| Fees | no cap on total percentage fees vs principal; the two collection models are not explained in the form |
| Effective from | collected but unused by the version resolver |
| Currency | free-text input on a KES-only institution |
| Activate with this version | activates the product, unrelated to which version is in force |

## J. Decisions I need from you before touching the engine

1. **`flat_on_principal`** — confirm it means `interest = principal × rate`, for the
   whole loan, independent of term and frequency.
2. **`per_installment`** — confirm it means `interest per installment = rate` applied
   per period, no annualisation.
3. **Flat + grace** — should total flat interest be based on the full term or only
   the paying installments?
4. **Existing loans** — none exist right now, so a fix cannot reprice anything;
   confirm no historical schedules must be preserved.

## K. Remediation plan (after your answers)

**Wave 1 — engine correctness (migration, one function).**
Rewrite `mf_generate_schedule`'s rate resolution to handle all four stored bases
explicitly and to `RAISE EXCEPTION` on an unknown basis instead of falling through
to per-annum. Fix `mf_create_loan_from_application`'s `'per_year'` default to
`'per_annum'` (separate migration).

**Wave 2 — backend invariants (migrations, one object each).**
Add a `CHECK` on `mf_loans.interest_rate_period`; add version-level checks:
`grace_period_installments < min_term_installments`, `penalty_basis` only
meaningful with a positive rate, total percentage fees < 100, and a unique
`(product_id, effective_from)`.

**Wave 3 — version resolution.**
Resolve the version in force by `effective_from <= today` and highest
`version_no`, in one place, used by the application form and by product display.

**Wave 4 — context-aware form.**
Hide/disable rate basis options invalid for the chosen method, hide penalty basis
until penalty rate > 0, explain the two fee collection models inline, fix the
currency field to KES, and mirror every rule added in wave 2 as a client-side
message. No formula ever runs in React.

**Wave 5 — deterministic tests.**
A SQL test file under `supabase/tests/` covering the 20 cases you listed:
10,000 principal across flat and declining, each rate basis, weekly and monthly,
grace and no grace, fees of both collection types, penalty on and off, band
violations, and a reconciliation assertion that
`sum(principal_due) = principal` and
`sum(total_due) = principal + interest + scheduled fees` exactly, with no residual.

**Rollback:** each wave is a single-object migration; the previous function body
is restored by re-applying it. No data is rewritten, so rollback is code-only.

## Acceptance

Changing a rate basis on a new product version measurably and predictably changes
the generated schedule; an unknown or contradictory configuration is rejected by
the database, not silently reinterpreted; every schedule reconciles to the stated
contractual obligation with zero unexplained residual.

======================IMPLEMENTATION PROGRESS=====================

Verified as genuinely done (checked against the live database, not the previous notes):

The pricing engine handles all four rate bases correctly and refuses anything it doesn't recognise.
Loan amount and term are checked against the product's allowed bands when a loan is created.
The grace-period safeguard works — I proved it by trying to save a product with a grace period longer than the shortest allowed term, and the database rejected it.
Duplicate start dates for the same product are blocked.
The "Publish new version" form only shows fields that make sense for the chosen setup.
What I was in the middle of: running a throwaway pricing check across 16 different product setups (flat and reducing-balance interest, all rate bases, weekly/monthly/daily/fortnightly, grace periods, zero interest, and both fee models) on a 10,000 loan, with everything discarded afterwards. It got as far as the last blocker: the test client I'd picked no longer exists in the client list, so the temporary loans couldn't be created. That's a one-line fix — pick a real client — but I ran out of credits before rerunning it.

Still outstanding:

Rerun that pricing check with a valid client and read the results, including re-deriving the 10,000 → 10,600 figure.
Confirm the two fee models behave as intended: a deducted fee should reduce the cash handed over without changing what the client owes, and an added fee should increase the first instalment.
Record the results in the project status file.



KINDLY NOTE
==============
**Important:** Do not ask me any questions after completing the remediation work in the plan file.

Once all remediations in the plan have been implemented, **fully test the Loan Product creation/configuration functionality**.

Create multiple loan products specifically designed to exercise **every configurable setting, field, input, and dropdown option** available during loan product creation.

The testing must verify that:

* Every field accepts and correctly processes valid input.
* Every dropdown/select option can actually be selected and produces the intended behavior.
* Every configurable setting is persisted correctly.
* The selected configuration is actually respected when the loan product is used.
* Different combinations of settings work correctly, not just individual fields in isolation.
* No field or option is merely present in the UI but disconnected from the underlying logic.
* Invalid or incompatible combinations are handled correctly where validation is expected.
* The resulting loan products can be used successfully to create loans and generate the expected repayment/payment schedules.

**Do not stop after confirming that the UI accepts the values.** Trace each configuration through the actual backend/database/business logic and verify that it affects the resulting loan behavior as intended.

The objective is to establish that **every part of the loan product configurability is functional end-to-end**, with no dead fields, non-functional dropdown options, ignored settings, or configuration values that are saved but never applied.