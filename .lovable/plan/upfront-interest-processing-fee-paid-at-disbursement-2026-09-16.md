# Upfront interest & processing fee paid at disbursement

## What I found today (verified against the live database)

**1. Loan product model.** A product (`mf_loan_products`) holds only name/code/status; all money rules live in versioned rows (`mf_loan_product_versions`): amount range, term range, repayment frequency, interest method, interest rate, rate period, grace, a `fees` list, penalty rules. Versions are published and the loan copies the rules at creation time.

**2. Interest model.** Configurable per product: method `flat`, `declining_balance`, or `declining_balance_equal_installments`; rate basis `per_annum`, `per_month`, `per_installment`, or `flat_on_principal`. The schedule builder prices every installment from these. There is **no** "deduct interest upfront" option anywhere — interest is always spread across installments and is only turned into income when a repayment is received.

**3. Processing fee model.** Fees are a list on the product version: a name, a basis (fixed amount or percent of principal), and a collection mode. Only two collection modes exist: **deducted from the payout** or **added to the first installment**. A fee the client hands over in cash at disbursement is **not** a supported mode.

**4. Disbursement today.** Payout must equal the approved principal. Fees marked "deducted from payout" are subtracted, and the client receives the remainder. Interest is never touched at disbursement.

**5. Accounting today.** Disbursement posts: principal receivable debited with the full principal, fee income credited with any deducted fee, cash/bank/mobile money credited with the net paid out. Interest income is credited only as repayments are allocated. Balanced double entry, using existing account mappings (`principal_receivable`, `interest_income`, `interest_receivable`, `fee_income`, cash keys).

**6. Loan terms are frozen.** Each loan stores its own copy of principal, interest method, rate, basis, grace and the fee list, and a freeze rule stops those changing after the loan leaves the application stage. Changing a product later does not touch existing loans.

**7. Root cause / gap.** The client's request is two separate capabilities and **neither exists yet**:
- Interest deducted upfront at disbursement — not configurable at all.
- Processing fee paid in cash by the client at disbursement (money in, recognised as income) — the only "at disbursement" fee mode nets the fee off the payout instead.

**8. Risk position.** There are 4 loans, 0 active, and **0 disbursement records**. No historical payout or ledger entry is affected by this work.

## What I will build

Two new **product-level options**, both defaulting to today's behaviour so no existing product or loan changes.

**A. Interest collection (per product)**
- `with_installments` (default, exactly as today)
- `deducted_upfront` — interest for the whole term is computed at the same rate/method already configured, deducted from the payout, and the repayment schedule then carries **principal only**.

**B. Fee collection (third mode, per fee)**
- existing: deducted from payout / added to first installment
- new: **paid by the client at disbursement** — not netted off the payout; recorded as cash received and fee income on the same day.

Worked example, product set to upfront interest + client-paid fee, principal 10,000, flat 20% on principal, fee 200:
- Contractual principal: 10,000 / Upfront interest: 2,000 / Fee: 200
- Client hands over 200; cashier pays out 8,000; net cash out of till 7,800
- Principal outstanding: 10,000; interest receivable: 0 (already collected)
- Interest income 2,000 and fee income 200 recognised at disbursement
- Schedule: principal only, 10,000 across the term

Ledger for that disbursement (balanced):
```text
Dr Principal receivable   10,000
   Cr Interest income               2,000
   Cr Fee income                      200
   Cr Cash/Bank/M-Pesa              7,800
```

## Technical changes

*Database (one additive migration, no destructive statements)*
- `mf_loan_product_versions.interest_collection text not null default 'with_installments'` (check: `with_installments | deducted_upfront`), plus the same snapshot column on `mf_loans`; extend the freeze trigger so it is immutable after approval.
- `mf_compute_loan_fees`: accept and pass through the `paid_at_disbursement` collection mode.
- New `mf_loan_upfront_interest(loan_id)`: returns the full-term interest from the loan's own frozen terms when `interest_collection = 'deducted_upfront'`, else 0.
- `mf_generate_schedule`: when upfront interest applies, price installments with zero interest due (principal + any first-installment fees only). All other methods untouched.
- `mf_disburse_loan`: net payout = principal − deducted fees − upfront interest; fee paid at disbursement is recorded separately (cash in), not netted. Store `upfront_interest` and the fee split on the disbursement row and in the `loan_disbursed` event payload.
- `mf_post_event` (`loan_disbursed` branch): add an interest income credit when upfront interest > 0, and a client-paid fee credit with matching cash debit. Existing branches untouched.
- `mf_reverse_disbursement`: mirror the new components in the reversal so a reversed payout unwinds interest and fee cleanly.

*Frontend*
- `ProductVersionDialog`: interest collection selector; third option in the fee collection selector, with plain-language helper text.
- `ProductDetailSheet`: show both settings.
- `DisburseDialog`: itemise principal, upfront interest, fee deducted, fee collected from client, and cash to hand over.
- `useMfLoanProducts` / `useMfLoans` types and labels updated to match.

*Untouched:* repayment allocation, collections, penalties, accounting for every other event, other modules.

## Test plan

1. Product with upfront interest: 10,000 / 20% flat / fee 200 → payout 7,800, principal outstanding 10,000, schedule principal-only.
2. Existing flat and declining products unchanged — same schedule and same payout as today.
3. Fee set to "paid by client" → not netted off the payout; cash received recorded.
4. Fee income lands in the mapped fee income account; interest in the mapped interest income account.
5. Disbursement journal balances to zero on every variant.
6. Reversal of an upfront-interest payout unwinds all components.
7. Change the product after disbursement → the disbursed loan's terms and schedule do not move.
8. A user without disbursement rights is still refused; branch scoping unchanged.
