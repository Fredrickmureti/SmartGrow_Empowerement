# Upfront interest: accounting investigation findings and proposed remediation

Investigation only so far — nothing has been changed. Everything below was read
from the live database and the code, not inferred from account names.

## 1. What the system does today (verified)

- **Interest income (4310)** is credited in exactly two places: when a repayment
  is received and its allocation includes an interest component, and — new —
  when interest is "deducted upfront" at disbursement. So the institution's
  established policy is **interest is income when collected**, not when accrued.
- **Interest receivable (1375)** exists as a configured mapping but **no posting
  routine ever uses it**. It is currently a decorative account.
- **Suspended interest (2430, liability)** likewise exists and is unused. It is
  the only liability-side interest account already mapped.
- Write-off logic states explicitly that unpaid interest was never accrued, so
  only principal is de-recognised. This confirms the collected-basis policy.
- With upfront interest the schedule is **principal only** (verified on
  LN-000006: 12 instalments, interest due 0.00). So no future repayment will
  ever allocate interest on these loans — the 2,000 cannot be recognised twice.
- Cash handling is correct and stays: fee received from client is a separate
  cash-in line; the payout line is net of deducted fees and upfront interest.

## 2. Was the earlier "interest posted at interest receivable" requirement bypassed?

There is **no implementation of that requirement anywhere** — not in the upfront
path and not in the normal path. It was never built, so the upfront work did not
regress it; it inherited the collected-basis model already in the code. Root
cause of the client's complaint: the upfront branch recognises a full term of
income on day one, which overstates today's profit even though the cash was
genuinely retained.

## 3. The four concepts, for the 10,000 / 2,000 / 500 example

| Concept | True at disbursement? |
| --- | --- |
| Borrower contractually owes 2,000 interest | Yes — but it is already settled by the deduction |
| Institution has *received* the 2,000 | Yes — retained out of the payout, cash never left |
| Institution has *earned* the 2,000 | No — the term has not run |
| A receivable exists for the 2,000 | **No** — you cannot have a receivable for cash you already hold |

So the client's instinct that "this is not yet income" is right, but
**Interest Receivable is the wrong account** — money already collected is not an
asset owed to you. The correct treatment is option **C: Deferred / Unearned
Interest, a liability, released to interest income over the loan term.**

## 4. Recommended model

- Add a `deferred_interest` (unearned interest) lending mapping, liability type.
  Do not reuse `suspended_interest` — that means something else (NPL suspension).
- Disbursement with upfront interest credits **Deferred interest**, not income.
- Interest is released to 4310 as the term runs — one line per instalment date,
  proportional to that instalment's share of interest under the loan's own
  frozen method (flat/declining/declining-equal all reduce to a fixed schedule
  of interest amounts already computable at origination, so no new maths).
- Early settlement: release the remaining balance immediately. Reversal of the
  disbursement: void the release entries then the disbursement (voiding, never
  editing). Write-off: released portion stays income, unreleased balance is
  released or refunded per policy — to be confirmed with you before build.
- `interest_receivable` stays unused for upfront loans; it becomes meaningful
  only if you later want accrual-basis interest on ordinary loans. That is a
  separate decision and is **not** part of this change.

### Before / after for LN-000006

```text
BEFORE (posted, JE-00026)
Dr 1370 Principal receivable 10,000
   Cr 4310 Interest income          2,000   <- overstates income today
Dr 1112 Bank                    500
   Cr 4320 Fee income                 500
   Cr 1112 Bank                     8,000

AFTER (proposed)
Dr 1370 Principal receivable 10,000
   Cr 2xxx Deferred interest        2,000   <- liability, released monthly
Dr 1112 Bank                    500
   Cr 4320 Fee income                 500
   Cr 1112 Bank                     8,000
then, over the 12 weekly instalments: Dr Deferred interest / Cr 4310, ~166.67 each
```

## 5. GL mapping UI — the part you struggled with

Rebuild `Lending → Configuration → Accounting mappings` as a grouped, readable
screen: sections for *What clients owe us*, *What we earn*, *Where cash sits*,
*Losses and provisions*; each row shows the account code + name, a plain-language
"used when…" sentence, and a clear, searchable account picker with the current
account visible at a glance. Add a completeness banner and block publishing a
product whose required mappings are missing (principal receivable, interest
income, deferred interest when upfront interest is on, fee income, the cash
account for each enabled disbursement method).

Product configuration keeps a **read-only accounting summary** plus a worked
preview (principal / upfront interest / fee in / cash out / resulting journal)
so an administrator sees the GL effect before publishing or disbursing. Mappings
stay organisation/branch-level configuration; the loan already freezes its money
terms, and the resolved accounts will be snapshotted onto the disbursement so a
later mapping change cannot re-interpret history.

## 6. The two loans already posted

Nothing is rewritten. Affected: **LN-000005 (3,000)** and **LN-000006 (3,000?
no — 3,000 for 5, 2,000 for 6)**, both disbursed 2026-09-16, **zero repayments
recorded**, so nothing else depends on them.

Two options, your choice:
1. **System-assisted correction (recommended):** one dated correction journal per
   loan moving the upfront interest from 4310 to Deferred interest, then the
   release schedule starts from the disbursement date. Books stay auditable; the
   original entries remain voided-not-deleted or intact with a linked correction.
2. **Manual:** I deliver a short plain-language walkthrough (WhatsApp-style) for
   your accountant to void and re-enter the two entries by hand.

## 7. Test scenarios before anything is called done

Upfront-interest product on each interest method and rate basis; a normal
(non-upfront) product unchanged; fee deducted vs fee paid by client; early
settlement; disbursement reversal; write-off; missing-mapping validation;
trial balance, P&L, balance sheet, loan statement and portfolio reports
re-checked; and confirmation that historical loans do not move when a product's
mappings change.

## 8. Reporting impact

P&L interest income for September drops by 5,000 across the two loans; balance
sheet gains a 5,000 deferred-interest liability that unwinds over each term.
Principal receivable, cash, fee income, portfolio balances, schedules and client
statements are unaffected — they never referenced interest income.

## Approval needed on two points

1. Confirm **Deferred/Unearned interest (liability)** rather than Interest
   Receivable, as argued in section 3.
2. Choose correction option 1 or 2 in section 6.



===================WHERE THINGS STAND AND IMPLEMENTATION PROGRESS==============
Done (applied to your live backend):

A new Unearned Loan Interest account (2440) plus a lending mapping for it.
Loan payouts with upfront interest now credit Unearned Loan Interest instead of recognising the whole term's interest as income on day one.
Interest is turned into income gradually: a release routine posts one entry per instalment as it falls due, with a record of every release, plus a catch-up routine for a whole institution.
Any unearned balance left is earned automatically when a loan is closed or written off.
A payout can no longer be reversed once some of that interest has already been earned, so the books can't fall out of step.
Cash handling is unchanged: fee received from the client and net cash paid out stay separate lines.
Not done yet:

Correcting the two loans already posted (LN-000005 KSh 3,000 and LN-000006 KSh 2,000). Their existing entries still show the interest as income. No repayments exist on either, so a single dated correction per loan moving the amount from Loan Interest Income to Unearned Loan Interest is all that's needed — I hadn't run it.
The clearer, grouped GL mapping screen with plain-language "used when" descriptions, the missing-mapping validation before publishing a product, and the accounting preview on the product and payout screens.
Testing of the new release posting end to end.
Because the new mapping and posting rule are already live while the screen and validation aren't, please avoid disbursing another upfront-interest loan until the remaining work is finished. Continuing needs available credits — top up and I'll pick up exactly here, starting with the two corrections.