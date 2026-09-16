\# Investigation Report — Client Loan Interest & Accounting Model

Investigation only. No code, database, RPC, mapping, or UI change was made.

## 1. Executive Finding
The client is describing a **flat-interest loan where interest is withheld at payout and earned week by week**. Contractually the borrower owes principal + interest from day one (one gross receivable), receives only the net cash, repays a level instalment, and interest becomes income in weekly slices, each slice posted only after the customer's payment is recorded. The live system already supports most of this (`interest_collection = 'deducted_upfront'`); what is missing is the weekly income recognition actually running, and the schedule showing the principal/interest split.

## 2. Client Business Model Reconstructed
1. **Disbursement** — recognise the whole obligation (P+I) as a receivable, park the interest in a holding account, hand over net cash.
2. **Repayment (manual)** — cash in, receivable down by the full instalment. No income touched.
3. **Recognition (automatic, after step 2)** — one week's interest moves out of the holding account into Interest Income.

## 3. Client Schedule Mathematics (10,000 / 2,000 / 12 weeks)
- 666.67 x 12 = 8,000.04 (principal component)
- 166.67 x 12 = 2,000.04 (interest component)
- Instalment 833.34 (system rounds to 833.33 x 12 = 10,000.00 exactly)
- Final row adjusts interest 166.67 -> 166.63 so interest totals exactly 2,000.

Reconciles as: **gross contract 10,000 = net cash 8,000 + interest 2,000**. So "gross loan 10,000" is *not* the cash the borrower receives; the borrower receives 8,000 and repays 10,000. Interest is 25% of cash advanced, i.e. 20% of the gross figure. This is the only reading in which the reference rows add up.

## 4. Client Accounting Model — worked example
Disbursement:
```text
Dr Loan Receivable         10,000
   Cr Cash/Bank                     8,000
   Cr Interest Receivable           2,000
```
Each week (x12):
```text
Dr Cash/Bank                  833.33      Dr Interest Receivable   166.67
   Cr Loan Receivable              833.33     Cr Interest Income          166.67
```
Running balances after week n: Loan Receivable 10,000 - 833.33n; Interest Receivable credit 2,000 - 166.67n; Interest Income 166.67n; Cash net -8,000 + 833.33n.
At week 12 (last interest slice 166.63): Loan Receivable 0, Interest Receivable 0, Interest Income 2,000, net cash +2,000. **The client's model is internally consistent and fully reconciles.**

## 5. "Interest Receivable" Interpretation
It carries a **credit** balance that is drawn down as income is earned. That is not a receivable asset — it is **unearned/deferred interest**: cash already collected (withheld) but not yet earned. Functionally it can sit either as a liability or as a contra-asset netted against the gross receivable (the usual presentation, so net portfolio = principal outstanding). Client wording: "Interest Receivable". Technical meaning: **deferred/unearned interest**. The live schema already has both mapping keys: `interest_receivable` (defined, mapped once, used by **no** posting routine) and `deferred_interest` (mapped and actively used).

## 6. "Loan Receivable P+I" Interpretation
Answer A/C: the **gross contractual obligation, principal + interest = 10,000**, opened in full at disbursement and reduced by the full instalment on every repayment (no interest split on the cash entry). Net exposure shown on the balance sheet = gross receivable less unearned interest.

## 7. Current System Behaviour (verified live)
- `mf_loan_product_versions.interest_collection` exists: `with_installments` | `deducted_upfront`, constrained to flat interest only. 1 published version and both existing loans already use `deducted_upfront`.
- `mf_loan_upfront_interest` computes the withheld interest; `mf_disburse_loan` pays out `principal - fees_deducted - upfront_interest`.
- `mf_post_event('loan_disbursed')` posts: Dr `principal_receivable` full principal, Cr `deferred_interest` upfront interest, Cr cash net. **This already equals the client's disbursement entry.**
- `mf_generate_schedule` sets scheduled interest to **0** for upfront loans; instalments are principal-only (833.33 x 12).
- `mf_record_repayment` allocates penalty/fee/interest/principal; with zero scheduled interest everything lands on principal, so the posting is Dr cash / Cr `principal_receivable`. **This equals the client's manual repayment entry.**
- `mf_release_deferred_interest` / `_due` exist and post Dr `deferred_interest` / Cr `interest_income` per instalment, idempotent via `mf_deferred_interest_releases` (unique per instalment). **Nothing calls them** — no cron job, no UI, no trigger. `mf_deferred_interest_releases` is empty, so no interest has ever been recognised on the two live loans.
- Recognition is driven by **schedule due date** (`due_date <= as_of`), not by the repayment being received.
- Disbursement reversal is blocked once any release exists; repayment reversal voids only the repayment journal.
- Write-off de-recognises principal only; unearned interest is not addressed.

## 8. Gap Analysis
| Current | Client requirement | Gap | Capability needed |
|---|---|---|---|
| Deferred interest credited at payout | Same | None | Reuse |
| Repayment posts Dr cash / Cr receivable | Same | None | Reuse |
| Weekly recognition function exists, never invoked | Must post after each repayment | **Critical** | Trigger recognition on successful repayment (and/or a scheduled runner) |
| Recognition keyed to due date | Keyed to payment received | Behavioural | Add a recognition-trigger setting |
| Schedule shows 833.33 principal, 0 interest | 666.67 + 166.67 | Presentation/reporting | Split display or store components |
| Account key `deferred_interest` | Client says "Interest Receivable" | Naming only | Label/chart-of-accounts decision |
| Principal field = gross 10,000 | Gross 10,000 / net 8,000 | Terminology risk in UI | Clarify payout preview wording |
| Write-off / early settlement of unearned interest | Undefined | Open | Business decision |

