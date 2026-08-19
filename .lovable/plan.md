# Investigation verdict — does Undeposited Funds still hold the KES 1,670.40?

Evidence gathered from the live database (no changes made).

Records involved (real IDs, not inferred from amounts):

```text
payment 8b4d1a2e… RCP-000001  KES 1,670.40  status=applied
  deposit_account_id = 80b54681…  (1340 Undeposited Funds)
  journal_entry_id   = 36d12f07…  (JE-00006, source_type=payment, source_id=payment id)

bank_transaction 44d6847d…  2026-08-18  PMT-FM-00002  credit 1,670.40
  is_reconciled = true, reconciled_type = payment
  reconciled_payment_id  = 8b4d1a2e…   (the same payment)
  journal_entry_id       = db66ccd0…   (JE-00008)

match 7534e575…  status=confirmed, confirmed_at 2026-08-19 15:31:29
  matched_payment_id = 8b4d1a2e…
  allocations = [{document_type: payment, document_id: 8b4d1a2e…, amount: 1670.40}]
  (an earlier proposal 4899ed59… of kind `account` is status=rejected)
```

Journal lines, read separately per entry:

```text
JE-00006  Payment from Fredrick Mureti      (source_type=payment)
  Dr 1340 Undeposited Funds      1,670.40
  Cr 1100 Accounts Receivable    1,670.40

JE-00008  Deposit of recorded receipts into bank   ref BDEP-7534e575
          (source_type=bank_reconciliation, source_id = bank transaction)
  Dr 1012 Cash at Bank - KES     1,670.40
  Cr 1340 Undeposited Funds      1,670.40
```

Both entries are `posted`, same organization, business and branch, same date, and both lines carry the same branch/business scope — so no report scope can see one without the other.

Balance of 1340 Undeposited Funds from posted journal lines: **0.00**.
`accounts.current_balance` for 1340: **0.00**. Cash at Bank 1012: 51,670.40.

## 1. ACCOUNTING EXPECTATION

A receipt taken into a clearing account is a two-step deposit. Step one records
the money and extinguishes the receivable (Dr Undeposited Funds / Cr AR). Step
two, when the bank confirms the money arrived, moves it out of the clearing
account into the bank (Dr Bank / Cr Undeposited Funds). The payment itself is
not re-recorded, not re-allocated and not duplicated; reconciliation is the
*banking* of an existing receipt, not a new settlement. After the deposit is
reconciled, the clearing account's balance for that receipt must be nil and the
bank must be higher by the same amount. There is no legitimate model in which
both the bank rises and the clearing account keeps the amount — that would
double-count the asset.

## 2. VERIFIED CURRENT BEHAVIOR

The system does exactly that. Confirming the match posted JE-00008
(Dr 1012 / Cr 1340) through the posting engine, linked the bank line to the
existing payment (`reconciled_type = payment`, `reconciled_payment_id` = the
payment), recorded the confirmed match with a `payment`-kind allocation, and
created **no** second payment, no second allocation and no change to the
receivable. Undeposited Funds nets to 0.00 today.

## 3. ROOT CAUSE

There is no live defect. The behaviour you saw belongs to the earlier state of
this line: before 15:31 today the line carried a stranded `account`-kind
proposal (`4899ed59…`, created 13:57, now `rejected`) that had rolled back on
the `reconciled_type` CHECK constraint. In that window the bank line was
unreconciled, no clearing entry existed, and Undeposited Funds legitimately
still held 1,670.40. The constraint has since been widened and the match
confirmed, which produced JE-00008.

If your screen still shows 1,670.40 in Undeposited Funds, it is a cached view of
that earlier state — the ledger no longer contains that balance.

## 4. IS THIS ACTUALLY A BUG?

**NO** for the accounting operation: the correct clearing entry is posted, the
receipt is not duplicated, and the clearing account is nil.

**CONDITIONAL** on one provenance nuance worth naming without fixing it here:
JE-00008's own `source_type`/`source_id` point at the bank transaction, and
nothing on the `payments` row records "deposited". The payment→deposit link
exists only on `bank_transactions.reconciled_payment_id` and on the match's
allocations. Any future payment-centric "undeposited receipts" list must read
those two, not the payment row. The existing picker already does.

## 5. ACCOUNTING CONSEQUENCE

None from the current state. The risk that did exist — the stranded proposal —
was that an operator, seeing no suggestion, would settle the invoice a second
time or hand-post Dr Bank / Cr Undeposited Funds unlinked to the receipt,
leaving the receipt eligible to be deposited again on another statement line.

## 6. SCOPE

Isolated. The clearing path is one seam (`bank_match_confirm` with a `payment`
allocation) and it behaves correctly for this account. No claim is made about
other clearing accounts beyond this: the same seam is account-agnostic, so it
would behave identically, but I did not exercise another one.

## 7. MINIMAL CORRECT FIX DIRECTION

No accounting fix is required. The only remaining question is verification, not
change. If anything is worth doing later it is the provenance ratchet in §4 —
making "is this receipt deposited?" answerable from one canonical read.

## 8. REQUIRED TEST

One pgTAP test on the clearing seam: record a receipt into a clearing account,
import a matching bank credit, confirm a `payment`-kind match, then assert —

- before confirm: clearing account balance = amount, bank = 0, bank line unreconciled;
- after confirm: clearing account balance = 0, bank = amount, `payments` count
  unchanged (exactly one), `payment_allocations` count unchanged, bank line
  `reconciled_type = 'payment'` with `reconciled_payment_id` = the receipt;
- confirming again is refused and posts no second entry.