## 9. Existing Interest Methods vs the Reference
- **flat + flat_on_principal + with_installments**: 833.33 principal + 166.67 interest, total 12,000 on a 10,000 principal — matches the *shape* but the totals differ (borrower gets 10,000, repays 12,000).
- **flat + deducted_upfront** (current live config): cash out 8,000, repay 10,000 — matches the client's **totals and journals**, but the schedule shows no interest column.
- **declining_balance / declining_balance_equal_installments**: interest falls each period, principal rises — does not match the constant 166.67.

Conclusion: the client's model is **an existing calculation method (flat) plus an interest recognition/collection model that already exists but is not wired up**, not a new calculation method.

## 10. Additive Architecture Recommendation
Keep the existing two dimensions already present in the schema — Interest Calculation Method (flat / declining / declining equal) and Interest Collection (with instalments / deducted upfront). Add only a **recognition trigger dimension** (on scheduled date vs on repayment received) and the presentational principal/interest split. Nothing needs removing.

## 11. Accounting Objects Possibly Required
No new account concept is strictly required — `deferred_interest` already does the job and `interest_receivable` already exists as an unused key. Decision needed only on which key/label the client's chart should use and whether it presents as liability or contra-asset.

## 12. Event Sequence & Ordering
Disbursement -> Repayment recorded (journal posted) -> Interest recognition for that instalment, in the same transaction as the repayment so a failure rolls both back. Idempotency is already guaranteed by the unique instalment row in `mf_deferred_interest_releases`. Repayment reversal must also reverse the matching recognition entry — today it does not, and the disbursement-reversal guard would then block the payout reversal.

## 13. Reporting Impact
Loan statement and schedule must show principal vs interest components separately from the cash instalment; portfolio outstanding should be gross receivable less unearned interest; P&L interest income accrues weekly, not at payout; balance sheet gains an unearned-interest balance; cash flow shows 8,000 out and 833.33 per week in. Cash received, interest income recognised, loan receivable and unearned interest are four distinct balances.

## 14. Historical Data Safety
Loan terms are frozen on `mf_loans` (method, rate, basis, collection, term, frequency) and the schedule rows are materialised at creation, so a new recognition setting would only apply to loans created after it. The two existing loans have no releases yet, so any change must decide explicitly whether to backfill them — no existing journal, schedule, repayment, product, or version may be modified.

## 15. Unresolved Business Decisions
1. Is recognition tied to payment received or to the scheduled week regardless of payment (arrears case)?
2. Early settlement: does remaining unearned interest become income immediately, or is it refunded/waived? Not established anywhere in code or rules.
3. Write-off: what happens to unrecognised interest on the written-off loan?
4. Reversal: should reversing a repayment also reverse that week's interest recognition?
5. Rounding: last-instalment residual on interest (166.63) vs on principal.
6. Does this apply to every product or only selected ones?
7. Should the account be presented as "Interest Receivable" (client wording) even though it behaves as unearned interest?
8. Restructure/top-up treatment of the remaining unearned balance.

## 16. Proposed Implementation Scope — FOR FUTURE APPROVAL ONLY
Wire recognition to the repayment event (or a scheduled runner) with a product-level setting; extend repayment reversal to reverse the paired recognition; store/derive the principal/interest split for upfront loans so schedules and statements show it; align reports and the disbursement preview wording; decide the account label. No change to existing calculation methods or historical loans.

## 17. Test Matrix
Schedule totals for 10,000/2,000/12w; payout equals 8,000; disbursement journal balances with 2,000 in the holding account; each repayment posts cash/receivable only; recognition posts exactly once per instalment; duplicate repayment attempts create no duplicate recognition; failed recognition rolls back the repayment; twelve weeks end with receivable 0, holding 0, income 2,000; repayment reversal unwinds both entries; early settlement, write-off, overdue and restructure paths; fee modes (deducted, paid by client, added to first instalment) stay independent of interest; existing `with_installments` and declining-balance loans produce byte-identical schedules and journals to today.


======================IMPLEMENTATION STATUS/PROGRESS AND WHERE THINGS STAND==================


Here's where things stand.

Verified as genuinely done (checked against the live database, not taken on trust): the interest-holding wiring at payout, the step that earns one week's interest when a receipt is recorded, and the new read-only schedule view that produces the borrower's principal-and-interest split. The one security notice flagged after that migration turned out to be pre-existing and unrelated — the new view already runs under the caller's own permissions, so nothing to fix there.

Done this session: the repayment schedule screen now shows the split (666.67 principal + 166.67 interest) and, for loans whose interest was held back, a new "Interest earned" column showing what has already become income. The printed loan agreement, repayment schedule and loan statement now show the same split, so the borrower never receives two differently shaped versions of the plan. Ordinary loans look exactly as before. The code compiles cleanly.

Unfinished: the screens have not been opened and viewed against a real loan, and the treatment of unearned interest on early settlement, write-off and restructuring still needs your decision before it can be built. Credits ran out, so continuing needs available credits.